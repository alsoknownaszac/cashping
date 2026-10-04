import { Logger, type INestApplication } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

const logger = new Logger('SecurityHeaders');

/**
 * `Strict-Transport-Security` value.
 *
 * 180 days, the figure `helmet` ships and the one a browser will honour. The header is
 * only *obeyed* when it arrives over HTTPS - a browser ignores it on a plain-HTTP response
 * on purpose, so a deployment that terminates TLS at the proxy (Render does) can serve it
 * unconditionally: it does nothing over HTTP in local dev and pins the domain to HTTPS in
 * production. `includeSubDomains` covers subdomains of the host that sent it (an API on
 * `api.example.com` therefore pins `api.example.com` and its children, not `example.com`).
 */
const STRICT_TRANSPORT_SECURITY = 'max-age=15552000; includeSubDomains';

/**
 * A baseline of security headers on every response (Step 34, Section 5 "API hardening").
 *
 * ## Why this exists
 *
 * The API answers JSON, holds a bearer token in the client, and also serves the Swagger UI.
 * Each of those is a reason to set *something* on the response, and none of it is something
 * Nest does for you. This is the deliberate, named answer to the Section 5 item that would
 * otherwise be a gap: the audit asks "which file, which line" for hardening, and this is it.
 *
 * ## Why hand-written rather than `helmet`
 *
 * `helmet`'s defaults include a Content-Security-Policy that this app cannot use: it serves
 * the interactive Swagger UI, whose HTML pulls its own inline scripts and styles, so a
 * strict CSP would break the docs - and for a JSON API a CSP protects nothing anyway. The
 * four headers below are the ones that mean something here, spelled out so each carries its
 * own justification rather than arriving as an opaque default set. This mirrors the choice
 * already made for CORS (`cors.ts`) and for rate limiting: the project would rather own a
 * small, readable control than take a dependency whose defaults it would then have to fight.
 *
 * ## What each header buys
 *
 * - `X-Content-Type-Options: nosniff` - stops a browser inferring a type from the body. A
 *   JSON error body sniffed as HTML is the classic reflected-content trap; `nosniff` makes
 *   the declared `Content-Type` the only thing the browser will act on.
 * - `X-Frame-Options: DENY` - the API is not meant to be framed, and neither is the Swagger
 *   UI. Without this, a page can embed the docs in an iframe and overlay them (clickjacking).
 * - `Referrer-Policy: no-referrer` - this API takes its credential in a header, not a URL,
 *   but a response that ever carried a token-bearing link would leak it through `Referer` to
 *   the next origin. `no-referrer` closes that before it is a question.
 * - `Strict-Transport-Security` - see the constant above; pins the domain to HTTPS once seen
 *   over a secure connection, defeating SSL-stripping downgrades.
 *
 * `X-Powered-By` is removed: Express sets it to `Express` by default, which tells a scanner
 * which framework and therefore which CVE list to try, for no benefit to any client.
 *
 * ## What is deliberately *not* set
 *
 * No `Content-Security-Policy` (it would break the served Swagger UI and protects nothing in
 * a JSON response), and no `Permissions-Policy`/`Cross-Origin-Opener-Policy` (browser-page
 * concerns that a machine-to-machine JSON API never exercises). Recording the omissions is
 * the point: an audit should see they were decisions, not oversights.
 *
 * CORS is *not* handled here - it is `configureCors` in `cors.ts`, because CORS is a
 * browser-side control with its own allow-list, not a static header.
 */
export function configureSecurityHeaders(app: INestApplication): void {
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    response.removeHeader('X-Powered-By');

    next();
  });

  logger.log('Security headers enabled (nosniff, frame-deny, no-referrer, HSTS)');
}
