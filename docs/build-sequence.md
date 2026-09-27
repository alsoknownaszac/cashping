Cashping — NestJS Build Sequence
A literal step-by-step walkthrough, in order, from project setup to deployment. This sits underneath the architecture plan — that document explains what and why; this one explains how, in order. Follow it top to bottom. Each step names what to build and what "done" looks like before moving to the next one.

Two items identified as MVP-blocking in the architecture plan's gap analysis (decimal precision handling, phone number normalization) are folded into the relevant steps below rather than left as a separate afterthought — they're cheap to do right the first time and expensive to retrofit.

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

- [ ] **Step 15:** handle uniqueness is case-insensitive (`@Miriam` and `@miriam` conflict); reserved words are actually rejected, not just documented; length/character bounds enforced and tested.
- [ ] **Step 16:** access tokens genuinely expire at 15 minutes (not just configured to — verify with a token issued in the past or a clock-shifted test); refresh tokens are stored hashed, not plaintext, in the database; a revoked refresh token is actually rejected on reuse.

- [ ] **Step 17:** two rapid, concurrent transaction-build requests for the *same* source account do not produce a sequence-number conflict — force this race deliberately, don't just trust the mutex/queue exists.

- [ ] **Step 18 (highest scrutiny of the whole build):** inspect the actual database row for a provisioned account — the secret key must be unreadable without the KMS call; confirm no raw secret key ever appears in application logs (grep logs after a provisioning run); confirm the encrypted blob differs per account (not reusing one data key silently).
- [ ] **Step 19:** a freshly registered and phone-verified user has, without further action, a Testnet account that is both funded (real XLM balance, not zero) and trustline-active for USDC — check both conditions independently, since "funded but no trustline" is a distinct failure mode from "trustline set but never funded."
- [ ] **Step 20:** balance endpoint reflects the real Horizon-reported USDC balance, not a cached/stale/default value — verify by comparing directly against a Horizon query for the same account.

**If anything fails:** Step 18 failing is a stop-everything issue, not a fix-later one — do not proceed to Day 3 with any doubt about key material safety, even against Testnet.

<!-- ============================================================
     STILL MISSING — Days 3 through 5 (Steps 21–34). Day 2 (Steps
     15–20, including the Step 18 standing rule and the "Audit
     Checklist — Day 2" above) was restored from a later paste and is
     verbatim. Days 3–5 are still absent, which is why the orphaned
     line below ("when: every item in Section 5 …") has no opening —
     it is the tail of a "Done when:" sentence from within that
     still-missing region, not a transcription error.
     ============================================================ -->

when: every item in Section 5 of the architecture plan has a concrete answer in the codebase, not just an intention.

<!-- (The "Done when:" opening of the line above was also lost on the far side of the truncation point.) -->

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

