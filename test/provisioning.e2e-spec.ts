import { randomInt } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_FALLBACK_HORIZON_URL,
  DEFAULT_FRIENDBOT_URL,
  DEFAULT_PROVISIONING_TIMEOUT_MS,
} from './../src/config/configuration.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { KmsKeyWrapper, createKmsClient } from './../src/wallet/custody/kms-key-wrapper.js';
import { SeedCustodyService } from './../src/wallet/custody/seed-custody.service.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';
import { FriendbotFunder } from './../src/wallet/provisioning/friendbot-funder.js';
import type { AccountFunder, FundingResult } from './../src/wallet/provisioning/account-funder.js';
import { UsdcTrustlineService } from './../src/wallet/provisioning/usdc-trustline.js';
import {
  HorizonAccountSource,
  createHorizonServer,
} from './../src/wallet/stellar/horizon-account-source.js';
import { HorizonPaymentsLookup } from './../src/wallet/stellar/horizon-payments-lookup.js';
import { HorizonTransactionLookup } from './../src/wallet/stellar/horizon-transaction-lookup.js';
import { HorizonTransactionSubmitter } from './../src/wallet/stellar/horizon-transaction-submitter.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Step 19 against the real thing: Testnet, a real KMS endpoint, and the real database.
 *
 * This is the file the Day 2 audit checklist asks for - "a freshly registered and
 * phone-verified user has, without further action, a Testnet account that is both funded
 * (real XLM balance, not zero) and trustline-active for USDC" - and it exists because
 * provisioning is the one place in the build where three systems have to agree about a
 * newly created account: KMS (a sealed seed), Horizon (a funded account that trusts USDC)
 * and Postgres (the row that ties the two together). A fake can check the flow's *shape*;
 * only a real run checks that the three agree. `account-provisioning.service.spec.ts`
 * already covers the sequence offline, with every port substituted.
 *
 * **Nothing is substituted here.** `KmsKeyWrapper` talks to a real KMS endpoint, Horizon is
 * `horizon-testnet.stellar.org`, and the row under test is in the configured database.
 *
 * ## The checks are two-sided on purpose
 *
 * The flow's own report is asserted, and then the *network* is asked directly - a plain
 * `fetch` to Horizon that does not go through this codebase - for the two conditions the
 * checklist names. That split is the point: "funded but no trustline" and "trustline set
 * but never funded" are different failures, and one assertion over the service's return
 * value cannot tell them apart, because the service is the thing being checked.
 *
 * ## Running it
 *
 * Skipped unless `RUN_STELLAR_IT=1`, so neither `npm test` nor CI needs a socket, a
 * database or a KMS endpoint. Exports it needs:
 *
 * ```bash
 * export AWS_REGION=eu-west-1
 * export AWS_KMS_KEY_ID=<an arn that exists in the endpoint below>
 * export AWS_ENDPOINT_URL=http://localhost:4566   # a local KMS; see the note below
 * export DATABASE_URL=postgresql://user:pass@localhost:5433/cashping?schema=public
 * export STELLAR_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
 * RUN_STELLAR_IT=1 npm run test:e2e test/provisioning.e2e-spec.ts
 * ```
 *
 * The endpoint is the one part that is not AWS. `test/custody.e2e-spec.ts` records the
 * LocalStack recipe (KMS on `4566`, key created with `awslocal kms create-key`); any
 * endpoint that speaks the KMS API works, and the master key has to exist *in it*, because
 * an ARN that is only shaped like one is a `NotFoundException`. This file compares the ARN
 * *stored on the row* against what was configured, which are equal when the configured
 * value is already the ARN.
 *
 * ## What it leaves behind
 *
 * Two `users` rows and two `stellar_accounts` rows, both deleted again in `afterAll` (the
 * account rows first: the relation is `onDelete: Restrict`, deliberately). The Testnet
 * accounts themselves cannot be deleted - they stay on the ledger, funded and trusting USDC,
 * with a seed nobody holds. That is a Testnet-only cost, and it is why this file provisions
 * exactly two accounts per run: the one the checklist describes, and the stored-but-never-
 * funded one the resumption test manufactures and completes.
 */

const ENABLED = process.env['RUN_STELLAR_IT'] === '1';

/** The two conditions the checklist insists are checked independently, from Horizon. */
interface HorizonAccount {
  readonly sequence: string;
  readonly balances: ReadonlyArray<{
    readonly asset_type: string;
    readonly asset_code?: string;
    readonly asset_issuer?: string;
    readonly balance: string;
  }>;
}

/**
 * The app's config, read from this process's environment rather than from a `.env`, for the
 * same reason `test/custody.e2e-spec.ts` does it: an integration run should say what it is
 * pointed at in the command that starts it, not inherit it from a file.
 *
 * The three values with no sensible default - a master key, a database, an issuer - throw
 * with the name of the export that is missing. The alternative is a run that dies twenty
 * seconds later inside an SDK with a message about a socket, which reads like an outage
 * rather than like a missing variable.
 */
function configWith(overrides: Record<string, string | number | undefined> = {}): ConfigService {
  const values: Record<string, string | number | undefined> = {
    nodeEnv: 'test',
    'database.url': process.env['DATABASE_URL'],
    'aws.region': process.env['AWS_REGION'] ?? 'eu-west-1',
    'aws.endpointUrl': process.env['AWS_ENDPOINT_URL'],
    'aws.accessKeyId': process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    'aws.secretAccessKey': process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    'aws.kmsKeyId': process.env['AWS_KMS_KEY_ID'],
    'stellar.network': 'TESTNET',
    'stellar.horizonUrl':
      process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org',
    'stellar.fallbackHorizonUrl': DEFAULT_FALLBACK_HORIZON_URL,
    'stellar.friendbotUrl': process.env['STELLAR_FRIENDBOT_URL'] ?? DEFAULT_FRIENDBOT_URL,
    'stellar.usdcIssuer': process.env['STELLAR_USDC_ISSUER'],
    // A number rather than a string: this is the *flow's* deadline, and the app's own
    // default is what a real deployment runs with.
    'stellar.provisioningTimeoutMs': Number(
      process.env['STELLAR_PROVISIONING_TIMEOUT_MS'] ?? DEFAULT_PROVISIONING_TIMEOUT_MS,
    ),
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`missing ${key} - see this spec's header for what to export`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

/**
 * The real friendbot, with a note of every call.
 *
 * The re-run check needs to know that the *funder* was not asked a second time, and the
 * only place that is observable from is between the provisioning service and the funder -
 * a balance cannot answer it, because friendbot's Horizon-shaped endpoint pays the starting
 * balance again on a repeat request rather than refusing (recorded in `FriendbotFunder`).
 */
class RecordingFunder implements AccountFunder {
  readonly kind: string;
  readonly asked: string[] = [];

  constructor(private readonly inner: AccountFunder) {
    this.kind = inner.kind;
  }

  fund(publicKey: string): Promise<FundingResult> {
    this.asked.push(publicKey);

    return this.inner.fund(publicKey);
  }
}

/** Everything the flow needs, wired the way `WalletModule` wires it - and nothing faked. */
interface Harness {
  readonly provisioning: AccountProvisioningService;
  readonly custody: SeedCustodyService;
  readonly prisma: PrismaService;
  readonly funder: RecordingFunder;
  readonly userId: string;
  /**
   * Every user this run wrote, so `afterAll` deletes all of them.
   *
   * A list rather than just `userId`, because the resumption test writes its own user: a
   * stored-but-never-funded account is manufactured the only way the schema allows - a real
   * sealed row for a real user, with no funding transaction.
   */
  readonly created: string[];
  readonly close: () => Promise<void>;
}

/**
 * Builds the real object graph, and a user who has just verified a phone number.
 *
 * The registration path itself (`auth.e2e-spec.ts`) is not repeated here: what Step 19
 * claims is about what a *verified* user ends up with, so the row is created directly with
 * the one column that triggers provisioning set.
 */
async function harness(): Promise<Harness> {
  const config = configWith();
  const prisma = new PrismaService(config);
  const stellar = new StellarService(
    config,
    new HorizonAccountSource(config, createHorizonServer),
    new HorizonTransactionSubmitter(config, createHorizonServer),
    // Step 28's third port, wired as `WalletModule` wires it. Nothing in this run polls; the point
    // is that the service under test is built the way the app builds it.
    new HorizonTransactionLookup(config, createHorizonServer),
    // The fourth port, on the same terms: nothing here reads deposits, but `WalletModule` supplies
    // it, so the service under test is built exactly as the app builds it.
    new HorizonPaymentsLookup(config, createHorizonServer),
  );
  const custody = new SeedCustodyService(new KmsKeyWrapper(config, createKmsClient), stellar);
  const funder = new RecordingFunder(new FriendbotFunder(config));

  const user = await prisma.user.create({
    data: {
      phoneNumber: `+2332${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
      phoneVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  return {
    provisioning: new AccountProvisioningService(
      prisma,
      stellar,
      custody,
      new UsdcTrustlineService(stellar, custody, config),
      funder,
      config,
    ),
    custody,
    prisma,
    funder,
    userId: user.id,
    created: [user.id],
    close: () => prisma.$disconnect(),
  };
}

/** Horizon's own answer, fetched without going through any of the code under test. */
async function horizonAccount(publicKey: string): Promise<HorizonAccount> {
  const horizon = process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org';
  const response = await fetch(`${horizon}/accounts/${publicKey}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Horizon answered HTTP ${response.status} for ${publicKey}`);
  }

  return (await response.json()) as HorizonAccount;
}

/**
 * One live run, in two tests that share state: the account the first one provisions is what
 * the second one re-runs against. Separated rather than merged into one long test because
 * the checklist treats "it provisioned" and "running it again changes nothing" as different
 * claims, and a failure should say which one broke.
 */
describe.skipIf(!ENABLED)('provisioning against Testnet (e2e, live)', () => {
  let app: Harness;
  /** Set by the first test; the second one re-runs against it. */
  let publicKey = '';

  beforeAll(async () => {
    app = await harness();
  });

  afterAll(async () => {
    // The account rows first: `onDelete: Restrict` refuses to delete the user until they are
    // gone, which is the schema insisting a funded Stellar account is not deleted casually.
    // Every user this run created, not only the first: the resumption test writes one too.
    for (const userId of app.created) {
      await app.prisma.stellarAccount.deleteMany({ where: { userId } });
      await app.prisma.user.deleteMany({ where: { id: userId } });
    }

    await app.close();
  });

  it('gives a verified user a funded account that trusts USDC', async () => {
    const outcome: ProvisioningOutcome = await app.provisioning.provisionFor(app.userId);

    // The flow's own report. On a failure vitest prints the outcome, which is where the
    // stage and the detail are.
    expect(outcome).toMatchObject({ status: 'provisioned' });

    if (outcome.status !== 'provisioned') {
      throw new Error(`provisioning did not finish: ${JSON.stringify(outcome)}`);
    }

    publicKey = outcome.publicKey;

    // The funder was asked about *this* account, once.
    expect(app.funder.asked).toEqual([outcome.publicKey]);

    // The row: sealed, bound to the configured master key, and carrying no seed.
    const row = await app.prisma.stellarAccount.findUnique({ where: { userId: app.userId } });
    expect(row?.publicKey).toBe(outcome.publicKey);
    expect(row?.encryptedSecretKey.startsWith('cp-kms-1.')).toBe(true);
    expect(row?.encryptedSecretKey).not.toMatch(/S[A-Z2-7]{55}/);
    expect(row?.dataKeyArn).toBe(process.env['AWS_KMS_KEY_ID']);

    // And the row opens again - through KMS, with the ARN it stores - back to the key it
    // was sealed for. Without this the audit could only claim the column *looks*
    // encrypted, which is a different and much weaker statement.
    const opened = await app.custody.openSeed({
      id: row?.id ?? '',
      encryptedSecretKey: row?.encryptedSecretKey ?? '',
      dataKeyArn: row?.dataKeyArn ?? '',
    });
    expect(opened.publicKey()).toBe(outcome.publicKey);

    // The network's own answer, which knows nothing about any of the above.
    const account = await horizonAccount(outcome.publicKey);
    const native = account.balances.find((balance) => balance.asset_type === 'native');
    const usdc = account.balances.find(
      (balance) =>
        balance.asset_code === 'USDC' &&
        balance.asset_issuer === process.env['STELLAR_USDC_ISSUER'],
    );

    // Condition one: funded. Not zero - and the balance is quoted in the run's report.
    expect(Number(native?.balance)).toBeGreaterThan(0);
    // Condition two: trustline-active for *this* issuer. Asserted separately, because
    // either condition can hold while the other does not, and only this one makes the
    // account able to receive USDC.
    expect(usdc).toBeDefined();
    expect(usdc?.balance).toBe('0.0000000');

    // The hashes are what an auditor pastes into an explorer, so the run prints them.
    expect(outcome.trustlineTransactionHash).toMatch(/^[0-9a-f]{64}$/);
    console.log(
      `[step 19] provisioned account=${outcome.publicKey} xlm=${native?.balance ?? '?'} ` +
        `usdc_trustline=yes funding_tx=${outcome.fundingTransactionHash ?? '(funder named none)'} ` +
        `trustline_tx=${outcome.trustlineTransactionHash} key=${row?.dataKeyArn ?? '?'}`,
    );
  }, 120_000);

  it('is idempotent: a second attempt funds nothing and submits nothing', async () => {
    expect(publicKey).not.toBe('');

    const before = await horizonAccount(publicKey);

    const outcome: ProvisioningOutcome = await app.provisioning.provisionFor(app.userId);

    expect(outcome).toMatchObject({ status: 'already-provisioned', publicKey });
    // The funder was not asked a second time. This is the check that matters on the
    // endpoint which pays repeats: a retry loop there is 10,000 XLM per attempt.
    expect(app.funder.asked).toEqual([publicKey]);

    // And nothing was submitted for the account at all. A Stellar account's sequence
    // number only moves when a transaction for it lands, so an unchanged one is the
    // network's own statement that the second attempt sent nothing - no second
    // `changeTrust`, and no funding transaction. This is the invariant the resumption path
    // had to keep: the second call now *does* read Horizon, and what stops it submitting a
    // redundant `changeTrust` is the USDC line in that answer rather than the row.
    const after = await horizonAccount(publicKey);
    expect(after.sequence).toBe(before.sequence);
    // Still exactly one trustline, not two: an `ensureFor` that ran again would leave
    // `changeTrust` as a no-op, and this is what says it did not run at all.
    expect(after.balances.filter((balance) => balance.asset_code === 'USDC')).toHaveLength(1);

    console.log(
      `[step 19] re-run status=${outcome.status} funder_calls=${app.funder.asked.length} ` +
        `sequence=${after.sequence} (unchanged) usdc_trustlines=${after.balances.length - 1}`,
    );
  }, 60_000);

  it('completes an account that was stored but never funded, rather than reporting it as done', async () => {
    // The stranded state, manufactured the only way the schema allows: a real sealed row for
    // a real user, with no funding transaction. It is reachable in production by exactly the
    // order this flow is built in - seal and store first, then spend - and then a funder that
    // refuses. The seed is sealed through KMS here, so the account is fully signable and
    // nothing in this test is a stub.
    const user = await app.prisma.user.create({
      data: {
        phoneNumber: `+2332${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
        phoneVerifiedAt: new Date(),
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    app.created.push(user.id);

    const sealed = await app.custody.createSealedAccount();
    await app.prisma.stellarAccount.create({
      data: {
        id: sealed.accountId,
        userId: user.id,
        publicKey: sealed.publicKey,
        encryptedSecretKey: sealed.encryptedSecretKey,
        dataKeyArn: sealed.dataKeyArn,
      },
      select: { id: true },
    });

    // Horizon has never heard of it, which is the state the row claims is not the case.
    await expect(horizonAccount(sealed.publicKey)).rejects.toThrow(/HTTP 404/);

    const outcome: ProvisioningOutcome = await app.provisioning.provisionFor(user.id);

    // The gap, on the real network. Before this fix the row alone answered
    // `already-provisioned`, so this account could never be funded or trusted by anyone,
    // however many times the service was called.
    expect(outcome).toMatchObject({ status: 'provisioned', publicKey: sealed.publicKey });

    if (outcome.status !== 'provisioned') {
      throw new Error(`resuming did not finish: ${JSON.stringify(outcome)}`);
    }

    // The funder ran for the *stored* key - the second account this run funded, and not the
    // first one's key reused.
    expect(app.funder.asked).toEqual([publicKey, sealed.publicKey]);

    // And the network agrees, which is the only check that counts: funded, and
    // trustline-active for this run's issuer.
    const account = await horizonAccount(sealed.publicKey);
    const native = account.balances.find((balance) => balance.asset_type === 'native');
    const usdc = account.balances.find(
      (balance) =>
        balance.asset_code === 'USDC' &&
        balance.asset_issuer === process.env['STELLAR_USDC_ISSUER'],
    );

    expect(Number(native?.balance)).toBeGreaterThan(0);
    expect(usdc?.balance).toBe('0.0000000');

    console.log(
      `[step 19] resumed account=${sealed.publicKey} xlm=${native?.balance ?? '?'} ` +
        `usdc_trustline=yes funding_tx=${outcome.fundingTransactionHash ?? '(funder named none)'} ` +
        `trustline_tx=${outcome.trustlineTransactionHash}`,
    );
  }, 120_000);
});
