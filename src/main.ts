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
    logger.log(
      'Postgres reachable via Prisma (queried users, otp_verifications)',
    );
  } catch (error) {
    logger.error(
      `Postgres unreachable via Prisma - ${(error as Error).message}`,
    );
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
async function verifyDependencies(
  app: INestApplication,
  config: AppConfig,
): Promise<void> {
  await verifyPostgres(app.get(PrismaService));
  await verifyRedis(config.redis.url);
}

async function bootstrap(): Promise<void> {
  loadEnvironmentFile();
  const config = configuration();

  initializeSentry(config);

  const app = await NestFactory.create(AppModule);
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
  logger.log(
    `API listening on http://localhost:${config.port} (routes under /${GLOBAL_PREFIX})`,
  );

  if (docsMounted) {
    logger.log(
      `API docs (Swagger UI) at http://localhost:${config.port}/${SWAGGER_PATH}`,
    );
  }
}

await bootstrap();
