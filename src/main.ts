import { writeSync } from 'node:fs';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { Redis } from 'ioredis';
import { AppModule } from './app.module.js';
import { configureCors } from './common/http/cors.js';
import { GLOBAL_PREFIX } from './common/http/prefix.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { SWAGGER_PATH, setupSwagger } from './common/http/swagger.js';
import configuration, { type AppConfig } from './config/configuration.js';
import { NodeEnvironment } from './config/validation.schema.js';
import { PrismaService } from './prisma/prisma.service.js';

const logger = new Logger('Bootstrap');

/**
 * Upper bound for every boot-time dependency check, so an unreachable peer
 * cannot stall startup.
 */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Loads `.env` before anything reads `process.env`.
 *
 * Step 6 initialises Sentry before the Nest app exists, which is earlier than
 * `ConfigModule` gets its turn at loading `.env` - this covers that gap for
 * `Sentry.init` and for the rest of this file.
 *
 * `loadEnvFile` is Node's built-in loader and, like dotenv, never overwrites a
 * variable that is already set: real environment variables from the container or
 * CI always win over a stray local `.env`. A missing file is expected outside
 * local dev - `.env` is both gitignored and excluded by `.dockerignore`.
 */
function loadEnvironmentFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env on disk - rely on the ambient environment.
  }
}

/**
 * Step 6: initialise Sentry before the Nest app is created, so reporting is in
 * place before any request-handling code exists.
 *
 * The DSN comes from the same `configuration()` factory Step 4 hands to
 * `ConfigModule`, keeping one definition of where configuration comes from.
 * Sampling is the only judgement call in here: low rates in production keep the
 * Sentry quota for real incidents, everything is kept locally.
 */
function initializeSentry(config: AppConfig): void {
  const isProduction = config.nodeEnv === NodeEnvironment.Production;

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    tracesSampleRate: isProduction ? 0.1 : 1,
    // Error and trace reporting only - no profiling. The Sentry v11 profiling
    // options (`profileSessionSampleRate`, `profileLifecycle`) do nothing without
    // `nodeProfilingIntegration()`, and `@sentry/profiling-node` is no longer a
    // dependency, so there is deliberately nothing profile-related to configure
    // here. Re-adding the integration is what would bring the options back.
  });

  logger.log(`Sentry initialised (environment: ${config.sentry.environment})`);
}

/**
 * Postgres reachability check.
 *
 * A real query through the generated Prisma client rather than a TCP probe: it
 * also proves the client was generated for the current schema and that the tables
 * the migrations created are actually there. `findFirst` rather than `count`
 * because one row is proof enough, and a `count(*)` over a table that only grows
 * is a scan nobody wants on every boot.
 */
async function verifyPostgres(prisma: PrismaService): Promise<void> {
  try {
    await Promise.all([
      prisma.user.findFirst({ select: { id: true } }),
      prisma.otpVerification.findFirst({ select: { id: true } }),
    ]);
    logger.log('Postgres reachable via Prisma (queried users, otp_verifications)');
  } catch (error) {
    logger.error(`Postgres unreachable via Prisma - ${(error as Error).message}`);
  }
}

/**
 * Redis reachability check.
 *
 * A real client handshake rather than a wire-protocol probe. The client is
 * deliberately short-lived: Redis earns a long-lived connection when BullMQ, OTP
 * rate limiting and idempotency keys are built, and that wiring should own it.
 * `retryStrategy` returns null so a dead Redis fails this check immediately
 * instead of retrying forever behind a boot that is waiting on it.
 */
async function verifyRedis(url: string): Promise<void> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  // ioredis reports connection trouble out-of-band. Without a listener that
  // 'error' event is unhandled and kills the process; the rejection from
  // connect()/ping() is what reports the failure below.
  redis.on('error', () => undefined);

  try {
    await redis.connect();
    const reply = await redis.ping();

    if (reply !== 'PONG') {
      throw new Error(`unexpected reply: ${JSON.stringify(reply)}`);
    }

    logger.log('Redis reachable via ioredis (PING -> PONG)');
  } catch (error) {
    logger.error(`Redis unreachable via ioredis - ${(error as Error).message}`);
  } finally {
    redis.disconnect();
  }
}

/**
 * Boot-time connectivity check for both dependencies.
 *
 * Failures are logged, never thrown: a missing dependency must not put the API
 * container into a restart loop (Step 3). The compose healthcheck is what marks
 * the container unhealthy.
 */
async function verifyDependencies(app: INestApplication, config: AppConfig): Promise<void> {
  await verifyPostgres(app.get(PrismaService));
  await verifyRedis(config.redis.url);
}

async function bootstrap(): Promise<void> {
  loadEnvironmentFile();
  const config = configuration();

  initializeSentry(config);

  // `abortOnError: false` is what makes a boot failure *readable*. Left at its
  // default, Nest logs an initialization error and then, from inside
  // `ExceptionsZone`, calls `process.exit(1)` - and that log goes to
  // `process.stdout`, which is a pipe under Render and therefore written
  // asynchronously, so the exit can drop the one line that names the cause.
  // `false` makes Nest rethrow instead of exiting: the rejection lands in the
  // `try/catch` at the foot of this file, which writes synchronously to stderr
  // before it exits. A module that cannot be constructed - an unreachable
  // dependency, a KMS key that is not in the configured region - now reports
  // itself, rather than leaving an empty log and a port scan timing out.
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  // Lets onModuleDestroy close the Prisma pool on SIGTERM/SIGINT, instead of the
  // process being cut off with connections still open.
  app.enableShutdownHooks();

  // Every route is mounted under the version prefix. This has to run before
  // `setupSwagger`, which publishes the prefixed paths (`/v1/health`) in the
  // OpenAPI document. The docs keep their unprefixed URL, so the address handed
  // to the frontend does not move when the API version does.
  app.setGlobalPrefix(GLOBAL_PREFIX);

  // Step 10: request bodies are validated from here on. Applied globally rather
  // than per-route so a future endpoint cannot opt out of input validation by
  // forgetting a decorator, and so the failure shape is one shape.
  app.useGlobalPipes(createValidationPipe());

  // Frontend hand-off: let the dev servers call the API from a browser (explicit
  // origin list, never a wildcard - see `configureCors`) and serve the interactive
  // docs unless they have been switched off. Both read the same validated config
  // as everything else.
  configureCors(app, config.cors.allowedOrigins);
  const docsMounted = setupSwagger(app, config.swagger.enabled);

  await verifyDependencies(app, config);

  await app.listen(config.port);
  logger.log(`API listening on http://localhost:${config.port} (routes under /${GLOBAL_PREFIX})`);

  if (docsMounted) {
    logger.log(`API docs (Swagger UI) at http://localhost:${config.port}/${SWAGGER_PATH}`);
  }
}

/**
 * Writes a line to stderr synchronously.
 *
 * Node writes to `process.stdout`/`process.stderr` asynchronously when they are
 * pipes - which is what they are under Render - and `process.exit()` does not
 * wait for such a write to land. A boot that dies before Nest prints its first
 * line therefore leaves an empty log, which is a failed deploy with no cause in
 * it. `writeSync` is synchronous, so the message is in the pipe before the
 * process goes away: a failure is readable even when it is the last thing to
 * run.
 */
function reportFatal(message: string): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    // stderr is gone (a closed pipe) - there is nothing left to report to.
  }
}

/** Renders an unknown thrown value into the single line a fatal log can carry. */
function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : String(error);
}

// A throw that escapes a callback, or a rejection nothing awaited, ends the
// process the same silent way the bare `await bootstrap()` used to: the deploy
// shows only "exited early" or a port scan timing out, and names no cause. Both
// handlers report and then exit non-zero, so a start-command failure is never an
// empty log again.
process.on('uncaughtException', (error) => {
  reportFatal(`Uncaught exception during startup - ${describeError(error)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  reportFatal(`Unhandled rejection during startup - ${describeError(reason)}`);
  process.exit(1);
});

try {
  await bootstrap();
} catch (error) {
  reportFatal(`Bootstrap failed - ${describeError(error)}`);
  process.exit(1);
}
