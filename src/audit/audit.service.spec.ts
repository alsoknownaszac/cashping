import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditEntry } from './audit.service.js';

/**
 * The one method every sensitive path calls, pinned on its two decisions.
 *
 * **What it writes.** `create`, one row, the caller's fields verbatim, and `null` for what the
 * caller did not supply - with `metadata` *absent* rather than null, because a nullable `Json`
 * column reads a bare `null` as the JSON value `null`, and a row that claims to hold metadata is
 * not the same row as one that holds none. Prisma's own types would not catch that mistake: both
 * spellings typecheck, and only the data disagrees.
 *
 * **What it does when the insert fails.** Nothing, to the caller. This is the decision the step
 * rests on - a full disk, a lock timeout or a dropped connection must not turn a payment into an
 * error - so it is asserted from the outside (the promise resolves) *and* from the inside (one line
 * naming the action, and no payload from the entry). The second half is the one a reviewer would
 * miss: a `catch` that logged the entry would put whatever the caller put in `metadata` into the
 * process log, which is the one place this codebase has decided secrets never go.
 *
 * What the insert's *effect* is - an append-only table that refuses revision - is not provable from
 * a fake at all. That is `test/audit.e2e-spec.ts`, against the trigger in the migration.
 */

/** The refusal a real `audit_log` gives a caller that tries to revise it. */
const APPEND_ONLY = 'audit_log is append-only: this is refused by the table (Step 32)';

/**
 * `PrismaService.auditLog`, with the four methods a caller could reach for.
 *
 * `update`, `delete` and `deleteMany` exist to fail: `AuditService` must never call them, and a fake
 * that simply did not define them would make that a type error rather than an assertion about
 * behaviour. `failure` is the outage switch.
 */
class FakeAuditLog {
  /** The `data` of every insert that succeeded, in order. */
  readonly rows: Record<string, unknown>[] = [];

  /** Every method called, so "only ever `create`" is assertable. */
  readonly calls: string[] = [];

  /** Set to make the insert fail, as a database problem would. */
  failure: Error | null = null;

  create = async (args: { data: Record<string, unknown> }): Promise<{ id: string }> => {
    this.calls.push('create');

    if (this.failure !== null) {
      throw this.failure;
    }

    this.rows.push(args.data);

    return { id: `audit-${this.rows.length}` };
  };

  update = async (): Promise<never> => {
    this.calls.push('update');

    throw new Error(APPEND_ONLY);
  };

  delete = async (): Promise<never> => {
    this.calls.push('delete');

    throw new Error(APPEND_ONLY);
  };

  deleteMany = async (): Promise<never> => {
    this.calls.push('deleteMany');

    throw new Error(APPEND_ONLY);
  };
}

function serviceOver(auditLog: FakeAuditLog): AuditService {
  return new AuditService({ auditLog } as unknown as PrismaService);
}

/** Capture the service's own error lines, since one test is about what they must not contain. */
function capturedErrors(): { lines: unknown[]; restore: () => void } {
  const lines: unknown[] = [];
  const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    lines.push(message);
  });

  return { lines, restore: () => spy.mockRestore() };
}

describe('the row it writes', () => {
  it('inserts the entry through `create`, with every column the caller supplied', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);

    const entry: AuditEntry = {
      action: 'payment.initiated',
      userId: '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41',
      subjectId: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
      outcome: 'ok',
      metadata: { amount: '12.5', recipientId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    };

    await expect(service.log(entry)).resolves.toBeUndefined();

    expect(auditLog.rows).toEqual([
      {
        action: 'payment.initiated',
        userId: '9f1c0cf4-3d2a-4f5b-9c2e-6a1f0c9b7d41',
        subjectId: '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f70',
        outcome: 'ok',
        metadata: { amount: '12.5', recipientId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
      },
    ]);

    // And nothing else was touched: the write is a `create` and this class has no other path to the
    // table, which is half of what "append-only" means (the other half is the trigger, and it is
    // `test/audit.e2e-spec.ts` that asks the database).
    expect(auditLog.calls).toEqual(['create']);
  });

  it('sends NULL for what the caller left out, and omits `metadata` rather than sending a JSON null', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);

    // `auth.login` is the shape this matters for: a user id and nothing else.
    await service.log({ action: 'auth.login', userId: 'user-1' });

    expect(auditLog.rows).toEqual([
      { action: 'auth.login', userId: 'user-1', subjectId: null, outcome: null },
    ]);
    // The distinction the schema documents: a bare `null` on a nullable `Json` column is stored as
    // the JSON value `null`, which is a row claiming to *have* metadata. "Not provided" has to keep
    // the one representation it has everywhere else.
    expect(Object.keys(auditLog.rows[0] ?? {})).not.toContain('metadata');
  });

  it('carries the metadata through unchanged', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);

    // Nothing here inspects, filters or renames what a caller passes: the rule that the payload
    // holds no secret is stated at the call site and kept by review, and a service that silently
    // dropped a key would be a service whose callers could not tell.
    const keyArn = 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-0000-0000-000000000000';

    await service.log({
      action: 'custody.key.unwrapped',
      subjectId: 'account-1',
      outcome: 'failed',
      metadata: { detail: 'KmsKeyNotFoundError: NotFoundException', keyArn },
    });

    expect(auditLog.rows[0]?.metadata).toEqual({
      detail: 'KmsKeyNotFoundError: NotFoundException',
      keyArn,
    });
  });
});

describe('the failure it swallows', () => {
  it('resolves when the insert fails, so an audit outage cannot become a payments outage', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);
    auditLog.failure = new Error('connection terminated unexpectedly');

    // A money path awaits this call. A rejection here would mean the round trip an operator's disk
    // full took the payment down with it - and the cheapest fix available at 3am would be to delete
    // the call.
    await expect(
      service.log({ action: 'payment.initiated', outcome: 'ok' }),
    ).resolves.toBeUndefined();
    expect(auditLog.rows).toEqual([]);
  });

  it('logs the action and the reason, and none of the entry', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);
    auditLog.failure = new Error('connection terminated unexpectedly');

    const { lines, restore } = capturedErrors();

    try {
      await service.log({
        action: 'auth.otp.verified',
        userId: 'user-1',
        metadata: { code: '654321' },
      });
    } finally {
      restore();
    }

    // The line names the action - which is what an operator greps for to find the gap - and the
    // reason the entry could not be written.
    expect(String(lines[0])).toContain('Audit entry auth.otp.verified could not be written');
    expect(String(lines[0])).toContain('connection terminated unexpectedly');
    // And it does *not* carry the entry. An OTP code is the example that makes this concrete, but
    // the rule is general: `metadata` is written for support and for whoever reviews an incident,
    // and a process log is not that table.
    expect(String(lines[0])).not.toContain('654321');
  });

  it('keeps appending after a failure, because each call stands alone', async () => {
    const auditLog = new FakeAuditLog();
    const service = serviceOver(auditLog);

    auditLog.failure = new Error('lock timeout');
    await service.log({ action: 'auth.login', userId: 'user-1' });

    // The outage ends, and the next entry is written like any other: nothing is queued, nothing is
    // retried, and no state from the failure survives in the instance.
    auditLog.failure = null;
    await service.log({ action: 'auth.login', userId: 'user-1' });

    expect(auditLog.rows).toEqual([
      { action: 'auth.login', userId: 'user-1', subjectId: null, outcome: null },
    ]);
  });
});
