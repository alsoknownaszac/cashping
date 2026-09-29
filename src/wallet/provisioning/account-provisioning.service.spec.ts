import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { SealedAccount, SeedCustodyService } from '../custody/seed-custody.service.js';
import {
  StellarSubmissionUnavailableError,
  type SubmittedTransaction,
} from '../stellar/transaction-submitter.js';
import {
  AccountFundingMisconfiguredError,
  AccountFundingUnavailableError,
  type AccountFunder,
  type FundingResult,
} from './account-funder.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
  type ProvisioningStage,
} from './account-provisioning.service.js';
import type { TrustlineAccountRow, UsdcTrustlineService } from './usdc-trustline.js';

/**
 * The provisioning sequence, with every collaborator faked (Step 19).
 *
 * Three things are being checked, and they are the three the service's docstring promises:
 *
 * - **The order.** The row is written before the account is funded, and everything that
 *   spends money happens after the insert. The fakes share one `calls` log *because* of
 *   that: a fake recording only its own calls could not tell "funded after the insert"
 *   from "funded before it", and the difference is an account whose key exists only as a
 *   local variable if the process dies in between.
 * - **The three stages.** A failure comes back as `incomplete` with the stage it got to,
 *   because that is what tells an operator - and a retry - whether the account exists on
 *   the network yet. Anything that collapsed those into one "failed" would lose the only
 *   fact the caller can act on.
 * - **The never-throws contract.** `verifyOtp` calls this *after* committing the
 *   verification, so an exception here answers 500 to a user whose code is already spent.
 *   The specs below include the cases that are supposed to be unreachable (a read that
 *   throws, a flow that outlives its deadline) to pin that down.
 *
 * The fakes are shaped like the real collaborators rather than like convenient stubs: the
 * insert echoes back the columns it was given (as Postgres does), the funder records which
 * public key it was asked to fund, and the trustline records *the row* it was handed. That
 * is what makes "the funder was given the key that was stored" checkable instead of assumed.
 */

const USER_ID = 'user-1';
const ACCOUNT_ID = 'account-1';
const PUBLIC_KEY = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const WINNER_PUBLIC_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const DATA_KEY_ARN = 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const ENVELOPE = 'cp-kms-1.eyJhY2NvdW50SWQiOiJhY2NvdW50LTEifQ.3f8b1c4d';
/** The projection `provision` reads a user through. */
interface FakeUserRow {
  id: string;
  phoneVerifiedAt: Date | null;
  stellarAccount: { id: string; publicKey: string } | null;
}

/** The columns the insert is given, and the columns a committed insert hands back. */
interface InsertData {
  id: string;
  userId: string;
  publicKey: string;
  encryptedSecretKey: string;
  dataKeyArn: string;
}

/** The four columns the insert selects, in the order the service names them. */
interface StoredAccountRow {
  id: string;
  publicKey: string;
  encryptedSecretKey: string;
  dataKeyArn: string;
}

/**
 * `PrismaService`, as provisioning uses it: one read of a user, one insert, and one
 * re-read after a conflict.
 *
 * The insert answers with the values it was *given*, under their column names, which is
 * what makes the "the funder was asked for the stored key" assertion a real one - a fake
 * answering with a fixed row would pass whichever key the service happened to be holding.
 */
class FakePrisma {
  /** What `user.findUnique` answers with. `null` is the unknown-id case. */
  userRow: FakeUserRow | null = {
    id: USER_ID,
    phoneVerifiedAt: VERIFIED_AT,
    stellarAccount: null,
  };

  /** Set to make the read itself throw - the failure the flow is not supposed to see. */
  userReadFailsWith: unknown = null;

  /** Set to make the insert fail: a `P2002` for a lost race, anything else for a bug. */
  insertFailsWith: unknown = null;

  /** What `stellarAccount.findUnique` answers with after a conflict. */
  concurrentRow: { id: string; publicKey: string } | null = null;

  /** The `data` of every insert, in order, so a spec can check what was written. */
  readonly inserts: InsertData[] = [];

  constructor(private readonly calls: string[]) {}

  readonly user = {
    findUnique: async (): Promise<FakeUserRow | null> => {
      this.calls.push('read-user');

      if (this.userReadFailsWith !== null) {
        throw this.userReadFailsWith;
      }

      return this.userRow;
    },
  };

  readonly stellarAccount = {
    create: async (args: {
      data: InsertData;
      select: { id: true; publicKey: true; encryptedSecretKey: true; dataKeyArn: true };
    }): Promise<StoredAccountRow> => {
      this.calls.push('insert-account');

      if (this.insertFailsWith !== null) {
        throw this.insertFailsWith;
      }

      this.inserts.push(args.data);

      // The `select` is what the caller gets back - the four columns it named, and not the
      // `userId` it also wrote - because that is what Postgres answers with. It is what makes
      // "the trustline was handed the stored row" an assertion about four fields rather than
      // about whatever the insert happened to be carrying.
      return {
        id: args.data.id,
        publicKey: args.data.publicKey,
        encryptedSecretKey: args.data.encryptedSecretKey,
        dataKeyArn: args.data.dataKeyArn,
      };
    },
    findUnique: async (): Promise<{ id: string; publicKey: string } | null> => {
      this.calls.push('read-account');

      return this.concurrentRow;
    },
  };
}

/** Key custody, reduced to the one call provisioning makes. */
class FakeCustody {
  /** The sealed account `createSealedAccount` answers with. */
  sealed: SealedAccount = {
    accountId: ACCOUNT_ID,
    publicKey: PUBLIC_KEY,
    encryptedSecretKey: ENVELOPE,
    dataKeyArn: DATA_KEY_ARN,
  };

  /** Set to make sealing fail, as an unreachable KMS or an unusable key would. */
  failWith: Error | null = null;

  constructor(private readonly calls: string[]) {}

  createSealedAccount = async (): Promise<SealedAccount> => {
    this.calls.push('seal');

    if (this.failWith !== null) {
      throw this.failWith;
    }

    return this.sealed;
  };
}

/**
 * The funder, recording which public key it was asked to fund.
 *
 * `hangs` is what makes the deadline testable. A funder that never answers is the one
 * failure the flow cannot classify - a deadline says nothing about whether the request
 * was received - so it has to end as an outcome like every other failure.
 */
class FakeFunder implements AccountFunder {
  readonly kind = 'friendbot';
  readonly funded: string[] = [];

  result: FundingResult = { outcome: 'funded', transactionHash: FUNDING_HASH };
  failWith: Error | null = null;

  /** When true, `fund` never settles: the flow's own deadline is then the only way out. */
  hangs = false;

  /** How long a successful funding takes, for the spec that asserts a ceiling is not a wait. */
  delayMs = 0;

  constructor(private readonly calls: string[]) {}

  fund = async (publicKey: string): Promise<FundingResult> => {
    this.calls.push('fund');
    this.funded.push(publicKey);

    if (this.hangs) {
      // A promise with no resolver, kept on purpose. The deadline wins the race and drops
      // this one; because `withDeadline` attaches handlers to the work it stops waiting for,
      // an answer arriving here later would be observed rather than unhandled.
      await new Promise<never>(() => undefined);
    }

    if (this.delayMs > 0) {
      await new Promise((resume) => setTimeout(resume, this.delayMs));
    }

    if (this.failWith !== null) {
      throw this.failWith;
    }

    return this.result;
  };
}

/** The trustline step, recording the row it was handed. */
class FakeTrustline {
  readonly ensured: TrustlineAccountRow[] = [];

  result: SubmittedTransaction = { hash: TRUSTLINE_HASH, ledger: 42_000_001 };
  failWith: Error | null = null;

  constructor(private readonly calls: string[]) {}

  ensureFor = async (account: TrustlineAccountRow): Promise<SubmittedTransaction> => {
    this.calls.push('trustline');
    this.ensured.push(account);

    if (this.failWith !== null) {
      throw this.failWith;
    }

    return this.result;
  };
}

/** Everything a spec needs to drive the service and inspect what it did. */
interface Harness {
  /** The shared call log: the order *across* collaborators is the assertion. */
  calls: string[];
  prisma: FakePrisma;
  custody: FakeCustody;
  trustline: FakeTrustline;
  funder: FakeFunder;
  service: AccountProvisioningService;
}

/**
 * The service with all four collaborators faked, wired the way `WalletModule` wires it:
 * the same arguments, in the same order, with the funder bound to the same token Nest
 * would inject.
 *
 * `timeoutMs` is the one config value the service reads, so it is the one thing the
 * harness is parameterised by - and the specs that care about the deadline drive it
 * through here rather than by waiting 30 seconds.
 */
function createHarness(options: { timeoutMs?: number } = {}): Harness {
  const calls: string[] = [];
  const prisma = new FakePrisma(calls);
  const custody = new FakeCustody(calls);
  const trustline = new FakeTrustline(calls);
  const funder = new FakeFunder(calls);
  const config = {
    getOrThrow: (): number => options.timeoutMs ?? TIMEOUT_MS,
  } as unknown as ConfigService;

  return {
    calls,
    prisma,
    custody,
    trustline,
    funder,
    service: new AccountProvisioningService(
      prisma as unknown as PrismaService,
      custody as unknown as SeedCustodyService,
      trustline as unknown as UsdcTrustlineService,
      funder,
      config,
    ),
  };
}

/** A `P2002` as Postgres reports it: the unique index on `userId` refused the row. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`userId`)',
    { code: 'P2002', clientVersion: '7.10.0', meta: { modelName: 'StellarAccount' } },
  );
}

/**
 * The stage and detail of an `incomplete` outcome.
 *
 * The narrowing lives here rather than in each spec so a test that drifts out of the
 * `incomplete` branch fails as "the outcome was `provisioned`" instead of as a
 * property access on the wrong member of the union.
 */
function incomplete(outcome: ProvisioningOutcome): {
  stage: ProvisioningStage | undefined;
  detail: string;
} {
  if (outcome.status !== 'incomplete') {
    throw new Error(`expected an incomplete outcome, got ${outcome.status}`);
  }

  return { stage: outcome.stage, detail: outcome.detail };
}

/** The lines the service logged, by level, with the logger itself replaced. */
interface CapturedLogs {
  log: string[];
  warn: string[];
  error: string[];
}

/**
 * Replaces Nest's logger output for one test.
 *
 * Two reasons, and the second is the important one. The failure-path specs deliberately
 * provoke `error` lines with stack traces, and printing them buries the failure output
 * of the run they are part of. More usefully: `provisionFor`'s docstring makes a claim
 * about what it logs - public keys and hashes yes, the envelope never - and a claim
 * about a log line can only be tested against the line.
 */
function captureLogs(): CapturedLogs {
  const captured: CapturedLogs = { log: [], warn: [], error: [] };

  vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown): void => {
    captured.log.push(String(message));
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown): void => {
    captured.warn.push(String(message));
  });
  vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown): void => {
    captured.error.push(String(message));
  });

  return captured;
}

let logs: CapturedLogs;

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountProvisioningService.provisionFor: the sequence', () => {
  it('seals, stores, funds and trusts an account, and reports all of it', async () => {
    const h = createHarness();

    const outcome = await h.service.provisionFor(USER_ID);

    // All six fields, because each one is something a caller or an operator acts on: the
    // row, the address that was funded, how the funding went, and the two hashes.
    expect(outcome).toEqual({
      status: 'provisioned',
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      funding: 'funded',
      fundingTransactionHash: FUNDING_HASH,
      trustlineTransactionHash: TRUSTLINE_HASH,
    });
  });

  it('writes the row before it spends anything', async () => {
    const h = createHarness();

    await h.service.provisionFor(USER_ID);

    // The whole reason the order is not the obvious one: funding first would leave the
    // window between the network's transaction and the insert as one where XLM is attached
    // to a key whose only sealed copy is a local variable.
    expect(h.calls).toEqual(['read-user', 'seal', 'insert-account', 'fund', 'trustline']);
  });

  it('stores the sealed columns under the id the envelope was bound to', async () => {
    const h = createHarness();

    await h.service.provisionFor(USER_ID);

    // `sealed.accountId` is what `sealEnvelope` used as its AAD, so an insert under a
    // different id - a default generated by the database, say - would produce a row whose
    // envelope cannot be opened. Nothing here derives an id of its own.
    expect(h.prisma.inserts).toEqual([
      {
        id: ACCOUNT_ID,
        userId: USER_ID,
        publicKey: PUBLIC_KEY,
        encryptedSecretKey: ENVELOPE,
        dataKeyArn: DATA_KEY_ARN,
      },
    ]);
  });

  it('funds and trusts the key it stored, not the one it generated', async () => {
    const h = createHarness();

    await h.service.provisionFor(USER_ID);

    expect(h.funder.funded).toEqual([PUBLIC_KEY]);

    // The trustline is handed the row the insert answered with - four columns, no `userId`
    // - because that is the row the seed can be opened against. Passing the sealed account
    // instead would be a second place where the envelope and its ARN are paired up.
    expect(h.trustline.ensured).toEqual([
      {
        id: ACCOUNT_ID,
        publicKey: PUBLIC_KEY,
        encryptedSecretKey: ENVELOPE,
        dataKeyArn: DATA_KEY_ARN,
      },
    ]);
  });

  it('reports a user who already has an account as already-provisioned, and funds nothing', async () => {
    const h = createHarness();
    h.prisma.userRow = {
      id: USER_ID,
      phoneVerifiedAt: VERIFIED_AT,
      stellarAccount: { id: 'account-existing', publicKey: WINNER_PUBLIC_KEY },
    };

    const outcome = await h.service.provisionFor(USER_ID);

    // The answer a repeat call is supposed to get: no key material was touched and no
    // faucet was called to establish that the account is already there.
    expect(outcome).toEqual({
      status: 'already-provisioned',
      accountId: 'account-existing',
      publicKey: WINNER_PUBLIC_KEY,
    });
    expect(h.calls).toEqual(['read-user']);
  });

  it('refuses a user whose phone number is not verified, and creates nothing', async () => {
    const h = createHarness();
    h.prisma.userRow = { id: USER_ID, phoneVerifiedAt: null, stellarAccount: null };

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // Unreachable from `verifyOtp`, which writes that column before calling - kept because
    // the cost is one branch and the cost of being wrong is an account for a number nobody
    // has proven they own.
    expect(stage).toBeUndefined();
    expect(detail).toContain('not verified');
    expect(h.calls).toEqual(['read-user']);
    expect(h.prisma.inserts).toEqual([]);
  });

  it('reports an unknown user as incomplete, naming no stage', async () => {
    const h = createHarness();
    h.prisma.userRow = null;

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // No stage, because no stage of the flow was reached: claiming `storage` here would
    // tell an operator that an attempt happened for a user who does not exist.
    expect(stage).toBeUndefined();
    expect(detail).toContain('does not exist');
    expect(h.calls).toEqual(['read-user']);
  });

  it('carries the funder\u2019s own outcome through, so a repeat funding is visible', async () => {
    const h = createHarness();
    h.funder.result = { outcome: 'already-funded', transactionHash: undefined };

    const outcome = await h.service.provisionFor(USER_ID);

    // Both are success - the account has XLM either way - and which one it was is what makes
    // a double-provisioning bug or a retry loop visible in the logs before it is a ticket.
    expect(outcome).toEqual({
      status: 'provisioned',
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      funding: 'already-funded',
      fundingTransactionHash: undefined,
      trustlineTransactionHash: TRUSTLINE_HASH,
    });
    expect(h.trustline.ensured).toHaveLength(1);
  });
});

describe('AccountProvisioningService.provisionFor: the stage a failure reports', () => {
  it('reports a sealing failure as storage, before anything exists anywhere', async () => {
    const h = createHarness();
    h.custody.failWith = new Error('KMS refused the data key');

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // The one stage whose failure leaves nothing behind: no row, and no account on the
    // network either, so a retry starts from nothing and cannot double-provision.
    expect(stage).toBe('storage');
    expect(detail).toContain('KMS refused the data key');
    expect(h.calls).toEqual(['read-user', 'seal']);
  });

  it('reports an insert that fails for any other reason as storage, and funds nothing', async () => {
    const h = createHarness();
    h.prisma.insertFailsWith = new Error('deadlock detected');

    const { stage } = incomplete(await h.service.provisionFor(USER_ID));

    expect(stage).toBe('storage');
    expect(h.funder.funded).toEqual([]);
    expect(h.calls).toEqual(['read-user', 'seal', 'insert-account']);
  });

  it('treats a lost insert race as already-provisioned, naming the winner\u2019s account', async () => {
    const h = createHarness();
    h.prisma.insertFailsWith = uniqueViolation();
    h.prisma.concurrentRow = { id: 'account-winner', publicKey: WINNER_PUBLIC_KEY };

    const outcome = await h.service.provisionFor(USER_ID);

    // The `@unique` on `userId` is what makes provisioning single-writer, and losing that
    // race is not a failure: an account exists, which is what the caller asked for. The
    // re-read is what makes the reported key the *stored* one rather than the one this call
    // generated and threw away.
    expect(outcome).toEqual({
      status: 'already-provisioned',
      accountId: 'account-winner',
      publicKey: WINNER_PUBLIC_KEY,
    });
    expect(h.funder.funded).toEqual([]);
    expect(h.calls).toEqual(['read-user', 'seal', 'insert-account', 'read-account']);
  });

  it('reports a unique conflict with no row behind it as storage, not as a success', async () => {
    const h = createHarness();
    h.prisma.insertFailsWith = uniqueViolation();
    h.prisma.concurrentRow = null;

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // A `P2002` on `publicKey` rather than on `userId` lands here, as would a row deleted
    // between the two statements. Answering `already-provisioned` would report an account
    // this process has no evidence of.
    expect(stage).toBe('storage');
    expect(detail).toContain('not found after a unique-index conflict');
  });

  it('reports an unreachable funder as funding, keeping the row it wrote', async () => {
    const h = createHarness();
    h.funder.failWith = new AccountFundingUnavailableError(
      PUBLIC_KEY,
      'friendbot answered HTTP 503',
    );

    const outcome = await h.service.provisionFor(USER_ID);

    // The row is the thing that makes the attempt resumable, so it stays - and the trustline
    // is not attempted against an account that does not exist on the ledger yet.
    expect(incomplete(outcome).stage).toBe('funding');
    expect(h.prisma.inserts).toHaveLength(1);
    expect(h.trustline.ensured).toEqual([]);
    expect(outcome).toMatchObject({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY });
  });

  it('reports a misconfigured funder as funding too', async () => {
    const h = createHarness();
    h.funder.failWith = new AccountFundingMisconfiguredError('friendbot answered HTTP 400');

    const { stage } = incomplete(await h.service.provisionFor(USER_ID));

    // The same *outcome* as an unreachable funder, because a caller cannot act on the
    // difference - both mean "this account is not funded". They differ in the log line's
    // level, which is the only place "retry" versus "page someone" is of any use.
    expect(stage).toBe('funding');
  });

  it('reports a funder failure it cannot classify as funding, not as an unknown stage', async () => {
    const h = createHarness();
    h.funder.failWith = new TypeError('undefined is not a function');

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // A bug inside the funder is still a funding failure: the row exists, the account does
    // not, and this call knows how far it got. Reporting no stage would throw away the one
    // fact the caller has.
    expect(stage).toBe('funding');
    expect(detail).toContain('TypeError');
  });

  it('reports a failed trustline submission as trustline, keeping the funded account', async () => {
    const h = createHarness();
    h.trustline.failWith = new StellarSubmissionUnavailableError('Horizon did not answer');

    const outcome = await h.service.provisionFor(USER_ID);

    // Funded but untrusted is the half-provisioned state Step 19 exists to rule out, so it
    // is reported as an incomplete attempt rather than as a success with a footnote - and
    // `stage: 'trustline'` says the flow reached its last step.
    expect(incomplete(outcome).stage).toBe('trustline');
    expect(h.calls).toEqual(['read-user', 'seal', 'insert-account', 'fund', 'trustline']);
    expect(outcome).toMatchObject({ accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY });
  });
});

describe('AccountProvisioningService.provisionFor: the deadline, and not throwing', () => {
  it('gives up on a flow that outlives the deadline, as an outcome rather than an error', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.funder.hangs = true;

    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    // `verifyOtp` has already committed by the time this runs, so the deadline has to come
    // back as an outcome: the caller answers 200 for a user whose code is spent, and the row
    // that was written before the hang is what lets a retry finish the job. No stage,
    // because a deadline says nothing about whether the funding request arrived.
    expect(stage).toBeUndefined();
    expect(detail).toContain('STELLAR_PROVISIONING_TIMEOUT_MS');
    expect(logs.error.join('\n')).toContain(`Provisioning failed for user ${USER_ID}`);
  });

  it('is a ceiling, not a wait: a flow that finishes inside it is not delayed by it', async () => {
    const h = createHarness({ timeoutMs: 5_000 });
    h.funder.delayMs = 10;

    const outcome = await h.service.provisionFor(USER_ID);

    // The timer is cleared as soon as the flow settles, so a five-second ceiling costs
    // nothing on the happy path - a registration never waits five seconds to be told it
    // succeeded.
    expect(outcome.status).toBe('provisioned');
    expect(logs.error).toEqual([]);
  });

  it('returns an outcome when something the flow never anticipated throws', async () => {
    const h = createHarness();
    h.prisma.userReadFailsWith = new TypeError('prisma is not what we thought');

    // The contract that matters most in this file. An exception here would answer 500 to a
    // user who has already succeeded, with a retry that cannot work - their code is spent.
    // A programming error surfaces as a log line instead, which is the trade `provisionFor`
    // documents.
    const { stage, detail } = incomplete(await h.service.provisionFor(USER_ID));

    expect(stage).toBeUndefined();
    expect(detail).toContain('TypeError');
    expect(logs.error).toHaveLength(1);
  });
});

describe('AccountProvisioningService logging', () => {
  it('names the account, the funder and both hashes on success', async () => {
    const h = createHarness();

    await h.service.provisionFor(USER_ID);

    const line = logs.log.join('\n');

    // Every part of this line is public by construction, and it is what makes a provisioning
    // question answerable from logs alone: which row, which address, and which two
    // transactions to look up.
    expect(line).toContain(`Provisioned account ${PUBLIC_KEY} for user ${USER_ID}`);
    expect(line).toContain('via friendbot');
    expect(line).toContain(`(funded ${FUNDING_HASH})`);
    expect(line).toContain(`trustline ${TRUSTLINE_HASH}`);
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
  });

  it('says which account a repeat call found', async () => {
    const h = createHarness();
    h.prisma.userRow = {
      id: USER_ID,
      phoneVerifiedAt: VERIFIED_AT,
      stellarAccount: { id: 'account-existing', publicKey: WINNER_PUBLIC_KEY },
    };

    await h.service.provisionFor(USER_ID);

    // A no-op call that logged nothing would make "why does this user have two accounts" and
    // "why does this user have none" look the same in the logs: absent.
    expect(logs.log.join('\n')).toContain('(account account-existing)');
  });

  it('warns for a failure a retry can clear, and errors for one that needs a human', async () => {
    const retryable = createHarness();
    retryable.funder.failWith = new AccountFundingUnavailableError(PUBLIC_KEY, 'HTTP 503');

    await retryable.service.provisionFor(USER_ID);

    // The level is the payoff of the lower layers separating "unavailable" from
    // "misconfigured": one wants a retry, the other wants a person. The stage is in the line
    // so that whoever reads it knows whether an account exists on the network.
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain('stage funding');
    expect(logs.warn[0]).toContain(`account ${ACCOUNT_ID}`);
    expect(logs.error).toEqual([]);

    const needsAHuman = createHarness();
    needsAHuman.funder.failWith = new AccountFundingMisconfiguredError('HTTP 400');

    await needsAHuman.service.provisionFor(USER_ID);

    expect(logs.error).toHaveLength(1);
    expect(logs.warn).toHaveLength(1);
  });

  it('warns, rather than alarms, when it refuses an unverified user', async () => {
    const h = createHarness();
    h.prisma.userRow = { id: USER_ID, phoneVerifiedAt: null, stellarAccount: null };

    await h.service.provisionFor(USER_ID);

    // Reaching here means a caller asked to provision for a user it had not verified: a bug
    // to be found, not an incident - and because the refusal changes nothing, this line is
    // the only trace that it happened at all.
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn.join()).toContain('not verified');
    expect(logs.error).toEqual([]);
  });

  it('never puts the sealed envelope or a seed in a log line, on any path', async () => {
    const [succeeded, sealingFailed, trustlineFailed] = [
      createHarness(),
      createHarness(),
      createHarness(),
    ];

    sealingFailed.custody.failWith = new Error('KMS refused the data key');
    trustlineFailed.trustline.failWith = new StellarSubmissionUnavailableError(
      'Horizon did not answer',
    );

    for (const h of [succeeded, sealingFailed, trustlineFailed]) {
      await h.service.provisionFor(USER_ID);
    }

    const logged = JSON.stringify(logs);

    // The envelope is the one secret-shaped thing that crosses this service's boundary on
    // every one of these paths, so this is the assertion with teeth: a `JSON.stringify` or a
    // template literal reaching for the row it was handed would put ciphertext in the log.
    // The seed itself cannot reach a line here (custody is faked), so the `S...` pattern is
    // a tripwire for the day a fake - or the real thing - holds one.
    expect(logged).toContain(PUBLIC_KEY);
    expect(logged).not.toContain(ENVELOPE);
    expect(logged).not.toMatch(/S[A-Z2-7]{55}/);
  });
});

const FUNDING_HASH = 'funding-hash';
const TRUSTLINE_HASH = 'trustline-hash';
const VERIFIED_AT = new Date('2026-01-01T00:00:00.000Z');
const TIMEOUT_MS = 1_000;
