import { randomInt, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { GLOBAL_PREFIX } from './../src/common/http/prefix.js';
import { createValidationPipe } from './../src/common/pipes/validation.pipe.js';
import {
  RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW,
  RECIPIENT_LOOKUP_WINDOW_SECONDS,
} from './../src/config/configuration.js';
import { UserStatus } from './../src/generated/prisma/enums.js';
import {
  SMS_SENDER,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './../src/notifications/sms/sms-sender.js';
import { RECIPIENT_SEARCH_MAX_LIMIT } from './../src/payments/recipients/recipient-query.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { RedisService } from './../src/redis/redis.service.js';
import {
  AccountProvisioningService,
  type ProvisioningOutcome,
} from './../src/wallet/provisioning/account-provisioning.service.js';

/**
 * Steps 21 and 22 over real HTTP, against the real database and the real Redis: what a search of
 * the recipient directory returns, what it refuses, and what it costs.
 *
 * ## The three claims this file exists to prove, because none of them can be proven by reading
 *
 * 1. **No phone number comes back.** `expectNoPhoneNumber` is run on *every* documented response
 *    body below, and it looks for the number in both shapes (E.164 and bare digits) as well as
 *    for the key itself. The rule is in `RecipientSearchResultDto`'s docblock; this is the
 *    assertion that keeps it true, and it is the first line of Step 21's audit.
 * 2. **The limit is enforced at the wire.** `RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW` lookups are
 *    spent over HTTP, the next is a 429 whose message carries the wait, and a *different*
 *    account's next lookup still succeeds - which is the per-caller keying, shown rather than
 *    asserted. A limit tested only at the service would not prove the guard, the filter and the
 *    exception mapping let the 429 out unaltered.
 * 3. **A directory row is a *payable* account.** Suspended and unverified fixtures are created
 *    directly in the database and are absent from both endpoints - 404 by id, and not in a
 *    search by their own number or handle - which is the "filter in the query, not in a mapper"
 *    decision, tested where it could be got wrong.
 *
 * ## Nothing is substituted except the SMS and the wallet
 *
 * The app is the real `AppModule`: real Postgres, real Redis, the global validation pipe, the
 * shared exception filter and the JWT guard. `SMS_SENDER` is replaced because a code has to be
 * read from somewhere and a test cannot receive a text; `AccountProvisioningService` is replaced
 * for the same reason `auth.e2e-spec.ts` replaces it - verification triggers provisioning, and a
 * run that reached KMS and Horizon to test a search would fail for reasons that have nothing to
 * do with this file (and would leave real Testnet accounts behind, which `stellar_accounts`'
 * `ON DELETE RESTRICT` would then refuse to clean up).
 *
 * ## Running it
 *
 * Local-only, like the other e2e files: it needs the compose stack (`docker compose up -d
 * postgres redis`) plus a `.env` whose `DATABASE_URL` and `REDIS_URL` point at it. It is not part
 * of CI. `npm run test:e2e test/recipients.e2e-spec.ts`.
 */

/** The two routes under test, as the frontend calls them. */
const SEARCH_PATH = `/${GLOBAL_PREFIX}/recipients/search`;
const RECIPIENTS_PATH = `/${GLOBAL_PREFIX}/recipients`;
const REGISTER_PATH = `/${GLOBAL_PREFIX}/auth/register`;
const VERIFY_PATH = `/${GLOBAL_PREFIX}/auth/otp/verify`;

/** Captures what would have been texted, so the code is readable in the test. */
class CapturingSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push({ ...message });

    return { providerMessageId: `test-${this.sent.length}` };
  }

  /** The newest message addressed to one number. */
  latestFor(phoneNumber: string): SmsMessage | undefined {
    const messages = this.sent.filter((message) => message.to === phoneNumber);

    return messages[messages.length - 1];
  }
}

const smsSender = new CapturingSmsSender();

/**
 * `AccountProvisioningService`, replaced - see the file docblock. It still records which user was
 * asked for a wallet, so this file keeps the one thing it can honestly assert about Step 19.
 */
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
 * Every number this run writes, in the E.164 form the column stores, so `afterAll` can remove
 * exactly what it created - the four registered accounts and the fixture rows alike. The local
 * spelling is never recorded: deleting by it silently removes nothing.
 */
const numbersWritten: string[] = [];

/** The handles this run claims, so a run killed mid-file cannot make the next one a 409. */
const claimedHandles: string[] = [];

/** Every account this file created, so its lookup counter can be removed in `afterAll`. */
const userIds: string[] = [];

/** A Ghanaian mobile this run has not registered, in the local spelling. */
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

/** Reserves a number for this run: recorded for cleanup, returned in both spellings. */
function reserveNumber(): { local: string; e164: string } {
  const local = freshLocalNumber();
  const e164 = toE164(local);

  numbersWritten.push(e164);

  return { local, e164 };
}

/** Groups a local number the way a person might type it: `024 123 4567`. */
function toSpaced(localNumber: string): string {
  return `${localNumber.slice(0, 3)} ${localNumber.slice(3, 6)} ${localNumber.slice(6)}`;
}

/** The single code in an SMS body. */
function codeFrom(body: string): string {
  const matches = body.match(/\d{6}/g) ?? [];

  expect(matches).toHaveLength(1);

  return matches[0] as string;
}

/** The half of a session response this file needs: who the caller is, and how to act as them. */
interface Session {
  userId: string;
  accessToken: string;
}

/** Registers a number with a handle and verifies it, the way a real user's account is created. */
async function registerAndVerify(
  app: INestApplication<App>,
  local: string,
  e164: string,
  handle: string,
): Promise<Session> {
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

/** `Authorization: Bearer <token>`, the only way this API accepts an access token. */
function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/**
 * Asserts that no phone number is disclosed anywhere in a response body.
 *
 * Three checks, because a leak can take three shapes: the field name (`phoneNumber`, in whatever
 * nesting a future edit adds), the E.164 string, and the bare digits without the `+`. It is run
 * on every body this file receives rather than on the search only - the confirmation path reads
 * the same row and would be the easier one to add a field to.
 */
function expectNoPhoneNumber(body: unknown, ...numbers: string[]): void {
  const serialized = JSON.stringify(body);

  expect(serialized, 'no response may carry a `phoneNumber` field').not.toContain('phoneNumber');

  for (const number of numbers) {
    expect(serialized, `${number} must not be echoed back`).not.toContain(number);
    expect(serialized, `${number} must not be echoed back`).not.toContain(number.replace('+', ''));
  }
}

/** The sentence(s) an error body carries, whichever of the two shapes the failure produced. */
function messagesOf(body: { message?: string | string[] }): string {
  const message = body.message ?? '';

  return Array.isArray(message) ? message.join('; ') : message;
}

describe('Recipient directory (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** The signed-in account doing the searching. */
  let caller: Session;
  /** The account the caller is trying to pay: it holds a handle and a display name. */
  let recipient: Session;
  /** A second account sharing the recipient's handle prefix, so `hasMore` is observable. */
  let other: Session;
  /** An account that spends its whole allowance on purpose, so no other test is limited by it. */
  let sweeper: Session;

  /** Numbers reserved for this run: two searched for, one deliberately never registered. */
  let callerNumber: { local: string; e164: string };
  let recipientNumber: { local: string; e164: string };
  let unregisteredNumber: { local: string; e164: string };

  /** Fixture rows that exist and are payable to nobody: an unverified account and a suspended one. */
  let pendingNumber: { local: string; e164: string };
  let suspendedNumber: { local: string; e164: string };

  /**
   * The handle prefix the matching accounts share.
   *
   * Drawn per run rather than written as a literal, so this file cannot collide with
   * `auth.e2e-spec.ts`'s `miriam` when the two suites run against the same database in parallel:
   * `handle` is unique across the whole table, and both files would be claiming the same string.
   */
  let prefix = '';

  /** Rows that exist only to prove the directory filters by status, and their ids. */
  let pendingId = '';
  let suspendedId = '';

  /** The display name written straight into the column, since no endpoint sets one yet. */
  const RECIPIENT_DISPLAY_NAME = 'Recipient Under Test';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_SENDER)
      .useValue(smsSender)
      .overrideProvider(AccountProvisioningService)
      .useValue(provisioning)
      .compile();

    app = moduleFixture.createNestApplication();
    // The same wiring as `main.ts`, in the same order: without the prefix the paths below 404, and
    // without the pipe a malformed query would reach the service instead of being refused at the
    // door - which is one of the things the `limit` test below checks.
    app.setGlobalPrefix(GLOBAL_PREFIX);
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    prisma = app.get(PrismaService);

    prefix = `r${randomInt(1000, 10000)}`;

    const handles = {
      caller: `${prefix}c`,
      recipient: `${prefix}a`,
      other: `${prefix}b`,
      /**
       * Deliberately *outside* the shared prefix. The sweeper exists to spend an allowance, and a
       * handle under `prefix` would appear in every `q=prefix` assertion below - both in the
       * prefix-search test (which is about the two accounts that share it) and in the status-filter
       * test (which counts the rows a prefix search is *allowed* to return). Unique and valid is
       * all it has to be.
       */
      sweeper: `sw${randomInt(100000, 1000000)}`,
      pending: `${prefix}p`,
      suspended: `${prefix}s`,
    };
    claimedHandles.push(...Object.values(handles));

    callerNumber = reserveNumber();
    recipientNumber = reserveNumber();
    const otherNumber = reserveNumber();
    const sweeperNumber = reserveNumber();
    unregisteredNumber = reserveNumber();
    pendingNumber = reserveNumber();
    suspendedNumber = reserveNumber();

    // Reserved up front and cleaned before anything is used: the database is the compose one and
    // outlives the run, so a number or handle left behind by a run that died would make the first
    // registration of the next one a 409 - a failure with nothing to do with this file.
    await prisma.user.deleteMany({ where: { phoneNumber: { in: numbersWritten } } });
    await prisma.user.deleteMany({ where: { handle: { in: claimedHandles } } });

    caller = await registerAndVerify(app, callerNumber.local, callerNumber.e164, handles.caller);
    recipient = await registerAndVerify(
      app,
      recipientNumber.local,
      recipientNumber.e164,
      handles.recipient,
    );
    other = await registerAndVerify(app, otherNumber.local, otherNumber.e164, handles.other);
    sweeper = await registerAndVerify(
      app,
      sweeperNumber.local,
      sweeperNumber.e164,
      handles.sweeper,
    );

    // No profile endpoint exists yet - Step 22's DTO reserves `displayName` for one - so the column
    // is written directly. What is under test is that a search returns the name, not how it got
    // there: a hard-coded `null` in the mapper would fail the assertion below.
    await prisma.user.update({
      where: { id: recipient.userId },
      data: { displayName: RECIPIENT_DISPLAY_NAME },
    });

    /** Two rows that exist, are payable to nobody, and must be invisible to both endpoints. */
    const pending = await prisma.user.create({
      data: {
        phoneNumber: pendingNumber.e164,
        handle: handles.pending,
        status: UserStatus.PENDING_VERIFICATION,
      },
    });
    const suspended = await prisma.user.create({
      data: {
        phoneNumber: suspendedNumber.e164,
        handle: handles.suspended,
        status: UserStatus.SUSPENDED,
      },
    });

    pendingId = pending.id;
    suspendedId = suspended.id;
  });

  it('finds a recipient by phone, and describes them without their number', async () => {
    const response = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: toSpaced(recipientNumber.local) })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    // The whole body, exactly. `matchedBy` says which reading of `q` produced this, `hasMore` says
    // the list is complete, and a result carries the three fields a pay screen needs. An added
    // field - a number, a status, a join date - fails this equality rather than slipping through.
    expect(response.body).toEqual({
      matchedBy: 'phone',
      results: [
        { id: recipient.userId, handle: `${prefix}a`, displayName: RECIPIENT_DISPLAY_NAME },
      ],
      hasMore: false,
    });

    expectNoPhoneNumber(response.body, recipientNumber.e164, recipientNumber.local);
  });

  it('finds recipients by handle prefix, ignoring casing and accepting the @', async () => {
    const response = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: `@${prefix.toUpperCase()}` })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    expect(response.body.matchedBy).toBe('handle');

    // Ordered by handle, and matched by *prefix*: `q` was only the shared part of these two, which
    // is what a person types when they half-remember a name.
    expect(response.body).toEqual({
      matchedBy: 'handle',
      results: [
        { id: recipient.userId, handle: `${prefix}a`, displayName: RECIPIENT_DISPLAY_NAME },
        { id: other.userId, handle: `${prefix}b`, displayName: null },
      ],
      hasMore: false,
    });

    expectNoPhoneNumber(response.body, recipientNumber.e164, callerNumber.e164);
  });

  it('caps the list at `limit` and says the list is not the whole answer', async () => {
    const capped = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: prefix, limit: 1 })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    // One of the two matches, and `hasMore` says so - a truncated answer reported as complete is
    // how a client tells a person "there is nobody else".
    expect(capped.body).toEqual({
      matchedBy: 'handle',
      results: [
        { id: recipient.userId, handle: `${prefix}a`, displayName: RECIPIENT_DISPLAY_NAME },
      ],
      hasMore: true,
    });

    // One past the ceiling is refused at the door rather than clamped silently: a client that asked
    // for 1000 and received 20 has no way to know its answer was cut down.
    const overLimit = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: prefix, limit: RECIPIENT_SEARCH_MAX_LIMIT + 1 })
      .set('Authorization', bearer(caller.accessToken))
      .expect(400);

    expect(messagesOf(overLimit.body)).toContain(String(RECIPIENT_SEARCH_MAX_LIMIT));
    expectNoPhoneNumber(overLimit.body);
  });

  it('never lists the caller, but does confirm the caller to themselves', async () => {
    // Own number: an empty list, and `matchedBy: 'phone'` says *why* it is empty. The exclusion is
    // in the query (`id: { not: callerId }`), not in the mapper, so it holds on both paths.
    const ownNumber = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: callerNumber.local })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    expect(ownNumber.body).toEqual({ matchedBy: 'phone', results: [], hasMore: false });
    expectNoPhoneNumber(ownNumber.body, callerNumber.e164, callerNumber.local);

    // Own handle prefix: the two other accounts match, the caller does not.
    const byPrefix = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: prefix })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    expect(byPrefix.body.results.map((row: { id: string }) => row.id)).not.toContain(caller.userId);

    // ...but confirming yourself is allowed, and answers about yourself: "is this the account I am
    // about to pay" has a sensible answer for one's own account, and the confirmation screen is the
    // same component for "this is you".
    const self = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${caller.userId}`)
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    expect(self.body).toEqual({
      id: caller.userId,
      handle: `${prefix}c`,
      displayName: null,
      verified: true,
    });

    expectNoPhoneNumber(self.body, callerNumber.e164, callerNumber.local);
  });

  it('answers an unregistered number with an empty list, and says which reading it used', async () => {
    const response = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: toSpaced(unregisteredNumber.local) })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    // A 200 with nobody in it, not a 404: "that number is not on Cashping" is an ordinary answer to
    // the question the search is asked. `matchedBy: 'phone'` is what tells the client apart from
    // "no handle starts with that", which is a different sentence to show a person.
    expect(response.body).toEqual({ matchedBy: 'phone', results: [], hasMore: false });
    expectNoPhoneNumber(response.body, unregisteredNumber.e164, unregisteredNumber.local);
  });

  it('keeps accounts that cannot receive money out of the directory entirely', async () => {
    // Two rows written straight into the database: they exist, and they are not payable. The filter
    // is `status: ACTIVE` in both queries rather than a mapper afterwards, which is what makes the
    // two endpoints agree - so the handle search still returns exactly the two payable accounts
    // whose handles share the prefix, not four.
    const byPrefix = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: prefix })
      .set('Authorization', bearer(caller.accessToken))
      .expect(200);

    expect(byPrefix.body.results.map((row: { id: string }) => row.id)).toEqual([
      recipient.userId,
      other.userId,
    ]);

    for (const fixture of [pendingNumber, suspendedNumber]) {
      const byNumber = await request(app.getHttpServer())
        .get(SEARCH_PATH)
        .query({ q: fixture.local })
        .set('Authorization', bearer(caller.accessToken))
        .expect(200);

      expect(byNumber.body).toEqual({ matchedBy: 'phone', results: [], hasMore: false });
      expectNoPhoneNumber(byNumber.body, fixture.e164, fixture.local);
    }
  });

  it('refuses a query it cannot read, naming the rule rather than saying "invalid search"', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // Too short to be a handle, and not a number: the registration rule, reused rather than
      // re-typed, so the two endpoints cannot drift about what a handle is.
      ['ab', 'at least 3'],
      // Whitespace only: the one refusal that exists only here, because `q` is the whole request.
      ['   ', 'pass `q`'],
      // A space is not a handle character, and the message says which characters are.
      ['miriam owusu', 'letters, digits and underscores'],
      // A partial number that kept its `+`: the normalizer refused it and `+` is not a handle
      // character, so this is a refusal rather than a search that finds nobody.
      ['+2332412345', 'letters, digits and underscores'],
    ];

    for (const [q, expected] of cases) {
      const refused = await request(app.getHttpServer())
        .get(SEARCH_PATH)
        .query({ q })
        .set('Authorization', bearer(caller.accessToken))
        .expect(400);

      expect(messagesOf(refused.body), `q=${JSON.stringify(q)}`).toContain(expected);
      expectNoPhoneNumber(refused.body, recipientNumber.e164);
    }

    // An empty string and a missing `q` are refused before the service sees them, and the message
    // names the field: shape at the door, semantics in the service.
    const fromPipe = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: '' })
      .set('Authorization', bearer(caller.accessToken))
      .expect(400);

    expect(messagesOf(fromPipe.body)).toContain('should not be empty');

    const missing = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .set('Authorization', bearer(caller.accessToken))
      .expect(400);

    expect(messagesOf(missing.body)).toContain('q');
  });

  it('answers 404 for an id that cannot be paid, without saying which case it is', async () => {
    const unknown = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${randomUUID()}`)
      .set('Authorization', bearer(caller.accessToken))
      .expect(404);

    const notPayable = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${pendingId}`)
      .set('Authorization', bearer(caller.accessToken))
      .expect(404);

    // The *same* sentence for "nothing holds this id" and "this account is not payable": telling
    // them apart is what would turn the endpoint into a probe for which ids exist and what state
    // they are in, and the confirmation screen has no use for the difference.
    expect(unknown.body.message).toBe(notPayable.body.message);
    expect(messagesOf(unknown.body)).toContain('No Cashping account with that id');
    expectNoPhoneNumber(unknown.body, recipientNumber.e164);
    expectNoPhoneNumber(notPayable.body, pendingNumber.e164, pendingNumber.local);

    // The other state that cannot receive money: an account that may not transact, refused with the
    // same sentence as the unverified one - deliberately not a 403, which would say "you may not
    // ask" rather than "there is nobody here to pay".
    const suspended = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${suspendedId}`)
      .set('Authorization', bearer(caller.accessToken))
      .expect(404);

    expect(suspended.body.message).toBe(unknown.body.message);
    expectNoPhoneNumber(suspended.body, suspendedNumber.e164, suspendedNumber.local);
  });

  it('refuses an id that is not an id, at the door', async () => {
    // `ParseUUIDPipe` before the service: "not a UUID" is a malformed request - fix it and send it
    // again - which is a different thing to tell a client than "no such account, stop looking".
    const refused = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/not-a-uuid`)
      .set('Authorization', bearer(caller.accessToken))
      .expect(400);

    expect(messagesOf(refused.body)).toContain('Validation failed');
    expectNoPhoneNumber(refused.body, recipientNumber.e164);
  });

  it('answers 401 on both routes without a token, before any lookup is counted', async () => {
    const search = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: prefix })
      .expect(401);

    const confirm = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${recipient.userId}`)
      .expect(401);

    // One answer for both, and it is the guard's: an unauthenticated request never reaches the
    // service, so it cannot spend the allowance or reveal whether the id exists.
    expect(messagesOf(search.body)).toBe(messagesOf(confirm.body));
    expectNoPhoneNumber(search.body, recipientNumber.e164);
  });

  it('spends the allowance per caller over HTTP, and answers 429 with the wait', async () => {
    // A fourth account on purpose: every search above cost the *caller* one unit of the allowance,
    // and a spent allowance is not a bug a later test should have to debug.
    //
    // The spend is a *sweep*, one different number per request, because that is the attack the limit
    // exists to price - each answer ("nobody holds this"/"this is someone") is the thing being
    // bought. Every number here is valid and unregistered, so each lookup is a plain 200 with an
    // empty list, and the allowance runs out anyway: what is counted is the lookup, not what it
    // found. Repeating one query would have shown the counter, but not that a sweep is what stops.
    for (let i = 0; i < RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW - 1; i += 1) {
      const swept = freshLocalNumber();
      const allowed = await request(app.getHttpServer())
        .get(SEARCH_PATH)
        .query({ q: swept })
        .set('Authorization', bearer(sweeper.accessToken));

      expect(allowed.status, `lookup ${i + 1} of ${RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW}`).toBe(
        200,
      );
      expect(allowed.body).toEqual({ matchedBy: 'phone', results: [], hasMore: false });
      expectNoPhoneNumber(allowed.body, toE164(swept), swept);
    }

    // The last unit of the allowance is spent on a *hit* rather than a miss, so the 429 below cannot
    // be explained away as "only empty answers are counted": finding out who a number belongs to
    // costs one unit, the same as learning that it belongs to nobody.
    const hit = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: recipientNumber.local })
      .set('Authorization', bearer(sweeper.accessToken))
      .expect(200);

    expect(hit.body).toEqual({
      matchedBy: 'phone',
      results: [
        { id: recipient.userId, handle: `${prefix}a`, displayName: RECIPIENT_DISPLAY_NAME },
      ],
      hasMore: false,
    });

    const refused = await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: freshLocalNumber() })
      .set('Authorization', bearer(sweeper.accessToken))
      .expect(429);

    // The 429 carries the wait rather than only a status, so a client can count down instead of
    // inviting the person to press the button again. What is asserted is what the value has to be -
    // a whole number of seconds inside the configured window - and not a fixed second: it is the
    // window's *remaining* TTL, and a busy machine can spend one of those before the last request
    // lands. A 0, a 3600 or a missing number still fails.
    const message = messagesOf(refused.body);
    const wait = /Try again in (\d+) seconds?\./.exec(message)?.[1];

    expect(wait, `429 message was: ${message}`).toBeDefined();
    expect(message).toContain('Too many recipient lookups');
    expect(Number(wait)).toBeGreaterThan(0);
    expect(Number(wait)).toBeLessThanOrEqual(RECIPIENT_LOOKUP_WINDOW_SECONDS);
    expectNoPhoneNumber(refused.body, recipientNumber.e164);

    // The same allowance covers both directory endpoints, because a confirmation is a lookup too:
    // leaving it uncounted would be a way around the search limit, one guessed id at a time.
    const confirm = await request(app.getHttpServer())
      .get(`${RECIPIENTS_PATH}/${recipient.userId}`)
      .set('Authorization', bearer(sweeper.accessToken))
      .expect(429);

    expect(messagesOf(confirm.body)).toContain('Too many recipient lookups');

    // ...and the counter is keyed by caller, not by address - every request in this file comes from
    // the same one - so an account that has spent nothing still gets its answer.
    await request(app.getHttpServer())
      .get(SEARCH_PATH)
      .query({ q: recipientNumber.local })
      .set('Authorization', bearer(other.accessToken))
      .expect(200);
  });

  afterAll(async () => {
    // Leftovers would make the *next* run fail for the wrong reason: `phone_number` and `handle` are
    // unique across the whole table, so a run that left rows behind turns the next one's
    // registrations into 409s. `deleteMany` rather than `delete`, because having no row is the
    // normal case for most of these numbers.
    const { count } = await prisma.user.deleteMany({
      where: { phoneNumber: { in: numbersWritten } },
    });

    // Every *payable* number got a row: the four registered accounts, plus the two fixtures written
    // by hand. The seventh reserved number is the one nobody holds, which is the whole point of it.
    expect(count, 'every row this run created should have been removed').toBe(userIds.length + 2);

    /**
     * The lookup counters outlive the rows they belong to - they are a fixed window in Redis - so a
     * spent allowance would make the next run fail for a reason that looks like a bug in the
     * limiter. Deleted by key rather than by pattern, for the same reason `auth.e2e-spec.ts`
     * deletes its OTP counters by name: `KEYS recipients:lookup:*` is the O(N) call the limiter's
     * own comments avoid.
     */
    const redis = app.get(RedisService);

    await redis.client.del(...userIds.map((id) => `recipients:lookup:${id}`));

    await app.close();
  });
});
