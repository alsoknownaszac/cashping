/**
 * Version prefix every route is mounted under (`app.setGlobalPrefix` in
 * `main.ts`).
 *
 * Versioning the URL is what lets a breaking change ship as `/v2` while `/v1`
 * keeps answering the clients already in the field.
 *
 * It lives in its own module rather than inline in `main.ts` because three
 * things have to agree on it: the prefix itself, the OpenAPI document (which
 * publishes `/v1/...` paths - see `swagger.ts`), and the tests and healthcheck
 * that call the routes. The interactive docs are deliberately *not* under it;
 * `SWAGGER_PATH` in `swagger.ts` explains why.
 */
export const GLOBAL_PREFIX = 'v1';
