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
import { STEP_UP_TOKEN_HEADER } from './../src/identity/pin/step-up-token.js';

/** The path the frontend calls for liveness, prefixed exactly as `main.ts` does. */
const HEALTH_PATH = `/${GLOBAL_PREFIX}/health`;

/**
 * The documented paths that carry `JwtAuthGuard`, and therefore answer 401 to the
 * tokenless request this file makes. Named rather than inferred: the point of the
 * loop below is that a path is routed and behaves like its siblings, and a guarded
 * GET answering 200 would mean the guard stopped being applied.
 *
 * Every guarded GET in the app belongs here, and the wallet pair is the reason this list
 * is spelled out rather than derived: Step 20 added them without touching this file, so
 * the loop below read 401 where it expected 200 and the whole suite failed for a reason
 * that had nothing to do with the docs. Adding a guarded GET now means adding it here -
 * which is a one-line edit and exactly the kind of thing a failing test should ask for.
 */
const PROTECTED_GET_PATHS = new Set([
  `/${GLOBAL_PREFIX}/auth/session`,
  // Step 30's history pair, added here the way the comment above asks for. Both read the caller's
  // own payments (`JwtAuthGuard`), so both answer 401 to the tokenless request below - and
  // `payments/{id}` is again Swagger's placeholder, whose 401 proves the guard ran before the
  // router's `ParseUUIDPipe`.
  `/${GLOBAL_PREFIX}/payments`,
  `/${GLOBAL_PREFIX}/payments/{id}`,
  `/${GLOBAL_PREFIX}/recipients/search`,
  // The documented path, with Swagger's own `{id}` placeholder rather than a UUID: the guard
  // runs before the router's `ParseUUIDPipe`, so this answers 401. A 400 here would mean the
  // pipe was reached first, i.e. that the route is unguarded - the failure this set exists to
  // turn red.
  `/${GLOBAL_PREFIX}/recipients/{id}`,
  `/${GLOBAL_PREFIX}/wallet/account`,
  `/${GLOBAL_PREFIX}/wallet/balance`,
]);

/**
 * The documented POSTs that carry `JwtAuthGuard`, and therefore answer 401 rather than the 400 an
 * unguarded POST answers to the empty body this file sends.
 *
 * Same idea as the GET set above, with one consequence worth writing down: a guarded POST never
 * reaches the validation pipe without a token, so "the body is refused" cannot be shown from a
 * tokenless request. It is shown where it can be - `test/payments.e2e-spec.ts` sends a signed
 * request carrying an undeclared field and asserts the 400 - and what this file keeps proving is
 * the part it can: the route exists, and the guard is attached to it.
 */
const PROTECTED_POST_PATHS = new Set([
  `/${GLOBAL_PREFIX}/auth/pin/change`,
  `/${GLOBAL_PREFIX}/auth/pin/verify`,
  // Step 34b and 34c's guarded POSTs, added here the way the GET set above asks for. Every one of
  // them writes a credential or a contact detail *on the caller's account*, so every one of them
  // needs the caller: without a token each answers 401, and the empty body this file sends never
  // reaches the validation pipe. The three that are deliberately *not* here are the other half of
  // the same statement - `login/password` and the reset pair answer 400, because needing no session
  // is the point of them.
  `/${GLOBAL_PREFIX}/auth/password/change`,
  `/${GLOBAL_PREFIX}/auth/email`,
  `/${GLOBAL_PREFIX}/auth/email/verify`,
  `/${GLOBAL_PREFIX}/payments`,
]);

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
      `/${GLOBAL_PREFIX}/auth/email`,
      `/${GLOBAL_PREFIX}/auth/email/verify`,
      `/${GLOBAL_PREFIX}/auth/login`,
      `/${GLOBAL_PREFIX}/auth/login/otp`,
      `/${GLOBAL_PREFIX}/auth/login/password`,
      `/${GLOBAL_PREFIX}/auth/logout`,
      `/${GLOBAL_PREFIX}/auth/otp/verify`,
      `/${GLOBAL_PREFIX}/auth/password/change`,
      `/${GLOBAL_PREFIX}/auth/password/reset`,
      `/${GLOBAL_PREFIX}/auth/password/reset/confirm`,
      `/${GLOBAL_PREFIX}/auth/pin/change`,
      `/${GLOBAL_PREFIX}/auth/pin/verify`,
      `/${GLOBAL_PREFIX}/auth/refresh`,
      `/${GLOBAL_PREFIX}/auth/register`,
      `/${GLOBAL_PREFIX}/auth/session`,
      HEALTH_PATH,
      `/${GLOBAL_PREFIX}/payments`,
      `/${GLOBAL_PREFIX}/payments/{id}`,
      `/${GLOBAL_PREFIX}/recipients/search`,
      `/${GLOBAL_PREFIX}/recipients/{id}`,
      `/${GLOBAL_PREFIX}/wallet/account`,
      `/${GLOBAL_PREFIX}/wallet/balance`,
    ]);
  });

  it('documents the step-up credential that POST /v1/payments demands (Step 34a)', async () => {
    const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

    const documented = response.body.paths as Record<string, Record<string, unknown>>;
    const post = documented[`/${GLOBAL_PREFIX}/payments`]?.post as
      | { parameters?: { name?: string; in?: string; required?: boolean }[] }
      | undefined;

    const stepUp = (post?.parameters ?? []).find(
      (parameter) => parameter.in === 'header' && parameter.name === STEP_UP_TOKEN_HEADER,
    );

    // A header the route requires and the document does not mention is half a contract, and the
    // missing half is the one that answers 403. `required: true` is the other half of the same
    // point: it is what makes the docs UI send the header at all.
    expect(
      stepUp,
      `POST /${GLOBAL_PREFIX}/payments does not document ${STEP_UP_TOKEN_HEADER}`,
    ).toMatchObject({ required: true });
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
          // Every guarded GET answers 401 to this tokenless request (`PROTECTED_GET_PATHS`),
          // which is still proof it is routed and that the guard is attached to it - the two
          // things this loop checks for. An unguarded GET is the 200 branch.
          expect(response.status, `${where} should answer`).toBe(
            PROTECTED_GET_PATHS.has(path) ? 401 : 200,
          );
        } else {
          // Routed, and either the body is refused (what the global validation pipe is for, and
          // proof it is wired into this app rather than only into `main.ts`) or the guard answers
          // first because this route is protected.
          expect(response.status, `${where} should answer`).toBe(
            PROTECTED_POST_PATHS.has(path) ? 401 : 400,
          );
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
