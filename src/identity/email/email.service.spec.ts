import { describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { type OtpCheckOutcome, type OtpService } from '../otp/otp.service.js';
import { EmailService } from './email.service.js';

/**
 * The email address's own rules (Step 34c), in isolation from HTTP and a database.
 *
 * The interesting half is the split the two columns exist for: `set` writes an address
 * *unverified*, and only a correct `verify` stamps `emailVerifiedAt` - the fact a receipt
 * depends on. A second address is one another account holds, and that is a refusal the
 * service decides rather than the database.
 */

class FakeAudit {
  readonly entries: AuditEntry[] = [];

  log = async (entry: AuditEntry): Promise<void> => {
    this.entries.push(entry);
  };
}

/** The `users` row this service reads and writes, plus the OTP row it consumes. */
class FakePrisma {
  email: string | null = null;
  emailVerifiedAt: Date | null = null;
  /** Another account already holding the address, when a test wants the conflict. */
  holder: { id: string } | null = null;
  missing = false;
  /** What the in-transaction code consume reports; 0 simulates losing the race. */
  consumeCount = 1;

  readonly setWrites: Array<Record<string, unknown>> = [];
  readonly verifyWrites: Array<Record<string, unknown>> = [];

  user = {
    findFirst: async (): Promise<{ id: string } | null> => this.holder,
    findUnique: async (): Promise<{ email: string | null; emailVerifiedAt: Date | null } | null> =>
      this.missing ? null : { email: this.email, emailVerifiedAt: this.emailVerifiedAt },
    update: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
      this.setWrites.push(data);
      this.email = data['email'] as string;
      this.emailVerifiedAt = data['emailVerifiedAt'] as Date | null;

      return {};
    },
  };

  private readonly tx = {
    otpVerification: {
      updateMany: async (): Promise<{ count: number }> => ({ count: this.consumeCount }),
    },
    user: {
      update: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        this.verifyWrites.push(data);
        this.emailVerifiedAt = data['emailVerifiedAt'] as Date;

        return {};
      },
    },
  };

  $transaction = async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(this.tx);
}

class FakeOtpService {
  checkOutcome: OtpCheckOutcome = { ok: true, otpId: 'otp-1' };

  readonly issued: string[] = [];
  readonly checked: Array<{ userId: string; code: string }> = [];

  issue = async (userId: string): Promise<{ code: string; expiresAt: Date }> => {
    this.issued.push(userId);

    return { code: '123456', expiresAt: new Date('2026-10-03T10:10:00.000Z') };
  };

  check = async (userId: string, code: string): Promise<OtpCheckOutcome> => {
    this.checked.push({ userId, code });

    return this.checkOutcome;
  };
}

function createHarness(): {
  prisma: FakePrisma;
  otp: FakeOtpService;
  audit: FakeAudit;
  service: EmailService;
} {
  const prisma = new FakePrisma();
  const otp = new FakeOtpService();
  const audit = new FakeAudit();

  return {
    prisma,
    otp,
    audit,
    service: new EmailService(
      prisma as unknown as PrismaService,
      otp as unknown as OtpService,
      audit as unknown as AuditService,
    ),
  };
}

describe('EmailService.set', () => {
  it('stores the address unverified, issues a code, and logs the attach without the address', async () => {
    const { prisma, otp, audit, service } = createHarness();

    const outcome = await service.set('user-1', 'miriam@example.com');

    expect(outcome).toEqual({
      ok: true,
      email: 'miriam@example.com',
      code: '123456',
      expiresAt: new Date('2026-10-03T10:10:00.000Z'),
    });

    expect(prisma.setWrites).toEqual([{ email: 'miriam@example.com', emailVerifiedAt: null }]);
    expect(otp.issued).toEqual(['user-1']);
    // `metadata` carries the user id and *not* the address: an address is a personal
    // identifier, and the table's rule is that identifiers other than the account id stay out.
    expect(audit.entries).toEqual([
      {
        action: 'auth.email.set',
        userId: 'user-1',
        outcome: 'ok',
        metadata: { userId: 'user-1' },
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain('miriam@example.com');
  });

  it('refuses an address another account already holds, and writes nothing', async () => {
    const { prisma, audit, service } = createHarness();

    prisma.holder = { id: 'user-2' };

    const outcome = await service.set('user-1', 'taken@example.com');

    expect(outcome).toEqual({ ok: false, reason: 'address_taken' });
    expect(prisma.setWrites).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
});

describe('EmailService.verify', () => {
  it('refuses when no address is attached, without counting anything', async () => {
    const { otp, service } = createHarness();

    const outcome = await service.verify('user-1', '123456');

    expect(outcome).toEqual({ ok: false, reason: 'no_address' });
    // Nothing was checked, so no OTP attempt was spent: there was no code to guess.
    expect(otp.checked).toEqual([]);
  });

  it('refuses an address that is already confirmed', async () => {
    const { prisma, service } = createHarness();

    prisma.email = 'miriam@example.com';
    prisma.emailVerifiedAt = new Date('2026-10-01T00:00:00.000Z');

    expect(await service.verify('user-1', '123456')).toEqual({
      ok: false,
      reason: 'already_verified',
    });
  });

  it('carries an OTP failure through unchanged, so the caller maps it with one table', async () => {
    const { prisma, otp, service } = createHarness();

    prisma.email = 'miriam@example.com';
    otp.checkOutcome = { ok: false, reason: 'invalid_code', attemptsRemaining: 3 };

    expect(await service.verify('user-1', '000000')).toEqual({
      ok: false,
      reason: 'code',
      failure: { ok: false, reason: 'invalid_code', attemptsRemaining: 3 },
    });
  });

  it('spends the code and stamps emailVerifiedAt together, on success', async () => {
    const { prisma, audit, service } = createHarness();

    prisma.email = 'miriam@example.com';

    const outcome = await service.verify('user-1', '123456');

    expect(outcome.ok).toBe(true);
    expect(prisma.emailVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.verifyWrites).toHaveLength(1);
    expect(audit.entries).toEqual([
      {
        action: 'auth.email.verified',
        userId: 'user-1',
        outcome: 'ok',
        metadata: { userId: 'user-1' },
      },
    ]);
  });

  it('refuses a code another request already spent', async () => {
    const { prisma, audit, service } = createHarness();

    prisma.email = 'miriam@example.com';
    prisma.consumeCount = 0;

    await expect(service.verify('user-1', '123456')).rejects.toThrow(/already been used/i);

    // The success path never committed, and nothing was logged as one.
    expect(audit.entries).toEqual([]);
  });
});
