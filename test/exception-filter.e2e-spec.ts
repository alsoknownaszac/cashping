import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { createConnection, type Socket } from 'node:net';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';

/**
 * The exception filter, exercised over real HTTP.
 *
 * This boots a *minimal* Nest application - one throwaway controller and the
 * filter - rather than the whole `AppModule`. The bug this pins down lives in
 * the HTTP layer: Express's body parser runs before any guard, controller or
 * database call, so the interesting requests (an oversized body, a bad charset)
 * never reach application code. A small app therefore reproduces it exactly while
 * keeping the test free of Postgres and Redis, and still goes through the same
 * `mapException` step and the same global filter the real app installs.
 */

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown): { ok: true; body: unknown } {
    return { ok: true, body };
  }

  @Get('boom')
  boom(): never {
    throw new Error('pg: connection string leaked');
  }

  @Get('teapot')
  teapot(): never {
    throw Object.assign(new Error('teapot'), { status: 418 });
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('no such thing');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('not allowed');
  }
}

const BASE = `/${GLOBAL_PREFIX}/probe`;

/**
 * Sends a raw request over a fresh socket and returns the raw response text.
 *
 * `socket.end()` half-closes the write side: the request is declared (via
 * `Content-Length`) to be longer than what is sent, then the sender stops. Node
 * ends the body early, which is the `request.aborted` path. Superagent cannot
 * express this - it always sets `Content-Length` to match the body it holds - so
 * the low-level socket is the only way to drive it.
 */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ port, host: '127.0.0.1' });
    let data = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    socket.on('connect', () => {
      socket.write(payload);
      socket.end();
    });
  });
}

describe('AllExceptionsFilter (e2e)', () => {
  let app: INestApplication<App>;
  let port: number;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Applied in `main.ts` for the real app, so applied here too.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    // A fixed port is not needed: the socket tests read whichever one is bound.
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 413 with the byte limit when the body is over it', async () => {
    const oversized = JSON.stringify({ x: 'a'.repeat(200_000) });

    const res = await request(app.getHttpServer())
      .post(`${BASE}/echo`)
      .set('Content-Type', 'application/json')
      .send(oversized)
      .expect(413);

    expect(res.body.statusCode).toBe(413);
    expect(res.body.error).toBe('Payload Too Large');
    expect(res.body.message).toMatch(/too large/i);
    expect(res.body.message).toMatch(/limit/i);
  });

  it('answers 415 and names an unsupported charset', async () => {
    const res = await request(app.getHttpServer())
      .post(`${BASE}/echo`)
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}')
      .expect(415);

    expect(res.body.statusCode).toBe(415);
    expect(res.body.error).toBe('Unsupported Media Type');
    expect(res.body.message).toMatch(/klingon/i);
  });

  it('answers 400 with a clear message for a non-gzip body declared as Content-Encoding: gzip', async () => {
    const res = await request(app.getHttpServer())
      .post(`${BASE}/echo`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('not gzip')
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toBe(
      'Request body could not be decompressed (Content-Encoding: gzip)',
    );
  });

  it('answers 400 for a malformed JSON body and says JSON', async () => {
    const res = await request(app.getHttpServer())
      .post(`${BASE}/echo`)
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toMatch(/json/i);
  });

  it('answers 400 when the body ends before Content-Length (aborted request)', async () => {
    const raw = await rawRequest(
      port,
      `POST ${BASE}/echo HTTP/1.1\r\n` +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 50\r\n' +
        '\r\n' +
        '{"a":1}',
    );

    expect(raw).toMatch(/^HTTP\/1\.1 400/);
  });

  it('answers a generic 500 when a controller throws a plain Error', async () => {
    const res = await request(app.getHttpServer()).get(`${BASE}/boom`).expect(500);

    expect(res.body.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.body.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('connection string');
  });

  it('returns a non-HttpException 4xx status instead of flooring it to 500', async () => {
    const res = await request(app.getHttpServer()).get(`${BASE}/teapot`).expect(418);

    expect(res.body.statusCode).toBe(418);
    expect(res.body.error).toBe("I'm a Teapot");
  });

  it('keeps an HttpException (404) behaving exactly as before', async () => {
    const res = await request(app.getHttpServer()).get(`${BASE}/missing`).expect(404);

    expect(res.body.statusCode).toBe(404);
    expect(res.body.error).toBe('Not Found');
    expect(res.body.message).toBe('no such thing');
  });

  it('keeps an HttpException (403) behaving exactly as before', async () => {
    const res = await request(app.getHttpServer()).get(`${BASE}/forbidden`).expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.message).toBe('not allowed');
  });

  it('still parses a normal JSON body (happy path unchanged)', async () => {
    const res = await request(app.getHttpServer())
      .post(`${BASE}/echo`)
      .send({ amount: '1' })
      .expect(201);

    expect(res.body).toEqual({ ok: true, body: { amount: '1' } });
  });
});
