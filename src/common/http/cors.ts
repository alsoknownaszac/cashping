import { Logger, type INestApplication } from '@nestjs/common';

const logger = new Logger('CORS');

/**
 * Allows the frontend dev servers (and, once deployed, the frontend origin) to
 * call this API from a browser.
 *
 * The allowed origins are an explicit list, never `'*'`: a wildcard would let any
 * page a signed-in user happens to visit call this API with their token.
 *
 * Worth knowing when auditing this: a request from an origin that is *not* on the
 * list is still routed and answered normally - the middleware just omits the
 * `Access-Control-Allow-Origin` header, and it is the browser that then refuses to
 * hand the response to the calling script. CORS is a browser-side control, not an
 * authorisation one; it is not a substitute for auth on an endpoint.
 *
 * A request with no `Origin` header at all (curl, the compose healthcheck,
 * server-to-server calls) is not a CORS request and is passed through untouched -
 * which is why this can be enabled without disturbing the container healthcheck.
 */
export function configureCors(app: INestApplication, allowedOrigins: string[]): void {
  app.enableCors({
    origin: allowedOrigins,
    // `allowedHeaders` is left unset on purpose: the middleware then reflects the
    // browser's `Access-Control-Request-Headers`, so a request that starts sending
    // `Authorization` (when auth lands) or any other header needs no change here.
  });

  logger.log(
    allowedOrigins.length > 0
      ? `CORS enabled for ${allowedOrigins.join(', ')}`
      : 'CORS enabled with an empty allow-list - every browser request will be blocked',
  );
}
