Cashping — NestJS Build Sequence
A literal step-by-step walkthrough, in order, from project setup to deployment. This sits underneath the architecture plan — that document explains what and why; this one explains how, in order. Follow it top to bottom. Each step names what to build and what "done" looks like before moving to the next one.

Two items identified as MVP-blocking in the architecture plan's gap analysis (decimal precision handling, phone number normalization) are folded into the relevant steps below rather than left as a separate afterthought — they're cheap to do right the first time and expensive to retrofit.

**Documentation convention used throughout this document:** any count of files, tests or lines quoted here, or in a commit message, carries the step it was measured at — `131 files scanned, 0 violations as of Step 25`, never a bare `131 files` — because the tree only grows and an unlabelled count silently becomes false. Evidence quoted below is the verbatim output of a command that can be re-run, and a re-measurement is appended with its own label rather than replacing the older figure. The README's *Documentation conventions* section states the rule in full.

Day 0 — Project Setup & Folder Structure
Step 1 — Initialize the repository

mkdir cashping-backend && cd cashping-backend
git init
npm i -g @nestjs/cli
nest new . --package-manager npm
Done when: a fresh NestJS app runs locally with npm run start:dev and responds on the default port.

Step 2 — Establish the folder structure Set this up before writing any feature code — it mirrors the module breakdown from the architecture plan and keeps bounded contexts separated from day one.

src/
├── main.ts
├── app.module.ts
├── config/
│   ├── configuration.ts        # env var loading/typing
│   └── validation.schema.ts    # class-validator schema for env vars
├── common/
│   ├── decorators/
│   ├── filters/                # global exception filter
│   ├── guards/                 # auth guards, step-up-auth guard
│   ├── interceptors/           # idempotency-key interceptor
│   └── pipes/                  # validation pipe config
├── identity/
│   ├── identity.module.ts
│   ├── controllers/
│   ├── services/
│   └── dto/
├── wallet/                     # Stellar account + signing
│   ├── wallet.module.ts
│   ├── controllers/
│   ├── services/
│   └── dto/
├── payments/
│   ├── payments.module.ts
│   ├── controllers/
│   ├── services/
│   ├── dto/
│   └── jobs/                   # BullMQ processors
├── notifications/
│   ├── notifications.module.ts
│   └── services/                # Africa's Talking client
├── ledger/
│   ├── ledger.module.ts
│   └── services/                # reconciliation, audit log
└── prisma/
    └── prisma.service.ts
prisma/
└── schema.prisma
Done when: the folder tree exists as empty modules that compile and boot together via app.module.ts imports.

Step 3 — Dockerize from the start

Write a multi-stage Dockerfile (build stage with full deps, slim runtime stage copying only dist/ + production node_modules).
Write docker-compose.yml for local dev: api, postgres, redis services.
Add .dockerignore (node_modules, .git, .env).
Done when: docker-compose up boots Postgres + Redis locally, and the API container connects to both.

Audit Checklist — Steps 1–3
Run this after building, before moving to Step 4. Each line should be a verified yes, not an assumption.

 Step 1: npm run start:dev boots without errors; hitting the default endpoint returns a response (not a connection error, not a silent hang).
 Step 2: every folder listed in the tree exists exactly as specified; app.module.ts imports all module stubs and the app still boots cleanly with no unused/orphaned modules.
 Step 3: docker-compose up starts all three services (api, postgres, redis) with no restart-looping containers; the API container can reach Postgres and Redis (verify with a trivial connection test, e.g. a health-check log line on boot, not just "the containers are running").
 .dockerignore excludes node_modules, .git, and .env — confirm none of these ended up inside the built image (docker exec in and check, or inspect image size for a red flag).
If anything fails: fix it before proceeding — do not carry a failed Step 1–3 item forward into Step 4, since everything after this depends on this foundation being solid.

Step 4 — Environment configuration

.env.example listing every required variable (DB URL, Redis URL, JWT secret, Africa's Talking API key, Sentry DSN, AWS credentials/KMS key ID, Stellar network config).
@nestjs/config wired with a validation schema — the app should refuse to boot if a required env var is missing, not fail mysteriously later.
Done when: removing any required variable from .env causes a clear boot-time error, not a runtime crash three requests in.

Step 5 — Prisma setup

npm i prisma @prisma/client
npx prisma init
Write the initial schema (User, OtpVerification models only for now — the rest come as their modules are built, so migrations stay tied to the feature that needs them).

Done when: npx prisma migrate dev runs clean against the Dockerized Postgres and generates a working client.

Step 6 — Sentry wired in before any feature code

npm i @sentry/nestjs @sentry/profiling-node
Initialize in main.ts before the Nest app boots, with the DSN read from config. Add the global exception filter so unhandled errors are both returned to the client as a clean error shape and reported to Sentry.

Done when: a deliberately-thrown test error in a throwaway endpoint shows up in the Sentry dashboard.

Step 7 — Basic CI GitHub Actions workflow: install deps, run lint, run unit tests, build. No deploy step yet — that comes at the end once there's something worth deploying.

Done when: a PR triggers the workflow and fails the build if lint or tests fail.

Audit Checklist — Steps 4–7
 Step 4: deliberately removing a required env var causes the app to fail at boot with a clear, specific error — not a silent default, not a runtime crash several requests in.
 Step 5: npx prisma migrate dev runs clean against the Dockerized Postgres; the generated Prisma client can perform a trivial query against User/OtpVerification without error.
 Step 6: a deliberately-thrown test error (in a throwaway endpoint, removed after verification) appears in the Sentry dashboard with a usable stack trace.
 Step 7: a PR with a deliberately broken lint rule or failing test causes the GitHub Actions workflow to fail red — not silently pass.
 The temporary TCP-probe health-check logic from Steps 1–3's audit (raw Postgres/Redis wire-protocol checks in main.ts) has been replaced with real Prisma-client and Redis-client based checks now that those clients exist — confirm no dual/inconsistent health-check paths remain in the codebase.
If anything fails: fix it before proceeding to Day 1.

Day 1 — Identity: Registration & OTP

**Step 7b — PrismaModule refactor (prerequisite)**
Move `PrismaService` out of `AppModule`'s provider list into its own `src/prisma/prisma.module.ts`, exported so any feature module can import it. This was a deliberate Step 5 shortcut — Identity, Wallet, and Payments modules all need database access starting this day, and a provider registered directly in `AppModule` doesn't scale cleanly across them.

Done when: `PrismaService` is no longer listed as a provider in `app.module.ts`; `PrismaModule` is imported wherever it's needed instead; full test suite and build still pass unchanged.

**Step 8 — User model finalized**
Add the full `User` model to `schema.prisma`: `phoneNumber` (unique, will store normalized E.164 format only), `phoneVerifiedAt`, `handle`, `passwordHash` (nullable if OTP-only auth), `status` enum. Run the migration.

**Step 9 — Phone number normalization utility (MVP-blocking item)**
Before the registration endpoint exists, build the normalization function it depends on: accept any reasonable input format (`024...`, `+233024...`, `233024...`) and convert to strict E.164 before it ever touches the database or a lookup query. Use `libphonenumber-js` rather than hand-rolled regex — phone number formatting has more edge cases than it looks like. Unit test this in isolation with a table of input formats before wiring it into any endpoint.

Done when: a test suite covering at least 5 input format variants all normalize to the same E.164 string.

**Step 10 — `POST /v1/auth/register`**
DTO validates a raw phone number input, passes it through the Step 9 normalizer, checks for an existing user, creates a `PENDING_VERIFICATION` user record, triggers OTP send.

**Step 11 — Africa's Talking integration**
Wrap Africa's Talking's SMS API in a `NotificationsService` method (`sendOtp(phoneNumber, code)`), isolated behind an interface so the provider can be swapped later without touching calling code.

**Step 12 — OTP generation & storage**
6-digit code, hashed (never stored plaintext) in `OtpVerification`, 5–10 minute expiry, attempt counter starting at 0.

**Step 13 — OTP request rate limiting (folds in AIT/SMS-pumping protection at minimal cost)**
Even a basic version now saves a rewrite later: cap OTP requests per phone number (e.g. 3 per 15 minutes) using `@nestjs/throttler` or a Redis counter. This is cheap to add at the same time as the endpoint itself and expensive to bolt on after the fact.

**Step 14 — `POST /v1/auth/otp/verify`**
Validates code against stored hash, checks expiry and attempt count, marks `phoneVerifiedAt`, increments attempts on failure, invalidates the OTP row on success.

Done when: a full register → receive OTP (check Africa's Talking sandbox/logs) → verify flow works end to end against the Dockerized local environment, including the rate-limit and expiry paths tested with deliberately wrong/expired codes.

### Audit Checklist — Day 1 (Steps 7b–14)

- [ ] **Step 7b:** `app.module.ts` no longer lists `PrismaService` as a provider; `PrismaModule` is properly exported/imported; existing suite still passes unchanged.
- [ ] **Step 8:** `User` model migration applied cleanly; a query against it via Prisma succeeds.
- [ ] **Step 9:** the normalization utility, tested in isolation, correctly converts at least 5 distinct input formats to the same E.164 output — verify with a real test run, not a read-through of the code.
- [ ] **Step 10:** registering with a valid phone number creates a `PENDING_VERIFICATION` user with a normalized (E.164) stored number, regardless of what format was submitted.
- [ ] **Step 11:** an actual OTP SMS is observably sent (Africa's Talking sandbox log or equivalent), not just a mocked call in a unit test.
- [ ] **Step 12:** the stored OTP is hashed, not plaintext — confirm by inspecting the actual database row.
- [ ] **Step 13:** exceeding the OTP request rate limit for a single phone number is actually blocked — verified by making the requests, not by reading the rate-limit config.
- [ ] **Step 14:** full register → verify flow works end to end; a wrong code, an expired code, and an exceeded-attempts scenario all fail correctly with clear responses rather than silently succeeding or crashing.

**If anything fails:** fix it before proceeding to Day 2 — Day 2's Stellar account provisioning triggers directly off `phoneVerifiedAt`, so a broken verification flow blocks everything downstream.

## Day 2 — Identity Finish & Stellar Wallet Provisioning

**Step 15 — @handle creation with validation**
Add `handle` uniqueness (case-insensitive) to the schema/query. Basic validation rules: allowed characters (alphanumeric + underscore), length bounds (e.g. 3–20 chars), and a small reserved-word blocklist (`admin`, `support`, `cashping`, and obvious variants) — cheap now, expensive to retrofit once real users have already claimed impersonation-adjacent handles.

**Step 16 — Auth module: JWT issuance & refresh**
`@nestjs/jwt` + `@nestjs/passport` — short-lived access token (15 min), longer-lived refresh token stored (hashed) server-side so it can be revoked. `POST /v1/auth/login`, `POST /v1/auth/refresh`.

**Step 17 — Stellar SDK wrapper service**
Before touching account creation, build a thin `StellarService` wrapping `@stellar/stellar-sdk`: network config (Testnet Horizon URL, with a fallback URL slot even if unused yet), keypair generation, and a serialized-per-account transaction builder (a per-account mutex/queue, since concurrent transaction building for the same source account will fail on sequence-number conflicts).

**Step 18 — Key encryption at rest**
Wire up AWS KMS (or Vault) envelope encryption before generating a single real key: encrypt each account's secret key with a per-account data key, encrypt the data key with the KMS master key. Store only the encrypted blob + KMS key reference in `StellarAccount.encryptedSecretKey`. This is the step where cutting corners under time pressure would be the most expensive mistake in the whole build — do not store a raw secret key even temporarily during development against Testnet.

**Standing rule for this step and any future step like it:** before writing code, describe the intended approach and wait for explicit confirmation before implementing. This applies to Step 18 and to any later step involving key material, credentials, or an action that would be costly or irreversible if built wrong the first time — the build-then-audit pattern used everywhere else in this document is deliberately not used here; the review happens before the code exists, not just after.

**Step 19 — Stellar account provisioning on registration completion**
Triggered once `phoneVerifiedAt` is set: generate a Stellar keypair, encrypt and store it, fund the new account with XLM from a funded "treasury" account (Testnet friendbot for local dev, a real funded account for staging), and immediately establish the USDC trustline in the same provisioning flow — don't leave the account in a "funded but untrusted" limbo state.

**Step 20 — `GET /v1/wallet/balance` and `GET /v1/wallet/account`**
Query Horizon for the account's current balances, filtered to the USDC line.

Done when: a newly registered, phone-verified user automatically has a funded Stellar Testnet account with an active USDC trustline, visible via the balance endpoint, with the encrypted key confirmed unreadable directly from the database.

### Audit Checklist — Day 2 (Steps 15–20)

- [x] **Step 15:** handle uniqueness is case-insensitive (`@Miriam` and `@miriam` conflict); reserved words are actually rejected, not just documented; length/character bounds enforced and tested.
- [x] **Step 16:** access tokens genuinely expire at 15 minutes (not just configured to — verify with a token issued in the past or a clock-shifted test); refresh tokens are stored hashed, not plaintext, in the database; a revoked refresh token is actually rejected on reuse.

- [x] **Step 17:** two rapid, concurrent transaction-build requests for the *same* source account do not produce a sequence-number conflict — force this race deliberately, don't just trust the mutex/queue exists.

- [x] **Step 18 (highest scrutiny of the whole build):** inspect the actual database row for a provisioned account — the secret key must be unreadable without the KMS call; confirm no raw secret key ever appears in application logs (grep logs after a provisioning run); confirm the encrypted blob differs per account (not reusing one data key silently).
- [x] **Step 19:** a freshly registered and phone-verified user has, without further action, a Testnet account that is both funded (real XLM balance, not zero) and trustline-active for USDC — check both conditions independently, since "funded but no trustline" is a distinct failure mode from "trustline set but never funded."
- [x] **Step 20:** balance endpoint reflects the real Horizon-reported USDC balance, not a cached/stale/default value — verify by comparing directly against a Horizon query for the same account.

**If anything fails:** Step 18 failing is a stop-everything issue, not a fix-later one — do not proceed to Day 3 with any doubt about key material safety, even against Testnet.

## Day 3 — Recipient Resolution & Payments Core (Part 1)

**Step 21 — `GET /v1/recipients/search`**
Accepts a phone number or handle, normalizes phone input through the Step 9 utility before querying, returns minimal recipient info (not the full user record — avoid leaking data beyond what's needed to confirm identity). Rate-limit this endpoint specifically — it's the one most exposed to enumeration attacks (someone probing which phone numbers are registered).

**Step 22 — `GET /v1/recipients/:id` (confirmation payload)**
Returns the fuller confirmation view: display name/handle, verified status indicator — the data the frontend's recipient-confirmation screen needs.

**Step 23 — Decimal precision foundation (MVP-blocking item)**
Before writing the payment creation endpoint, confirm the `Transaction.amount` field is `Decimal` in Prisma (not `Float`), install `decimal.js`, and establish the rule now, in code review terms: **amounts are strings in every DTO and every JSON response, converted to `Decimal` immediately on entry and only converted to a display string immediately on exit — never a bare JS `number` in between.** Write this as an actual lint rule or code comment convention the rest of the build follows, since it's easy to violate accidentally in a later step if it isn't decided now.

**Step 24 — Idempotency interceptor**
Build the interceptor (in `common/interceptors/`) that checks an `idempotencyKey` from the request against Redis/DB before allowing a payment-creation request to proceed, returning the original result on a duplicate rather than creating a second transaction.

**Step 25 — `POST /v1/payments` (creation, not yet submission)**
Validates recipient exists, validates amount (server-side only, ignore any client-computed total), locks the sender's balance inside a DB transaction using `Prisma.$transaction` with a raw `SELECT ... FOR UPDATE` (Prisma doesn't expose row locks natively — this is the one deliberate raw-SQL escape hatch in the codebase), writes the `Transaction` row as `PENDING`, and returns `202` with the transaction ID. Does not yet touch Stellar — that's Day 4.

Done when: two rapid duplicate requests with the same idempotency key produce exactly one `Transaction` row, and a deliberately-forced race (two simultaneous payment requests draining the same balance) doesn't allow an overdraft.

### Audit Checklist — Day 3 (Steps 21–25)

- [x] **Step 21:** search returns only minimal recipient info, not the full user record; rate limiting is verified by actually making the requests, not by reading the guard config; a deliberate enumeration attempt (sweeping many numbers) is meaningfully slowed/blocked. — verified by `test/recipients.e2e-spec.ts` (`npm run test:e2e test/recipients.e2e-spec.ts`, 11 tests): every documented body is asserted to carry no phone number in any of its three shapes; the allowance is spent over HTTP by *sweeping distinct unregistered numbers* (each a 200 with an empty list, so what is counted is the lookup rather than what it found) and the next lookup is a 429 whose message carries the remaining window; the confirmation route draws on the same allowance; and a second caller still gets its 200, which is the per-caller keying shown rather than asserted.
- [x] **Step 22:** the confirmation payload contains everything the recipient-confirmation screen needs (display name/handle, verified indicator) and nothing more sensitive than that. — the body is asserted *exactly* (`id`, `handle`, `displayName`, `verified`, and nothing else) for a payable recipient and for the caller's own id, and unverified, suspended and unknown ids all answer the same 404 sentence, which is also asserted to be identical between the three so the endpoint cannot be used to ask which ids exist.
- [x] **Step 23:** grep the codebase for any bare JS `number` handling of an amount between entry and exit — there should be none; a deliberately-crafted high-precision amount round-trips through create → store → display without precision loss. — the grep is now `npm run lint:money` (`src/common/money/money-discipline.ts`, wired into `npm run lint` and therefore into every CI push): **121 files scanned, 0 violations**, and it *fails* on four shapes — a money-named column typed `Float`/`Real`/`DoublePrecision` in `prisma/schema.prisma`, a money member typed `number`/`Decimal` in a `*.dto.ts`, a money-named local/parameter/property typed `number` anywhere else, and a `decimal.js` import outside `src/common/money/` — each proven to fire (exit 1, with the offending `file:line` and the reason) by running the real CLI over a deliberately-violating tree. (`121 files scanned, 0 violations` was this step's run; the command reports **131 files, 0 violations** as of Step 25, which is the same claim on a larger tree.) `src/common/money/amount.ts` is the only way a money value can exist (`new Amount(...)` is private): `fromString` for untrusted text, strict about *spelling* (a sign, `1e3`, whitespace, a thousands separator, a leading or trailing point, and any amount with more than 7 decimals are each refused with a specific reason), `fromDatabase` for what Postgres returned, judged by *value* and throwing on the 17-decimal shape a float leaves behind, plus `isPositive()`, `toStellarAmount()` and one canonical `toString()` used for both the database and JSON. Round-trip verified against the real database by `test/money.e2e-spec.ts` (`npm run test:e2e test/money.e2e-spec.ts`, 13 tests when this line was written, 14 since Step 25): `123456789012.1234567` (a value `Number()` provably cannot carry) and the ends of the range survive create → store → display byte-for-byte, the column is asserted `numeric(20, 7)` from `information_schema` rather than from the DDL, and the *same* crafted value written to a `double precision` column in the same row comes back `123456789012.12346` — losing a digit **quietly**, which is the argument for the rule being structural rather than a parser. Two things this step's text asked for did not exist at the time and were not faked: there was no `Transaction` model to confirm (Step 25 owns the schema, and the rule is what gave it `Decimal @db.Decimal(20, 7)` — which is also why the round-trip ran against a spec-owned `numeric(20, 7)` table), and the `POST /v1/payments` hop belonged to Step 25. **Both landed in Step 25:** the model and its migration exist, this file now asserts the real `transactions.amount` column out of `information_schema` as well, and the endpoint's own round trip (client → endpoint → column → response) is `test/payments.e2e-spec.ts`.
- [x] **Step 24:** two rapid duplicate requests with the same idempotency key produce exactly one `Transaction` row — verified live, not inferred from the interceptor's code. — verified by `test/payments.e2e-spec.ts` (`npm run test:e2e test/payments.e2e-spec.ts`, 15 tests, real Postgres and real Redis, real `AppModule`): a retry with the same key and the same body answers with the *stored* body (the same transaction id, `Idempotency-Replayed: true`), and the row count for that key is read from the table (`prisma.transaction.findMany` filtered on the key) rather than inferred from a status code - **one row**. Two requests sent *without awaiting* (same key, same body) also produce exactly one row: the winner is a 202, the loser is either a 409 ("already in flight") or a replay of the same id, and both are acceptable outcomes of a genuine race while two rows are not. The same key with a *different* body is a 400 and still one row; no key at all is a 400 with no row; and a key whose request was refused is reusable, which is the release path proven over HTTP. The interceptor's branching (in flight, completed, different body, missing or ill-formed key, no authenticated user, store unreachable) is `idempotency.interceptor.spec.ts` (13 tests) against a fake store, and the Redis protocol underneath it (`SET NX` as the single command that decides who runs, the record's shape, the claim's TTL, fail-closed, release) is `idempotency-store.spec.ts` (11 tests) against a fake Redis whose three behaviours are the ones correctness leans on. Two layers carry the claim, and only the second is a guarantee: the Redis record makes the *answer* right, while `@@unique([senderId, idempotencyKey])` (migration `add_transactions`) makes the *row count* right even when the claim is gone - a `P2002` from that index becomes a 409 naming the key rather than a 500, asserted in `payments.service.spec.ts`. Not claimed: Redis unreachable is a 503 (fail closed) and a lost claim degrades a retry to that 409 instead of the original body; both are recorded in the README's Known gaps.
- [x] **Step 25 (mutation-tested, per the Step 17 standard):** a deliberately-forced concurrent race on the same sender's balance does not allow an overdraft; confirm this by breaking the lock deliberately and watching the test fail, then restoring it — the same proof standard Step 17's `AccountLock` test used. — the race is forced over HTTP in `test/payments.e2e-spec.ts`: five concurrent `POST /v1/payments` of `3` from one wallet holding `10` (real `Prisma.$transaction`, real raw `SELECT ... FOR UPDATE`, real Redis), asserted as **exactly three 202s, exactly two 409s**, and - read from the database rather than from the responses - `SUM(amount)` over that sender's `PENDING`/`PROCESSING` rows equal to `9`. **Mutation test:** with the `FOR UPDATE` clause deleted from the statement and nothing else changed, the same test fails - `AssertionError: expected [ { status: 202, …(2) }, …(4) ] to have a length of 3 but got 5` - i.e. five payments accepted and 15 committed against a wallet of 10, which is the overdraft the lock prevents; the clause was restored and the file re-run green (15/15). The rest of the step's sentence is asserted too: the amount is validated server-side by `Amount.fromString` (a client-computed `total` is refused outright by the global pipe, `1.50000000` / `99999999999999` / `0` / `-1` are 400s carrying the reason, and `123456789012.1234567` round-trips client → endpoint → `numeric(20, 7)` → response byte-for-byte, asserted against the row); the recipient must be payable (`RecipientsService.assertPayableRecipient`, the same one-sentence 404 the confirmation endpoint uses, and no lookup allowance spent on the payment path); the row is written `PENDING` with the amount as a canonical string and the client's key; the response is `202` with the transaction ID; and nothing in the path touches Stellar - confirmed by the fact that the e2e's Horizon is a fake, so a submission would have failed loudly. The overdraft arithmetic is the money module's (`Amount.minus` / `Amount.isAtLeast` at `MONEY_ARITHMETIC_PRECISION`, with the 21-significant-digit result the library default would round asserted in `amount.spec.ts`), the ordering the lock depends on is asserted in `payments.service.spec.ts` (balance read *before* the transaction opens, `SUM` *after* the lock), and the column the money rule prescribes is now asserted on the table that uses it (`test/money.e2e-spec.ts` reads `transactions.amount` out of `information_schema`: `numeric`, precision 20, scale 7).

**If anything fails:** fix before Day 4 — Day 4 builds the Stellar submission on top of whatever `Transaction` row Day 3 created, so a broken lock or a precision bug here becomes a real financial bug once real submission is wired in.

---

## Day 4 — Payments Core (Part 2): Stellar Submission

**Step 26 — BullMQ queue setup**
Register the payments queue and a worker processor in `payments/jobs/`.

**Step 27 — Transaction submission job**
On `Transaction` creation, enqueue a job. The processor: builds the Stellar payment operation via the Step 17 `StellarService`, signs with the sender's decrypted (in-memory only, never logged) key, submits to Horizon, updates status to `PROCESSING` with the returned hash.

**Standing rule applies to this step, same as Step 18:** this is the step where the app actually signs a real user's key and submits a real payment to the network — combining `SeedCustodyService`, the Stellar SDK wrapper, and BullMQ into the one action that moves someone's money. Before writing code, describe the intended approach (how the key is retrieved and immediately discarded after signing, how a mid-submission failure is handled without double-submitting, how the job is idempotent against retries) and wait for explicit confirmation.

**Added during Step 26's review (a topic the proposal must cover, not a decision taken now):** say explicitly whether submission **reuses Step 24's idempotency pair** — the client's `Idempotency-Key` with the `@@unique([senderId, idempotencyKey])` constraint behind it — or needs a mechanism of its own, and why. The two are answering different questions ("this HTTP request was sent twice" versus "this *job* ran twice"), and the answer decides what the processor keys a retry on, so it must be argued in the proposal rather than settled implicitly while implementing. Step 26 deliberately left both handles open: the queue has no `defaultJobOptions` (attempts/backoff are part of the answer) and nothing enqueues a payment yet.

**Answered in the approved proposal (`docs/step-27-proposal.md`), before any code was written.** The pair is *not* reused as the worker mechanism: it is client-scoped, the worker's question is system-scoped, and Redis is the wrong side of the failure line for money when the authoritative state is already a row. The mechanism is `jobId = transaction.id` (a courtesy, because BullMQ forgets a job when its retention fires) plus a conditional `UPDATE` in Postgres as the arbiter, with the row deciding what each attempt does. Four decisions were put to review and approved as proposed — the rebuild fence (rebuild only when `now > submission_deadline` **and** a freshly loaded sequence equal to the recorded one, with a `tx_bad_seq`-on-rebuild restoring the previous record and stopping); four new `transactions` columns (`stellar_tx_hash` unique, `stellar_tx_sequence` as `varchar`, `submission_deadline`, `failure_reason`); the enqueue placed inside `PaymentsService.create`'s transaction before the commit; and the unique index over the hash. The review added one thing to that list, shipped in this step rather than deferred: a **three-second `commandTimeout` on the producer's Redis connection** (`PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS`), because the enqueue runs inside the sender's row lock and an unbounded hang there is an availability cascade onto every payment from that sender. It is a *second* connection on purpose: ioredis arms `commandTimeout` for blocking commands too, and BullMQ's worker blocks for `drainDelay` (5s idle, up to 10s with a delayed job pending), so a few-second bound on the shared connection would turn every idle worker tick into an error plus a retry delay.

**Step 28 — Status polling job**
A separate repeatable BullMQ job (or a per-transaction delayed job scheduled right after submission) polls Horizon for confirmation using the stored `stellarTxHash`, updates status to `SUCCESSFUL` or `FAILED` with a `failureReason`, and triggers a notification.

**Answered in the approved proposal (`docs/step-28-29-proposal.md`) before the code was written.** The repeatable job won: a sweep whose work list is the `transactions` table (rather than one delayed job per payment, whose work list is Redis) is the only shape in which a flushed keyspace or a retention policy costs a *delay* rather than a payment that nothing will ever look at again. The schedule is a BullMQ job scheduler (`upsertJobScheduler`, id `confirmation-sweep`, one stable id per deployment so replicas do not multiply ticks) and it is **off by default** (`PAYMENTS_CONFIRMATION_INTERVAL_MS=0` registers nothing and says so at boot), because a process that starts writing payment verdicts on a timer has to be something a deployment opted into. A tick takes at most `CONFIRMATION_SWEEP_BATCH = 50` rows, oldest deadline first, and resolves them through `confirmation-triage.ts` — a pure function over what Horizon said, the row's recorded deadline and the clock: settled-and-successful → `SUCCESSFUL`; settled-and-not → `FAILED` with `landed-unsuccessful:<tx code>`; not found before the deadline plus `CONFIRMATION_GRACE_MS = 60_000` → wait; past it → `FAILED` with `not-found-after-deadline`; Horizon unavailable, or a hash with no deadline → `unresolved`, which writes nothing at all. The grace window is a reading of Horizon's ingest lag, not a product decision: erring towards waiting costs a minute, erring the other way claims a payment failed that then lands. The sender is told **after** the write, from the stored row, and a provider failure is logged and swallowed, which is what makes "one resolution, one SMS" a property of the compare-and-set rather than of a caller's timing. §5 of the proposal names exactly which of Step 27's `PROCESSING`-for-ever cases this closes (every row with a recorded hash) and which it deliberately does not (a claim that died before `recordEnvelope`, reported as `stuckWithoutHash` after five minutes and never written from the poller).

**Step 29 — Transaction status state machine**
Formalize the transitions (`PENDING → PROCESSING → SUCCESSFUL | FAILED`) as an explicit guard in the service layer — no direct status writes from anywhere else in the codebase, so the state machine can't be bypassed by a future shortcut.

**Answered in the same proposal.** `src/payments/services/transaction-status.ts` owns the table *and* every write of the column (`claimForSubmission`, `recordEnvelope`/`restoreEnvelope`, `markFailed`, `markSuccessful`), each a compare-and-set on the status it expects; the guards refuse an illegal move before the database is touched, and the `WHERE` clause is what actually decides a race. Creation is deliberately not a writer: a payment is created `PENDING` by the column's own `@default(PENDING)`, so the schema states what a payment starts as and the state machine states what it becomes — turning the rule on removed three restatements of the default (`PaymentsService.create` and two e2e fixtures) on the first run. The structural half is `npm run lint:status` (`src/payments/status-discipline.ts`, wired into `npm run lint` beside the money rule), which flags a `data: { status: ... }` on `transaction.create|createMany|update|updateMany|upsert` anywhere outside that file, a raw `SET status =`, and an exemption pointing at a file that has been moved, printing `file:line [rule] what to write instead`. It also prints what it *read* (`158 files scanned, 3 status writes in the sanctioned writer, 0 violations`) so a clean run cannot be confused with a scan that found nothing.


Done when: a payment submitted through the full flow (create → job picks it up → Stellar submission → polling confirms) lands as `SUCCESSFUL` with a real Testnet transaction hash you can look up on a Stellar Testnet explorer, and a deliberately-invalid payment (e.g. insufficient balance forced past the earlier check, or a bad destination) resolves to `FAILED` with a readable reason rather than hanging in `PROCESSING` forever.

### Audit Checklist — Day 4 (Steps 26–29)

- [x] **Step 26:** the queue is registered and a trivial job round-trips through it in a test. — verified by `test/queue.e2e-spec.ts` (`npm run test:e2e test/queue.e2e-spec.ts`, 3 tests, real Redis, nothing substituted): the queue is resolved through the token `PaymentsQueueModule` registered (`getQueueToken('payments')`), the worker started by booting the app is consuming (`PaymentsProcessor.worker.isRunning()`), and a probe job added through the application's own enqueue path (`PaymentsQueueService.enqueueProbe()`) comes back as `{ pong: true, workerPid: <n> }` with the completed count unchanged — the probe sets `removeOnComplete`, so asking whether the worker is alive does not leave a job behind. The second test adds a job name no handler knows and asserts the job is **rejected**, not acknowledged, because a job marked done without being attempted is a payment reported as submitted. What the e2e deliberately does *not* assert is that the answering pid is its own process: every e2e file boots this same application and vitest runs files in parallel, so several processes may each have a worker on this queue, and BullMQ hands a job to exactly one of them — asserting `process.pid` would pass alone and flake in the suite. The step's other decisions are pinned where they are cheap enough to run on every commit: `payments-queue.module.spec.ts` (2 tests — the connection is `redis.url` and nothing else, and a missing URL throws rather than silently defaulting to BullMQ's `127.0.0.1`), `payments.processor.spec.ts` (6 — the probe's answer is this process's pid, an unknown job name throws with the name and id in the message, and both worker event handlers: `failed`, logged with name/id/attempt count and tested with no job at all, and `error`, which is a crash guard rather than decoration because BullMQ emits `error` from its blocking run loop and an `EventEmitter` with no `error` listener throws), and `payments-queue.service.spec.ts` (3 — the probe is added with exactly `{ removeOnComplete: true }` and no attempts or backoff, and a refused `add` rejects rather than being swallowed, since only the caller knows what a failed enqueue means). **11 new tests; unit suite 640 tests in 38 files, lint 139 files scanned / 0 violations / 0 warnings, build exit 0, all as of Step 26.** Nothing in this step enqueues a payment: the queue has no `defaultJobOptions` and the processor has no submission handler, because both are Step 27's to decide — the retry policy is what decides whether a repeated job becomes a repeated payment, and it is not a decision to make in passing while wiring a queue.
- [x] **Step 27 (highest scrutiny, same standard as Step 18):** a real Testnet transaction hash is produced from a real signed submission; the decrypted key is confirmed never logged (grep, as in Step 18's audit); a deliberately-retried job does not produce a double-submission; confirm via the approved proposal that this was built exactly as agreed, not improvised during implementation. — verified by `test/submission.e2e-spec.ts` (`RUN_STELLAR_IT=1 npm run test:e2e test/submission.e2e-spec.ts`, 4 tests when this line was written — the file runs 7 since Step 28 added three: real KMS endpoint, real Horizon, real Postgres and Redis) plus 4 new unit specs. **The real submission**, quoted from the run this line was written after: payment `ae930f12-0e00-4dfd-9244-48c50887bbb4` was built, signed and submitted by `PaymentsSubmissionService` as `e9da1c48bdfaeacd13eb05d1fff82eee4d61d77f0faa467c9d539955bf36ec0d` in ledger `4943111` (sequence `21230478610661377`); the row moved `PENDING → PROCESSING` carrying that hash, that sequence and a future deadline; and Horizon — asked directly with a plain `fetch`, not through this codebase — reports the transaction landed, the sender at `98.7500000` USDC and the recipient at `1.2500000` (from `100.0000000` and `0.0000000`). **The deliberate retry:** the same `transactionId` submitted again answers `deferred (recorded-transaction-still-valid)` — the fence — and the network is what says no second transaction exists: the sender's sequence is unchanged (`21230478610661378`) and the row still names one hash. **The key sweep:** the sender's seed (`keypair.secret()`, opened in-process through the real KMS for the sweep) appears in none of the run's 46 captured log lines (47 in the run Step 28's line records), the wallet row, the payment row or the job result, and the stored row is asserted to be a `cp-kms-1.` envelope. **The review's addition, measured rather than asserted:** the same file wedges Redis with `CLIENT PAUSE 6000 ALL` and asserts the payment fails *at* the bound (`3044`, `3122`, `3206`, `3251` ms in the runs that line was written from and `3602` ms in the re-run Step 28's line records, against `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS = 3000`: the assertion is the band `2750 ≤ elapsed < 5000`, the bound plus `BOUND_SLACK_MS = 2000` for a loaded machine, and every measurement lands well before the `6000` ms pause ends) rather than hanging on the sender's row lock, that no `transactions` row was written, that the producer **recovers** (a probe round-trips afterwards), and that the orphan job the abandoned script eventually queues is **rejected** by the handler ("does not exist, so there is nothing to submit") — the loud half of the §6 trade. Offline, 692 tests in 42 files (`npm test`, Step 27) cover the fence's two halves and the `BigInt` sequence comparison, every row of the triage table, the transition table, the enqueue's exact options, and the order of the writes (`claim → record → submit`). **Re-measured after this step's files landed:** `npm run lint` → `Found 0 warnings and 0 errors` (`oxlint src/ test/ --deny-warnings`, 148 files) and `Money discipline: 148 files scanned, 0 violations as of Step 27` — the first measurement that covers the new files rather than the tree they were added to. The bound was re-measured once more after the e2e's unused imports were removed (`3353` ms on a fifth run — inside the same band the assertion allows, with the same four assertions passing). **One name was amended later, by Step 28's audit of this step's triage table:** the reason a permanent operation code earns is `landed-unsuccessful:<code>` rather than `submission-rejected:<code>`, because an operation code arrives inside a `tx_failed` result, and a transaction earns that result by being *closed* — the ledger has it, the fee is charged and the sequence consumed. `submission-rejected:<code>` is now reserved for the codes that mean no ledger ever saw the envelope (`NEVER_LANDED_TRANSACTION_CODES`), and §4 of this step's proposal records the amendment with the reasoning: no answer in the table changed, only what the name claims about the ledger.
- [x] **Step 28:** a real submitted transaction is polled and correctly resolves to `SUCCESSFUL`; a deliberately-invalid transaction resolves to `FAILED` with a readable reason rather than hanging in `PROCESSING`. — **verified against the real network** (`RUN_STELLAR_IT=1 npm run test:e2e test/submission.e2e-spec.ts`: 7 tests passed in 59.90 s, exit 0 — real Testnet Horizon, the local KMS, real Postgres and real Redis; the environment that run needs — a KMS endpoint on `http://localhost:5055`, a key created there, `AWS_ENDPOINT_URL` pointing at it, and `.env` for Postgres and Redis — is written out in the test file's header comment, and leaving it out is how a run fails on AWS credentials rather than on this code). **The poll, on a payment this run submitted:** payment `c049ecbd-8c8f-47ee-a2c2-bd2d7886ae12` was built, signed and submitted as `4273807222da539ed9d53d7d1af6ba5cdeffc62bbf2d4f5ad52e4fca76974a8e` in ledger `4951050` (sequence `21264576356024321`), which left the row `PROCESSING`; `PaymentsConfirmationService.sweep()` then moved it to `SUCCESSFUL` (`polled=1 confirmed=1`); Horizon — asked with a plain `fetch`, not through this codebase — reports that same hash `successful: true` in ledger `4951050`, the sender at `98.7500000` USDC and the recipient at `1.2500000`; and the sender was told once, after the write rather than before it. **The `FAILED` half, on a transaction the ledger really refused:** a second row was claimed and given the envelope of a landed-but-unsuccessful transaction **read from Horizon's own history** — preflight refuses any transaction whose operations would fail, so a transaction that lands *and* fails cannot be manufactured by this app, only found — the same sweep resolved it `PROCESSING → FAILED (landed-unsuccessful:tx_failed)` (payment `f7bdbbb9-e03b-4ba4-a0ac-b327b12adf64`), the sender was notified, and the hash the row holds (`c51dac0f015e04a12e9c5c635c12e2a4e580a12283b5795387086867feabfadc`) answers `successful: false` in ledger `4951050` when queried directly — the network charged a fee for it (`100` stroops), and its source account is `GAB62KEK…`, not this app's sender, which is the detail that shows the envelope was found rather than built here — and a fee charged for a transaction nobody meant to fail is what "the ledger really refused" means. **The deliberately-invalid half, on a payment the network refuses outright:** a row for `1000000.0000000` USDC against a sender holding `98.7500000` is refused at submission with an HTTP 400 naming `op_underfunded`, and the app's own submission path answers `failed` and writes `FAILED` / `landed-unsuccessful:op_underfunded` (payment `a17a84d4-8e7d-4fd8-9df6-b5767d2d0c88`), rather than leaving a `PROCESSING` row that no poll could ever resolve; the sender's USDC line is asserted unchanged (the money provably did not move) and a second attempt through a fresh load answers `skipped (status:FAILED)` instead of attempting a second debit. **What such a refusal leaves behind is the one claim in this line that had to be rewritten, and the correction is the interesting part:** the test first asserted that a refused submission leaves `stellar_tx_hash` `NULL` and that Horizon has no record of the hash, and the run falsified both halves. The row keeps the hash of the envelope this app built (`markFailed` keeps it deliberately, as the fingerprint of the attempt) and the ledger **has** the transaction: `GET /transactions/b49bf0f798dd66818df2b31a4cb7b3da496f364ce576ab7125f4ea3f498f5664` answers `successful: false` in ledger `4951053`, with a fee charged for it (`100` stroops) — read back with a plain `curl` outside this codebase as well as by the test's own assertion. **That finding is what renamed the reason, and this re-run is where the rename is verified rather than argued:** both `FAILED` cases above wrote `landed-unsuccessful:` — `tx_failed` on the poll's path, `op_underfunded` on the submission's — because the two shapes are one event, a transaction a ledger closed unsuccessfully, and the vocabulary now belongs to the *code* rather than to whichever caller learned it first. `submission-rejected:<code>` is reserved for the codes that mean no ledger ever saw the envelope (`tx_bad_seq`, `tx_too_late`, `tx_malformed`, `tx_insufficient_fee`, `tx_bad_auth`, `tx_no_source_account`, `tx_insufficient_balance`, `tx_internal_error`, held in `NEVER_LANDED_TRANSACTION_CODES`), a code in neither list is named `unknown:<code>` instead of borrowing a claim, and no verdict moved with the names: a permanent operation code is still `failed` and an unclassified one still `retry`. The reservation is asserted as a property over the list itself in `submission-triage.spec.ts`, which is how a code cannot drift from one column to the other unnoticed. §6 of the proposal carries the measurement and the reasoning; Step 27's proposal records the amendment to its own table, and a `FAILED` row's hash is worth asking Horizon about rather than assuming it is absent, whichever of the two names the row carries. Everything up to the network is already checked, and checked by the decision rather than by the wiring: `confirmation-triage.spec.ts` (12 tests: every branch of the table, including both boundaries of the grace window and the two answers that conclude nothing), `payments-confirmation.service.spec.ts` (13 tests: the work-list query asserted whole, one compare-and-set per resolution, no write for `waiting`/`unresolved`, no second notification when the row was resolved elsewhere, the resolution kept when the provider is down, and one unreadable row not costing the rest of the tick its poll), `horizon-transaction-lookup.spec.ts` (9 tests: Horizon's 404 as a normal `not-found`, a 5xx as `unavailable`, a failed record decoded to `tx_failed`), `submission-triage.spec.ts` (15 tests: every row of Step 27's table, plus the naming asserted as properties over both code lists — every `landed-unsuccessful:` code is one a ledger closed, every code in `NEVER_LANDED_TRANSACTION_CODES` wears `submission-rejected:`, and a code in neither list claims neither), and `payments.processor.spec.ts` (the confirmation branch runs one sweep and lets a query failure fail the job). No check in this repository could have substituted for that run, because what it tests is the network's behaviour rather than this code's.
- [x] **Step 29:** attempt a direct status write from outside the state-machine guard in a test — it should be structurally prevented or caught, not merely discouraged by convention. — **caught, on a real file in this repository.** `npm run lint:status` was run with a rogue write added at `src/payments/rogue-shortcut.ts` (a `prisma.transaction.update({ where, data: { status: 'FAILED' } })` that nothing imports), and it exited **1** with:
  ```
  Status discipline: 1 violation(s) in 159 scanned files

    src/payments/rogue-shortcut.ts:12  [transaction-status-write] transaction.update writes the status column directly, which bypasses the state machine - call a writer in src/payments/services/transaction-status.ts (claimForSubmission, recordEnvelope, restoreEnvelope, markFailed, markSuccessful) instead
  ```
  removing the file and re-running it answers `158 files scanned, 3 status writes in the sanctioned writer, 0 violations` and exits 0 — so the pass is a pass over the whole repository (`src/` and `test/`, 158 files) and not a scan that found nothing. Beside that, `src/payments/status-discipline.spec.ts` pins the rule itself (19 tests: each write method, the line number, the detail naming the file and the writers to call instead, prose and other-model writes and `where: { status }` reads accepted, raw `SET status =` flagged in either case, a status smuggled through a variable *not* flagged — the gap the checker names about itself — the exemption counted and its absence reported, and the repository clean with three writes in the sanctioned file). Three rules run in CI: `oxlint --deny-warnings`, `lint:money`, `lint:status`.

**If anything fails:** Step 27 failing is a stop-everything issue, same as Step 18 — do not proceed to Day 5 with any doubt about signing/submission safety.

---

## Day 5 — History, Reconciliation, Hardening

**Step 30 — `GET /v1/payments/:id` and `GET /v1/payments`**
Individual lookup plus paginated, filterable history (sent/received, date range, status).

**Answered in the code, with every decision recorded where it was made.** `src/payments/history/payment-history-query.ts` owns both what `GET /v1/payments` accepts and the `WHERE` clause that answers it — the same split Step 21's `classifyRecipientQuery` makes, so the half that can be exhaustive without a database is a spec of its own (`payment-history-query.spec.ts`, 71 tests: every value each parameter takes, every empty string, both ends of the clamp, a reversed range, `2026-02-31`). Both reads call one predicate, `membershipWhere(userId, direction)`, and the caller's id is an *argument* rather than a request parameter, so a payment is visible to the two accounts on the row and "belongs to two other people" and "does not exist" are the same 404: there is no second check, by design, because a second check is a second place for the two answers to disagree — and the detail route is therefore not an oracle for which payment ids exist. An id that is not a UUID is a 400 from `ParseUUIDPipe` before any row is read, because "fix the request" and "stop looking" are different instructions. The filters: `direction` is `sent`/`received`/`both` (default `both`), `status` is one of the four, `from`/`to` are **inclusive** ISO-8601 bounds on `createdAt` with a date-only value read as midnight UTC of that day (`2026-02-31` refused rather than rolled into March), and `limit` is a whole number **clamped** to `[1, 50]` (default 20) when it is out of range, while a value that is not a whole number at all is a 400 — the one deliberate difference from Step 21's `limit`, where the bound prices sweeping other people's handles; here the caller is reading their own money, a page is a page, and `hasMore` says whether there is another one. The bound lives in the module and not as `@Max()` on the DTO, so there is one statement of it instead of two free to drift. `hasMore` comes from reading `limit + 1` rows and discarding the extra one rather than from a second `count()`, which is the difference between an answer that cannot disagree with the page in hand and one that can, and the order is `createdAt` descending with the **id as a tiebreak** (`PAYMENT_HISTORY_ORDER`) so the boundary a client pages on is drawn on a total order. A list row carries six fields; `failureReason` and `stellarTxHash` are on the detail body only — a disclosure decision as much as a size one, since the reason is a raw machine code and the fewer rows carrying one, the fewer places it can be rendered as a sentence somebody wrote for a person.

**Step 31 — Reconciliation job**
A scheduled BullMQ job comparing the sum of internal ledger movements per account against the actual Horizon balance, logging (and alerting via Sentry) any drift.

**Step 32 — Audit log**
Append-only table/model logging sensitive actions (login, OTP verify, handle change, payment initiated/completed, any key-access event) — write this as a service method called explicitly at each of those points, not as a generic catch-all interceptor, so the log entries carry meaningful context.

**Step 33 — Rate limiting pass**
Go back through every endpoint built so far and confirm `@nestjs/throttler` guards are applied appropriately — this is a deliberate sweep, not a one-time setup, since it's easy for a new endpoint added mid-week to slip through unguarded.

**Step 34 — Security review against the architecture plan's Section 5 checklist**
Walk the checklist item by item against the actual code: key management, auth, transaction integrity, data protection, API hardening, Stellar-specific risks. Fix anything found before calling the week done — this is the checkpoint, not a formality.

Done when: every item in Section 5 of the architecture plan has a concrete answer in the codebase, not just an intention.

### Audit Checklist — Day 5 (Steps 30–34)

- [x] **Step 30:** history endpoint correctly paginates and filters (sent/received, date range, status) against real data, not just a small fixture that happens to pass. — `npm run test:e2e test/payments-history.e2e-spec.ts`, **25 tests passed** (4.7s of tests; 15.0s including the boot) against the real `AppModule` — real Postgres, real Redis, the real `PaymentsService` and query module, with only `SMS_SENDER`, `AccountProvisioningService` and `StellarService` substituted (the last reports every account absent, so a route that reached Horizon would fail loudly). The data is **thirty rows, one per hour from `2026-06-01T00:00:00Z`**, written straight into `transactions` through Step 29's own writers (`claimForSubmission` / `markSuccessful` / `markFailed`, never a hand-written `status`), with the four statuses cycled, the sender alternating, and a control *pair* belonging to two other accounts written at the same instant as the caller's tenth row. Pagination: the default page is twenty rows, newest first, with the twentieth at that row's own instant and `hasMore: true`; `limit=50` reads all thirty to the end, oldest last, one entry per payment, `hasMore: false`; `limit=1000` is answered rather than refused (the caller's whole thirty here; the fifty-row cap itself is pinned by the unit spec); `limit=0` clamps up to a single row while `-1`, `1.5`, `twenty` and an empty `limit` are 400s naming the parameter. Filters: `direction=sent` and `received` each answer the fifteen rows on that side, `status=SUCCESSFUL` the seven rows in that state and `FAILED` the seven in that one (so the four statuses partition the thirty), a combination that matches nothing answers an empty page rather than an error, an empty `direction` is no filter while an empty `from` is a 400, and both time bounds are proved **inclusive from both sides** by putting `from` and `to` on a row's own `createdAt` — with a date-only bound read as midnight UTC of that day (a `to` on the day itself excludes the day), a reversed range refused, and `2026-02-31` refused as not an instant. Membership is asserted from the outside: the control pair is absent from the caller's and the partner's pages, both of its parties read it by id with their own `direction` (one `sent`, one `received`), every other account gets 404, and that 404 is compared *field by field* with the 404 for a UUID nobody minted — equal `message`, `error` and `statusCode`, and the same key set — so the two answers are one answer. A non-UUID id is a 400 before any row is looked for. The order's totality is the one property thirty hour-apart rows cannot show, so the control pair carries it: two rows in one millisecond, asserted newest first by `id` descending and identical on a second request. Measured at this step: `npm test` is **841 tests in 47 files**, `npm run lint` is oxlint (0 warnings, 0 errors) then `Money discipline: 164 files scanned, 0 violations` and `Status discipline: 164 files scanned, 3 status writes in the sanctioned writer, 0 violations`, and `npm run build` exits 0.
- [ ] **Step 31:** the reconciliation job actually detects a deliberately-introduced drift between internal ledger and Horizon balance, and alerts via Sentry — verified by forcing a mismatch, not by reading the comparison logic.
- [ ] **Step 32:** every listed sensitive action (login, OTP verify, handle change, payment initiated/completed, key-access event) produces a real audit log row — verified by triggering each one and checking the table, not by grepping for the service-method calls.
- [ ] **Step 33:** re-check every endpoint built across Days 1–5 for a throttler guard — produce the actual list of endpoints and their guard status as evidence, not an assertion that the sweep happened.
- [ ] **Step 34:** each item in the architecture plan's Section 5 has a specific, named answer (which file, which line, which test) — a checklist item marked done with no pointer to where it's enforced doesn't count.

**If anything fails:** this is the last checkpoint before the Days 6–7 buffer — anything found here should be fixed now, not carried into buffer time meant for edge cases and slippage absorption.

---

Days 6–7 — Buffer
No new features. This time is explicitly for:

Edge cases: expired OTPs, insufficient balance, malformed phone numbers, duplicate handle race conditions, Horizon timeouts.
Bug fixing anything surfaced by the Day 5 security review.
Absorbing any slippage from Days 1–5 — with one developer, treat this buffer as expected, not a sign something went wrong.
Deployment — ECS/Fargate
Step 35 — Production Docker image Confirm the multi-stage Dockerfile from Step 3 produces a slim, production-only image (no dev dependencies, no source maps unless intentionally kept for Sentry).

Step 36 — Push to Amazon ECR Create an ECR repository, authenticate Docker to it, build and push the production image.

Step 37 — Secrets in AWS Secrets Manager Move every value from .env (DB credentials, JWT secret, Africa's Talking key, KMS key reference) into Secrets Manager — never bake secrets into the Docker image or commit them to the ECS task definition in plaintext.

Step 38 — ECS cluster, task definition, and service Create a Fargate cluster, define a task (CPU/memory sized to match the earlier cost estimate — start small, e.g. 0.5 vCPU/1GB), reference the ECR image and Secrets Manager values, and create a service with a target group behind an Application Load Balancer.

Step 39 — Health checks Point the ALB's health check at GET /v1/health (and separately verify /v1/health/stellar manually — don't wire Horizon connectivity into the ALB health check itself, since a Horizon blip shouldn't cause ECS to cycle the container).

Step 40 — Staging smoke test Run the entire register → verify → wallet provision → search recipient → send payment → confirm flow against the deployed staging environment on Stellar Testnet, not just locally — this is the first time the KMS integration, Secrets Manager values, and real network latency are all exercised together.

Step 41 — CI/CD deploy step Extend the Day 0 GitHub Actions workflow with a deploy job (build → push to ECR → force new ECS deployment) gated on the main branch, so future changes ship without a manual console click-through.

Done when: a fresh clone of the repo, with only AWS credentials and the documented env vars, can be built and deployed to a working staging environment by someone who wasn't the original developer — that's the real test of whether this sequence actually captured everything.

This document is the implementation companion to the NestJS architecture plan. If a step here conflicts with something in that plan, the architecture plan's reasoning wins — this is the "in what order" layer on top of it, not a replacement for it.

