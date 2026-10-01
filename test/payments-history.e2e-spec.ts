import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import { TransactionStatus, UserStatus } from './../src/generated/prisma/enums.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import {
  claimForSubmission,
  markFailed,
  markSuccessful,
  recordEnvelope,
} from './../src/payments/services/transaction-status.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';
import {
  StellarAccountNotFoundError,
  type StellarBalanceLine,
} from './../src/wallet/stellar/account-source.js';
import { StellarService } from './../src/wallet/stellar/stellar.service.js';

/**
 * Step 30 over real HTTP, against real Postgres: `GET /v1/payments` and `GET /v1/payments/:id`,
 * with **thirty rows a test did not write by hand**.
 *
 * ## Why thirty, and why a real database
 *
 * The audit item this file answers says the history endpoint has to paginate and filter "against
 * real data, not just a small fixture that happens to pass" - and the failure mode a small fixture
 * hides is exactly the one that matters here. A boundary bug (a page of twenty asked for as
 * twenty-one, an inclusive `to` built as exclusive, an order that is not total) is invisible at
 * three rows and obvious at thirty, because thirty is more than one page: the row at the seam and
 * the page that must not claim to be the whole answer appear only once a list is longer than a page.
 * The last one - an order that is not total - is the exception a long list cannot demonstrate, so it
 * is carried separately by a pair of rows written at the same instant (the control pair below), whose
 * page has no chronology to sort it by.
 *
 * So the rows are seeded straight into `transactions` - the API has no way to write thirty
 * payments, and driving this through `POST /v1/payments` would make the file a test of Step 25 -
 * with one property chosen for the filter assertions: **one row per hour**, so a `from`/`to`
 * boundary can be placed exactly on a row's `createdAt` and the inclusive end proved rather than
 * assumed.
 *
 * ## What is substituted, and what is not
 *
 * The app is the real `AppModule`: real Postgres, real Redis, the global validation pipe, the
 * shared exception filter, the JWT guard, the real `PaymentsService` and the real query module.
 * Three providers are replaced, and each is a thing a test cannot have:
 *
 * - `SMS_SENDER`, so the registration codes can be read (`auth.e2e-spec.ts` does the same).
 * - `AccountProvisioningService`, so verification reaches no KMS and no Horizon. Nothing here reads
 *   a balance - the rows are seeded - but a real provisioning call would still be a real network
 *   call in the middle of `beforeAll`.
 * - `StellarService`, the Horizon seam, replaced by one that reports every account as absent. The
 *   two routes under test must not reach it at all, and a fake that answers nothing is how that
 *   stops being a claim about the code and becomes a fact about the run.
 *
 * ## The rows are moved by the state machine, not by this file
 *
 * A row is created `PENDING` (the column's own default) and then claimed and resolved through
 * `claimForSubmission` / `markSuccessful` / `markFailed` - the same writers the submission path
 * uses - because Step 29's rule is a lint over `test/` as well: `status` is written in exactly one
 * file, and this is not it. The side effect is a better fixture: every non-`PENDING` row here is in
 * a state something actually produced.
 *
 * ## Running it
 *
 * Local-only, like the other e2e files: it needs the compose stack (`docker compose up -d postgres
 * redis`) and a `.env`. It is not part of CI. `npm run test:e2e test/payments-history.e2e-spec.ts`.
 */

const PAYMENTS_PATH = `/${GLOBAL_PREFIX}/payments`;
const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;

/** One row of history, as a page spells it. */
interface HistoryItem {
  id: string;
  status: string;
  amount: string;
  direction: string;
  recipientId: string;
  createdAt: string;
}

/** The body of `GET /v1/payments`. */
interface ListBody {
  items: HistoryItem[];
  hasMore: boolean;
}

/** The body of `GET /v1/payments/:id`: a history row plus the two fields only one payment carries. */
interface PaymentDetail extends HistoryItem {
  failureReason: string | null;
  stellarTxHash: string | null;
}

/** A response, as this file asserts about it. */
interface RawResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Captures what would have been texted, so the verification code is readable here. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  latestFor(phoneNumber: string): SmsMessage | undefined {
    const messages = this.sent.filter((message) => message.to === phoneNumber);

    return messages[messages.length - 1];
  }
}

const smsSender = new CapturingSmsSender();

/** `AccountProvisioningService`, replaced: no KMS, no Horizon, no Testnet account. */
class RecordingProvisioning {
  async provisionFor(): Promise<ProvisioningOutcome> {
    return {
      status: 'provisioned',
      accountId: randomUUID(),
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      funding: 'funded',
      fundingTransactionHash: 'funding-hash',
      trustlineTransactionHash: 'trustline-hash',
    };
  }
}

const provisioning = new RecordingProvisioning();

/**
 * Horizon, replaced by one that knows no accounts.
 *
 * `loadBalances` is the only method a balance read reaches, and reporting every key absent is the
 * strongest available form of "this run did not ask": a read of a balance would fail here rather
 * than quietly succeed against a fixture.
 */
class AbsentStellar {
  async loadBalances(accountId: string): Promise<readonly StellarBalanceLine[]> {
    throw new StellarAccountNotFoundError(accountId);
  }

  network(): string {
    return 'TESTNET';
  }
}

const stellar = new AbsentStellar();

/** A number this run has not registered, in the local spelling. */
function freshLocalNumber(): string {
  return `024${randomInt(0, 10 ** 7)
    .toString()
    .padStart(7, '0')}`;
}

/** `+233241234567` from `0241234567`, asserted without the normalizer's help. */
function toE164(localNumber: string): string {
  const withoutTrunkPrefix = localNumber.replace(/^0/, '');

  expect(withoutTrunkPrefix).toMatch(/^2\d{8}$/);

  return `+233${withoutTrunkPrefix}`;
}

/** The single code in an SMS body. */
function codeFrom(body: string): string {
  const matches = body.match(/\d{6}/g) ?? [];

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

/** The half of a session response this file needs. */
interface Session {
  userId: string;
  accessToken: string;
}

/** The instant the oldest seeded row was written: `2026-06-01T00:00:00.000Z`. */
const FIRST_ROW_AT = Date.UTC(2026, 5, 1, 0, 0, 0, 0);

const HOUR_MS = 3_600_000;

/**
 * The four statuses, cycled so every filter matches something - and does not match something else.
 *
 * The cycle's period (four) is deliberately not a multiple of the direction's (two), which is what
 * gives each status rows in both directions and makes the `direction`+`status` assertions mean
 * something.
 */
const STATUS_CYCLE = [
  TransactionStatus.PENDING,
  TransactionStatus.PROCESSING,
  TransactionStatus.SUCCESSFUL,
  TransactionStatus.FAILED,
] as const;

/** The machine code every `FAILED` row here carries, in Step 27's vocabulary. */
const FAILURE_REASON = 'landed-unsuccessful:tx_failed';

/** Rows the caller is a party to: more than one page, so a page boundary and its `hasMore` exist. */
const SEEDED_ROWS = 30;

/** One seeded payment: an amount, a sender, a status, and an hour. */
interface SeededRow {
  readonly index: number;
  readonly amount: string;
  readonly sender: 'viewer' | 'partner';
  readonly status: TransactionStatus;
  readonly createdAt: Date;
}

/**
 * The fixture, as data rather than as thirty literal calls.
 *
 * `sender` alternates, so the caller sent fifteen rows and received fifteen. The amount carries the
 * row's index (`1.0000001` … `30.0000001`), which makes a page's order readable in an assertion and
 * in a failure message, and exercises the seventh decimal of `numeric(20, 7)` on real rows.
 */
function seedPlan(): SeededRow[] {
  return Array.from({ length: SEEDED_ROWS }, (_, index) => ({
    index,
    amount: `${index + 1}.0000001`,
    sender: index % 2 === 0 ? 'viewer' : 'partner',
    status: statusFor(index),
    createdAt: new Date(FIRST_ROW_AT + index * HOUR_MS),
  }));
}

/**
 * The status of row `index`, cycling through all four.
 *
 * The fallback is unreachable (`index % 4` is always one of `0..3`); it is there because the
 * compiler cannot know that, and the alternative is a non-null assertion.
 */
function statusFor(index: number): TransactionStatus {
  return STATUS_CYCLE[index % STATUS_CYCLE.length] ?? TransactionStatus.PENDING;
}

/** The `createdAt` of row `index`, as an ISO string - the value a `from`/`to` bound is written with. */
function at(index: number): string {
  return new Date(FIRST_ROW_AT + index * HOUR_MS).toISOString();
}

/**
 * The hash a seeded row's transaction carries: the row's number in the first byte, `e` after it.
 *
 * Sixty-four hex digits, like a real one, unique per row, and readable in a failure message - which
 * a random UUID would not be.
 */
function hashFor(index: number): string {
  return (index + 1).toString(16).padStart(2, '0').padEnd(64, 'e');
}

describe('Payment history (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** The caller: a party to every seeded row this file lists. */
  let viewer: Session;
  /** The other party: sender or recipient on each of those rows, and on nothing else. */
  let partner: Session;
  /** A third account, a party to no row the caller can see. */
  let stranger: Session;

  /**
   * The caller's rows in seed order, so an assertion can say "row 7" rather than repeat an amount.
   * `seeded[7]` is the seventh-oldest of the thirty, at `FIRST_ROW_AT + 7 hours`.
   */
  let seeded: Array<{ index: number; id: string; amount: string }> = [];

  /** A payment neither the caller nor the partner is a party to: the control for the scope tests. */
  let strangersPaymentId = '';

  /**
   * A second payment between those same two other accounts, written at the *same instant* as the
   * control above (and therefore at the same instant as one of the caller's own rows).
   *
   * This pair is what makes the endpoint's order observable rather than assumed. Thirty rows an hour
   * apart are already in a total order by `createdAt` alone, so they cannot tell "newest first" from
   * "newest first, ties broken by id" - two rows sharing an instant can. The stranger's page is where
   * they show up: two rows, one millisecond, no chronology to sort them by.
   */
  let tiedPaymentId = '';

  /** Everything a registered account leaves behind, so `afterAll` can remove exactly that. */
  const numbersWritten: string[] = [];
  const claimedHandles: string[] = [];
  const userIds: string[] = [];

  /** `GET /v1/payments`, as an actor. */
  async function list(actor: Session, query: Record<string, string> = {}): Promise<RawResponse> {
    const response = await request(app.getHttpServer())
      .get(PAYMENTS_PATH)
      .query(query)
      .set('Authorization', `Bearer ${actor.accessToken}`);

    return { status: response.status, body: response.body as Record<string, unknown> };
  }

  /** `GET /v1/payments/:id`, as an actor. */
  async function detail(actor: Session, id: string): Promise<RawResponse> {
    const response = await request(app.getHttpServer())
      .get(`${PAYMENTS_PATH}/${id}`)
      .set('Authorization', `Bearer ${actor.accessToken}`);

    return { status: response.status, body: response.body as Record<string, unknown> };
  }

  /** The response as a page, failing loudly with the body if it was not a 200. */
  function page(response: RawResponse, what: string): ListBody {
    expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(200);

    return response.body as unknown as ListBody;
  }

  /** The response as one payment, failing loudly with the body if it was not a 200. */
  function payment(response: RawResponse, what: string): PaymentDetail {
    expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(200);

    return response.body as unknown as PaymentDetail;
  }

  /**
   * One seeded payment: written the way the API writes one, then moved by the state machine.
   *
   * `createdAt` is written explicitly rather than left to `now()`, because the filter tests put a
   * boundary exactly on a row's timestamp. The status is *not* written here - the column's default
   * makes the row `PENDING`, and `claimForSubmission`, `recordEnvelope`, `markSuccessful` and
   * `markFailed` are the only writers Step 29 allows, in this directory too, where
   * `npm run lint:status` scans. Each write is asserted to have landed, so a fixture that silently
   * failed to reach a state fails here rather than in an assertion about filtering.
   *
   * A row that has left `PENDING` is given the record a submission leaves behind (a hash, a
   * sequence, a deadline), because a real `PROCESSING` or `SUCCESSFUL` row has one - and because
   * the two bodies differ in exactly this: `stellarTxHash` is on the detail response and absent
   * from a list item.
   */
  async function seed(row: SeededRow): Promise<{ id: string; amount: string }> {
    const created = await prisma.transaction.create({
      data: {
        senderId: row.sender === 'viewer' ? viewer.userId : partner.userId,
        recipientId: row.sender === 'viewer' ? partner.userId : viewer.userId,
        amount: row.amount,
        idempotencyKey: randomUUID(),
        createdAt: row.createdAt,
      },
      select: { id: true },
    });

    if (row.status !== TransactionStatus.PENDING) {
      expect(await claimForSubmission(prisma, created.id)).toBe(true);

      expect(
        await recordEnvelope(prisma, created.id, null, {
          hash: hashFor(row.index),
          sequence: `${4_000_000_000 + row.index}`,
          deadline: new Date(row.createdAt.getTime() + 60_000),
        }),
      ).toBe(true);
    }

    if (row.status === TransactionStatus.SUCCESSFUL) {
      expect(await markSuccessful(prisma, created.id)).toBe(true);
    }

    if (row.status === TransactionStatus.FAILED) {
      expect(await markFailed(prisma, created.id, FAILURE_REASON)).toBe(true);
    }

    return { id: created.id, amount: row.amount };
  }

  /** Registers and verifies an account, the way a real user's is created. */
  async function registerAndVerify(local: string, e164: string, handle: string): Promise<Session> {
    const registration = await request(app.getHttpServer())
      .post(REGISTER_PATH)
      .send({ phoneNumber: local, handle });

    expect(
      registration.status,
      `expected 201 from ${REGISTER_PATH}, got ${registration.status} ${JSON.stringify(
        registration.body,
      )}`,
    ).toBe(201);

    claimedHandles.push(handle.toLowerCase());

    const message = smsSender.latestFor(e164);

    expect(message, `no verification code was texted to ${e164}`).toBeDefined();

    const response = await request(app.getHttpServer())
      .post(VERIFY_PATH)
      .send({ phoneNumber: local, code: codeFrom((message as SmsMessage).body) })
      .expect(200);

    const session: Session = {
      userId: response.body.userId as string,
      accessToken: response.body.accessToken as string,
    };

    userIds.push(session.userId);

    return session;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .overrideProvider(StellarService)
      .useValue(stellar)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`: without the prefix every path below 404s, and without the pipe
    // the query strings and ids this file refuses would reach the service instead of being stopped
    // at the door - which is half of what is asserted here.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);

    const prefix = `h${randomInt(1000, 10000)}`;
    const handles = {
      viewer: `${prefix}v`,
      partner: `${prefix}p`,
      stranger: `${prefix}s`,
      unrelated: `${prefix}u`,
    };
    claimedHandles.push(...Object.values(handles));

    const numbers = {
      viewer: freshLocalNumber(),
      partner: freshLocalNumber(),
      stranger: freshLocalNumber(),
      unrelated: freshLocalNumber(),
    };
    const numbersE164 = Object.fromEntries(
      Object.entries(numbers).map(([who, local]) => [who, toE164(local)]),
    ) as Record<keyof typeof numbers, string>;

    numbersWritten.push(...Object.values(numbersE164));

    // The database outlives a run, so a number or handle left behind by a run that died would make
    // the first registration of this one a 409 - a failure with nothing to do with this file.
    await prisma.transaction.deleteMany({
      where: {
        OR: [
          { sender: { phoneNumber: { in: numbersWritten } } },
          { recipient: { phoneNumber: { in: numbersWritten } } },
        ],
      },
    });
    await prisma.stellarAccount.deleteMany({
      where: { user: { phoneNumber: { in: numbersWritten } } },
    });
    await prisma.user.deleteMany({ where: { phoneNumber: { in: numbersWritten } } });
    await prisma.user.deleteMany({ where: { handle: { in: claimedHandles } } });

    viewer = await registerAndVerify(numbers.viewer, numbersE164.viewer, handles.viewer);
    partner = await registerAndVerify(numbers.partner, numbersE164.partner, handles.partner);
    stranger = await registerAndVerify(numbers.stranger, numbersE164.stranger, handles.stranger);

    /**
     * The fourth account is written directly rather than registered: it exists only to be the far
     * side of one payment the caller is not a party to, so it never signs in and needs no session.
     */
    const unrelated = await prisma.user.create({
      data: {
        phoneNumber: numbersE164.unrelated,
        handle: handles.unrelated,
        status: UserStatus.ACTIVE,
        phoneVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    userIds.push(unrelated.id);

    seeded = [];

    for (const row of seedPlan()) {
      const written = await seed(row);

      seeded.push({ index: row.index, id: written.id, amount: written.amount });
    }

    expect(seeded).toHaveLength(SEEDED_ROWS);

    /**
     * The control: a payment between the two accounts the caller is not a party to, written the way
     * a real one is and left `PENDING`.
     *
     * It is what makes the 404 below a statement about *scope* rather than about a row that merely
     * is not in the table: this id exists, names a real payment between two real people, and is
     * still invisible to the caller - and if the list ever lost its membership clause, this row
     * would be the one to arrive in the page.
     */
    const strangers = await prisma.transaction.create({
      data: {
        senderId: stranger.userId,
        recipientId: unrelated.id,
        amount: '7.0000001',
        idempotencyKey: randomUUID(),
        createdAt: new Date(FIRST_ROW_AT + 10 * HOUR_MS),
      },
      select: { id: true },
    });

    strangersPaymentId = strangers.id;

    /**
     * The same two accounts, the other way round, at the same millisecond.
     *
     * Read from the stranger's side this is the tie: two rows with one `createdAt`, so the page's
     * order is the endpoint's tiebreak and nothing else - and the two rows are also one `sent` and
     * one `received`, which is how a caller's side is shown to be derived per row rather than per
     * request. Both are between the stranger and the fourth account, so neither is a party the
     * caller can be on and both make the 404 below a statement about scope.
     */
    const tied = await prisma.transaction.create({
      data: {
        senderId: unrelated.id,
        recipientId: stranger.userId,
        amount: '7.0000002',
        idempotencyKey: randomUUID(),
        createdAt: new Date(FIRST_ROW_AT + 10 * HOUR_MS),
      },
      select: { id: true },
    });

    tiedPaymentId = tied.id;
  }, 120_000);

  afterAll(async () => {
    /**
     * Transactions first: both relations are `ON DELETE RESTRICT` deliberately - the database
     * refuses to destroy payment history quietly - so this file's thirty-odd rows have to go before
     * the accounts they name can.
     */
    await prisma.transaction.deleteMany({
      where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }] },
    });
    await prisma.stellarAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await app.close();
  }, 60_000);

  /** The seeded row at `index`, failing loudly where the seed plan and an expectation disagree. */
  function rowAt(index: number): { index: number; id: string; amount: string } {
    const row = seeded[index];

    if (row === undefined) {
      throw new Error(`no seeded row ${index} - the seed plan and this expectation disagree`);
    }

    return row;
  }

  /** The amount of the row at `index`, as the seed wrote it. */
  function amountOf(index: number): string {
    return rowAt(index).amount;
  }

  /** Every row index: `0..29`. */
  function everyRow(): number[] {
    return Array.from({ length: SEEDED_ROWS }, (_, index) => index);
  }

  /**
   * The amounts of the rows at `indices`, newest first - the order the endpoint answers in.
   *
   * Written as "these rows, in this order" rather than as a hand-typed list of decimals, so a filter
   * test states *which rows matched*; the amounts are the seed's own numbers, which is what makes a
   * wrong row visible instead of merely a wrong count.
   */
  function amountsNewestFirst(indices: readonly number[]): string[] {
    return [...indices].sort((left, right) => right - left).map((index) => amountOf(index));
  }

  describe('a signed-out caller', () => {
    it('gets 401 from both routes', async () => {
      const listing = await request(app.getHttpServer()).get(PAYMENTS_PATH);
      const detail = await request(app.getHttpServer()).get(
        `${PAYMENTS_PATH}/${strangersPaymentId}`,
      );

      expect(listing.status).toBe(401);
      expect(detail.status).toBe(401);
    });
  });

  describe('a page of history', () => {
    it('answers the newest first, twenty at a time, and says the page was cut short', async () => {
      const body = page(await list(viewer), 'GET /v1/payments with no query at all');

      expect(body.items).toHaveLength(20);
      expect(body.hasMore).toBe(true);

      // Row 29 is the newest payment this account is a party to, row 10 is the twentieth, and the
      // timestamps are the seed's own instants - so this pins the order and the boundary at once.
      expect(body.items[0]?.amount).toBe(amountOf(29));
      expect(body.items[0]?.createdAt).toBe(at(29));
      expect(body.items[19]?.amount).toBe(amountOf(10));
      expect(body.items[19]?.createdAt).toBe(at(10));
    });

    it('carries the six fields a list renders, and not the two only one payment needs', async () => {
      const body = page(await list(viewer, { limit: '50' }), 'the whole history');

      expect(body.items).toHaveLength(SEEDED_ROWS);
      expect(body.hasMore).toBe(false);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'amount',
          'createdAt',
          'direction',
          'id',
          'recipientId',
          'status',
        ]);

        // The disclosure decision, asserted rather than assumed: a page of history does not carry a
        // machine failure reason or a ledger hash at all - the keys are absent, not empty, so there
        // is nothing for a client to render by accident. The rows the detail tests below read both
        // values from are in this very page.
        expect(item).not.toHaveProperty('failureReason');
        expect(item).not.toHaveProperty('stellarTxHash');

        // The amount arrived as text through `Amount` rather than through a JS number:
        // `numeric(20, 7)` with all seven decimals, exactly as the seed wrote it.
        expect(item.amount).toMatch(/^\d+\.\d{7}$/);
      }
    });

    it('reads to the end of the history, oldest last, one entry per payment', async () => {
      const body = page(await list(viewer, { limit: '50' }), 'limit=50');

      expect(body.items.map((item) => item.id)).toEqual(
        [...seeded].reverse().map((row) => row.id),
      );
      expect(body.items.map((item) => item.amount)).toEqual(amountsNewestFirst(everyRow()));
    });

    it('does not show a payment the caller is not a party to, and shows it to the people who are', async () => {
      const own = page(await list(viewer, { limit: '50' }), "the caller's whole history");
      const other = page(await list(partner, { limit: '50' }), "the other party's history");
      const strangerPage = page(await list(stranger, { limit: '50' }), "the stranger's history");

      const seedIds = seeded.map((row) => row.id);

      // Both parties see all thirty rows, each appearing once from their own side: that is the
      // `both` direction doing its job - an `OR` over the two columns, not a union of two lists.
      expect(own.items.map((item) => item.id)).toEqual([...seedIds].reverse());
      expect(other.items.map((item) => item.id)).toEqual([...seedIds].reverse());

      // The stranger is a party to exactly two payments - the pair written at the same instant, one
      // each way - and neither is visible to the two accounts above, even though both were written
      // at the same instant as one of the caller's own rows. That is the scope clause doing its job:
      // without it these two arrive in the caller's page, and nothing else there would look wrong.
      const tiedNewestFirst = [strangersPaymentId, tiedPaymentId].sort().reverse();
      const amountsById = new Map([
        [strangersPaymentId, '7.0000001'],
        [tiedPaymentId, '7.0000002'],
      ]);

      expect(strangerPage.items.map((item) => item.id)).toEqual(tiedNewestFirst);

      // One instant, two rows: there is no chronology to sort them by, so this order *is* the
      // endpoint's tiebreak (`createdAt` desc, then `id` desc) rather than a coincidence of
      // insertion - and the amounts are read back by id, so the direction assertion below is about
      // the right row.
      expect(strangerPage.items.map((item) => item.createdAt)).toEqual([at(10), at(10)]);
      expect(strangerPage.items.map((item) => item.amount)).toEqual(
        tiedNewestFirst.map((id) => amountsById.get(id)),
      );
      expect(strangerPage.items.map((item) => item.direction)).toEqual(
        tiedNewestFirst.map((id) => (id === strangersPaymentId ? 'sent' : 'received')),
      );

      // Asked again, the same order: a page boundary drawn on an order that is not total is how a
      // client sees one payment twice and never sees another.
      const strangerAgain = page(await list(stranger, { limit: '50' }), 'the same page again');

      expect(strangerAgain.items.map((item) => item.id)).toEqual(tiedNewestFirst);

      expect(own.items.map((item) => item.id)).not.toContain(strangersPaymentId);
      expect(own.items.map((item) => item.id)).not.toContain(tiedPaymentId);
    });

    it('clamps a limit above the cap rather than refusing it', async () => {
      const capped = page(await list(viewer, { limit: '1000' }), 'limit=1000');

      expect(capped.items).toHaveLength(SEEDED_ROWS);
      expect(capped.hasMore).toBe(false);
    });

    it('clamps a limit below one up to a single row', async () => {
      const smallest = page(await list(viewer, { limit: '0' }), 'limit=0');

      expect(smallest.items).toHaveLength(1);
      expect(smallest.items[0]?.amount).toBe(amountOf(29));
      expect(smallest.hasMore).toBe(true);
    });

    it('honours a limit in between, and the page is the newest rows', async () => {
      const three = page(await list(viewer, { limit: '3' }), 'limit=3');

      expect(three.items.map((item) => item.amount)).toEqual(amountsNewestFirst([27, 28, 29]));
      expect(three.hasMore).toBe(true);
    });

    it('refuses a limit that is not a whole number of payments, naming the parameter', async () => {
      // `0` is clamped (above) while `-1` and `''` are refused: a page size nobody can mean is a
      // typo, and turning a value that is not a number at all into a default would hide it.
      for (const limit of ['1.5', '-1', 'twenty', '']) {
        const response = await list(viewer, { limit });

        expect(response.status, `expected 400 for limit=${JSON.stringify(limit)}`).toBe(400);
        expect(String(response.body.message)).toMatch(/limit has to be a whole number/);
      }
    });
  });

  describe('the filters', () => {
    it('reads one side of the history with direction', async () => {
      const even = everyRow().filter((index) => index % 2 === 0);
      const odd = everyRow().filter((index) => index % 2 === 1);

      const sent = page(await list(viewer, { direction: 'sent', limit: '50' }), 'direction=sent');
      const received = page(
        await list(viewer, { direction: 'received', limit: '50' }),
        'direction=received',
      );

      // The seed alternates who paid: even rows are the caller's own payments out, odd rows are
      // payments in - fifteen each, and no row in both, which is what makes `both` an `OR` over two
      // columns rather than a union of two lists.
      expect(sent.items.map((item) => item.amount)).toEqual(amountsNewestFirst(even));
      expect(received.items.map((item) => item.amount)).toEqual(amountsNewestFirst(odd));
      expect(sent.hasMore).toBe(false);
      expect(received.hasMore).toBe(false);

      for (const item of sent.items) {
        expect(item.direction).toBe('sent');
        expect(item.recipientId).toBe(partner.userId);
      }

      for (const item of received.items) {
        expect(item.direction).toBe('received');
        expect(item.recipientId).toBe(viewer.userId);
      }

      // `direction` is derived per caller from the row, so the same fifteen payments answer
      // `received` to the partner: one endpoint, two sides of the same rows.
      const otherSide = page(
        await list(partner, { direction: 'received', limit: '50' }),
        "the partner's received page",
      );

      expect(otherSide.items.map((item) => item.id)).toEqual(sent.items.map((item) => item.id));
    });

    it('treats an empty direction as no filter at all', async () => {
      // A client that always appends `direction=` is asking for everything, and the query is meant
      // to read that as "not provided" rather than as a fourth value.
      const body = page(await list(viewer, { direction: '', limit: '50' }), 'direction=');

      expect(body.items).toHaveLength(SEEDED_ROWS);
      expect(body.hasMore).toBe(false);
    });

    it('refuses a direction nobody can mean, naming the values that work', async () => {
      const response = await list(viewer, { direction: 'sideways' });

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(
        /direction has to be one of sent, received, both/,
      );
    });

    it('reads one status at a time', async () => {
      const failedRows = everyRow().filter((index) => index % 4 === 3);
      const successfulRows = everyRow().filter((index) => index % 4 === 2);

      const failed = page(
        await list(viewer, { status: 'FAILED', limit: '50' }),
        'status=FAILED',
      );
      const successful = page(
        await list(viewer, { status: 'SUCCESSFUL', limit: '50' }),
        'status=SUCCESSFUL',
      );

      expect(failed.items.map((item) => item.amount)).toEqual(amountsNewestFirst(failedRows));
      expect(successful.items.map((item) => item.amount)).toEqual(
        amountsNewestFirst(successfulRows),
      );

      for (const item of failed.items) {
        expect(item.status).toBe(TransactionStatus.FAILED);
      }

      for (const item of successful.items) {
        expect(item.status).toBe(TransactionStatus.SUCCESSFUL);
      }

      // The two terminal statuses hold seven rows each and the other two hold eight (sixteen are
      // still moving), so the four statuses partition the history rather than overlapping in it.
      expect(failed.items).toHaveLength(7);
      expect(successful.items).toHaveLength(7);
    });

    it('refuses a status outside the four, naming them', async () => {
      // Lower case is refused rather than normalized: the column holds upper-case values, and a
      // filter that quietly accepted both spellings would hide a client that got the contract wrong.
      const response = await list(viewer, { status: 'successful' });

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/status has to be one of/);
      expect(String(response.body.message)).toMatch(/SUCCESSFUL/);
    });

    it('combines filters, and a combination that matches nothing answers an empty page', async () => {
      const rows = everyRow().filter((index) => index % 2 === 0 && index % 4 === 2);

      const sentSuccessful = page(
        await list(viewer, { direction: 'sent', status: 'SUCCESSFUL', limit: '50' }),
        'direction=sent&status=SUCCESSFUL',
      );

      expect(sentSuccessful.items.map((item) => item.amount)).toEqual(amountsNewestFirst(rows));
      expect(sentSuccessful.hasMore).toBe(false);

      // Every receipt is odd-indexed and every `PENDING` row is even-indexed, so this combination
      // cannot match - and an empty page is a page, not a 404.
      const impossible = page(
        await list(viewer, { direction: 'received', status: 'PENDING', limit: '50' }),
        'direction=received&status=PENDING',
      );

      expect(impossible.items).toEqual([]);
      expect(impossible.hasMore).toBe(false);
    });
  });

  describe('the time bounds', () => {
    it('includes the row a bound names, on both sides', async () => {
      // Both bounds are `>=` and `<=`, and the boundary is the whole point: a client filtering by a
      // row's own `createdAt` must not lose that row, and neither must a client paging on it.
      const from = page(await list(viewer, { from: at(10), limit: '50' }), `from=${at(10)}`);
      const to = page(await list(viewer, { to: at(10), limit: '50' }), `to=${at(10)}`);

      expect(from.items.map((item) => item.amount)).toEqual(
        amountsNewestFirst(everyRow().filter((index) => index >= 10)),
      );
      expect(from.items).toHaveLength(20);
      expect(from.items[19]?.createdAt).toBe(at(10));
      expect(from.hasMore).toBe(false);

      // Eleven matching rows and no more. The control payment was written at exactly `at(10)` too,
      // and it is nobody here's: one assertion covering an inclusive bound and membership at once.
      // The newest of the eleven is the boundary row itself - the bound included the row it names.
      expect(to.items.map((item) => item.amount)).toEqual(
        amountsNewestFirst(everyRow().filter((index) => index <= 10)),
      );
      expect(to.items).toHaveLength(11);
      expect(to.items[0]?.createdAt).toBe(at(10));
      expect(to.items[10]?.createdAt).toBe(at(0));
      expect(to.hasMore).toBe(false);
    });

    it('reads a window between two bounds', async () => {
      const body = page(
        await list(viewer, { from: at(5), to: at(9), limit: '50' }),
        'from=at(5)&to=at(9)',
      );

      expect(body.items.map((item) => item.amount)).toEqual(amountsNewestFirst([5, 6, 7, 8, 9]));
      expect(body.hasMore).toBe(false);
    });

    it('reads a date-only bound as midnight UTC of that day, and nothing more', async () => {
      // The oldest row is written at exactly midnight, so `to=2026-06-01` includes it and nothing
      // else: the day it names is *not* included, and a client that wants that whole day says so
      // (`...T23:59:59.999Z`). Silently widening the bound would be a hidden `+23:59:59.999`.
      const body = page(await list(viewer, { to: '2026-06-01' }), 'to=2026-06-01');

      expect(body.items.map((item) => item.amount)).toEqual([amountOf(0)]);
      expect(body.hasMore).toBe(false);
    });

    it('refuses a range the other way round', async () => {
      // It can only ever match nothing, which is never what a caller meant, so it is a 400 rather
      // than an empty page that looks like an empty history.
      const response = await list(viewer, { from: at(9), to: at(5) });

      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/from has to be earlier than to/);
    });

    it('refuses a bound that is not an instant, including a date that does not exist', async () => {
      const refusals = [
        ['from', 'yesterday'],
        ['from', '2026-9-1'],
        ['from', ''],
        ['to', '2026-02-31'],
        ['to', '2026-13-01'],
        ['to', '2026-02-31T00:00:00Z'],
        ['to', '2026-06-01T99:00:00Z'],
      ] as const;

      for (const [parameter, value] of refusals) {
        const response = await list(viewer, { [parameter]: value });

        expect(response.status, `expected 400 for ${parameter}=${value}`).toBe(400);
        expect(String(response.body.message)).toMatch(
          new RegExp(`${parameter} has to be an ISO-8601 instant`),
        );
      }
    });
  });

  describe('one payment, by id', () => {
    it("answers each party's own side of the same payment", async () => {
      const row = rowAt(4);

      // Row 4: the caller sent it, and nothing has been submitted for it yet.
      const asSender = payment(await detail(viewer, row.id), 'the sender reading their own payment');
      const asRecipient = payment(await detail(partner, row.id), 'the recipient reading it');

      expect(asSender.id).toBe(row.id);
      expect(asSender.status).toBe(TransactionStatus.PENDING);
      expect(asSender.amount).toBe(row.amount);
      expect(asSender.createdAt).toBe(at(4));
      expect(asSender.direction).toBe('sent');
      expect(asSender.recipientId).toBe(partner.userId);

      // `null` stays `null` rather than being dropped, so a client can switch on presence: nothing
      // has been built for this payment, so there is no hash, and it has not failed, so no reason.
      expect(asSender.failureReason).toBeNull();
      expect(asSender.stellarTxHash).toBeNull();

      // The same id, the same row, the other side of it. `recipientId` is still the account being
      // paid, which on this reading is the account asking.
      expect(asRecipient.id).toBe(row.id);
      expect(asRecipient.amount).toBe(row.amount);
      expect(asRecipient.createdAt).toBe(at(4));
      expect(asRecipient.direction).toBe('received');
      expect(asRecipient.recipientId).toBe(partner.userId);
    });

    it('reports the machine reason of a failed payment, verbatim', async () => {
      const row = rowAt(3);

      // Row 3: the partner sent it, and the submission path recorded a ledger transaction that a
      // ledger closed unsuccessfully - which is why a `FAILED` row still has a hash to paste into
      // an explorer, and the reason nothing in the API paraphrases.
      const body = payment(await detail(viewer, row.id), 'a failed payment the caller received');

      expect(body.status).toBe(TransactionStatus.FAILED);
      expect(body.direction).toBe('received');
      expect(body.failureReason).toBe(FAILURE_REASON);
      expect(body.stellarTxHash).toBe(hashFor(3));
    });

    it('carries the hash of a payment that left PENDING, which the list does not', async () => {
      const row = rowAt(1);

      const inFlight = payment(await detail(viewer, row.id), 'a payment in flight');
      // Row 2 landed, and it is read by the partner - the side that did not send it.
      const landed = payment(await detail(partner, rowAt(2).id), 'a payment that landed');

      expect(inFlight.status).toBe(TransactionStatus.PROCESSING);
      expect(inFlight.direction).toBe('received');
      expect(inFlight.stellarTxHash).toBe(hashFor(1));
      expect(inFlight.failureReason).toBeNull();

      // A hash that landed and still no failure reason: `failureReason` is null because the payment
      // did not fail, not merely because no transaction was ever built for it.
      expect(landed.status).toBe(TransactionStatus.SUCCESSFUL);
      expect(landed.direction).toBe('received');
      expect(landed.stellarTxHash).toBe(hashFor(2));
      expect(landed.failureReason).toBeNull();

      // The one row read both ways: the detail body has the hash, and the list item has no such key
      // at all. `not.toHaveProperty` is the assertion - a hash sent as `null` would pass an equality
      // check against `null` while still being on the wire.
      const page1 = page(await list(viewer, { limit: '50' }), 'the same rows in the list');
      const sameRow = page1.items.find((item) => item.id === row.id);

      expect(sameRow).toBeDefined();
      expect(sameRow).not.toHaveProperty('stellarTxHash');
      expect(sameRow).not.toHaveProperty('failureReason');
    });

    it('404s for a payment the caller is not a party to, exactly as for one that is not there', async () => {
      const notMine = await detail(viewer, strangersPaymentId);
      const notThere = await detail(viewer, randomUUID());

      expect(notMine.status).toBe(404);
      expect(notThere.status).toBe(404);

      // One answer for two situations, and that is the point: this row exists, between the stranger
      // and a fourth account, and the caller cannot tell it from an id nobody ever minted. A route
      // that answered differently would be an oracle for which payment ids exist. Only `path` and
      // `timestamp` differ, and both are facts about the request rather than about the row - so the
      // body has no field that could carry a hint about what was or was not found.
      expect(notMine.body.message).toEqual(notThere.body.message);
      expect(notMine.body.error).toEqual(notThere.body.error);
      expect(notMine.body.statusCode).toBe(notThere.body.statusCode);
      expect(Object.keys(notMine.body).sort()).toEqual([
        'error',
        'message',
        'path',
        'statusCode',
        'timestamp',
      ]);
      expect(String(notMine.body.message)).toMatch(/No payment with that id involves this account/);

      // The row is real, though: the account that paid it reads it, on its own side.
      const asSender = payment(await detail(stranger, strangersPaymentId), 'the account that paid');

      expect(asSender.id).toBe(strangersPaymentId);
      expect(asSender.direction).toBe('sent');
      expect(asSender.status).toBe(TransactionStatus.PENDING);

      // And the partner - a party to thirty other payments, and to none of this one - gets the same
      // 404 the caller does. The answer is about this row, not about the caller's history being
      // empty.
      expect((await detail(partner, strangersPaymentId)).status).toBe(404);
    });

    it('refuses an id that is not a UUID, before any row is looked for', async () => {
      // A 400 rather than a 404: an id that cannot be an id is a malformed request, and the two mean
      // different things to a client - fix the request, or stop looking.
      for (const id of ['not-a-uuid', '1234', '6d1f3c9e-4a11-4f6b-9d1e-2b3c4d5e6f7']) {
        const response = await detail(viewer, id);

        expect(response.status, `expected 400 for id=${id}`).toBe(400);
        expect(JSON.stringify(response.body).toLowerCase()).toContain('uuid');
      }
    });
  });
});


