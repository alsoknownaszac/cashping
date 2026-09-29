import { Logger, applyDecorators, type INestApplication } from '@nestjs/common';
import { ApiResponse, DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

const logger = new Logger('Swagger');

/**
 * Path the interactive docs are served from (relative to the host, so
 * `http://localhost:<PORT>/api/docs` locally).
 *
 * Deliberately *outside* the global prefix: this URL is a bookmark in the
 * frontend engineer's browser, so moving the API to `/v1` must not move it. The
 * documented paths still carry the prefix, which is the part a client needs.
 */
export const SWAGGER_PATH = 'api/docs';

/**
 * `info.version` of the generated document, kept in step with `package.json` by
 * hand - there is no build step that copies one into the other, and the OpenAPI
 * spec requires this field to be present.
 */
const API_VERSION = '0.0.1';

/**
 * Builds the OpenAPI document from the controllers actually registered on `app`,
 * so a controller added later shows up in the docs without touching this file.
 *
 * The document is a description of the running app, not a second definition of
 * it: shapes come from the decorators on the controllers and their DTOs.
 *
 * Every path carries the global prefix (`/v1/health`), because `SwaggerModule`
 * reads it off the app by default. That is the URL a client has to call, so this
 * must run *after* `app.setGlobalPrefix(...)` or the document would advertise
 * routes that 404.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Cashping API')
    .setDescription(
      [
        'HTTP API for the Cashping frontend.',
        '',
        'Errors from every endpoint share one shape (`ErrorResponseDto`): the global',
        'exception filter answers a 4xx with the real reason and a 5xx with a generic',
        'message, reporting the detail to Sentry instead of to the caller.',
      ].join('\n'),
    )
    .setVersion(API_VERSION)
    .addTag('app', 'Service root - the page a human opens to see that the API is up.')
    .addTag(
      'health',
      'Liveness for the frontend health banner, the container healthcheck and future load balancers.',
    )
    .addTag(
      'auth',
      [
        'Phone identity - no passwords.',
        'Register: POST /auth/register, then POST /auth/otp/verify.',
        'Sign in: POST /auth/login/otp for a code, then POST /auth/login for a token pair; POST /auth/refresh renews the access token and GET /auth/session returns the signed-in user.',
      ].join('\n'),
    )
    .addTag(
      'wallet',
      [
        "The signed-in user's Stellar account (Step 20).",
        'GET /wallet/account is the wallet itself - the address it is paid at, the network, and whether the ledger knows it yet. GET /wallet/balance is its USDC line, read from Horizon on every call rather than cached.',
      ].join('\n'),
    )
    .addTag(
      'recipients',
      [
        'Who a payment can be sent to (Steps 21-22).',
        'GET /recipients/search turns a phone number or a handle into an account id, and GET /recipients/:id confirms that the id is the right person. Neither returns a phone number, and the search is rate-limited per caller.',
      ].join('\n'),
    )
    /**
     * The `Authorization: Bearer <token>` scheme, so the routes that need it show a
     * padlock and a "Try it out" that can actually be used (Step 16). `@ApiBearerAuth()`
     * has to name the same security scheme, and it does: both default to `bearer`.
     */
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: [
        'Access token from POST /auth/login or POST /auth/refresh.',
        'Send it as `Authorization: Bearer <token>`.',
        'It is a JWT that expires after 15 minutes - refresh it rather than sending the user back to the code screen.',
      ].join(' '),
    })
    .build();

  return SwaggerModule.createDocument(app, config);
}

/**
 * Documents the shared error shape for a list of statuses on one endpoint.
 *
 * Written as `@ApiErrorResponses([{ status: 409, description: '...' }])`, this
 * expands to one `@ApiResponse` per entry - worth the helper because every
 * endpoint in this API fails in the same body shape, and repeating
 * `type: ErrorResponseDto` on each status is where a controller eventually
 * documents a different shape by accident.
 *
 * `status` is a plain number rather than `HttpStatus`: the decorator is about the
 * document, and the numeric literal next to the description reads the same as the
 * spec the frontend is handed.
 */
export function ApiErrorResponses(
  responses: ReadonlyArray<{ status: number; description: string }>,
): MethodDecorator {
  return applyDecorators(
    ...responses.map(({ status, description }) =>
      ApiResponse({ status, type: ErrorResponseDto, description }),
    ),
  );
}

/**
 * Serves the docs at `/api/docs` (Swagger UI) and the document itself at
 * `/api/docs-json`, when `enabled` is true.
 *
 * `SwaggerModule.setup` has a `useGlobalPrefix` option and it is left off on
 * purpose, which is worth spelling out: it moves the UI itself under the prefix
 * (`/v1/api/docs`), so the hand-off URL would change every time the API version
 * did. The prefix that matters - the one inside the documented paths - is applied
 * while the document is built (see `createOpenApiDocument`), so leaving the
 * option off gives prefixed paths *and* a stable docs URL. Passing it would
 * satisfy neither half.
 *
 * Returns whether the docs were mounted, so the caller can log without repeating
 * the decision.
 */
export function setupSwagger(app: INestApplication, enabled: boolean): boolean {
  if (!enabled) {
    logger.warn(`Swagger UI disabled (ENABLE_SWAGGER=false) - /${SWAGGER_PATH} is not mounted`);
    return false;
  }

  SwaggerModule.setup(SWAGGER_PATH, app, createOpenApiDocument(app));
  logger.log(`Swagger UI mounted at /${SWAGGER_PATH} (document: /${SWAGGER_PATH}-json)`);

  return true;
}
