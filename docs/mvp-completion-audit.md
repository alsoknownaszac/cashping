# MVP completion audit — what was built against the plan

This document compares what actually exists in this repository against the original backend
architecture plan, item by item. It exists because "we built the plan" is a claim, and a claim
nobody checked is how a gap survives to launch.

**The reference is the plan as written, not anything reconstructed from the code.** The plan —
*Cashping — Backend Architecture & Build Plan (NestJS / Node.js)* — was never committed to this
repository, so the version this audit was done against is quoted in the prompts that produced it.
Where the plan and this repository disagree, both are stated rather than reconciled: a deviation is
a fact about the build, and this document's job is to surface it, not to smooth it out.

**How each row was checked**, in rough order of how much weight it carries:

- Read the code that would have to exist (`src/`, `prisma/schema.prisma`, `test/`) rather than the
  documentation about it.
- Grep for the *absence* as well as the presence: several "Not Done" rows below are conclusions
  drawn from a search that found nothing anywhere in `src/`, and the search is named so it can be
  repeated.
- Where a claim was already measured in `README.md` or a step's audit line, that measurement is
  cited with the step it was taken at, per this repository's own convention
  (`README.md` → *Documentation conventions*).

### The numbers in this document, and when they were taken

Measured for this audit, on the tree this file is committed with — the code as of Step 34c plus the
deletion of the refusing email stub, and with no source change in the commit that added this file:

```bash
npm test        # 61 files, 993 tests, 49.66s
npm run lint    # oxlint: 0 warnings, 0 errors on 219 files
                # Money discipline:  219 files scanned, 0 violations
                # Status discipline: 219 files scanned, 3 status writes in the sanctioned writer, 0 violations
ls test/*.e2e-spec.ts | wc -l   # 16
```

Two things those numbers are *not*: they are not the counts in `README.md` (which carry the step
they were measured at, and this tree is larger), and they are not evidence that the e2e suites pass.
`npm test` is the unit suite; the e2e suites need the compose Postgres and Redis and are run by
hand — `README.md` records that CI runs lint, the unit tests and the build, and no e2e suite at all.

A change that lands after this audit cannot appear in the rows below, so the one such change — the
fix to Step 34c's email endpoint, which was the single send in `AuthService` with no cap on it — is
recorded at the end of this file, under *After this audit*, carrying the commit it landed in. That
is the convention read the other way: a measurement carries the step it was taken at, so a change
carries the commit it landed in, and neither is allowed to pass for the other.

### How to read the statuses

| Status | Means |
| --- | --- |
| **Done** | The item exists and is exercised (a test, a real run, or a lint gate that fails on a violation). |
| **Partially Done** | Part of the item exists and part does not. The *evidence* column says which half. |
| **Not Done** | Nothing implements it. A search that found nothing is named where that is how it was decided. |
| **Superseded** | The plan asked for something else, deliberately, later in the project. Not a gap. |

---

## A. Section 11 — "Critical (MVP-blocking)"

| Item | Status | Evidence |
| --- | --- | --- |
| **SIM swap / phone takeover protection** — a PIN independent of the phone before any payment, plus step-up friction after any auth event from a new device/context | **Partially Done** | The PIN half is built: `src/identity/pin/` (scrypt hash, `PIN_MAX_ATTEMPTS = 5`, `PIN_LOCKOUT_MINUTES = 15`, both in `src/config/configuration.ts`), and `src/common/guards/step-up-auth.guard.ts` refuses `POST /v1/payments` without a fresh `X-Step-Up-Token` from `POST /v1/auth/pin/verify`, writing `auth.pin.failed` with outcome `denied` for every refusal. Pinned by `test/pin.e2e-spec.ts`. **The device half does not exist**: nothing in `src/` records a device, a user agent, or a sign-in context, so "an auth event from a new device" is not a thing this system can notice. See finding **F1**. |
| **Decimal precision handling, end to end** — `Decimal` not `Float`, amounts as strings on the wire, all arithmetic through a decimal-safe library | **Done** | `prisma/schema.prisma`: `amount Decimal @db.Decimal(20, 7)`. Amounts travel as strings (DTO members typed `string`, asserted by `test/money.e2e-spec.ts` — README records 14 tests there). `decimal.js` is confined to `src/common/money/` and the discipline check *fails the build* on four shapes: a money-named column typed `Float`/`Real`/`DoublePrecision`, a money member typed `number` in a `*.dto.ts`, a money-named local/parameter/property typed `number` anywhere else, and a `decimal.js` import from outside `src/common/money/` (`src/common/money/money-discipline.ts`, `RULES` ×4). Wired into `npm run lint`, therefore into every CI run. Re-measured for this audit: **219 files scanned, 0 violations**. |
| **Key backup / disaster recovery procedure** — what happens on KMS master-key loss or outage, who may invoke recovery, where the material lives | **Not Done** | No procedure exists in any form: no runbook document (the `docs/` tree is five files, none about recovery), nothing in `README.md` → *Known gaps*, and no `kms:ReEncrypt*` permission or re-wrap code anywhere. The *limitation* is documented in two places — `README.md`'s custody section ("the master key cannot be rotated by this application yet … recovering today means a re-wrap step that has not been written") and `docs/pre-production-hardening.md` §3.0(b) — so this is a known-and-named gap, not a surprise. It is still not the deliverable the plan asked for. See finding **F2**. |
| **Transaction irreversibility — defined process** — user-facing "no refund guarantee" language, a support/dispute path, and an audit trail structured for dispute investigation | **Partially Done** | The audit-trail third is built and is the strongest of the three: an append-only `audit_log` table (migration `20261001120000_add_audit_log`, with a trigger that refuses `UPDATE`/`DELETE` even from the table owner), `payment.initiated`/`payment.completed`/`payment.failed` rows, and a failure vocabulary that separates *landed and unsuccessful* from *never landed* (`landed-unsuccessful:` vs `submission-rejected:` prefixes, `src/payments/services/submission-triage.ts`). **The other two thirds are missing**: no user-facing refund/irreversibility language exists in any DTO, doc, or message template, and there is no support or dispute route — a grep for `refund\|dispute\|irreversib` across the repository returns only prose about signatures being irreversible. See finding **F3**. |
| **Basic AML/velocity controls** — per-transaction and rolling daily/weekly limits, plus a hook point for sanctions/watchlist screening | **Not Done** | No velocity, threshold, or limit code exists (`src/config/configuration.ts` holds `OTP_REQUESTS_PER_WINDOW`, `RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW`, `IDEMPOTENCY_TTL_SECONDS` — cost and abuse caps — and no amount ceiling of any kind), and a grep for `sanction\|watchlist\|AML` across `src/` finds nothing. `README.md` → *Known gaps* states the position deliberately: "there is no *product* limit — no per-transaction maximum, no daily ceiling, no velocity rule … A real limit belongs with the product owner, applied as its own check in `PaymentsService`." That is an honest record of an open product decision, and it is still an MVP-blocking item from the plan's own list. See finding **F4**. |

## B. Section 11 — "Important"

| Item | Status | Evidence |
| --- | --- | --- |
| **Ghana Data Protection Act compliance** — an explicit checklist item for Ghanaian PII, not just generic "encrypt PII" | **Partially Done** | The substance is strong and generic: phone numbers are masked before they reach any log line (`maskPhoneNumber`, `src/common/phone/phone-number.ts`), a recipient search never returns a phone number (`RecipientSearchResponseDto` states the decision), `AuditEntry.metadata` is forbidden from carrying a secret or an identifier, and seeds exist only inside the envelope. **The jurisdiction-specific artefact does not exist**: a grep for `Data Protection`, `Ghana` and `privacy` across `src/` and `docs/` finds no checklist, no retention policy, and no data-subject-process note. The plan asked for the checklist; the controls it would audit mostly exist. See finding **F5**. |
| **Handle validation rules** — character rules, length limits, profanity/reserved-word filter (`admin`, `support`, `cashping`) | **Done** | `src/identity/handle/handle.ts` is the single answer: 3–20 characters (`HANDLE_MIN_LENGTH`/`HANDLE_MAX_LENGTH`), `/^[a-z0-9_]+$/` after normalization, and `RESERVED_HANDLES` — an explicit set covering `admin`, `administrator`, `root`, `moderator`, `support`, `help`, `cashping` and underscore variants of the impersonation names, with a spec that fails if an unreachable entry is ever added. Case-insensitive uniqueness comes from canonical storage plus a `CHECK` constraint backstop. Proven over HTTP: commit `2993aa1` ("prove the handle rules over HTTP and at the constraint"), `test/auth.e2e-spec.ts` ("refuses a reserved handle over HTTP, and claims nothing for the number that tried"). **Reserved-word filtering is built; there is no profanity list** — see the note in finding **F6**. |
| **Phone number normalization** — enforce E.164 at registration and lookup | **Done** | `src/common/phone/phone-number.ts` with `libphonenumber-js`, `DEFAULT_PHONE_REGION = 'GH'`, normalization applied before every write and every lookup. `prisma/schema.prisma`'s `User` docblock records why it must be *before*: `024 123 4567`, `+233241234567` and `2330241234567` all reach the column as `+233241234567`, which is what makes a unique index on the number meaningful. Pinned by `src/common/phone/phone-number.spec.ts`. |
| **Horizon fallback / failure handling** — a fallback Horizon URL, and "Horizon unreachable" as a distinct retryable state from "transaction failed" | **Partially Done** | The classification half is built and carefully argued: `src/payments/services/submission-triage.ts` returns five answers (`accepted`, `retry`, `rebuild`, `superseded`, `failed`) so that "no verdict" travels out as a retryable error while a definitive no becomes `FAILED`; `horizon-transaction-lookup.ts` treats a 404 as a plain not-found and a 5xx as unavailable; `transaction-submitter.ts` separates "Horizon said no" from "Horizon never answered" at the port. Pinned by `submission-triage.spec.ts` and `horizon-transaction-lookup.spec.ts`. **The fallback is a slot, not a feature**: `STELLAR_HORIZON_FALLBACK_URL` is validated and resolved (`DEFAULT_FALLBACK_HORIZON_URL`, `configuration.ts:290`) and the file says so — "Nothing queries it yet: it is a slot, so pointing the fallback at a real second host stays a…" deliberate future. No code ever reads the fallback URL to retry against it. See finding **F7**. |
| **OTP/SMS pumping (AIT fraud) protection** — friction (CAPTCHA or equivalent) before OTP send, and hard per-phone-number *daily* caps distinct from general rate limiting | **Partially Done** | The cap exists and fails closed: `OTP_REQUESTS_PER_WINDOW = 3` per `OTP_REQUEST_WINDOW_MINUTES = 15` per *number* (not per caller — "the number is what is being pumped"), counted in Redis, and `otp-rate-limiter.service.ts` refuses to send when the counter cannot be read, because "every send costs money and a pumped number is exactly the scenario this limit exists for". **The two other halves are missing**: there is no CAPTCHA or equivalent friction anywhere (`CAPTCHA` appears in this repository only in the hardening doc, about Circle's faucet), and the cap is a 15-minute window rather than a hard daily ceiling — `configuration.ts` has no daily counter. See finding **F8**. |
| **Ghana SMS Sender ID registration** — a prerequisite with the NCA before branded OTP messages can be sent at scale | **Not Done** | No sender-ID work exists anywhere (no `from` parameter, no NCA reference, no operational note). The code states the prerequisite plainly and leaves it out deliberately: `src/notifications/sms/africas-talking-sms.sender.ts` — "What this class does *not* have: a `from`. Africa's Talking falls back to the account's default sender … a live account needs one registered before launch — that is the one piece of configuration a switch to live will want, and it does not belong in a Day-1 diff." See finding **F9** — this one is a launch blocker that lives entirely outside the codebase, so no test can catch it. |
| **Session/device management** — bind refresh tokens to device fingerprints, show users their active sessions, and offer "log out all other devices" | **Partially Done** | Token hygiene is solid: refresh tokens are stored hashed, rotate on use, and a replayed token revokes the whole family (`TokenService.revokeAllForUser`; `src/identity/token/refresh-token.ts`; migration `20260926182000_user_refresh_tokens`), `POST /v1/auth/logout` revokes one session, and `GET /v1/auth/session` reflects the row as it is now. **Device binding, an active-session list and a sign-out-everywhere route do not exist**, and the frontend doc says so in as many words: "neither the change nor the reset retires outstanding refresh tokens … so 'sign out everywhere' is a separate feature with a separate route, and it does not exist yet" (`docs/frontend-auth-flow.md` §6). Same missing capability as finding **F1**. |

## C. Section 11 — "Worth tracking"

| Item | Status | Evidence |
| --- | --- | --- |
| **API versioning policy** — how `/v2/` gets introduced without breaking the frontend | **Done** | Every route is mounted under `/v1` through one definition (`src/common/http/prefix.ts`, applied by `app.setGlobalPrefix` in `main.ts`), so a breaking change can ship as `/v2` while `/v1` keeps answering the clients already in the field. The docs are served *outside* the prefix (`/api/docs`), so the address handed to the frontend does not move when the API version does. `README.md` → *API docs and CORS* records both halves, and `src/common/http/prefix.ts`'s docblock states the intent. |
| **Standardized error-code taxonomy** across all endpoints, not just HTTP status codes | **Partially Done** | One shape for every failure, produced by one global filter and published for the frontend: `src/common/dto/error-response.dto.ts` (`statusCode`, `error`, `message`, `path`, `timestamp`) implementing the filter's own interface, so a field added in one place fails to compile in the other; declared on every route's Swagger. **There is no machine-readable per-condition code.** A client telling "insufficient balance" (409) apart from "recipient not payable" (404) from "PIN lockout" (429) does it by status plus a human sentence, so the taxonomy is a convention rather than a contract. See finding **F10**. |
| **Push notifications** as a supplement to SMS for transaction confirmations | **Not Done** | `src/notifications/` contains `sms/` and `email/` and nothing else — no push provider, no device-token table or column, no dependency for one. A resolved payment notifies by SMS, plus an email receipt when a *verified* address exists (`PaymentsConfirmationService.notify` → `NotificationsService.sendPaymentResult`). The plan itself places this in the post-MVP bucket ("Push notifications as a supplement to SMS … reduces polling load and SMS cost"), so it is a deliberate deferral rather than an unmet MVP requirement — Section 11 files it under *Worth tracking*, the bucket after *Critical (MVP-blocking)* and *Important*, which is the section this row sits in. |
| **Formal incident response runbook** — escalation path for reconciliation drift and other production incidents | **Not Done** | No runbook exists; what exists is the *signal*, scattered where it was written: reconciliation drift logs a line naming the public key **and** calls `Sentry.captureMessage` with account id, user id, both balances and the drift (`src/ledger/services/reconciliation.service.ts` — the only non-exception Sentry report in the app), boot failures write a named cause to stderr before exiting (`main.ts`), and `render.yaml` records that a free instance has no shell or one-off jobs, "so an incident is diagnosed from the log and the API rather than from a shell on the instance". A signal without an escalation path is half of the item. See finding **F11**. |

## D. Section 6 — API design, endpoint by endpoint

Route surface as it exists: `src/identity/auth.controller.ts` (`auth`), `src/wallet/wallet.controller.ts`
(`wallet`), `src/payments/controllers/payments.controller.ts` (`payments`),
`src/payments/controllers/recipients.controller.ts` (`recipients`), `src/health/health.controller.ts`
(`health`), all under the `/v1` global prefix.

| Planned endpoint | Status | Evidence |
| --- | --- | --- |
| `POST /v1/auth/register` `{ phoneNumber }` | **Done** | `auth.controller.ts:75`; the DTO is `{ phoneNumber, pin?, handle? }` — the optional `handle` is where the plan's separate handle route went, and the PIN became optional at `e97c363` ("make the registration PIN optional"). Answers `201` with the pending account and the OTP delivery facts. |
| `POST /v1/auth/otp/verify` `{ phoneNumber, code }` | **Done** | `auth.controller.ts:128` → `200` with the token pair; this is also the write that flips `status` to `ACTIVE`, sets `phoneVerifiedAt`, and triggers wallet provisioning (`AccountProvisioningService.provisionFor`). |
| `POST /v1/auth/handle` `{ handle }` | **Superseded** | No such route exists, by design: a handle is claimed at registration and registration is the only writer. `src/audit/audit-events.ts` states it directly — "Registration is the only writer: there is no change-handle endpoint" — and the validation rules live in one module (`src/identity/handle/handle.ts`) so a future rename route would reuse them rather than re-implement them. |
| `POST /v1/auth/login` | **Done** | `auth.controller.ts:234` (`{ phoneNumber, code }`). The build also has what the plan did not: `login/otp` (`:179`) to request a code, `login/password` (`:512`), `logout` (`:312`) and `session` (`:334`). |
| `POST /v1/auth/refresh` `{ refreshToken }` | **Done** | `auth.controller.ts:277`; rotation with family revocation on replay (`TokenService`). |
| `GET /v1/wallet/balance` | **Done** | `wallet.controller.ts:95`; read from Horizon on every call rather than cached, so a stale number cannot be mistaken for a current one. |
| `GET /v1/wallet/account` | **Done** | `wallet.controller.ts:53`; returns the public key (this is the address the hardening doc's faucet step reads) and the trustline state. |
| `GET /v1/recipients/search?query=` | **Done, with a naming deviation** | `recipients.controller.ts:55` (`@Get('search')`) — but the parameter is **`q`**, not `query` (`@ApiQuery({ name: 'q' })`), with an optional `limit`. A client written against the plan's `?query=` gets a validation refusal naming `q`. Recorded here because it is a contract difference a frontend would hit on the first call, not a functional gap. |
| `GET /v1/recipients/:id` | **Done** | `recipients.controller.ts:106`; returns handle, display name and a verified indicator and nothing else, with unverified/suspended/unknown all answering an identical 404. |
| `POST /v1/payments` `{ recipientId, amount, idempotencyKey }` | **Done** | `payments.controller.ts:101-104`: `@Post()` + `@HttpCode(HttpStatus.ACCEPTED)` (202), guarded by `JwtAuthGuard` **and** `StepUpAuthGuard`, wrapped in `IdempotencyInterceptor`. The key arrives as an `Idempotency-Key` header (the plan had it in the body). |
| `GET /v1/payments/:id` | **Done** | `payments.controller.ts:249`; declared *after* `@Get()` deliberately, so `/payments` is not swallowed by the `:id` route. |
| `GET /v1/payments` | **Done** | `payments.controller.ts:203`; filtered, membership-based (a caller only ever sees payments it is a party to), `limit` + time-window paging. Landed as Step 30 (`6337a57`). |
| `GET /v1/health` | **Done** | `health.controller.ts:20`; `{ status, uptimeSeconds, timestamp }`, no database or Redis call — deliberately "the API process is up", not "every dependency is healthy". |
| `GET /v1/health/stellar` | **Not Done** | No such route exists in any controller. The nearest substitutes are `GET /v1/wallet/balance` and `/v1/wallet/account` (both live Horizon reads), the KMS boot probe, and the reconciliation sweep's per-account Horizon read. See finding **F12**. |

## E. Section 12 — Finalized decisions

| Decision | Status | Evidence |
| --- | --- | --- |
| **Custody model: fully custodial** | **Done** | Not a claim in a document — the mechanism is the product: the app generates the wallet, seals the seed, and signs on the user's behalf (`src/wallet/provisioning/`, `src/wallet/custody/`, `SeedCustodyService.openSeed` → signature). No user ever holds key material, and nothing in the API can return it. |
| **Regulatory posture: confirmed, compliance is aware** | **Done (a decision with no artefact in this repository)** | Stated here because a reader looking for code will not find it, and its absence is not a gap: this is a business and legal fact rather than a behaviour of the system. Nothing in the repository asserts, records or checks it. |
| **Team/timeline: one developer; 4–7 days as the floor, up to 2 weeks realistic** | **Done as a decision, with a timeline observation** | One developer built it, in the shape the plan described. The elapsed time exceeded the plan's own outer bound by a wide margin: the commit history runs from the Nest scaffold (`d5851c4`) through steps 1–34 and several deployment fixes to this audit, and staging has still not been smoke-tested (`docs/pre-production-hardening.md` §3 is the run that would settle it, and §3.0(b) says nothing is deployed yet). Worth naming as a planning fact rather than a defect. |
| **SMS provider: Africa's Talking** | **Done** | `src/notifications/sms/africas-talking-sms.sender.ts` — form-encoded `POST {baseUrl}/version1/messaging`, the key in an `apiKey` header rather than in a URL or a username/password pair, sandbox vs live host resolved from configuration (a sandbox key is refused by the live host), and the per-recipient `status` checked so a 2xx that will never deliver is not reported as "we sent you a code". |
| **Backend stack: NestJS + TypeScript, using the official SDF-maintained `@stellar/stellar-sdk`** | **Done** | `package.json`: `@nestjs/*` 12.x plus `@stellar/stellar-sdk` `^17.1.0`, and no third-party Stellar wrapper anywhere. The SDK is wrapped in its own service (`src/wallet/stellar/`), consistent with the modular-monolith shape the plan described. |
| **Containerization: Docker from Day 1** | **Done** | `Dockerfile` and `docker-compose.yml` exist from the early steps (api + Postgres + Redis, with healthchecks and pinned image tags). One correction to the plan's intent in practice: the staging deployment does **not** run the image — `render.yaml` runs the app natively on Node (`runtime: node`, `NODE_VERSION=24`) because that is what the free plan's start-command route needs. Docker remains the local and portable path, not the deploy path. |
| **Error tracking: Sentry, alongside structured logging** | **Partially Done** | Sentry is wired in and does real work: `@sentry/nestjs` (`6be9d80`), environment-aware sampling in `main.ts`, 5xx reported by the global exception filter with no stack in the response body, and reconciliation drift as the one deliberate non-exception report. **Structured JSON logging and request IDs do not exist**: `nestjs-pino` is not a dependency, no logger is configured for JSON output, and a grep for `requestId`/`correlationId` across `src/` finds nothing, so the second half of this decision was not implemented. See finding **F13**. |
| **Infra: AWS ECS/Fargate as the primary target, Render kept as the $0 fallback** | **Superseded** | Deliberately superseded, and worth being precise about: Render stopped being the fallback and became the target (`render.yaml`, `96c1534` and the four fixes after it — `5e97599` free plans, `51be801` native Node runtime, `bd3dfbe` `NODE_VERSION`, `cf0f700` migration in the start command). ECS/Fargate was never built: no task definition, no ECR push, no IaC beyond the Render Blueprint. Nothing is lost from the plan's decision set — Render was the plan's own second option — but the primary target changed, and the AWS account is now doing one job (KMS) rather than hosting the app. The plan's Section 3 *Infra* row (**AWS ECS/Fargate (primary)**, with Render as a `$0` fallback) is **Superseded** for the same reason. |
| **Section 3 — Key management: AWS KMS / HashiCorp Vault** | **Done** | KMS was chosen and is the only one used: envelope encryption per account, the master key never exported, `@aws-sdk/client-kms` the only AWS SDK in the tree, and Vault appears nowhere. The policy this credential is granted is specified in `README.md` and explained in `docs/kms-credentials-explained.md`. |

## F. Section 7 — the async flow, as actually implemented

| Planned stage | Status | Evidence |
| --- | --- | --- |
| `POST /payments` validates, locks the balance, writes `PENDING`, enqueues a job, answers `202` with the id | **Done** | `payments.controller.ts:101-104` (`@HttpCode(HttpStatus.ACCEPTED)`, `IdempotencyInterceptor`); `PaymentsService.create` takes a row lock on the sender's wallet with a raw `SELECT … FOR UPDATE` (Prisma exposes no row lock), sums in-flight amounts from the ledger under that lock, writes the `PENDING` row **and** adds the submission job inside the same transaction, then answers `202`. Proven by a forced race, mutation-tested: `README.md` → *Two payments at once cannot overdraw the wallet*. |
| A worker builds, signs and submits via the SDK, moving the row to `PROCESSING` | **Done** | `src/payments/jobs/payments.processor.ts` (`@Processor(PAYMENTS_QUEUE)`, job name `submit-payment`), delegating to `PaymentsSubmissionService`: the row is claimed with `claimForSubmission`, the envelope recorded with `recordEnvelope`, and the five-way triage (`accepted`/`retry`/`rebuild`/`superseded`/`failed`) decides what a failure becomes. Landed as Steps 26–27 (`50e242d`, `696003f`). |
| A separate polling job watches Horizon and resolves `SUCCESSFUL`/`FAILED` | **Done** | A second, *repeatable* job on the same queue (`confirm-payments`), registered with BullMQ's job scheduler (`upsertJobScheduler`, one idempotent entry per deployment — `PaymentsQueueService.ensureConfirmationScheduler`), interval from `CONFIRMATION_INTERVAL_MS`, which defaults to `0`, i.e. **off unless configured**. The sweep is `PaymentsConfirmationService`; every status change goes through the state machine (`src/payments/services/transaction-status.ts` is the only writer, enforced by a lint rule that fails the build — re-measured for this audit: **219 files scanned, 3 status writes in the sanctioned writer, 0 violations**). |
| …then updates the ledger and triggers a notification | **Done** | `PaymentsConfirmationService.notify(row, 'SUCCESSFUL' \| 'FAILED')` → `NotificationsService.sendPaymentResult`: SMS always, plus an email receipt only when `emailVerifiedAt` is set (an address that was never proved is passed as `null`). The audit rows (`payment.completed` / `payment.failed`) are written after the status write, so a notify that threw cannot leave a settled payment with nothing in the trail. |
| The client polls `GET /payments/:id`, or receives a push/WebSocket update | **Partially Done — the polling half, deliberately** | Polling is complete (`payments.controller.ts:249`, plus the history endpoint). Push and WebSocket do not exist (`@nestjs/websockets` is not a dependency and no gateway exists in `src/`), and the plan itself defers them: "Explicitly deferred to post-MVP: WebSocket live updates (nice-to-have, not required)". |
| *(not in the plan)* a scheduled reconciliation job | **Done — added beyond the plan** | A second queue (`ledger`, job `reconcile-balances`, `LedgerQueueService.ensureReconciliationScheduler`, default interval `0` = off) runs `ReconciliationService.sweep()`: each account's internal USDC total compared exactly against Horizon, oldest-first, `RECONCILIATION_SWEEP_BATCH = 50` per tick, drift reported by log line **and** `Sentry.captureMessage`. Landed as Step 31 in `1417d06`. This is Section 5.3's reconciliation requirement, and the backstop for the one class of disagreement nothing else can see. |

## G. Section 9 — testing strategy, and which forms were actually used

| Planned form | Status | Evidence |
| --- | --- | --- |
| Unit tests for state machines and balance math, "integer minor units, never floats" | **Done, with two documented deviations** | **993 unit tests in 61 files**, measured with `npm test` for this audit (49.66s). The deviations are deliberate and on the record: the runner is **Vitest**, not Jest (`package.json`: `"test": "vitest run"`), and amounts are **`Decimal(20, 7)` strings through `decimal.js`, not integer minor units** — `README.md` → *Money precision and the money rule (Step 23)* argues the choice, and the discipline linter is what makes it hold rather than good intentions. |
| Integration tests against a local Stellar network (`docker stellar/quickstart`) | **Superseded — integration runs against real Testnet instead** | No `stellar/quickstart` container exists in `docker-compose.yml`; the string survives only as the default value of the fallback Horizon URL slot. What exists instead is stronger: opt-in integration specs against **real Testnet** behind `RUN_STELLAR_IT=1` (`test/wallet.e2e-spec.ts`, `test/provisioning.e2e-spec.ts`, `test/submission.e2e-spec.ts` — `README.md` records a real `changeTrust` and a real submission accepted on Testnet, with the account id), and against **LocalStack KMS** behind `RUN_KMS_IT=1` (`test/custody.e2e-spec.ts`). The trade is explicit: real network behaviour, at the cost of needing a socket, credentials and a faucet, which is why they are skipped by default. |
| E2E tests with `@nestjs/testing` + supertest for API contract coverage | **Done** | **16** `*.e2e-spec.ts` files in `test/`, booting the real `AppModule` through supertest under `vitest.config.e2e.ts` (15s test timeout, 90s hooks — each file validates config, connects Prisma and Redis). They run against the compose Postgres and Redis, and **not in CI**: `README.md` states plainly that CI runs lint, the unit tests and the build, and no e2e suite at all. So the contract coverage exists and is exercised by hand, and nothing re-runs it on a pull request. |
| Load/concurrency tests targeting balance locking and double-spend | **Partially Done — the concurrency proof is stronger than the plan asked for; the load test does not exist** | Concurrency is proven by deliberate, deterministic races rather than by generated load: `src/wallet/stellar/account-lock.spec.ts` (sequence conflicts forced at the port), and the overdraft race in `README.md` — "five proofs", *mutation tested*, with the `202`/`409` split and `SUM = 9` read from the database rather than asserted from a mock. **No load-generating harness exists** (no k6, artillery or wrk anywhere in the repository), so "holds under real concurrent load" is unmeasured while "cannot double-spend" is measured. |

## Findings — what the rows above point at, and which of it is still open

Every *See finding* above lands here, and the numbers agree with the rows: they run in document
order, A → B → C → D → E, which is the shape a list written as the rows were written would have.
**This section is a reconstruction, and it says so on purpose.** There is no version of it to
restore. `78a697d` added this document and `a5be3b1` annotated it; a pickaxe for `F13` across every
ref matches only `78a697d`, so the string has never left this file and was never deleted from it.
The object store agrees: no reachable *or* unreachable blob, no branch, tag, stash or reflog entry,
no editor local history, and nothing else on disk under this project holds a `Findings` heading or a
second draft of this document. The pointers above were written without the list they point at, and
this is that list built back from them.

Each entry says what it was built from, because that is the first thing a reader would want to
check:

- **stated** — the row's evidence column states the gap in full. The entry restates it and names the
  consequence, which is the part that goes past the row.
- **named** — the row names the gap in a clause, and cites the artefacts around it. The substance is
  still the row's; the wording is this section's.
- **inferred** — the row's pointer is the only evidence. Read it as a question to confirm, not a
  measurement.

*Open* below means the finding is still true of the tree as it stands. A finding whose row says
*Partially Done* is usually only partly open, and its entry names the half that is missing.

**F1 — the device half of SIM-swap protection, and every device-aware feature with it.** *[stated ·
rows A and B]* The friction the plan asked for exists: `src/identity/pin/` (scrypt,
`PIN_MAX_ATTEMPTS = 5`, `PIN_LOCKOUT_MINUTES = 15`), `src/common/guards/step-up-auth.guard.ts`
refusing `POST /v1/payments` without a fresh `X-Step-Up-Token` from `POST /v1/auth/pin/verify`,
every refusal written as `auth.pin.failed` with outcome `denied`, pinned by `test/pin.e2e-spec.ts`.
What does not exist is the *input* that friction would need in order to fire on the plan's own
condition: nothing in `src/` records a device, a user agent, or a sign-in context, so "an auth event
from a new device" is not a thing this system can notice, and a replayed refresh token is
indistinguishable from a legitimate one on a new phone. Row B's three features are missing for the
same reason — no fingerprint to bind to, no active-session list to show, no sign-out-everywhere
route — and `docs/frontend-auth-flow.md` §6 says so in as many words: "'sign out everywhere' is a
separate feature with a separate route, and it does not exist yet". **Still open**, still on the
plan's Critical list, and the only finding two rows point at.

**F2 — key backup / disaster recovery.** *[stated · row A]* No procedure exists in any form: no
runbook document, nothing in `README.md` → *Known gaps*, no `kms:ReEncrypt*` permission and no
re-wrap code anywhere — so the day the KMS master key is lost or unavailable there is no written
answer to who may invoke recovery or where the material lives. What exists is a *named limitation*,
in `README.md`'s custody section ("the master key cannot be rotated by this application yet …
recovering today means a re-wrap step that has not been written") and in
`docs/pre-production-hardening.md` §3.0(b), which makes this a known-and-named gap rather than a
surprise — and still not the deliverable the plan asked for. **Still open**, Not Done, on the plan's
Critical list.

**F3 — transaction irreversibility: the user-facing and support halves.** *[stated · row A]* Three
things were asked for: irreversibility language a user sees, a support or dispute path, and an audit
trail structured for dispute investigation. The third is built and is the strongest artefact in this
audit — an append-only `audit_log` (migration `20261001120000_add_audit_log`, with a trigger that
refuses `UPDATE`/`DELETE` even from the table owner),
`payment.initiated`/`payment.completed`/`payment.failed` rows, and a failure vocabulary that
separates *landed and unsuccessful* from *never landed* (`landed-unsuccessful:` versus
`submission-rejected:`, `src/payments/services/submission-triage.ts`). The other two do not exist:
no DTO, doc or message template carries irreversibility language, and there is no support or dispute
route — a grep for `refund\|dispute\|irreversib` across the repository returns only prose about
signatures being irreversible. **Partly open**: the record a dispute would be conducted from exists;
the sentence that tells a user there is no way back, and the door they knock on afterwards, do not.

**F4 — AML/velocity controls, including the screening hook.** *[stated · row A]* No amount ceiling
of any kind exists: `src/config/configuration.ts` holds the cost-and-abuse caps
(`OTP_REQUESTS_PER_WINDOW`, `RECIPIENT_LOOKUP_REQUESTS_PER_WINDOW`, `IDEMPOTENCY_TTL_SECONDS`) and
nothing per-transaction, per-day or per-week, and a grep for `sanction\|watchlist\|AML` across
`src/` finds nothing — so the hook point the plan asked for, for sanctions or watchlist screening,
has nowhere to attach either. `README.md` → *Known gaps* records the position deliberately ("there
is no *product* limit — no per-transaction maximum, no daily ceiling, no velocity rule … A real
limit belongs with the product owner, applied as its own check in `PaymentsService`"), which is an
honest record of an open product decision. It is the plan's own Critical list that makes it a
finding: the decision itself is the gap. **Still open**, Not Done.

**F5 — the jurisdiction-specific Ghana DPA artefact.** *[stated · row B]* The controls a checklist
would audit mostly exist, and they are generic rather than Ghanaian: phone numbers masked before any
log line (`maskPhoneNumber`, `src/common/phone/phone-number.ts`), a recipient search that never
returns a phone number (`RecipientSearchResponseDto`), `AuditEntry.metadata` forbidden from carrying
a secret or an identifier, seeds confined to the custody envelope. What the plan asked for is the
artefact itself, and it does not exist: a grep for `Data Protection`, `Ghana` and `privacy` across
`src/` and `docs/` finds no checklist, no retention policy and no data-subject-process note —
nothing a regulator, a partner's due diligence or an engineer joining later could read. **Partly
open**: the practice passes, the paperwork is missing.

**F6 — the profanity half of handle filtering.** *[named · row B — and the reading that follows is
inferred, which makes this the entry to check first]* The row's clause is the whole of the evidence
— "**Reserved-word filtering is built; there is no profanity list** — see the note in finding
**F6**" — and the note it points at does not exist, so this is a reading rather than a restatement.
Reserved words are built carefully (`src/identity/handle/handle.ts`: 3–20 characters,
`/^[a-z0-9_]+$/` after normalization, an explicit `RESERVED_HANDLES` set covering `admin`,
`administrator`, `root`, `moderator`, `support`, `help`, `cashping` and underscore variants,
case-insensitive uniqueness with a `CHECK` backstop, proven over HTTP at `2993aa1` and in
`test/auth.e2e-spec.ts`). The plan asked for a "profanity/reserved-word filter"; nothing in `src/`
or `prisma/schema.prisma` matches `profan\|slur`, so the second list was never written, and no
decision to leave it out is recorded either. **What is certain** is the absence — that much is the
row's. **What is inferred** is the judgement that would go with it: whether the missing note argued
the omission acceptable (reserved names are the impersonation risk, and a profanity list is a
content-policy question rather than a security one) or left it open. Read the status as *open,
unjudged* until that call is confirmed.

**F7 — the fallback Horizon URL: a slot, not a second host.** *[stated · row B]* The classification
half is built and is well argued: `src/payments/services/submission-triage.ts` returns five answers
(`accepted`, `retry`, `rebuild`, `superseded`, `failed`) so that "no verdict" travels out as
retryable while a definitive no becomes `FAILED`; `horizon-transaction-lookup.ts` treats a 404 as a
plain not-found and a 5xx as unavailable; `transaction-submitter.ts` separates "Horizon said no"
from "Horizon never answered" at the port. What is missing is the destination:
`STELLAR_HORIZON_FALLBACK_URL` is validated and resolved (`DEFAULT_FALLBACK_HORIZON_URL`,
`configuration.ts:290`) and the file says what it is — "Nothing queries it yet: it is a slot, so
pointing the fallback at a real second host stays a deliberate future" — and no code reads it in
order to retry against it. The consequence is exact: an outage this system is now correct about
calling *retryable* still has one place to retry, and that place is the one that is down. **Partly
open** — the state exists, the second host does not.

**F8 — OTP/SMS pumping: the friction and the daily ceiling.** *[stated · row B — and the finding the
note below leans on]* The cap half is built and fails closed: `OTP_REQUESTS_PER_WINDOW = 3` per
`OTP_REQUEST_WINDOW_MINUTES = 15`, counted per *number* rather than per caller ("the number is what
is being pumped"), in Redis, with `otp-rate-limiter.service.ts` refusing to send when the counter
cannot be read. The two other halves the plan named are missing, exactly as the row says: no CAPTCHA
or equivalent friction before a send (`CAPTCHA` appears in this repository only in
`docs/pre-production-hardening.md`, about Circle's faucet), and no hard *daily* ceiling — the window
simply resets, and `configuration.ts` has no daily counter. Consequence: a script can drive sends to
the cap on a number and keep doing it every fifteen minutes, indefinitely, with every one of those
messages paid for on a live account. **Partly open**, and this is the finding the note below does
*not* close: `377ea5c` put `POST /v1/auth/email` under this same limiter and the same window, which
closes the *reach* of this class of cost — a paid message to a third party, one identifier over —
while the friction and the daily ceiling stand as written.

**F9 — Ghana SMS Sender ID registration.** *[stated · row B]* No sender-ID work exists anywhere: no
`from` parameter, no NCA reference, no operational note. The code states the prerequisite and leaves
it out deliberately — `src/notifications/sms/africas-talking-sms.sender.ts` records that Africa's
Talking falls back to the account's default sender, and that "a live account needs one registered
before launch — that is the one piece of configuration a switch to live will want, and it does not
belong in a Day-1 diff". **Still open**, and unlike every other entry here its fix is not in this
repository: it is a launch blocker that lives entirely outside the codebase, so no test, lint gate
or audit number can catch it, and it belongs on a launch checklist rather than in a backlog of code.

**F10 — a machine-readable error code.** *[stated · row C]* One shape for every failure is built and
published: `src/common/dto/error-response.dto.ts` (`statusCode`, `error`, `message`, `path`,
`timestamp`) implementing the global filter's own interface, so a field added in one place fails to
compile in the other, and declared on every route's Swagger. What does not exist is a per-condition
code: a client telling "insufficient balance" (409) apart from "recipient not payable" (404) from
"PIN lockout" (429) does it by status plus a human sentence, which is what makes the taxonomy a
convention rather than a contract. Consequence: client branching on a specific failure matches on
wording, so a reworded message is a silent behaviour change in the frontend rather than a
compile-time one in the backend. **Partly open** — the envelope is done, the vocabulary inside it is
not machine-readable.

**F11 — the escalation path behind the signals.** *[stated · row C]* No runbook exists. The signals
do, scattered where they were written: reconciliation drift logs a line naming the public key
**and** calls `Sentry.captureMessage` with the account id, the user id, both balances and the drift
(`src/ledger/services/reconciliation.service.ts` — the app's only non-exception Sentry report); boot
failures write a named cause to stderr before exiting (`main.ts`); and `render.yaml` records that a
free instance has no shell and no one-off jobs, "so an incident is diagnosed from the log and the
API rather than from a shell on the instance". Who is paged, in what order, who may touch balances
to correct a drift, and what a finished incident looks like are all undefined — "A signal without an
escalation path is half of the item". **Still open**, Not Done.

**F12 — `GET /v1/health/stellar`.** *[stated · row D]* No such route exists in any controller, so
the endpoint the plan specified for the chain's own liveness is absent. The nearest substitutes are
read-only and indirect: `GET /v1/wallet/balance` and `GET /v1/wallet/account` (both live Horizon
reads), the KMS boot probe, and the reconciliation sweep's per-account Horizon read. Consequence:
`GET /v1/health` answers `{ status, uptimeSeconds, timestamp }` with no database call and no chain
call, so it tells an operator the process is up and nothing about whether the accounts this app
serves can reach Horizon — and the substitutes prove that one account at a time, and only when
something asks. **Still open**, Not Done.

**F13 — structured JSON logging and request IDs.** *[stated · row E]* Sentry is wired in and does
real work: `@sentry/nestjs` (`6be9d80`), environment-aware sampling in `main.ts`, 5xx reported by
the global exception filter with no stack in the response body, and reconciliation drift as the one
deliberate non-exception report. The other half of the same decision does not exist: `nestjs-pino`
is not a dependency, no logger is configured for JSON output, and a grep for
`requestId`/`correlationId` across `src/` finds nothing. Consequence: log lines are unstructured
text, and one request cannot be followed across the log, Sentry and the audit table by a shared
identifier — which is the join an incident (F11) or a dispute (F3) would be worked with. **Partly
open** — tracking exists, correlation does not.

**Not one of the thirteen is closed by the change below.** What `377ea5c` closed was a gap this
audit never got as far as listing — a send that consulted no counter — and the convention set out in
*The numbers in this document* is why that is recorded there with its commit rather than written
into these entries.

## After this audit — the send that counted nothing, closed

The rows above are this audit *as it was taken*, and none of them is rewritten here: their numbers are
the ones measured for the tree in `78a697d` (*The numbers in this document*), and a row that said
**Not Done** or **Partially Done** still says it. This section is that convention read the other way.
If a measurement has to carry the step it was taken at, then a change that lands after an audit has to
carry the commit it landed in, or the document quietly turns into a description of a tree it was never
checked against.

**The gap, and why no row above covers it.** `POST /v1/auth/email` was the one *send* in `AuthService`
that consulted no counter. Everything else that service sends is a text to a number, and each of those
spends the number's allowance through `OtpRateLimiterService` at the endpoint that sends it —
`register`, `requestLoginCode`, `requestPasswordReset` — while the endpoint that mails a verification
code (`setEmail` → `EmailService.set` → `NotificationsService.sendEmailVerification`) spent nothing at
all. That is the same class of cost as section B's OTP/SMS pumping row (finding **F8**): a message to a
third party that is paid for on every call, one identifier over — the mailbox rather than the handset —
and reachable by any authenticated caller. No row above names it because the plan lists no email
endpoint at all; the route is one of Step 34c's additions beyond the plan, so the gap surfaced from
reading the code, which is this document's first method, rather than from a plan row.

**What closed it** — `377ea5c`, *fix(auth): count the address's send allowance on POST /v1/auth/email
(Step 34c)*. `AuthService.setEmail` now spends the address's allowance through the same limiter, the
same counter and the same window as the SMS sends (`OTP_REQUESTS_PER_WINDOW` = 3 per
`OTP_REQUEST_WINDOW_MINUTES` = 15, counted in Redis), refusing the fourth attempt with **429** and the
minutes to wait, and answering **503** when the limit cannot be evaluated — the fail-closed answer the
other paths already give, since a cap whose purpose is to price messages must send none rather than
guess and send. The subject is the address rather than the account, because a mailbox is what a caller
can pump; the count sits after every refusal and before the delivery, so a 409 or a 400 mails nothing
and spends nothing.

**Two consequences, neither of them a defect.** An address's 15-minute window is now shared between
sends and password guesses, exactly as a number's already was: one identifier, one allowance, spent by
whatever is spent on it. And an address the limit refuses stays attached but unproved, which is not a
delivery target — the receipts path mails only a *verified* address (`verifiedEmail` in
`src/payments/services/payments-confirmation.service.ts`).

**How it is proven**, as measured at `377ea5c`: `src/identity/auth.service.spec.ts` gained an
`AuthService.setEmail (Step 34c)` block (the normalized subject and its mail mask, the 429 with its
wait, the 503, a conflict that costs no allowance, and a malformed address that short-circuits);
`test/email.e2e-spec.ts` makes four real calls against the compose stack and reads the fourth as a 429
naming the wait, with the row left attached and unproved; `test/password.e2e-spec.ts`'s arithmetic
moved with it, because the attach now spends one of the address's three. The unit suite is **61 files
/ 998 tests** (993 at `78a697d`), `npm run lint` is 0 warnings and 0 errors on 219 files, `npm run
build` is green, and the four e2e suites that exercise this endpoint are **41** tests.

**What this does not close.** Finding **F8** stands as written: there is still no CAPTCHA or equivalent
friction, and the cap is still a 15-minute window rather than a hard daily ceiling. The change above
closes the distance between *this endpoint* and the cap every other send already consults.

**One number in the rows was wrong rather than overtaken.** Section A's key-recovery row said the
`docs/` tree was three files; it held five when this audit was taken and it holds five now —
`build-sequence.md`, `frontend-auth-flow.md`, `kms-credentials-explained.md`,
`pre-production-hardening.md` and this document — so the row has been corrected in place, from three
to five. *Documentation conventions* is the reason that is not an edit to leave alone: a count that
is *re-measured* later is appended with its own label rather than corrected, because the older
number is evidence about a smaller tree — and five files is not a smaller tree or a bigger one, it
is the same tree mis-counted, which that rule does not cover. The correction is named here rather
than made quietly because *the rows above are not rewritten* is otherwise a promise this document
makes, and the rest of it argues against edits nobody can see. The rest of that row is untouched.
**A second pointer pointed at nothing, and was re-aimed rather than followed.** The
push-notifications row ended by sending the reader to a *Deliberately deferred* section, and no such
section was ever written — the search that cleared the *Findings* list clears this one too: the
phrase appears in this document only in the sentence that pointed at it. Writing that section was
the other way to go, and the weaker one, because the plan already keeps the bucket and this document
already reproduces it: section C is the plan's *Worth tracking* list, and section F quotes the
plan's own *explicitly deferred to post-MVP* line about WebSocket updates. A deferral list kept in
two documents is two lists that can drift apart, so the row now names the bucket the plan files the
item under — which is what "the plan itself places this in the post-MVP bucket" was asserting all
along, and is the only evidence the deferral has.

### The open findings, on one line each

Thirteen, and not one of them is a plan row's status restated: **seven are still open in full** —
F1, F2, F4, F6, F9, F11, F12 — and **six are half-built**, F3, F5, F7, F8, F10 and F13. The email
send cap that `377ea5c` closed is not among them; it was never a plan row, which is why it is
recorded in *After this audit* with its commit instead of here.

- **F1 · SIM-swap, the device half** — the PIN and the step-up gate are built and proven; nothing in `src/` records a device, so "an auth event from a new device" cannot fire, and row B's active-session list and sign-out-everywhere route go with it. *Still open.*
- **F2 · KMS key recovery / break-glass** — nothing exists in any form: no runbook, no re-wrap, no recovery permission. It is on the plan's own Critical list, and the limitation is *named* in `README.md` and `docs/pre-production-hardening.md` §3.0(b) — named and unbuilt is still unbuilt. *Still open.*
- **F3 · Irreversibility, two thirds of three** — the append-only trail a dispute would be conducted from exists; the sentence telling a user there is no way back, and the support door they knock on after, do not. *Partly open.*
- **F4 · AML/velocity, and the screening hook with it** — no amount ceiling of any kind, so there is nowhere for a sanctions or watchlist check to attach. `README.md` → *Known gaps* records it as an open product decision, honestly and deliberately, which makes the decision itself the gap. *Still open.*
- **F5 · Ghana DPA artefact** — the practice passes (numbers masked before any log line, a recipient search that returns none, no identifier in audit metadata); the checklist, the retention policy and the data-subject note a regulator or a new engineer would read do not exist. *Partly open.*
- **F6 · The handle profanity list** — reserved words are built, pinned as a vocabulary and proven over HTTP; nothing in `src/` or the schema matches `profan\|slur`, and no decision to leave it out is recorded anywhere. *Still open.*
- **F7 · The Horizon fallback host** — the retryable-versus-failed classification it would serve is built and tested; the second host is a validated configuration slot that nothing queries. *Partly open.*
- **F8 · OTP pumping, friction and the daily ceiling** — the cap fails closed at 3 per 15 minutes per number; there is no CAPTCHA and no daily ceiling, so a script can spend a number's allowance every window, indefinitely, on a live account. *Partly open.*
- **F9 · Ghana SMS Sender ID registration** — no `from`, no NCA reference, no note. This is the one finding whose fix is not in this repository, so no test, lint gate or number in this audit can catch it: it belongs on a launch checklist. *Still open.*
- **F10 · A machine-readable error code** — one envelope for every failure, declared on every route; no per-condition code inside it, so a client telling 409 from 404 from 429 branches on wording, and a reworded message is a silent frontend change. *Partly open.*
- **F11 · The escalation path behind the signals** — the signals exist (the drift log line *and* its Sentry message, named boot causes on stderr, log-only diagnosis on a shell-less Render instance); who is paged, who may touch a balance to correct a drift, and what a finished incident looks like are undefined. *Still open.*
- **F12 · `GET /v1/health/stellar`** — no such route, so health answers without touching the database or the chain, and the substitutes prove one account's reachability at a time and only when something asks. *Still open.*
- **F13 · Log correlation** — Sentry is wired in and does real work; JSON logging and a request id are not, so nothing joins the log, Sentry and the audit table for a single request — the join an incident (F11) or a dispute (F3) would be worked with. *Partly open.*

## Where this lands, in one paragraph

The build is solid where the plan was most specific, and the solidity is mechanical rather than
claimed: amounts are `Decimal(20, 7)` strings through `decimal.js`, every payment status change goes
through one state machine, and both are lint gates that fail the build, so a tree grown to 219 files
reports 0 violations in each and carries 993 unit tests (998 after `377ea5c`) that CI runs on every
push — while the Section 6 surface is complete except `GET /v1/health/stellar` (F12), and differs
from the plan in the three places a frontend would meet on its first call: the handle is a field on
register rather than a route of its own, the recipient search takes `?q=` rather than `?query=`, and
the idempotency key arrives as a header rather than in the body. What is *not* built is mostly
out-of-scope by decision rather than missed: ECS/Fargate became Render (and Render was the plan's own
fallback), the local `stellar/quickstart` network became real Testnet, the polling-only confirmation
path is what the plan itself files under post-MVP, and the two capabilities this repository records
as deliberately absent — registering with an email, and Google SSO (Step 34d) — sit outside the
sections audited here rather than inside them as gaps. The real surprise is the thirteen findings,
and the sharpest of them are not the ones the plan's own lists would have predicted: the KMS master
key has no recovery procedure of any kind (F2), there is no amount ceiling for an AML rule or a
screening hook to attach to (F4), a user is never told that a payment cannot be reversed and has
nowhere to take a dispute (F3), the SIM-swap friction is built with no device to fire on (F1), and
the SMS Sender ID is a launch blocker that lives entirely outside this repository, where no test,
lint gate or number in this document can catch it (F9). And the one gap nothing planned for at all
was found by reading the code rather than a row: a paid send on `POST /v1/auth/email` that consulted
no counter — recorded at the end of this file with the commit that closed it, `377ea5c`, because a
change that lands after an audit has to carry the commit it landed in.
