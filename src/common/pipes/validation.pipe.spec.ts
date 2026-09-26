import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { createValidationPipe } from './validation.pipe.js';

/**
 * The pipe is asserted through the decorators it exists to run, rather than by
 * reading its options back: a `ValidationPipe` built with the wrong flags would
 * still report `whitelist: true` only if the cast is right, while what matters is
 * whether a bad body is actually rejected.
 *
 * The DTO below is a stand-in for the real ones the auth endpoints declare, so
 * this stays a unit test of the shared pipe - no controller, no module, no `.env`.
 */
class FixtureDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  phoneNumber!: string;
}

/** The parts of the thrown response these assertions inspect. */
interface ValidationFailure {
  status: number;
  response: { message?: unknown };
}

/**
 * Runs `payload` through the pipe and returns the response it threw.
 *
 * `transform` is asynchronous - a rejection has to be awaited, or it surfaces as
 * an unhandled rejection and the assertion passes for the wrong reason.
 */
async function reject(payload: unknown): Promise<ValidationFailure> {
  const pipe = createValidationPipe();

  try {
    await pipe.transform(payload, { type: 'body', metatype: FixtureDto });
  } catch (caught) {
    return caught as ValidationFailure;
  }

  throw new Error('expected the pipe to reject the payload, but it accepted it');
}

describe('createValidationPipe', () => {
  it('accepts a body that matches the DTO', async () => {
    const pipe = createValidationPipe();
    const transformed = await pipe.transform(
      { phoneNumber: '0241234567' },
      { type: 'body', metatype: FixtureDto },
    );

    expect(transformed).toBeInstanceOf(FixtureDto);
    expect(transformed.phoneNumber).toBe('0241234567');
  });

  it('rejects a missing field with a 400 that names it', async () => {
    const { status, response } = await reject({});

    expect(status).toBe(400);
    expect(JSON.stringify(response.message)).toContain('phoneNumber');
  });

  it('rejects a field of the wrong type', async () => {
    const { status, response } = await reject({ phoneNumber: 241234567 });

    expect(status).toBe(400);
    expect(JSON.stringify(response.message)).toContain('phoneNumber');
  });

  it('rejects a field that breaks its rule (length)', async () => {
    const { status, response } = await reject({ phoneNumber: '0241234567890123456' });

    expect(status).toBe(400);
    expect(JSON.stringify(response.message)).toContain('phoneNumber');
  });

  // The two whitelist flags: an undeclared field is refused, not silently
  // dropped, so a client cannot come to believe `isAdmin` was accepted.
  it('rejects an undeclared property instead of quietly dropping it', async () => {
    const { status, response } = await reject({
      phoneNumber: '0241234567',
      isAdmin: true,
    });

    expect(status).toBe(400);
    expect(JSON.stringify(response.message)).toContain('isAdmin');
  });
});
