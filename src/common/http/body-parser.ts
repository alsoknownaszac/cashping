import { Logger } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';

const logger = new Logger('BodyParser');

/**
 * Installs the JSON body parser with an explicit size limit, and nothing else.
 *
 * ## Why this is a function and not two lines inline in `main.ts`
 *
 * Three things have to agree on the ceiling: `main.ts` (which applies it to the running API),
 * the e2e suite (which boots the app itself, so a limit set *only* in `main.ts` would not be
 * exercised by any test), and the reader trying to find where the limit is defined. Spelling the
 * wiring out once means all three point at this file, exactly as `configureCors` and
 * `configureSecurityHeaders` already do for their own controls.
 *
 * ## Why `bodyParser: false` at creation is a precondition
 *
 * Unless the app is created with `{ bodyParser: false }`, Nest registers `express.json()` *and*
 * `express.urlencoded()` for you, at their own defaults (a silent `100kb`). A parser added
 * afterwards runs *second*: leaving the defaults on and calling
 * `useBodyParser('json', { limit })` here would install a second JSON parser behind a first one
 * that still accepts 100 KB - the limit would look applied and never bind. Express runs parsers
 * in registration order, so both callers (`main.ts` and `test/body-limit.e2e-spec.ts`) create the
 * app with `bodyParser: false` and let this function install the only JSON parser there is.
 *
 * ## What is deliberately *not* registered
 *
 * No `urlencoded`, `text` or `raw` parser. Every endpoint here takes `application/json` (the
 * DTOs under `src/identity/dto` and `src/payments/dto`; every other route is a GET), so the
 * urlencoded parser is pure attack surface - a second, differently-parsed way to reach the same
 * handlers. Leaving it off is the tightening, not a side effect of the change.
 *
 * @param jsonLimit A `body-parser` size - a unit-suffixed string (`16kb`, `1mb`) or a byte count
 *   as a number/string. Comes from `http.jsonBodyLimit`, which `BODY_LIMIT_JSON` backs, and is
 *   validated at boot (`src/config/validation.schema.ts`).
 */
export function configureBodyParser(app: NestExpressApplication, jsonLimit: string): void {
  app.useBodyParser('json', { limit: jsonLimit });

  logger.log(
    `JSON body parser enabled with a ${jsonLimit} limit; urlencoded/text/raw parsers are not registered`,
  );
}
