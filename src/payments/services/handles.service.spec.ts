import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { type PrismaService } from '../../prisma/prisma.service.js';
import {
  RecipientLookupRateLimitExceededError,
  RecipientLookupRateLimitUnavailableError,
  type RecipientLookupRateLimiter,
} from './recipient-lookup-rate-limiter.service.js';
import { HandlesService } from './handles.service.js';

/**
 * The availability check's decisions, against a fake Prisma and a fake allowance: the rules come
 * from `handle.ts` (pinned by `handle.spec.ts`) and the allowance's *policy* is pinned by
 * `recipient-lookup-rate-limiter.service.spec.ts`, so what this file witnesses is what is left -
 * the order (shape, then the counter, then the query), the mapping of each refusal onto a status,
 * and the one answer that needs the caller: their own handle is available to them.
 */

const CALLER = '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41';
const OTHER = '1b7e5a02-8c46-4d1e-8f0b-2c7a9d3e5f60';

interface HarnessOptions {
  /** The accounts that hold a handle, as `handle -> user id`. Anything absent is free. */
  holders?: Readonly<Record<string, string>>;
  /** When set, the allowance throws this instead of counting. */
  limitError?: Error;
}

/**
 * A harness that records *one* ordered log of what happened, rather than two lists to compare
 * afterwards: the class docstring claims shape is checked before the counter and the counter
 * before the query, and only a single sequence can hold that claim to account.
 */
function createHarness(options: HarnessOptions = {}) {
  const holders = options.holders ?? {};
  const events: string[] = [];

  const prisma = {
    user: {
      findUnique: async (args: { where: { handle: string } }) => {
        events.push(`lookup:${args.where.handle}`);

        const holder = holders[args.where.handle];

        return holder === undefined ? null : { id: holder };
      },
    },
  } as unknown as PrismaService;

  const rateLimiter = {
    consume: async (callerId: string) => {
      events.push(`consume:${callerId}`);

      if (options.limitError !== undefined) {
        throw options.limitError;
      }
    },
  } as unknown as RecipientLookupRateLimiter;

  return { service: new HandlesService(prisma, rateLimiter), events };
}

/** Runs the operation, expecting it to refuse, and reports the status and message it refused with. */
async function captureHttpError(
  operation: () => Promise<unknown>,
): Promise<{ status: number; message: string }> {
  try {
    await operation();
  } catch (caught) {
    if (!(caught instanceof HttpException)) {
      throw caught;
    }

    const response = caught.getResponse();

    return {
      status: caught.getStatus(),
      message:
        typeof response === 'string'
          ? response
          : String((response as { message?: string }).message ?? ''),
    };
  }

  throw new Error('expected the operation to refuse, but it resolved');
}

describe('HandlesService.checkAvailability', () => {
  it('answers true for a free handle, echoing the canonical form it checked', async () => {
    const { service, events } = createHarness();

    await expect(service.checkAvailability(CALLER, { handle: '@Miriam' })).resolves.toEqual({
      handle: 'miriam',
      available: true,
    });

    // The `@` is stripped and the case lowered before the query, so the column's unique index is
    // the case-insensitive match - the same canonicalisation registration stores.
    expect(events).toEqual([`consume:${CALLER}`, 'lookup:miriam']);
  });

  it('answers false when another account holds the handle', async () => {
    const { service } = createHarness({ holders: { taken: OTHER } });

    await expect(service.checkAvailability(CALLER, { handle: 'taken' })).resolves.toEqual({
      handle: 'taken',
      available: false,
    });
  });

  it('answers true for the handle the caller already holds', async () => {
    const { service } = createHarness({ holders: { ama_1: CALLER } });

    // A re-submitted name is not a conflict in `AuthService.resolveHandle`, and it is not one
    // here: the question is "could *I* claim this", and the answer for one's own handle is yes.
    await expect(service.checkAvailability(CALLER, { handle: 'ama_1' })).resolves.toEqual({
      handle: 'ama_1',
      available: true,
    });
  });

  it('refuses a handle that breaks a rule with a 400, before spending a lookup', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['ab', 'needs at least 3 characters'],
      ['@has-dash', 'letters, digits and underscores'],
      ['support', 'reserved'],
      // Over HTTP the DTO's 20-character ceiling refuses this first; the service still holds the
      // rule, because the rule is `handle.ts`'s and not the DTO's to own.
      ['a'.repeat(21), 'can be at most 20 characters'],
    ];

    for (const [input, expected] of cases) {
      const { service, events } = createHarness();

      const { status, message } = await captureHttpError(() =>
        service.checkAvailability(CALLER, { handle: input }),
      );

      expect(status, input).toBe(400);
      expect(message, input).toContain(expected);
      // Shape is free: a handle that can never be valid is refused before the counter is touched
      // or the database is asked, so it cannot be used to price - or to probe - anything.
      expect(events, input).toEqual([]);
    }
  });

  it('answers 429 with the wait when the allowance is spent, without asking the database', async () => {
    const { service, events } = createHarness({
      limitError: new RecipientLookupRateLimitExceededError(42),
    });

    const { status, message } = await captureHttpError(() =>
      service.checkAvailability(CALLER, { handle: 'miriam' }),
    );

    expect(status).toBe(429);
    expect(message).toContain('42 seconds');
    // Counted before the query, so a sweep is priced even where the name is free - the same
    // ordering `/recipients/search` uses, and for the same reason.
    expect(events).toEqual([`consume:${CALLER}`]);
  });

  it('answers 503 without asking the database when the allowance cannot be evaluated', async () => {
    const { service, events } = createHarness({
      limitError: new RecipientLookupRateLimitUnavailableError(),
    });

    const { status } = await captureHttpError(() =>
      service.checkAvailability(CALLER, { handle: 'miriam' }),
    );

    // Fail closed: a counter that cannot be read is not one that has been spent, so the check is
    // refused rather than run uncounted - the same distinction the directory draws.
    expect(status).toBe(503);
    expect(events).toEqual([`consume:${CALLER}`]);
  });

  it('reads one second as singular in the 429 message', async () => {
    const { service } = createHarness({
      limitError: new RecipientLookupRateLimitExceededError(1),
    });

    const { message } = await captureHttpError(() =>
      service.checkAvailability(CALLER, { handle: 'miriam' }),
    );

    expect(message).toContain('1 second.');
  });

});

