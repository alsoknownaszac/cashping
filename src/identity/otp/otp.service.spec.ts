import { type ConfigService } from '@nestjs/config';
import { beforeAll, describe, expect, it } from 'vitest';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { hashSecret } from '../credentials/secret-hash.js';
import { OtpService } from './otp.service.js';

/**
 * The storage rules of Step 12, asserted against a fake Prisma: the plaintext code
 * is never persisted, a resend replaces the previous code instead of adding a
 * second one, and a code is single-use, expiring and attempt-bounded.
 *
 * The fake records the calls it received, so the tests can assert the *ordering*
 * the service promises (invalidate before create, one transaction) rather than
 * only the end state.
 */

const USER_ID = 'user-1';

/** The OTP policy `configuration()` supplies. */
const OTP_CONFIG: Readonly<Record<string, number>> = {
  'otp.codeLength': 6,
  'otp.ttlMinutes': 10,
  'otp.maxAttempts': 5,
};

function createConfig(): ConfigService {
  return { getOrThrow: (key: string) => OTP_CONFIG[key] } as unknown as ConfigService;
}

interface FakeOtpRow {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

/**
 * The `otpVerification` table, in memory.
 *
 * `where` is matched field-by-field rather than per call site, which is what lets
 * one implementation serve `findFirst`, `update` and `updateMany`: a test that
 * changes the filter the service uses would start failing rather than silently
 * matching everything.
 */
class FakePrisma {
  readonly rows: FakeOtpRow[] = [];

  /** Every call, in order, so ordering promises can be asserted. */
  readonly calls: string[] = [];

  transactionCount = 0;

  private nextId = 1;

  readonly tx = {
    otpVerification: {
      create: async (args: { data: { userId: string; codeHash: string; expiresAt: Date } }) => {
        this.calls.push('tx.create');
        return this.insert(args.data);
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<FakeOtpRow> }) => {
        this.calls.push('tx.updateMany');
        return { count: this.patch(args.where, args.data) };
      },
    },
  };

  readonly otpVerification = {
    findFirst: async (args: {
      where: Record<string, unknown>;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }): Promise<FakeOtpRow | null> => {
      this.calls.push('findFirst');

      const direction = args.orderBy?.createdAt === 'desc' ? -1 : 1;
      const matched = this.rows
        .filter((row) => this.matches(row, args.where))
        .sort((a, b) => direction * (a.createdAt.getTime() - b.createdAt.getTime()));

      return matched[0] ?? null;
    },
    update: async (args: { where: { id: string }; data: Partial<FakeOtpRow> }) => {
      this.calls.push('update');

      const row = this.rows.find((candidate) => candidate.id === args.where.id);

      if (row === undefined) {
        throw new Error(`no OTP row with id ${args.where.id}`);
      }

      Object.assign(row, args.data);

      return row;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Partial<FakeOtpRow> }) => {
      this.calls.push('updateMany');

      return { count: this.patch(args.where, args.data) };
    },
  };

  async $transaction<T>(work: (tx: FakePrisma['tx']) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.calls.push('begin');

    const result = await work(this.tx);

    this.calls.push('commit');

    return result;
  }

  /** The codes that are still usable for `userId`. */
  liveRows(userId = USER_ID): FakeOtpRow[] {
    return this.rows.filter((row) => row.userId === userId && row.consumedAt === null);
  }

  private insert(data: { userId: string; codeHash: string; expiresAt: Date }): FakeOtpRow {
    const row: FakeOtpRow = {
      id: `otp-${this.nextId++}`,
      userId: data.userId,
      codeHash: data.codeHash,
      expiresAt: data.expiresAt,
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    };

    this.rows.push(row);

    return row;
  }

  private patch(where: Record<string, unknown>, data: Partial<FakeOtpRow>): number {
    const matched = this.rows.filter((row) => this.matches(row, where));

    for (const row of matched) {
      Object.assign(row, data);
    }

    return matched.length;
  }

  private matches(row: FakeOtpRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(
      ([field, value]) => (row as unknown as Record<string, unknown>)[field] === value,
    );
  }
}

function createService(prisma: FakePrisma): OtpService {
  return new OtpService(prisma as unknown as PrismaService, createConfig());
}

/** Adds a row directly, standing in for code issued in an earlier request. */
function seedRow(prisma: FakePrisma, overrides: Partial<FakeOtpRow> = {}): FakeOtpRow {
  const row: FakeOtpRow = {
    id: `seed-${prisma.rows.length + 1}`,
    userId: USER_ID,
    codeHash: 'scrypt$16384$8$1$aabb$aabb',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };

  prisma.rows.push(row);

  return row;
}

describe('OtpService.issue', () => {
  it('returns a numeric code of the configured length, expiring `ttlMinutes` from now', async () => {
    const prisma = new FakePrisma();
    const before = Date.now();

    const { code, expiresAt } = await createService(prisma).issue(USER_ID);

    expect(code).toMatch(/^\d{6}$/);

    const ttlMs = expiresAt.getTime() - before;

    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000 + 1_000);
  });

  it('stores only a hash, so a database dump holds no usable codes', async () => {
    const prisma = new FakePrisma();

    const { code } = await createService(prisma).issue(USER_ID);
    const [row] = prisma.rows;

    expect(row?.codeHash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    // Asserted by equality rather than by substring: a six-digit code can turn up
    // inside a hex digest by coincidence, and "the test is flaky" is not a finding.
    expect(Object.values(row ?? {})).not.toContain(code);
    expect(JSON.stringify(prisma.rows)).not.toContain(`"${code}"`);
  });

  it('leaves the attempt counter to the column default', async () => {
    const prisma = new FakePrisma();

    await createService(prisma).issue(USER_ID);

    expect(prisma.rows[0]?.attempts).toBe(0);
  });

  it('invalidates then creates, in one transaction, so two live codes cannot exist', async () => {
    const prisma = new FakePrisma();

    await createService(prisma).issue(USER_ID);

    // One transaction per send, and the invalidation strictly before the insert:
    // reversed, the new code would be immediately spent.
    expect(prisma.transactionCount).toBe(1);
    expect(prisma.calls).toEqual(['begin', 'tx.updateMany', 'tx.create', 'commit']);
  });

  it('replaces the previous code when the user asks for a resend', async () => {
    const prisma = new FakePrisma();
    const service = createService(prisma);

    const first = await service.issue(USER_ID);
    const second = await service.issue(USER_ID);

    // Two rows, one of them live: the old code is spent rather than deleted, so
    // "was a code ever sent" survives for support.
    expect(prisma.rows).toHaveLength(2);
    expect(prisma.liveRows()).toHaveLength(1);
    expect(prisma.rows[0]?.consumedAt).not.toBeNull();
    expect(prisma.rows[0]?.codeHash).not.toBe(prisma.rows[1]?.codeHash);
    // A one-in-a-million collision would make the next assertion vacuous, so it is
    // asserted rather than assumed.
    expect(first.code).not.toBe(second.code);

    // Only the newest code is accepted...
    await expect(service.check(USER_ID, second.code)).resolves.toEqual({
      ok: true,
      otpId: prisma.rows[1]?.id,
    });

    // ...and the code it replaced is refused. There is one live row per user, so
    // the stale code is compared against the *new* hash and counts as a wrong
    // attempt (`invalid_code`) rather than being looked up on its own.
    await expect(service.check(USER_ID, first.code)).resolves.toEqual({
      ok: false,
      reason: 'invalid_code',
      attemptsRemaining: 4,
    });
  });
});

describe('OtpService.check', () => {
  const CODE = '123456';
  let correctHash: string;

  beforeAll(async () => {
    correctHash = await hashSecret(CODE);
  });

  it('reports no live code without writing anything', async () => {
    const prisma = new FakePrisma();
    const service = createService(prisma);

    await expect(service.check(USER_ID, CODE)).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(prisma.calls).toEqual(['findFirst']);
  });

  it('accepts the right code and leaves consuming it to the caller', async () => {
    const prisma = new FakePrisma();
    const row = seedRow(prisma, { codeHash: correctHash });

    const outcome = await createService(prisma).check(USER_ID, CODE);

    expect(outcome).toEqual({ ok: true, otpId: row.id });
    // The row is deliberately still live here: `AuthService.verifyOtp` consumes it
    // in the same transaction that activates the user, so a crash cannot leave a
    // spent code next to an unverified phone.
    expect(row.consumedAt).toBeNull();
    expect(prisma.calls).toEqual(['findFirst']);
  });

  it('reports an expired code as expired, consuming it without counting an attempt', async () => {
    const prisma = new FakePrisma();
    const row = seedRow(prisma, { expiresAt: new Date(Date.now() - 1_000) });

    await expect(createService(prisma).check(USER_ID, CODE)).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });

    expect(row.consumedAt).not.toBeNull();
    // Expiry is not the user's mistake: counting it would spend part of an
    // allowance on a window that had already closed.
    expect(row.attempts).toBe(0);
  });

  it('cannot retry a code it has already declared dead', async () => {
    const prisma = new FakePrisma();
    seedRow(prisma, { expiresAt: new Date(Date.now() - 1_000) });
    const service = createService(prisma);

    await service.check(USER_ID, CODE);

    // The second answer is `not_found`, because the dead row was consumed rather
    // than left behind for another attempt.
    await expect(service.check(USER_ID, CODE)).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('counts a wrong code and says how many attempts are left', async () => {
    const prisma = new FakePrisma();
    const row = seedRow(prisma);

    await expect(createService(prisma).check(USER_ID, '999999')).resolves.toEqual({
      ok: false,
      reason: 'invalid_code',
      attemptsRemaining: 4,
    });

    expect(row.attempts).toBe(1);
    expect(row.consumedAt).toBeNull();
  });

  it('consumes the code on the attempt that uses up the allowance', async () => {
    const prisma = new FakePrisma();
    const row = seedRow(prisma, { attempts: 4 });

    await expect(createService(prisma).check(USER_ID, '999999')).resolves.toEqual({
      ok: false,
      reason: 'too_many_attempts',
      attemptsRemaining: 0,
    });

    // Consumed in the same write that records the attempt, so there is no window
    // in which a code with nothing left is still live.
    expect(row.attempts).toBe(5);
    expect(row.consumedAt).not.toBeNull();
  });

  it('refuses even the correct code once the attempts are gone', async () => {
    const prisma = new FakePrisma();
    const row = seedRow(prisma, { attempts: 5, codeHash: correctHash });

    await expect(createService(prisma).check(USER_ID, CODE)).resolves.toEqual({
      ok: false,
      reason: 'too_many_attempts',
      attemptsRemaining: 0,
    });

    // Why the counter is checked before the hash: otherwise the limit would mean
    // "five wrong guesses, then guess once more".
    expect(row.consumedAt).not.toBeNull();
  });

  it('checks the newest code when the table somehow holds more than one', async () => {
    const prisma = new FakePrisma();
    const older = seedRow(prisma, {
      createdAt: new Date(Date.now() - 60_000),
      codeHash: 'scrypt$16384$8$1$aabb$aabb',
    });
    const newer = seedRow(prisma, { codeHash: correctHash, createdAt: new Date() });

    const outcome = await createService(prisma).check(USER_ID, CODE);

    expect(outcome).toEqual({ ok: true, otpId: newer.id });
    // Guards the `orderBy: createdAt desc`: without it this could match the stale
    // row (and `older.id` would be the answer).
    expect(older.id).not.toBe(newer.id);
  });
});
