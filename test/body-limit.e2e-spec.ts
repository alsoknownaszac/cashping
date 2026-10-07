import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter.js';
import { configureBodyParser } from './../src/common/http/body-parser.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';

/**
 * The JSON body ceiling, exercised over real HTTP.
 *
 * This boots a *minimal* Nest application - one throwaway controller and the exception filter -
 * rather than the whole `AppModule`, for the same reason `exception-filter.e2e-spec.ts` does: the
 * thing under test is the HTTP layer. The body parser runs before any guard, controller or
 * database call, so the interesting requests never reach application code, and a small app
 * reproduces that exactly while keeping the test free of Postgres and Redis.
 *
 * The app is wired the way `main.ts` wires the real one - `bodyParser: false` at creation, then
 * `configureBodyParser` - because the limit only *binds* in that pairing (see `body-parser.ts`).
 * A limit set only in `main.ts` would not be exercised by any test at all; applying the same
 * function here is what makes this a test of the production wiring rather than of a lookalike.
 */

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown): { ok: true; body: unknown } {
    return { ok: true, body };
  }
}

const BASE = `/${GLOBAL_PREFIX}/probe`;

/**
 * Issues a POST whose serialised JSON body is exactly `bytes` bytes, so the size limit is the only
 * thing that can refuse it.
 *
 * `JSON.stringify({ a: '…' })` is `{"a":"…"}` - 8 bytes of scaffolding (two braces, a quoted key, a
 * colon and two quotes) plus the value - so `bytes - 8` characters of value produce a `bytes`-byte
 * body. The object is handed to superagent to serialise the way any real client's request is, which
 * keeps the byte count honest; passing a pre-built Buffer would not (superagent JSON-encodes a
 * Buffer into `{"type":"Buffer","data":[…]}`).
 */
function postJsonBodyOfSize(app: INestApplication<App>, bytes: number) {
  return request(app.getHttpServer())
    .post(`${BASE}/echo`)
    .send({ a: 'x'.repeat(bytes - 8) });
}

describe('JSON body size limit (e2e)', () => {
  const KB = 1024;
  let app: INestApplication<App>;

  async function boot(limit: string): Promise<INestApplication<App>> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();

    const instance = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    instance.setGlobalPrefix(GLOBAL_PREFIX);
    configureBodyParser(instance, limit);
    await instance.init();

    return instance;
  }

  describe('with the default 16kb ceiling', () => {
    beforeAll(async () => {
      app = await boot('16kb');
    });

    afterAll(async () => {
      await app.close();
    });

    it('accepts a body well under the limit (~90% of it)', async () => {
      const response = await postJsonBodyOfSize(app, Math.floor(16 * KB * 0.9)).expect(201);

      expect(response.body.ok).toBe(true);
    });

    it('refuses a body one byte over the limit with a 413 that names the limit', async () => {
      const response = await postJsonBodyOfSize(app, 16 * KB + 1).expect(413);

      expect(response.body.statusCode).toBe(413);
      expect(response.body.error).toMatch(/payload too large/i);
      expect(response.body.message).toMatch(/limit/i);
    });

    it('still parses an ordinary body (happy path unchanged)', async () => {
      const response = await request(app.getHttpServer())
        .post(`${BASE}/echo`)
        .send({ amount: '1' })
        .expect(201);

      expect(response.body).toEqual({ ok: true, body: { amount: '1' } });
    });

    it('does not read a urlencoded body, because no urlencoded parser is registered', async () => {
      const response = await request(app.getHttpServer())
        .post(`${BASE}/echo`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('a=1')
        .expect(201);

      // The JSON parser skips a non-JSON content type, and with no urlencoded parser the stream is
      // never read - so `@Body()` sees nothing and the field serialises away.
      expect(response.body).toEqual({ ok: true });
    });
  });

  describe('with a custom 1kb ceiling', () => {
    beforeAll(async () => {
      app = await boot('1kb');
    });

    afterAll(async () => {
      await app.close();
    });

    it('honours the configured limit rather than a hard-coded one', async () => {
      // One byte over 1kb is refused...
      await postJsonBodyOfSize(app, KB + 1).expect(413);
      // ...while exactly 1kb is accepted, which is the boundary body-parser itself draws.
      await postJsonBodyOfSize(app, KB).expect(201);
    });
  });
});
