import { describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditService } from '../../audit/audit.service.js';
import { type PrismaService } from '../../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';

/**
 * The password's own rules (Step 34b), in isolation from HTTP and from a database.
 *
 * What is asserted here is what the e2e file cannot cheaply reach: that the *stronger* work
 * factor is really used, that a change without the current password writes nothing, and that
 * `verify` answers `false` for a missing password as well as a wrong one - the distinction
 * that would otherwise become an enumeration oracle at the endpoint.
 */

class FakeAudit {
  readonly entries: AuditEntry[] = [];

  log = async (entry: AuditEntry): Promise<void> => {
    this.entries.push(entry);
  };
}

/** The `users` row this service reads and writes, with the writes recorded. */
class FakePrisma {
  hash: string | null = null;
  missing = false;

  readonly writes: Array<{ passwordHash: string }> = [];

  user = {
    findUnique: async (): Promise<{ passwordHash: string | null } | null> =>
      this.missing ? null : { passwordHash: this.hash },
    update: async ({ data }: { data: { passwordHash: string } }): Promise<unknown> => {
      this.writes.push(data);
      this.hash = data.passwordHash;

      return {};
    },
  };
}

function createHarness(): {
  prisma: FakePrisma;
  audit: FakeAudit;
  service: PasswordService;
} {
  const prisma = new FakePrisma();
  const audit = new FakeAudit();

  return {
    prisma,
    audit,
    service: new PasswordService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    ),
  };
}

describe('PasswordService.change', () => {
  it('sets a password where there was none, with the password work factor, and logs it', async () => {
    const { prisma, audit, service } = createHarness();

    const outcome = await service.change('user-1', undefined, 'correct horse battery staple');

    expect(outcome.ok).toBe(true);

    // The gap that makes a password different from a PIN: the stored hash carries N=32768, the
    // password's work factor, not the 16384 the PIN and OTP use.
    expect(prisma.hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(prisma.hash).not.toContain('correct horse battery staple');
    expect(audit.entries).toEqual([{ action: 'auth.password.set', userId: 'user-1', outcome: 'ok' }]);
  });

  it('refuses a change with no current password once one is set, and writes nothing', async () => {
    const { prisma, audit, service } = createHarness();

    prisma.hash = 'scrypt$16384$8$1$aabb$aabb';

    const outcome = await service.change('user-1', undefined, 'a new password');

    expect(outcome).toEqual({ ok: false, reason: 'current_password_required' });
    expect(prisma.writes).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it('refuses a wrong current password, and writes nothing', async () => {
    const { prisma, service } = createHarness();

    // A real hash, so the comparison actually runs rather than short-circuiting on a bad format.
    prisma.hash = await serviceHash('the real one');

    const outcome = await service.change('user-1', 'not it', 'a new password');

    expect(outcome).toEqual({ ok: false, reason: 'invalid_password' });
    expect(prisma.writes).toEqual([]);
  });

  it('replaces the password when the current one is proved, and logs the change', async () => {
    const { prisma, audit, service } = createHarness();

    prisma.hash = await serviceHash('the real one');

    const outcome = await service.change('user-1', 'the real one', 'a new password');

    expect(outcome.ok).toBe(true);
    expect(prisma.writes).toHaveLength(1);
    expect(audit.entries).toEqual([
      { action: 'auth.password.changed', userId: 'user-1', outcome: 'ok' },
    ]);
  });

  it('answers 401-shaped if the row is gone', async () => {
    const { prisma, service } = createHarness();

    prisma.missing = true;

    await expect(service.change('gone', undefined, 'a new password')).rejects.toThrow(
      /no account is associated/i,
    );
  });
});

describe('PasswordService.verify', () => {
  it('accepts the right password and refuses a wrong one', async () => {
    const { prisma, service } = createHarness();

    prisma.hash = await serviceHash('the real one');

    await expect(service.verify('user-1', 'the real one')).resolves.toBe(true);
    await expect(service.verify('user-1', 'not it')).resolves.toBe(false);
  });

  it('answers false for an account with no password, exactly as for a wrong one', async () => {
    const { service } = createHarness();

    // The reason there is no third answer: "no password is set" and "it did not match" have to
    // be indistinguishable, or the login endpoint tells an attacker which is which.
    await expect(service.verify('user-1', 'anything')).resolves.toBe(false);
  });
});

describe('PasswordService.set', () => {
  it('overwrites the password and logs it as a change', async () => {
    const { prisma, audit, service } = createHarness();

    await service.set('user-1', 'a reset password');

    expect(prisma.hash).toMatch(/^scrypt\$32768\$/);
    expect(audit.entries).toEqual([
      { action: 'auth.password.changed', userId: 'user-1', outcome: 'ok' },
    ]);
  });
});

/** A hash made the way the service makes one, for a test that needs to prove a real password. */
async function serviceHash(password: string): Promise<string> {
  const { hashSecret, PASSWORD_SCRYPT_PARAMS } = await import('../credentials/secret-hash.js');

  return hashSecret(password, PASSWORD_SCRYPT_PARAMS);
}
