import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PIN_LENGTH } from '../../config/configuration.js';
import { ChangePinDto } from './change-pin.dto.js';
import { PIN_PATTERN, pinRuleMessage } from './pin-pattern.js';
import { RegisterDto } from './register.dto.js';
import { VerifyPinDto } from './verify-pin.dto.js';

/**
 * The four-digit rule, asserted at the layer that enforces it (Step 34a).
 *
 * It is pinned here rather than only through the endpoints because the rule is the *contract*,
 * and everything downstream depends on it being true before a hash is computed: an invalid PIN
 * is a 400 from the validation pipe, which is what keeps it out of the attempt counter and out
 * of the audit log. `PinService` may assume it is looking at four digits, and this file is the
 * reason it may.
 *
 * Both write paths are checked - registration and a PIN change - because a rule enforced in one
 * DTO and not the other is how "exactly four digits" and "exactly four digits, unless you are
 * registering" end up in the same API.
 */

/** A number that is nobody's, so the phone field never decides the outcome of a test. */
const PHONE = '+233241234567';

const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['three digits', '123'],
  ['five digits', '12345'],
  ['a letter among digits', '12a4'],
  ['letters only', 'abcd'],
  ['the empty string', ''],
  ['a trailing space', '1234 '],
  ['a leading space', ' 1234'],
  ['a decimal point', '12.4'],
  ['a sign', '-123'],
  ['four digits of whitespace-safe unicode', '１２３４'],
];

/**
 * The constraint messages a DTO reports for one property.
 *
 * `plainToInstance` first, because that is exactly what the global validation pipe does before
 * `validate`: the decorators run against an *instance* of the class.
 *
 * The class is a parameter rather than being read off the body, and that is not a style choice -
 * a body literal's `constructor` is `Object`, so `validate` would find no metadata and report
 * nothing, and every one of these tests would pass for the wrong reason.
 */
async function messagesFor(
  target: new () => object,
  body: Record<string, unknown>,
  property: string,
): Promise<string[]> {
  const errors = await validate(plainToInstance(target, body));

  return errors
    .filter((error) => error.property === property)
    .flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('the PIN pattern', () => {
  it('is built from PIN_LENGTH rather than written out, so the policy has one home', () => {
    expect(PIN_PATTERN.source).toBe(`^\\d{${PIN_LENGTH}}$`);
    expect(pinRuleMessage('pin')).toContain(String(PIN_LENGTH));
    expect(pinRuleMessage('currentPin')).toContain('currentPin');
  });
});

describe('RegisterDto', () => {
  it('accepts a four-digit PIN', async () => {
    await expect(
      messagesFor(RegisterDto, { phoneNumber: PHONE, pin: '1234' }, 'pin'),
    ).resolves.toEqual([]);
  });

  for (const [description, pin] of REJECTED) {
    it(`rejects ${description}`, async () => {
      const messages = await messagesFor(RegisterDto, { phoneNumber: PHONE, pin }, 'pin');

      expect(messages).toContain(pinRuleMessage('pin'));
    });
  }

  it('accepts a body with no PIN at all, which is the deferred path (Step 34d)', async () => {
    // `@IsOptional()` is what makes this pass: an account can be registered without a PIN and
    // have one installed later at `POST /auth/pin/change`. The malformed-PIN cases above still
    // fire, because a value that *is* sent is still checked.
    await expect(messagesFor(RegisterDto, { phoneNumber: PHONE }, 'pin')).resolves.toEqual([]);
  });
});

describe('ChangePinDto', () => {
  it('accepts a four-digit PIN with no currentPin, which is the set path', async () => {
    const dto = plainToInstance(ChangePinDto, { pin: '1234' } as ChangePinDto);

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('accepts a four-digit currentPin, which is the change path', async () => {
    const dto = plainToInstance(ChangePinDto, { pin: '1234', currentPin: '4321' } as ChangePinDto);

    await expect(validate(dto)).resolves.toEqual([]);
  });

  for (const [description, pin] of REJECTED) {
    it(`rejects ${description} as the new PIN`, async () => {
      const messages = await messagesFor(ChangePinDto, { pin, currentPin: '4321' }, 'pin');

      expect(messages).toContain(pinRuleMessage('pin'));
    });

    it(`rejects ${description} as the current PIN`, async () => {
      const messages = await messagesFor(ChangePinDto, { pin: '1234', currentPin: pin }, 'currentPin');

      // A malformed `currentPin` is a 400, not a 409: it never reaches the comparison, so it
      // never counts as a wrong guess against the lockout.
      expect(messages).toContain(pinRuleMessage('currentPin'));
    });
  }
});

describe('VerifyPinDto', () => {
  it('accepts a four-digit PIN', async () => {
    await expect(messagesFor(VerifyPinDto, { pin: '1234' }, 'pin')).resolves.toEqual([]);
  });

  for (const [description, pin] of REJECTED) {
    it(`rejects ${description}`, async () => {
      const messages = await messagesFor(VerifyPinDto, { pin }, 'pin');

      expect(messages).toContain(pinRuleMessage('pin'));
    });
  }
});
