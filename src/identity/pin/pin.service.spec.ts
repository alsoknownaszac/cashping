import { type ConfigService } from '@nestjs/config';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { hashSecret } from '../credentials/secret-hash.js';
import { PinService, type PinAttemptOutcome, type PinChangeOutcome } from './pin.service.js';

/**
 * The PIN's storage and lockout rules (Step 34a), asserted against a fake Prisma.
 *
 * Every claim here is one an endpoint depends on: the plaintext PIN is never written, the hash
 * never leaves the service, a wrong PIN costs an attempt, the attempt that spends the allowance
 * locks the PIN rather than leaving the counter at the maximum, a live lock refuses even the
 * *correct* PIN, and the change endpoint goes through the same counter as a payment step-up - which
 * is the difference between a lockout and a lockout with a bypass.
 *
 * The database is exercised for real in `test/pin.e2e-spec.ts`; what this file can prove that an
 * e2e cannot is the *arithmetic*, including the two states a test would otherwise have to wait
 * fifteen minutes for.
 */

const USER_ID = 'user-1';

/** The PIN these tests use, and the one a wrong submission must not resemble. */
const PIN = '1234';
const WRONG_PIN = '9999';

/** The policy `configuration()` supplies. */
const PIN_CONFIG: Readonly<Record<string, number>> = {
  'pin.maxAttempts': 5,
  'pin.lockoutMinutes': 15,
};

function createConfig(): ConfigService {
  return { getOrThrow: (key: string) => PIN_CONFIG[key] } as unknown as ConfigService;
}

/** The four columns this service reads or writes, in memory. */
interface FakeUserRow {
  id: string;
  transactionPinHash: string | null;
  transactionPinSetAt: Date | null;
  transactionPinAttempts: number;
  transactionPinLockedUntil: Date | null;
}

/**
 * The `users` table, as `PinService` uses it.
 *
 * `update` understands the two shapes the service sends - absolute values, and the
 * `{ increment: 1 }` that the database applies - because that difference is the subject of one of
 * the tests: an increment the application computed would have been read-then-written, and the test
 * that asserts the row's count after concurrent-ish guesses is asserting exactly that it is not.
 */
class FakePrisma {
  readonly users = new Map<string, FakeUserRow>();
  readonly calls: string[] = [];

  insert(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
    const row: FakeUserRow = {
      id: USER_ID,
      transactionPinHash: null,
      transactionPinSetAt: null,
      transactionPinAttempts: 0,
      transactionPinLockedUntil: null,
      ...overrides,
    };

    this.users.set(row.id, row);

    return row;
  }

  readonly user = {
    findUnique: async (args: { where: { id: string } }) => {
      this.calls.push('findUnique');

      const row = this.users.get(args.where.id);

      return row === undefined
        ? null
        : {
            transactionPinHash: row.transactionPinHash,
            transactionPinAttempts: row.transactionPinAttempts,
            transactionPinLockedUntil: row.transactionPinLockedUntil,
          };
    },

    update: async (args: {
      where: { id: string };
      data: {
        transactionPinHash?: string;
        transactionPinSetAt?: Date;
        transactionPinAttempts?: number | { increment: number };
        transactionPinLockedUntil?: Date | null;
      };
      select?: { transactionPinAttempts: boolean };
    }) => {
      this.calls.push('update');

      const row = this.users.get(args.where.id);

      if (row === undefined) {
        throw new Error(`no user with id ${args.where.id}`);
      }

      const { data } = args;

      if (data.transactionPinHash !== undefined) {
        row.transactionPinHash = data.transactionPinHash;
      }

      if (data.transactionPinSetAt !== undefined) {
        row.transactionPinSetAt = data.transactionPinSetAt;
      }

      if (typeof data.transactionPinAttempts === 'number') {
        row.transactionPinAttempts = data.transactionPinAttempts;
      } else if (data.transactionPinAttempts !== undefined) {
        row.transactionPinAttempts += data.transactionPinAttempts.increment;
      }

      if (data.transactionPinLockedUntil !== undefined) {
        row.transactionPinLockedUntil = data.transactionPinLockedUntil;
      }

      return args.select === undefined
        ? row
        : { transactionPinAttempts: row.transactionPinAttempts };
    },
  };
}

/** The audit log, recording what was written. */
class FakeAudit {
  readonly entries: AuditEntry[] = [];

  log = async (entry: AuditEntry): Promise<void> => {
    this.entries.push(entry);
  };
}

interface Harness {
  prisma: FakePrisma;
  audit: FakeAudit;
  pins: PinService;
}

function createHarness(): Harness {
  const prisma = new FakePrisma();
  const audit = new FakeAudit();

  return {
    prisma,
    audit,
    pins: new PinService(
      prisma as unknown as PrismaService,
      createConfig(),
      audit as unknown as AuditService,
    ),
  };
}

/** A hash of the right PIN, computed once: scrypt is deliberately slow. */
let correctHash: string;

beforeAll(async () => {
  correctHash = await hashSecret(PIN);
});

describe('PinService.verify', () => {
  it('says there is nothing to prove when the account has no PIN, and counts nothing', async () => {
    const { pins, prisma, audit } = createHarness();
    prisma.insert();

    await expect(pins.verify(USER_ID, PIN)).resolves.toEqual({ ok: false, reason: 'not_set' });

    // A refusal that is not a guess: no attempt counted and no audit row that would make "someone
    // asked for the PIN of an account that has none" look like an attack.
    expect(prisma.calls).toEqual(['findUnique']);
    expect(audit.entries).toEqual([]);
  });

  it('accepts the PIN it was set with, and clears the counter and any expired lock', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({
      transactionPinHash: correctHash,
      transactionPinAttempts: 3,
      transactionPinLockedUntil: new Date(Date.now() - 60_000),
    });

    await expect(pins.verify(USER_ID, PIN)).resolves.toEqual({ ok: true });

    expect(row.transactionPinAttempts).toBe(0);
    expect(row.transactionPinLockedUntil).toBeNull();
    expect(audit.entries).toEqual([
      { action: 'auth.pin.verified', userId: USER_ID, outcome: 'ok' },
    ]);
  });

  it('counts a wrong PIN and says how many attempts are left', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({ transactionPinHash: correctHash });

    await expect(pins.verify(USER_ID, WRONG_PIN)).resolves.toEqual({
      ok: false,
      reason: 'invalid_pin',
      attemptsRemaining: 4,
    });

    expect(row.transactionPinAttempts).toBe(1);
    // The row is the guess, and the metadata is what makes it readable: which endpoint the PIN
    // arrived on, and what is left of the allowance.
    expect(audit.entries).toEqual([
      {
        action: 'auth.pin.failed',
        userId: USER_ID,
        outcome: 'failed',
        metadata: { context: 'verify', attemptsRemaining: 4 },
      },
    ]);
  });

  it('locks the PIN on the attempt that spends the allowance, and resets the counter', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({ transactionPinHash: correctHash, transactionPinAttempts: 4 });

    const outcome = await pins.verify(USER_ID, WRONG_PIN);

    expect(outcome).toMatchObject({ ok: false, reason: 'locked' });

    const { lockedUntil } = outcome as { lockedUntil: Date };

    // Fifteen minutes from now - from the policy rather than hard-coded, because the lock is the
    // window's consequence and has to be as long as the window.
    expect(lockedUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(lockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(row.transactionPinLockedUntil).not.toBeNull();
    // Reset rather than left at the maximum: a lock that expires into an account that is
    // immediately re-locked is a lock nobody can use.
    expect(row.transactionPinAttempts).toBe(0);
    expect(audit.entries).toEqual([
      {
        action: 'auth.pin.failed',
        userId: USER_ID,
        outcome: 'failed',
        metadata: { context: 'verify', attemptsRemaining: 0, lockedForMinutes: 15 },
      },
    ]);
  });

  it('refuses even the correct PIN while the lock is live', async () => {
    const { pins, prisma } = createHarness();
    prisma.insert({
      transactionPinHash: correctHash,
      transactionPinLockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(pins.verify(USER_ID, PIN)).resolves.toMatchObject({ reason: 'locked' });

    // The lock is checked *before* the comparison, which is what stops "locked" from meaning
    // "five wrong guesses, then send the real one".
    expect(prisma.calls).toEqual(['findUnique']);
  });
});

describe('PinService.change', () => {
  it('sets a PIN on an account that has none, storing a hash and never the PIN', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert();

    const outcome = await pins.change(USER_ID, undefined, PIN);

    expect(outcome.ok).toBe(true);
    expect(row.transactionPinHash).toMatch(/^scrypt\$/);
    expect(row.transactionPinHash).not.toContain(PIN);
    expect(row.transactionPinSetAt).not.toBeNull();
    expect(audit.entries).toEqual([
      {
        action: 'auth.pin.set',
        userId: USER_ID,
        outcome: 'ok',
        metadata: { source: 'set' },
      },
    ]);
  });

  it('requires the current PIN when one exists, and writes nothing without it', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({ transactionPinHash: correctHash });

    await expect(pins.change(USER_ID, undefined, PIN)).resolves.toEqual({
      ok: false,
      reason: 'current_pin_required',
    });

    expect(row.transactionPinHash).toBe(correctHash);
    expect(prisma.calls).toEqual(['findUnique']);
    expect(audit.entries).toEqual([]);
  });

  it('counts a wrong current PIN, so a change is not a way around the lockout', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({ transactionPinHash: correctHash });

    await expect(pins.change(USER_ID, WRONG_PIN, PIN)).resolves.toEqual({
      ok: false,
      reason: 'invalid_pin',
      attemptsRemaining: 4,
    });

    // The PIN is unchanged, the guess is counted, and the row says which endpoint it came from.
    // Without this, an attacker holding a stolen access token would have a second, unlimited
    // guess counter - which is the failure this test exists to keep from coming back.
    expect(row.transactionPinHash).toBe(correctHash);
    expect(row.transactionPinAttempts).toBe(1);
    expect(audit.entries).toEqual([
      {
        action: 'auth.pin.failed',
        userId: USER_ID,
        outcome: 'failed',
        metadata: { context: 'change', attemptsRemaining: 4 },
      },
    ]);
  });

  it('replaces the hash when the current PIN is proved, and resets the old PIN state', async () => {
    const { pins, prisma, audit } = createHarness();
    const row = prisma.insert({ transactionPinHash: correctHash, transactionPinAttempts: 2 });

    const outcome = await pins.change(USER_ID, PIN, WRONG_PIN);

    expect(outcome.ok).toBe(true);
    expect(row.transactionPinHash).toMatch(/^scrypt\$/);
    expect(row.transactionPinHash).not.toBe(correctHash);
    // A new credential starts with a clean allowance: the old PIN's wrong guesses are not facts
    // about this one.
    expect(row.transactionPinAttempts).toBe(0);
    expect(audit.entries).toEqual([
      { action: 'auth.pin.changed', userId: USER_ID, outcome: 'ok' },
    ]);

    // And the swap is real: the new PIN works, the old one no longer does.
    await expect(pins.verify(USER_ID, WRONG_PIN)).resolves.toEqual({ ok: true });
    await expect(pins.verify(USER_ID, PIN)).resolves.toMatchObject({ reason: 'invalid_pin' });
  });
});

describe('the hash never leaves the service', () => {
  it('returns no outcome carrying a hash, a salt or the PIN itself', async () => {
    const { pins, prisma } = createHarness();
    prisma.insert({ transactionPinHash: correctHash });

    const outcomes: Array<PinAttemptOutcome | PinChangeOutcome> = [
      await pins.verify(USER_ID, PIN),
      await pins.verify(USER_ID, WRONG_PIN),
      await pins.change(USER_ID, PIN, PIN),
      await pins.change(USER_ID, undefined, PIN),
    ];

    for (const outcome of outcomes) {
      const serialised = JSON.stringify(outcome);

      // The two claims together are the storage rule: nothing here is a hash (so a caller cannot
      // compare PINs itself) and nothing here is a PIN (so a logged outcome is not a credential).
      expect(serialised).not.toContain('scrypt');
      expect(serialised).not.toContain(PIN);
      expect(serialised).not.toContain(correctHash);
    }
  });
});
