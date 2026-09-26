import { ValidationPipe } from '@nestjs/common';

/**
 * The app-wide `ValidationPipe` (Step 10 needs it: a DTO that "validates a raw
 * phone number input" only validates if a pipe is actually running).
 *
 * Until now nothing was piped: the two endpoints returned fixed shapes, so a
 * request body could not be wrong. Every POST from here on can, and the choice
 * is between a request that fails a `class-validator` rule with a clear reason
 * and a handler that receives `undefined` and fails 500 lines later.
 *
 * The three flags are the whole decision:
 *   - `whitelist` strips properties the DTO does not declare, so an undeclared
 *     field can never reach a service by accident (`{ phoneNumber, isAdmin }`).
 *   - `forbidNonWhitelisted` rejects the request instead of quietly dropping the
 *     extra field. Silently ignoring `isAdmin` teaches the client the field was
 *     accepted; a 400 says the body does not match the documented shape.
 *   - `transform` instantiates the DTO class, which is what makes the decorators
 *     apply at all (and what will coerce future non-string fields).
 *
 * The failure body is left to Nest's default factory on purpose: it produces
 * `{ statusCode: 400, message: [<one per failing field>], error: 'Bad Request' }`,
 * which is exactly the shape `ErrorResponseDto` already documents for the
 * global exception filter (`message` as a string *or* an array of per-field
 * messages). A custom factory here would be a second definition of the same
 * contract. Note the difference from `validation.schema.ts`, which deliberately
 * reports one message per variable: that report is read by an operator fixing a
 * file, while this one is read by a client that should be told everything wrong
 * with its body in one response.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}
