import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { AUDIT_ACTIONS, type AuditAction } from './../src/audit/audit-events.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { IDEMPOTENCY_KEY_HEADER } from './../src/common/interceptors/idempotency.interceptor.js';
import { STEP_UP_TOKEN_HEADER } from './../src/identity/pin/step-up-token.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import {
  EMAIL_SENDER,
  type EmailMessage,
  type EmailSendResult,
  type EmailSender,
} from './../src/notifications/email/email-sender.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { PaymentsConfirmationService } from './../src/payments/services/payments-confirmation.service.js';
import {
  claimForSubmission,
  recordEnvelope,
} from './../src/payments/services/transaction-status.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  KeyCustodyUnavailableError,
  KEY_WRAPPER,
  type KeyDescription,
  type KeyWrapper,
  type UnwrapDataKeyRequest,
  type WrapDataKeyRequest,
  type WrappedDataKey,
} from './../src/wallet/custody/key-wrapper.js';
import { KmsKeyWrapper } from './../src/wallet/custody/kms-key-wrapper.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';
import { StellarAccountNotFoundError } from './../src/wallet/stellar/account-source.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Step 32's exit criterion, and deliberately the one the checklist spells out: **every listed
 * sensitive action produces a real row in `audit_log`** - verified by *triggering* each one and
 * reading the table, not by grepping the source for the calls.
 *
 * So every assertion below is a `SELECT` against the migrated database, and every trigger is the
 * application's own path: HTTP for the identity events (the registration, the sign-in, the PIN pair
 * and the payment), the bound `KEY_WRAPPER` for the two custody events, and the real
 * `PaymentsConfirmationService.sweep` for the two resolutions. A file that asserted `audit.log` had
 * been *called* would pass against a table
 * that did not exist; this one cannot.
 *
 * ## What is substituted, and what is not
 *
 * The app is the real `AppModule` - real Postgres, real Redis, the real OTP policy, the real queue,
 * the real `AuditService` over the real table. Five providers are replaced, and each is something a
 * test cannot have:
 *
 * - `SMS_SENDER`, because the code has to be read from somewhere.
 * - `EMAIL_SENDER`, for the same reason since Step 34c: the *other* code is only ever in the email,
 *   so an address cannot be confirmed without reading what was sent. The real binding is
 *   `ResendEmailSender`, so without this the attach below would try to send through Resend.
 * - `AccountProvisioningService`, so verification reaches no KMS, no friendbot and no Horizon - the
 *   wallet rows below are written directly, with keys the fake below recognises.
 * - `StellarService`, as the Horizon seam: the balance read the payment needs, and the transaction
 *   lookup the sweep needs. It answers "unavailable" for any hash it was not told about, which is
 *   what keeps this file's sweep from touching rows other files left in `PROCESSING`.
 * - `KmsKeyWrapper` - the *inner* half of the custody binding. `WalletModule` still builds the real
 *   `AuditedKeyWrapper` over it, so the custody tests exercise the app's own decorator, the app's own
 *   `AuditService` and the real table; only the AWS call is faked, for the reason
 *   `custody.e2e-spec.ts` is gated on `RUN_KMS_IT`: this file has to run with no KMS, no credentials
 *   and no network.
 *
 * ## What this run leaves behind, stated rather than discovered
 *
 * The entries this file appends are not removable - that is the table's whole promise, and the
 * migration's trigger is why. So the file reads only what its own ids point at (its user ids, its
 * payment ids, its account id) and never truncates the table, which would take rows other files
 * wrote. A local database therefore accumulates a handful of rows per run; CI does not run e2e at
 * all (it has no database service), so nothing in a pipeline grows without bound.
 */

/** The routes this file drives, with the same prefix and pipe `main.ts` installs. */
const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;

/** The PIN every registration sends (Step 34a): exactly four digits, or the DTO refuses the body. */
const PIN = '1234';

/**
 * A PIN that is not the one on the account, and the one the change below replaces it with.
 *
 * Both are four digits and neither is `PIN`, so a refusal or an acceptance below cannot be the
 * digits arriving twice: what the two calls at the end of this file prove is that a wrong PIN is
 * recorded as a failure and a right one changes the account.
 */
const WRONG_PIN = '9173';
const NEW_PIN = '5678';

/** The policy this file relies on, mirroring `configuration()`. */
const PIN_MAX_ATTEMPTS = 5;

const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;
/** The step-up call (Step 34a): proving the PIN is what a payment is allowed by. */
const PIN_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/pin/verify`;
/** The change call: the one that can replace a PIN, and therefore the one that appends `changed`. */
const PIN_CHANGE_PATH = `/${GLOBAL_PREFIX}/auth/pin/change`;
const LOGIN_CODE_PATH = `/${GLOBAL_PREFIX}/auth/login/otp`;
const LOGIN_PATH = `/${GLOBAL_PREFIX}/auth/login`;
/**
 * Step 34b's four: sign in with the password, set or change it, and the SMS reset pair.
 *
 * The reset pair is two routes on purpose - asking for a code and spending one are different calls -
 * and both answer the *same* body for a known and an unknown number, which is the property
 * `password.e2e-spec.ts` proves and this file only needs to trigger.
 */
const LOGIN_PASSWORD_PATH = `/${GLOBAL_PREFIX}/auth/login/password`;
const PASSWORD_CHANGE_PATH = `/${GLOBAL_PREFIX}/auth/password/change`;
const PASSWORD_RESET_PATH = `/${GLOBAL_PREFIX}/auth/password/reset`;
const PASSWORD_RESET_CONFIRM_PATH = `/${GLOBAL_PREFIX}/auth/password/reset/confirm`;
/** Step 34c's pair: attach an address, then confirm it with the code that was emailed to it. */
const EMAIL_PATH = `/${GLOBAL_PREFIX}/auth/email`;
const EMAIL_VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/email/verify`;
const PAYMENTS_PATH = `/${GLOBAL_PREFIX}/payments`;

/** The password this file sets, the one it replaces it with, and one that is neither. */
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different password';
const RESET_PASSWORD = 'the third password this account has had';
const WRONG_PASSWORD = 'not the password on this account';

/** Captures what would have been texted, so a code is readable without a phone. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  /** The newest code sent to one number, or a failure that says so. */
  latestCodeFor(phoneNumber: string): string {
    const messages = this.sent.filter((message) => message.to === phoneNumber);
    const message = messages[messages.length - 1];

    if (message === undefined) {
      throw new Error(`no SMS was captured for ${phoneNumber}`);
    }

    const matches = message.body.match(/\d{6}/g) ?? [];

    expect(matches).toHaveLength(1);

    return matches[0] as string;
  }
}

const smsSender = new CapturingSmsSender();

/**
 * Captures what would have been emailed, exactly as `CapturingSmsSender` captures a text.
 *
 * Step 34c's verification code exists in the message and nowhere else - the response deliberately
 * does not echo it - so this is what makes confirming an address possible in a test. The address a
 * message was sent *to* is the other half of what the assertions below read, and the reason this
 * sender keeps the whole `EmailMessage` rather than only the body.
 */
class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-email-${this.sent.length}` };
  }

  /** The newest code sent to one address, or a failure that says so. */
  latestCodeFor(address: string): string {
    const messages = this.sent.filter((message) => message.to === address);
    const message = messages[messages.length - 1];

    if (message === undefined) {
      throw new Error(`no email was captured for ${address}`);
    }

    const matches = message.body.match(/\d{6}/g) ?? [];

    expect(matches).toHaveLength(1);

    return matches[0] as string;
  }
}

const emailSender = new CapturingEmailSender();

/** `AccountProvisioningService`, replaced: no KMS, no Horizon, no Testnet account. */
class RecordingProvisioning {
  readonly provisioned: string[] = [];

  async provisionFor(userId: string): Promise<ProvisioningOutcome> {
    this.provisioned.push(userId);

    return {
      status: 'provisioned',
      accountId: `account-${userId}`,
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      funding: 'funded',
      fundingTransactionHash: 'funding-hash',
      trustlineTransactionHash: 'trustline-hash',
    };
  }
}

const provisioning = new RecordingProvisioning();

/**
 * Horizon and its transaction lookup, replaced by two maps.
 *
 * `balances` is what `BalancesService` reads before a payment; `settled` is what the sweep is told
 * about a hash. The default for an unknown hash is `unavailable` rather than `not-found` on purpose:
 * this file's sweep sees every `PROCESSING` row in the database, including the ones other files left
 * behind, and only "Horizon did not answer" leaves those exactly as they were (`unavailable` writes
 * nothing, at any deadline). The other two answers would resolve somebody else's fixture.
 */
class FakeStellar {
  /** The issuer every reported USDC line carries - set from the app's own configuration. */
  issuer = '';

  readonly balances = new Map<string, string>();

  readonly settled = new Map<string, { ledger: number; successful: boolean; code: string | null }>(
    [],
  );

  readonly looked: string[] = [];

  async loadBalances(accountId: string) {
    const balance = this.balances.get(accountId);

    if (balance === undefined) {
      throw new StellarAccountNotFoundError(accountId);
    }

    return [
      { asset_type: 'native', balance: '100.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: this.issuer,
        balance,
        limit: '922337203685.4775807',
        is_authorized: true,
      },
    ];
  }

  async lookupTransaction(hash: string) {
    this.looked.push(hash);

    const answer = this.settled.get(hash);

    if (answer === undefined) {
      return { kind: 'unavailable', detail: 'this run only answers for its own hashes' } as const;
    }

    return {
      kind: 'settled',
      ledger: answer.ledger,
      successful: answer.successful,
      transactionCode: answer.code,
    } as const;
  }

  network(): string {
    return 'TESTNET';
  }
}

const stellar = new FakeStellar();

/**
 * `KmsKeyWrapper`, replaced by an answer with no AWS behind it - and a switch for the refusal.
 *
 * It is bound *under* `AuditedKeyWrapper` (see the file's header), so the entries asserted below are
 * written by the real decorator against the real table.
 */
class FakeKms implements KeyWrapper {
  readonly wrapped = { accountId: '' };

  /** The ARN the fake resolves, in the shape a row would store. */
  keyArn = 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-0000-0000-000000000000';

  /** Set to make the next call fail the way an unreachable KMS does. */
  refusal: Error | null = null;

  async wrapDataKey(request: WrapDataKeyRequest): Promise<WrappedDataKey> {
    this.wrapped.accountId = request.accountId;

    if (this.refusal !== null) {
      throw this.refusal;
    }

    return {
      dataKey: Buffer.from('plaintext-data-key'),
      wrappedDataKey: Buffer.from('wrapped-data-key'),
      keyArn: this.keyArn,
    };
  }

  async unwrapDataKey(request: UnwrapDataKeyRequest): Promise<Buffer> {
    if (this.refusal !== null) {
      throw this.refusal;
    }

    expect(request.keyArn).toBe(this.keyArn);

    return Buffer.from('plaintext-data-key');
  }

  async describeMasterKey(): Promise<KeyDescription> {
    if (this.refusal !== null) {
      throw this.refusal;
    }

    return { arn: this.keyArn, region: 'eu-west-1', keyState: 'Enabled' };
  }
}

const kms = new FakeKms();

/** `+233241234567` from `0241234567`, asserted without the normalizer's help. */
function toE164(localNumber: string): string {
  const withoutTrunkPrefix = localNumber.replace(/^0/, '');

  expect(withoutTrunkPrefix).toMatch(/^2\d{8}$/);

  return `+233${withoutTrunkPrefix}`;
}

/** A number this run has not registered, in the local spelling. */
function freshLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/** The half of a session response this file needs. */
interface Session {
  userId: string;
  accessToken: string;
  /**
   * From `POST /v1/auth/pin/verify` (Step 34a): proof the transaction PIN was given, which every
   * `POST /v1/payments` request has to carry.
   */
  stepUpToken: string;
}

/** One entry, as this file reads it back - the columns every assertion is made about. */
interface Entry {
  action: string;
  userId: string | null;
  subjectId: string | null;
  outcome: string | null;
  metadata: unknown;
}

describe('Step 32: one real audit row per sensitive action (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let sender: Session;
  let recipient: Session;

  /** The sender's number in both spellings, and the handle prefix this run owns. */
  let senderNumber = '';
  let senderE164 = '';
  let prefix = '';

  /** The sender's `stellar_accounts` row: the subject of the two custody entries. */
  let accountId = '';

  /** Every id this run created, so the reads below cannot be answered by another run's rows. */
  const userIds: string[] = [];
  const subjectIds: string[] = [];
  const phoneNumbers: string[] = [];
  const handles: string[] = [];

  /**
   * The read this file exists to make: rows out of the real table, filtered to something this run
   * owns.
   *
   * `metadata` is selected because half of what these assertions are about is the *context* the step
   * demanded ("meaningful context", in the build sequence's words), and that is where it lives.
   */
  function entries(where: {
    action?: AuditAction;
    userId?: string;
    subjectId?: string;
  }): Promise<Entry[]> {
    return prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: { action: true, userId: true, subjectId: true, outcome: true, metadata: true },
    });
  }

  /** Registers, reads the code out of the captured SMS, and verifies - the whole Day 1 flow. */
  async function registerAndVerify(local: string, handle: string): Promise<Session> {
    const registration = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ pin: PIN, phoneNumber: local, handle });

    expect(
      registration.status,
      `expected 201 from ${REGISTER_PATH}, got ${registration.status} ${JSON.stringify(
        registration.body,
      )}`,
    ).toBe(201);

    const verification = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: smsSender.latestCodeFor(toE164(local)) });

    expect(
      verification.status,
      `expected 200 from ${VERIFY_PATH}, got ${verification.status} ${JSON.stringify(
        verification.body,
      )}`,
    ).toBe(200);

    /**
     * Step 34a: the PIN is proved in a second, deliberate call, and the token that answers it is
     * what allows a payment. Proving it here keeps every fixture in this file an account that can
     * actually pay - which is what the payment entry below is made with.
     */
    const stepUp = await request(app.getHttpServer())
      .post(PIN_VERIFY_PATH)
      .set('Authorization', `Bearer ${String(verification.body.accessToken)}`)
      .send({ pin: PIN })
      .expect(200);

    const session: Session = {
      userId: String(verification.body.userId),
      accessToken: String(verification.body.accessToken),
      stepUpToken: String(stepUp.body.stepUpToken),
    };

    userIds.push(session.userId);

    return session;
  }

  /**
   * The `stellar_accounts` row a finished provisioning would have left, plus the balance the fake
   * Horizon reports for it - written directly because `AccountProvisioningService` is substituted.
   * Its id is what the two custody entries are attributed to.
   */
  async function giveWallet(userId: string, balance: string): Promise<string> {
    const publicKey = `G${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 55)}`;

    const row = await prisma.stellarAccount.create({
      data: {
        userId,
        publicKey,
        // Nothing in this file reads the envelope; the columns are NOT NULL, and a real provisioning
        // would have sealed a real seed into them.
        encryptedSecretKey: 'cp-kms-1.test.test.test.test.test',
        dataKeyArn: kms.keyArn,
      },
      select: { id: true },
    });

    stellar.balances.set(publicKey, balance);

    return row.id;
  }

  /**
   * A `PROCESSING` row holding `hash`, written through Step 29's own writers.
   *
   * `senderId` is a parameter so the email test below can settle a payment for the account that
   * verified an address, while every other caller keeps the two fixtures above.
   */
  async function processingRowWithHash(hash: string, senderId = sender.userId): Promise<string> {
    const row = await prisma.transaction.create({
      data: {
        senderId,
        recipientId: recipient.userId,
        amount: '1.0000000',
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });

    subjectIds.push(row.id);

    expect(await claimForSubmission(prisma, row.id)).toBe(true);
    expect(
      await recordEnvelope(prisma, row.id, null, {
        hash,
        sequence: '1',
        deadline: new Date(Date.now() + 120_000),
      }),
    ).toBe(true);

    return row.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      // Step 34c's seam, replaced for the same reason and with the same shape: the code arrives in
      // an email, so the substituted sender is where the verification below reads it.
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .overrideProvider(StellarService)
      .useValue(stellar)
      // The *inner* half of the custody binding: `WalletModule` still builds the real
      // `AuditedKeyWrapper` over whatever is bound to this class.
      .overrideProvider(KmsKeyWrapper)
      .useValue(kms)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, so the paths below are the ones a client uses.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);
    // The same issuer `UsdcTrustlineService` compares the fake lines against, read from the app's own
    // configuration so the two cannot disagree.
    stellar.issuer = app.get(ConfigService).getOrThrow<string>('stellar.usdcIssuer');

    prefix = `audit${randomInt(1000, 10_000)}`;
    senderNumber = freshLocalNumber();
    const recipientNumber = freshLocalNumber();
    senderE164 = toE164(senderNumber);

    phoneNumbers.push(senderE164, toE164(recipientNumber));
    handles.push(`${prefix}s`, `${prefix}r`);

    // The database outlives a run, so a number or handle left behind by a run that died would make
    // the first insert of this one a 409 with nothing to do with this file.
    await prisma.transaction.deleteMany({
      where: {
        OR: [
          { sender: { phoneNumber: { in: phoneNumbers } } },
          { recipient: { phoneNumber: { in: phoneNumbers } } },
        ],
      },
    });
    await prisma.stellarAccount.deleteMany({
      where: { user: { phoneNumber: { in: phoneNumbers } } },
    });
    await prisma.user.deleteMany({
      where: { OR: [{ phoneNumber: { in: phoneNumbers } }, { handle: { in: handles } }] },
    });

    sender = await registerAndVerify(senderNumber, handles[0] as string);
    recipient = await registerAndVerify(recipientNumber, handles[1] as string);

    accountId = await giveWallet(sender.userId, '10.0000000');
    await giveWallet(recipient.userId, '0.0000000');
    subjectIds.push(accountId);

    console.log(
      `[step 32] audit run: sender=${sender.userId} recipient=${recipient.userId} account=${accountId}`,
    );
  }, 90_000);

  afterAll(async () => {
    if (app !== undefined) {
      // The rows this run wrote, and nothing else. The *entries* stay: `audit_log` takes no
      // `DELETE`, which is this file's subject - the header says why that is left visible rather
      // than worked around.
      await prisma.transaction.deleteMany({
        where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }] },
      });
      await prisma.stellarAccount.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await app.close();
    }
  }, 60_000);

  it('registering and verifying append user.handle.set and auth.otp.verified', async () => {
    // Both were triggered by `beforeAll`, through the API, and this is the table's answer. The
    // handle entry carries `source`, which is what tells a first claim from a resend; the
    // verification entry carries the account and nothing else, because the code and the number are
    // exactly what this table is not allowed to hold.
    expect(await entries({ action: 'user.handle.set', userId: sender.userId })).toEqual([
      {
        action: 'user.handle.set',
        userId: sender.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: { handle: handles[0], source: 'registration' },
      },
    ]);

    expect(await entries({ action: 'auth.otp.verified', userId: sender.userId })).toEqual([
      {
        action: 'auth.otp.verified',
        userId: sender.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);
  });

  it('signing in with a code appends auth.login', async () => {
    await request(app.getHttpServer())
      .post(LOGIN_CODE_PATH)
      .send({ phoneNumber: senderNumber })
      .expect(200);

    await request(app.getHttpServer())
      .post(LOGIN_PATH)
      .send({ phoneNumber: senderNumber, code: smsSender.latestCodeFor(senderE164) })
      .expect(200);

    expect(await entries({ action: 'auth.login', userId: sender.userId })).toEqual([
      {
        action: 'auth.login',
        userId: sender.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);
  });

  it('creating a payment appends payment.initiated, naming the row, the payer and the payee', async () => {
    const response = await request(app.getHttpServer())
      .post(PAYMENTS_PATH)
      .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
      .set('Authorization', `Bearer ${sender.accessToken}`)
      // Step 34a: the second credential, without which the guard answers 403 and no entry is made.
      .set(STEP_UP_TOKEN_HEADER, sender.stepUpToken)
      .send({ recipientId: recipient.userId, amount: '1.25' });

    expect(
      response.status,
      `expected 202 from ${PAYMENTS_PATH}, got ${response.status} ${JSON.stringify(response.body)}`,
    ).toBe(202);

    const paymentId = String(response.body.id);

    subjectIds.push(paymentId);

    // The three identities and the amount: the payment, the payer as `user_id`, the payee in the
    // metadata, and the amount as the canonical `Amount` string the row itself holds. The
    // idempotency key is deliberately absent - it is a client-chosen value, and three identities
    // are enough to answer "what was initiated".
    expect(await entries({ subjectId: paymentId })).toEqual([
      {
        action: 'payment.initiated',
        userId: sender.userId,
        subjectId: paymentId,
        outcome: 'ok',
        metadata: { amount: '1.25', recipientId: recipient.userId },
      },
    ]);
  });

  it('a key wrap, and a refused unwrap, each append a custody entry', async () => {
    const wrapper = app.get<KeyWrapper>(KEY_WRAPPER);

    await wrapper.wrapDataKey({ accountId });

    // The half that matters: a KMS call that did not happen. The refusal is the real custody error
    // the port declares, thrown by the fake, and the entry has to survive it - which it does because
    // the decorator writes before it rethrows.
    kms.refusal = new KeyCustodyUnavailableError('unwrap', 'AggregateError (ECONNREFUSED)');

    try {
      await expect(
        wrapper.unwrapDataKey({
          accountId,
          keyArn: kms.keyArn,
          wrappedDataKey: Buffer.from('wrapped-data-key'),
        }),
      ).rejects.toBeInstanceOf(KeyCustodyUnavailableError);
    } finally {
      kms.refusal = null;
    }

    const custody = await entries({ subjectId: accountId });

    // Both entries are attributed to the *account* and carry no `user_id`: the decorator sees what
    // the port sees, and a data key belongs to a `stellar_accounts` row. That is why the table has
    // no foreign keys - the two halves of this entry come from different rows.
    expect(custody).toContainEqual({
      action: 'custody.key.wrapped',
      userId: null,
      subjectId: accountId,
      outcome: 'ok',
      metadata: { keyArn: kms.keyArn },
    });
    expect(custody).toContainEqual({
      action: 'custody.key.unwrapped',
      userId: null,
      subjectId: accountId,
      outcome: 'failed',
      metadata: {
        detail: 'KeyCustodyUnavailableError: AggregateError (ECONNREFUSED)',
        keyArn: kms.keyArn,
      },
    });
  });

  it('the sweep appends payment.completed with the ledger, and payment.failed with the reason', async () => {
    const settledHash = 'c'.repeat(64);
    const refusedHash = 'd'.repeat(64);

    stellar.settled.set(settledHash, { ledger: 4_321_000, successful: true, code: null });
    stellar.settled.set(refusedHash, {
      ledger: 4_321_001,
      successful: false,
      code: 'tx_failed',
    });

    const settled = await processingRowWithHash(settledHash);
    const refused = await processingRowWithHash(refusedHash);

    // The real sweep, over the real table, with the app's own `AuditService`. It also sees whatever
    // `PROCESSING` rows this database is holding from other runs; the fake answers `unavailable` for
    // any hash it was not told about, so those are counted and left exactly as they were.
    const result = await app.get(PaymentsConfirmationService).sweep();

    expect(result.confirmed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const resolved = await prisma.transaction.findMany({
      where: { id: { in: [settled, refused] } },
      select: { id: true, status: true, failureReason: true },
    });

    expect(resolved).toContainEqual({ id: settled, status: 'SUCCESSFUL', failureReason: null });
    expect(resolved).toContainEqual({
      id: refused,
      status: 'FAILED',
      failureReason: 'landed-unsuccessful:tx_failed',
    });

    // The two entries, each read back from the table. The ledger on the successful one is the
    // number the lookup reported, and the reason on the failed one is the string the row was given -
    // decided once and written to both places, so the trail and the payment cannot disagree.
    expect(await entries({ subjectId: settled })).toEqual([
      {
        action: 'payment.completed',
        userId: sender.userId,
        subjectId: settled,
        outcome: 'ok',
        metadata: { ledger: 4_321_000 },
      },
    ]);
    expect(await entries({ subjectId: refused })).toEqual([
      {
        action: 'payment.failed',
        userId: sender.userId,
        subjectId: refused,
        outcome: 'failed',
        metadata: { reason: 'landed-unsuccessful:tx_failed' },
      },
    ]);
  });

  it('refuses an UPDATE and a DELETE, so a row that exists is a row as written', async () => {
    const before = await entries({ userId: sender.userId });

    expect(before.length).toBeGreaterThan(0);

    // The trigger, not the service: this is the statement a support engineer would type, and it is
    // refused by the database. The raw UPDATE is asserted on its *message* because that is what a
    // caller sees; the model-level `deleteMany` is asserted on its effect, because Prisma's own
    // wrapper is free to reword the database's text.
    await expect(
      prisma.$executeRaw`UPDATE "audit_log" SET "outcome" = 'tampered' WHERE "user_id" = ${sender.userId}::uuid`,
    ).rejects.toThrow(/append-only/);

    await expect(prisma.auditLog.deleteMany({ where: { userId: sender.userId } })).rejects.toThrow();

    // Compared as a set of serialised rows rather than as an array: two entries written in the same
    // millisecond have an order the database does not promise, and this assertion is about the rows
    // themselves - that they are exactly what they were before the two statements.
    const after = await entries({ userId: sender.userId });

    expect(after.map((row) => JSON.stringify(row)).sort()).toEqual(
      before.map((row) => JSON.stringify(row)).sort(),
    );
    expect(after).toHaveLength(before.length);
  });

  it('a wrong PIN appends auth.pin.failed, and a real change appends auth.pin.changed', async () => {
    // Step 34a's last two actions, triggered the way a client triggers them: the step-up call with a
    // PIN that is not this account's, then the change that replaces it. They are here, after every
    // other trigger, because the change takes away the PIN the fixtures above pay with - the
    // sender's step-up token was proved in `beforeAll` and is not needed again below.
    const wrong = await request(app.getHttpServer())
      .post(PIN_VERIFY_PATH)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({ pin: WRONG_PIN });

    expect(
      wrong.status,
      `expected 401 from ${PIN_VERIFY_PATH}, got ${wrong.status} ${JSON.stringify(wrong.body)}`,
    ).toBe(401);

    const changed = await request(app.getHttpServer())
      .post(PIN_CHANGE_PATH)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({ pin: NEW_PIN, currentPin: PIN });

    expect(
      changed.status,
      `expected 200 from ${PIN_CHANGE_PATH}, got ${changed.status} ${JSON.stringify(
        changed.body,
      )}`,
    ).toBe(200);

    /**
     * The refusal carries the endpoint it arrived on and what is left of the allowance - the two
     * facts that tell "someone is guessing at a payment PIN" apart from "someone's connection
     * retried" - and the change carries nothing at all: that it happened is the whole entry.
     *
     * Neither row holds a PIN. That is the rule the metadata column is written under, and the reason
     * a support engineer can read this table at all: `auth.pin.failed` is an *event*, not the digits
     * somebody tried.
     */
    expect(await entries({ action: 'auth.pin.failed', userId: sender.userId })).toEqual([
      {
        action: 'auth.pin.failed',
        userId: sender.userId,
        subjectId: null,
        outcome: 'failed',
        metadata: { context: 'verify', attemptsRemaining: PIN_MAX_ATTEMPTS - 1 },
      },
    ]);

    expect(await entries({ action: 'auth.pin.changed', userId: sender.userId })).toEqual([
      {
        action: 'auth.pin.changed',
        userId: sender.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);

    // And the digits are nowhere in what this run wrote for the account: read whole, as the file's
    // other assertions about secrets are, so a PIN in *any* column of the row would fail this.
    const written = await entries({ userId: sender.userId });

    expect(JSON.stringify(written)).not.toContain(WRONG_PIN);
    expect(JSON.stringify(written)).not.toContain(NEW_PIN);
  });

  it('setting, changing and signing in with a password each append a row', async () => {
    /**
     * A third account of its own, rather than one of the two fixtures above.
     *
     * `otp.requestsPerWindow` is three: the fixtures have already spent one on a registration and
     * one on the code sign-in, which leaves room for exactly one more issue and a password sign-in
     * costs one per attempt. A fresh number keeps this test's own budget separate from theirs
     * instead of making the two tests' order matter.
     */
    const local = freshLocalNumber();
    const account = await registerAndVerify(local, `${prefix}p`);

    // Set, then change: the first write is `set` (there was no password) and the second is
    // `changed`, which is the whole reason the two literals are separate.
    const set = await request(app.getHttpServer())
      .post(PASSWORD_CHANGE_PATH)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: PASSWORD });

    expect(
      set.status,
      `expected 200 from ${PASSWORD_CHANGE_PATH}, got ${set.status} ${JSON.stringify(set.body)}`,
    ).toBe(200);

    await request(app.getHttpServer())
      .post(PASSWORD_CHANGE_PATH)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ password: NEW_PASSWORD, currentPassword: PASSWORD })
      .expect(200);

    expect(await entries({ action: 'auth.password.set', userId: account.userId })).toEqual([
      {
        action: 'auth.password.set',
        userId: account.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);

    expect(await entries({ action: 'auth.password.changed', userId: account.userId })).toEqual([
      {
        action: 'auth.password.changed',
        userId: account.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);

    // The refusal and then the acceptance, the same pair the PIN test above makes: `denied` is
    // one outcome for "no such account", "no password set" and "wrong password", because the HTTP
    // answer is one message for all three - and the row is what tells a guessing attack from a
    // mistyped password.
    await request(app.getHttpServer())
      .post(LOGIN_PASSWORD_PATH)
      .send({ phoneNumber: local, password: WRONG_PASSWORD })
      .expect(401);

    const signedIn = await request(app.getHttpServer())
      .post(LOGIN_PASSWORD_PATH)
      .send({ phoneNumber: local, password: NEW_PASSWORD });

    expect(
      signedIn.status,
      `expected 200 from ${LOGIN_PASSWORD_PATH}, got ${signedIn.status} ${JSON.stringify(
        signedIn.body,
      )}`,
    ).toBe(200);

    const signIns = await entries({ action: 'auth.password.login', userId: account.userId });

    expect(signIns.map((entry) => entry.outcome).sort()).toEqual(['denied', 'ok']);
    expect(signIns).toContainEqual({
      action: 'auth.password.login',
      userId: account.userId,
      subjectId: null,
      outcome: 'denied',
      metadata: null,
    });

    // And no password is anywhere in what this run wrote for the account - read whole, as the PIN
    // assertion above does, so a password in *any* column of a row would fail this.
    const written = await entries({ userId: account.userId });

    expect(JSON.stringify(written)).not.toContain(PASSWORD);
    expect(JSON.stringify(written)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(written)).not.toContain(WRONG_PASSWORD);
  });

  it('a reset, an email attach and its verification each append a row, and a settled payment reaches both channels', async () => {
    // A fourth account, for the reason the third one exists: this test issues a reset code, and
    // `otp.requestsPerWindow` is per number.
    const local = freshLocalNumber();
    const e164 = toE164(local);
    const account = await registerAndVerify(local, `${prefix}e`);

    await request(app.getHttpServer())
      .post(PASSWORD_RESET_PATH)
      .send({ phoneNumber: local })
      .expect(202);

    const resetCode = smsSender.latestCodeFor(e164);

    await request(app.getHttpServer())
      .post(PASSWORD_RESET_CONFIRM_PATH)
      .send({ phoneNumber: local, code: resetCode, newPassword: RESET_PASSWORD })
      .expect(200);

    // The request is written only for a number that resolved to an account - a request for an
    // unknown one sends nothing and writes nothing, which is what keeps the identical HTTP answer
    // from being an enumeration oracle.
    expect(
      await entries({ action: 'auth.password.reset.requested', userId: account.userId }),
    ).toEqual([
      {
        action: 'auth.password.reset.requested',
        userId: account.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);

    expect(
      await entries({ action: 'auth.password.reset.completed', userId: account.userId }),
    ).toEqual([
      {
        action: 'auth.password.reset.completed',
        userId: account.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: null,
      },
    ]);

    // The writing of the new password is the *other* writer of `auth.password.changed`: one literal
    // for "the password in force was replaced", whether the old one was proved or a code was - and
    // `reset.completed` above is the flow finishing, which is a different fact.
    expect(await entries({ action: 'auth.password.changed', userId: account.userId })).toHaveLength(
      1,
    );

    const address = `audit-${randomUUID()}@example.com`;

    await request(app.getHttpServer())
      .post(EMAIL_PATH)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ email: address })
      .expect(200);

    // The row names the account and never the address: an address is a personal identifier, and the
    // rule this table is read under is that no identifier but the account id appears in the clear.
    const setRows = await entries({ action: 'auth.email.set', userId: account.userId });

    expect(setRows).toContainEqual({
      action: 'auth.email.set',
      userId: account.userId,
      subjectId: null,
      outcome: 'ok',
      metadata: { userId: account.userId },
    });
    expect(JSON.stringify(setRows)).not.toContain(address);

    await request(app.getHttpServer())
      .post(EMAIL_VERIFY_PATH)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ code: emailSender.latestCodeFor(address) })
      .expect(200);

    expect(await entries({ action: 'auth.email.verified', userId: account.userId })).toEqual([
      {
        action: 'auth.email.verified',
        userId: account.userId,
        subjectId: null,
        outcome: 'ok',
        metadata: { userId: account.userId },
      },
    ]);

    /**
     * The second delivery channel, over the real sweep.
     *
     * `PaymentsConfirmationService.notify` is the only caller that passes an address, and it passes
     * one *only* when `email_verified_at` is set - so this is the claim Step 34c is about: a settled
     * payment reaches the address as well as the number, and the two say the same thing.
     */
    await giveWallet(account.userId, '10.0000000');

    const settledHash = 'e'.repeat(64);

    stellar.settled.set(settledHash, { ledger: 4_322_000, successful: true, code: null });

    const paid = await processingRowWithHash(settledHash, account.userId);

    await app.get(PaymentsConfirmationService).sweep();

    // By subject as well as by address: the mailbox already received the verification code, and "the
    // receipt went there" is a claim about a receipt, not about the mailbox.
    const receipts = emailSender.sent.filter(
      (message) => message.to === address && /went through/.test(message.subject),
    );
    const texted = smsSender.sent.filter((message) => message.to === e164);

    expect(receipts).toHaveLength(1);
    // The email body *is* the string that was texted - one template, two transports - which is what
    // makes a second channel worth having rather than a second set of wording to keep in step.
    expect(receipts[0]?.body).toBe(texted[texted.length - 1]?.body);

    // And the payment's own row is the one the earlier sweep test describes the shape of.
    expect((await entries({ subjectId: paid })).map((entry) => entry.action)).toEqual([
      'payment.completed',
    ]);

    /**
     * The negative half, and the rule the two columns exist for: a *replaced* address is written
     * unverified, so the next settlement texts the number and emails nobody. The attach itself is
     * still a row - the account does hold the address - and the row still does not hold it.
     */
    const unproved = `unproved-${randomUUID()}@example.com`;

    await request(app.getHttpServer())
      .post(EMAIL_PATH)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ email: unproved })
      .expect(200);

    const unprovedHash = 'f'.repeat(64);

    stellar.settled.set(unprovedHash, { ledger: 4_322_001, successful: true, code: null });

    await processingRowWithHash(unprovedHash, account.userId);

    await app.get(PaymentsConfirmationService).sweep();

    expect(smsSender.sent.filter((message) => message.to === e164).length).toBeGreaterThan(
      texted.length,
    );
    // By subject as well, and for the same reason as the pair above: attaching this address mailed
    // *it* a verification code, so "nothing was emailed to that address" is not a claim this test can
    // make - "no receipt went there" is the one the two columns decide.
    expect(
      emailSender.sent.filter(
        (message) => message.to === unproved && /went through/.test(message.subject),
      ),
    ).toHaveLength(0);
    // Still exactly one receipt: the address the second settlement could not use is the one this
    // account had just replaced, so that settlement emailed nobody.
    expect(
      emailSender.sent.filter(
        (message) => message.to === address && /went through/.test(message.subject),
      ),
    ).toHaveLength(1);

    const bothAttaches = await entries({ action: 'auth.email.set', userId: account.userId });

    expect(bothAttaches).toHaveLength(2);
    expect(JSON.stringify(bothAttaches)).not.toContain(address);
    expect(JSON.stringify(bothAttaches)).not.toContain(unproved);
  });

  it('has a row in the table for every action in the vocabulary', async () => {
    // The checklist item, computed rather than asserted in prose: every action `AUDIT_ACTIONS`
    // declares has at least one row that this run's ids point at, and the rows came from the triggers
    // above rather than from a fixture.
    const written = await prisma.auditLog.findMany({
      where: {
        OR: [{ userId: { in: userIds } }, { subjectId: { in: subjectIds } }],
      },
      select: { action: true },
    });

    const seen = new Set(written.map((row) => row.action));
    const missing = [...AUDIT_ACTIONS].filter((action) => !seen.has(action));

    expect(missing, `no audit row was written for: ${missing.join(', ')}`).toEqual([]);

    console.log(
      `[step 32] audit trail: ${written.length} rows written for ${seen.size}/${AUDIT_ACTIONS.length} actions`,
    );
  });
});
