import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from './audit-events.js';

/**
 * The vocabulary, pinned because it is the half of Step 32 the database deliberately does not hold.
 *
 * `schema.prisma` records the argument for `TEXT` over an enum: a `CHECK` constraint would make a
 * new sensitive point a migration, and the first person it blocked would write the row directly.
 * The price of that is paid here - the union is what keeps a typo from becoming a new *kind* of
 * event, and these assertions are what keep the union's two promises: the shape the second index
 * scans, and a list short enough to be read.
 */

describe('the action vocabulary', () => {
  it('names every action `<area>.<event>`, because the index is a prefix scan on it', () => {
    // `audit_log_action_created_at_idx` answers "every custody event last week" by scanning this
    // string's prefix. That only works if the prefix is a stable, lower-case word - so the shape is
    // asserted for every action rather than for the ones a reader happens to look at.
    for (const action of AUDIT_ACTIONS) {
      expect(action, `"${action}" is not <area>.<event>`).toMatch(/^[a-z]+\.[a-z]+(\.[a-z]+)*$/);
    }
  });

  it('has no duplicates, so one event is one name', () => {
    // Two literals for one event would be two rows for one thing happening, and a query for
    // "every sign-in" that silently missed one of them.
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('is the twenty-one actions of Steps 32, 34a, 34b and 34c, and deliberately nothing else', () => {
    // Written out rather than counted, because adding one is a decision about what this table is
    // for, and a decision should have to touch this list - the same reason `AUDIT_ACTIONS` is a
    // union rather than a `string`.
    expect([...AUDIT_ACTIONS]).toEqual([
      'auth.otp.verified',
      'auth.login',
      'auth.pin.set',
      'auth.pin.changed',
      'auth.pin.verified',
      'auth.pin.failed',
      'auth.pin.reset.requested',
      'auth.pin.reset.completed',
      'auth.password.set',
      'auth.password.changed',
      'auth.password.login',
      'auth.password.reset.requested',
      'auth.password.reset.completed',
      'auth.email.set',
      'auth.email.verified',
      'user.handle.set',
      'payment.initiated',
      'payment.completed',
      'payment.failed',
      'custody.key.wrapped',
      'custody.key.unwrapped',
    ]);
  });

  it('answers three outcomes, now that something denies', () => {
    // `failed` means the operation the entry names did not happen. `denied` arrived with its first
    // writer in Step 34a - a step-up guard refusing a payment - and is what keeps "a guess at the
    // PIN that was wrong" and "a payment attempted with no PIN proof at all" from being one row.
    expect([...AUDIT_OUTCOMES]).toEqual(['ok', 'failed', 'denied']);
  });
});
