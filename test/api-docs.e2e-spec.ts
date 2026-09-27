import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { configureCors } from './../src/common/http/cors.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { SWAGGER_PATH, setupSwagger } from './../src/common/http/swagger.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import configuration from './../src/config/configuration.js';

/** The path the frontend calls for liveness, prefixed exactly as `main.ts` does. */
const HEALTH_PATH = `/${GLOBAL_PREFIX}/health`;

/**
 * The documented paths that carry `JwtAuthGuard`, and therefore answer 401 to the
 * tokenless request this file makes. Named rather than inferred: the point of the
 * loop below is that a path is routed and behaves like its siblings, and a guarded
 * GET answering 200 would mean the guard stopped being applied.
 */
const PROTECTED_GET_PATHS = new Set([`/${GLOBAL_PREFIX}/auth/session`]);

/**
 * What the frontend engineer actually consumes, over real HTTP and wired exactly
 * the way `main.ts` wires it: the docs route, the document's coverage, CORS, and
 * the documented health shape.
 *
 * Local-only: it boots `AppModule`, so it needs a `.env` (the unit suite stays
 * hermetic). Run it with `npm run test:e2e`.
 */
describe('Frontend hand-off (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The same wiring, in the same order, as `main.ts`: route prefix, then the
    // global pipes, then CORS, then the docs - which publish the prefixed paths,
    // so this exercises the URLs the frontend really calls rather than a simpler
    // app nobody runs. The pipes matter here: the POST routes below are reached
    // with an empty body, and without them that request would fall through to the
    // handler (and touch the database) instead of being refused at the door.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    configureCors(app, configuration().cors.allowedOrigins);
    setupSwagger(app, configuration().swagger.enabled);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it(`serves the interactive docs at /${SWAGGER_PATH}`, async () => {
    const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(200);

    expect(response.text).toContain('Swagger UI');
  });

  it('serves the docs outside the route prefix, so the hand-off URL cannot move', async () => {
    // Mounting the UI with `useGlobalPrefix: true` is the one way this URL could
    // drift, so it is asserted rather than assumed.
    await request(app.getHttpServer()).get(`/${GLOBAL_PREFIX}/${SWAGGER_PATH}`).expect(404);
  });

  it(`serves the document at /${SWAGGER_PATH}-json, covering every controller in the app`, async () => {
    const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

    // Deliberately an exact list, of the *prefixed* paths a client calls, in the
    // order `sort()` produces (plain string order): when a controller is added,
    // this fails until the expectation is updated - which is the moment to confirm
    // it really showed up in the docs (it is generated from the app, so it should).
    expect(Object.keys(response.body.paths as Record<string, unknown>).sort()).toEqual([
      `/${GLOBAL_PREFIX}`,
      `/${GLOBAL_PREFIX}/auth/login`,
      `/${GLOBAL_PREFIX}/auth/login/otp`,
      `/${GLOBAL_PREFIX}/auth/logout`,
      `/${GLOBAL_PREFIX}/auth/otp/verify`,
      `/${GLOBAL_PREFIX}/auth/refresh`,
      `/${GLOBAL_PREFIX}/auth/register`,
      `/${GLOBAL_PREFIX}/auth/session`,
      HEALTH_PATH,
    ]);
  });

  it('lists every documented path and method as a request the app really serves', async () => {
    const document = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

    const paths = document.body.paths as Record<string, Record<string, unknown>>;

    for (const [path, item] of Object.entries(paths)) {
      // Every method the document advertises, not just GET: a POST route that is
      // documented but not routed is exactly the drift this catches, and a GET
      // would not see it.
      for (const method of Object.keys(item)) {
        const where = `${method.toUpperCase()} ${path}`;
        const call =
          method === 'get'
            ? request(app.getHttpServer()).get(path)
            : method === 'post'
              ? request(app.getHttpServer()).post(path)
              : undefined;

        if (call === undefined) {
          throw new Error(`${where} is documented, but this test cannot call that method`);
        }

        const response = await call.send({});

        expect(response.status, `${where} is documented but not routed`).not.toBe(404);
        expect(response.status, `${where} is documented but not routed`).not.toBe(405);

        if (method === 'get') {
          // `/auth/session` is the one documented GET behind `JwtAuthGuard`, and its
          // answer without a bearer token is 401 - which is still proof it is routed
          // and that the guard is attached to it, the two things this loop checks for.
          expect(response.status, `${where} should answer`).toBe(
            PROTECTED_GET_PATHS.has(path) ? 401 : 200,
          );
        } else {
          // Routed, and the body is refused: what the global validation pipe is
          // for, and proof it is wired into this app rather than only into
          // `main.ts`.
          expect(response.status, `${where} should reject an empty body`).toBe(400);
        }
      }
    }
  });

  it('exposes the documented health shape', async () => {
    const response = await request(app.getHttpServer()).get(HEALTH_PATH).expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(new Date(response.body.timestamp as string).toISOString()).toBe(response.body.timestamp);
  });

  it('adds the CORS header for an origin from the configured allow-list', async () => {
    const allowedOrigin = configuration().cors.allowedOrigins[0] as string;

    const response = await request(app.getHttpServer())
      .get(HEALTH_PATH)
      .set('Origin', allowedOrigin)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
  });

  it('leaves the CORS header out for an origin that is not on the list', async () => {
    const response = await request(app.getHttpServer())
      .get(HEALTH_PATH)
      .set('Origin', 'http://not-allowed.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
