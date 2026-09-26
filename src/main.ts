import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Socket } from 'node:net';
import { AppModule } from './app.module.js';

const logger = new Logger('Bootstrap');

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Opens a TCP connection and resolves once it is established.
 */
function connect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('connection timed out'));
    });
    socket.connect(port, host, () => resolve(socket));
  });
}

/**
 * Sends a payload and resolves with the first chunk the server writes back.
 */
function exchange(socket: Socket, request: Buffer | string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
    socket.once('error', reject);
    socket.write(request);
  });
}

/**
 * Redis connectivity check: a real protocol-level handshake (`PING` -> `+PONG`).
 */
async function probeRedis(host: string, port: number): Promise<void> {
  const socket = await connect(host, port);
  try {
    const reply = await exchange(socket, 'PING\r\n');
    if (reply !== '+PONG') {
      throw new Error(`unexpected reply: ${JSON.stringify(reply)}`);
    }
  } finally {
    socket.destroy();
  }
}

/**
 * PostgreSQL connectivity check: a real protocol-level handshake. The
 * PostgreSQL SSLRequest packet (int32 length 8 + int32 code 80877103) is
 * answered with a single byte, 'S' (SSL supported) or 'N' (not) — proof that
 * something speaking the Postgres wire protocol is listening, with no
 * client library and no credentials required.
 */
async function probePostgres(host: string, port: number): Promise<void> {
  const socket = await connect(host, port);
  try {
    // prettier-ignore
    const sslRequest = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
    const reply = await exchange(socket, sslRequest);
    if (reply !== 'S' && reply !== 'N') {
      throw new Error(`unexpected reply: ${JSON.stringify(reply)}`);
    }
  } finally {
    socket.destroy();
  }
}

/**
 * Trivial boot-time connectivity probe for Postgres and Redis (Step 3 of the
 * build sequence). It logs a health-check line per dependency so container
 * networking can be verified from `docker compose logs` alone.
 *
 * Failures are logged, never thrown: a missing dependency must not put the API
 * container into a restart loop.
 */
async function verifyDependencies(): Promise<void> {
  const postgresHost = process.env.POSTGRES_HOST ?? 'localhost';
  const postgresPort = Number(process.env.POSTGRES_PORT ?? 5432);
  const redisHost = process.env.REDIS_HOST ?? 'localhost';
  const redisPort = Number(process.env.REDIS_PORT ?? 6379);

  try {
    await probePostgres(postgresHost, postgresPort);
    logger.log(`Postgres reachable at ${postgresHost}:${postgresPort}`);
  } catch (error) {
    logger.error(
      `Postgres unreachable at ${postgresHost}:${postgresPort} - ${(error as Error).message}`,
    );
  }

  try {
    await probeRedis(redisHost, redisPort);
    logger.log(`Redis reachable at ${redisHost}:${redisPort}`);
  } catch (error) {
    logger.error(
      `Redis unreachable at ${redisHost}:${redisPort} - ${(error as Error).message}`,
    );
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await verifyDependencies();
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}`);
}

await bootstrap();

