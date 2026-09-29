<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## API docs and CORS

Every route is mounted under a version prefix - `/v1`, set with `app.setGlobalPrefix` in
`main.ts` (`src/common/http/prefix.ts` holds the single definition) - so a breaking change
can later ship as `/v2` while `/v1` keeps answering the clients already in the field. The
docs are served *outside* that prefix, so the address handed to the frontend does not move
when the API version does:

```bash
http://localhost:<PORT>/api/docs       # Swagger UI: every endpoint, with "Try it out"
http://localhost:<PORT>/api/docs-json  # the OpenAPI 3 document itself (client generation)
http://localhost:<PORT>/v1/health      # liveness - I/O-free, so a poller can hit it often
```

`<PORT>` is `PORT` from `.env` (3000 by default). The documented paths carry the prefix
(`/v1/health`), so "Try it out" from `/api/docs` calls the URL a client really has to call.
The document is generated from the controllers registered on the app, so a new controller
appears there without editing the setup; `test/api-docs.e2e-spec.ts` fails if one is
missing.

### Switching the docs off (they are off in production)

`ENABLE_SWAGGER` (default `true`) gates the UI *and* the document: with
`ENABLE_SWAGGER=false` neither `/api/docs` nor `/api/docs-json` is mounted (both 404) while
every API route keeps working. Production sets it to `false` - the API surface is not a
secret from the team, but publishing every endpoint plus a live "Try it out" console on a
public host is an invitation nobody needs. `docker-compose.yml` falls back to `false` for
the same reason (that service runs with `NODE_ENV=production`); set `ENABLE_SWAGGER=true`
in `.env` to keep the docs in the stack. A value that is not `true`/`false` fails startup
with the variable named, rather than quietly leaving the docs in the wrong state.

### How the documented shapes are produced

Every field comes from the decorators on the controller or DTO, which has two
consequences worth knowing before adding an endpoint:

- **`@ApiProperty()` is required on every DTO field.** No Swagger CLI plugin is
  configured in `nest-cli.json`, so an undecorated field is published as an empty
  object - worse than no docs, because the shape looks real and says nothing.
  `src/common/http/swagger.spec.ts` fails the suite if any DTO in the document has no
  fields at all.
- **class-validator constraints are not reflected.** `@nestjs/swagger` v12 maps
  `@IsEmail()`/`@MaxLength()`/`@Min()` onto `format`/`maxLength`/`minimum` only through
  its compile-time plugin, which this project does not enable (it also would not run
  under vitest, so tests and `dist` would disagree about the same DTO). Describe the
  constraint explicitly instead: `@ApiProperty({ description: '…', maxLength: 40 })`.

Failures are documented once, in `ErrorResponseDto`: the global exception filter answers
every endpoint with that shape, so a client renders errors from one definition.

### CORS

`CORS_ALLOWED_ORIGINS` is the comma-separated list of origins allowed to call the API
from a browser. It defaults to the two local dev servers (`http://localhost:3000`,
`http://localhost:5173`) and is validated at boot: a value a browser would never send - a
wildcard, a bare host, a trailing slash or a path - fails startup instead of turning into
an opaque CORS error in the frontend's console. There is no wildcard mode.

An origin that is not on the list is not rejected: the request is answered normally,
without the `Access-Control-Allow-Origin` header, and the browser then refuses to hand
the response to the calling script. CORS is a browser-side control, not authorisation -
it is no substitute for auth on an endpoint. A request with no `Origin` header at all
(curl, the container healthcheck, server-to-server) is not a CORS request and is passed
through untouched.

## Registration and phone verification (Day 1)

The identity flow is two calls. Both take the number in whatever form the user typed it,
normalize it to strict E.164 before it reaches a query or a write, and are documented in
`/api/docs` (`src/identity/auth.controller.ts`, `src/identity/dto/`).

```bash
POST /v1/auth/register      # { phoneNumber }            -> 201 { userId, phoneNumber, status, expiresAt, codeLength }
POST /v1/auth/otp/verify    # { phoneNumber, code }       -> 200 { userId, phoneNumber, status, phoneVerifiedAt }
```

| Situation | Answer |
| --- | --- |
| Number is already `ACTIVE` | `409` - verify with a code, or use another number |
| Number is `SUSPENDED` | `403` |
| Number is `PENDING_VERIFICATION` | `201` - the row is reused, the previous code is invalidated (this is the resend path) |
| No user for the number (verify) | `404` |
| Wrong code | `400`, with the attempts left in the message |
| Expired code | `400` - the code is consumed, so it cannot be retried |
| Attempts used up | `429` - request a new code |
| Over the send allowance | `429` - "try again in N minutes", from the counter's own TTL |
| SMS provider or Redis unavailable | `503` - nothing was sent |

The policy lives in `src/config/configuration.ts` as constants rather than environment
variables, because these are product rules rather than per-environment settings: a
6-digit code (`OTP_CODE_LENGTH`), valid for 10 minutes (`OTP_TTL_MINUTES`), 5 wrong
guesses (`OTP_MAX_ATTEMPTS`), and 3 sends per number per 15 minutes
(`OTP_REQUESTS_PER_WINDOW` / `OTP_REQUEST_WINDOW_MINUTES`). Every one of them is
asserted by a test.

Where the pieces live, and why:

- **`src/common/phone/phone-number.ts`** - normalization (`normalizePhoneNumber`) and
  `maskPhoneNumber`, the only form of a number allowed in a log line. `PHONE_DEFAULT_REGION`
  (default `GH`) is validated against libphonenumber's own metadata at boot, so a region
  the parser knows nothing about fails startup instead of every registration.
- **`src/identity/otp/otp-crypto.ts`** - code generation (CSPRNG), scrypt hashing
  (`scrypt$N$r$p$salt$hash`) and the constant-time comparison. The plaintext code is
  never stored and never logged; it exists only in the SMS.
- **`src/identity/otp/otp.service.ts`** - issuing (`issue`) and checking (`check`) codes.
  At most one live code per user: a resend spends the previous one inside the same
  transaction as the insert. Verification consumes the code in the same transaction that
  activates the user, so a crash cannot leave an active account whose code still works.
- **`src/identity/otp/otp-rate-limiter.service.ts`** - the per-number send cap, in Redis
  under `otp:requests:<sha256(phoneNumber)>` (hashed, so a `KEYS` dump does not print
  customers' numbers). It **fails closed**: if Redis cannot answer, no SMS is sent.
- **`src/notifications/notifications.service.ts`** - the message itself. The provider sits
  behind the `SMS_SENDER` token (`src/notifications/sms/`), which is the one line to change
  to swap Africa's Talking for something else, and the seam tests replace.

`test/auth.e2e-spec.ts` runs the whole flow over HTTP against the real database and Redis
(register, read the code from a captured message, verify, then the wrong-code, lockout,
expiry and rate-limit paths). It needs the compose stack - `docker compose up -d postgres
redis` - and a `.env`, so it is deliberately not part of the CI job, which has no database
service. It registers random numbers and deletes them again in `afterAll`, so repeated runs
are safe for the numbers it reserved - with one gap, recorded in [Known gaps](#known-gaps):
a run killed before that hook leaves rows for numbers no later run draws again.

## Stellar key custody (Step 18)

Every account's secret seed is stored **encrypted**, in a form that cannot be opened without
a KMS call. There is no plaintext seed anywhere in the database, no seed in any log line, and
no code path that stores one "temporarily" - the audit for this step exists precisely to prove
that, by reading the table directly rather than through the API.

**The stored form** (`src/wallet/custody/secret-envelope.ts`):

```text
cp-kms-1.<wrapped data key>.<iv>.<tag>.<ciphertext>      # five dot-separated base64url segments
```

- A per-account **data key** (AES-256) encrypts the seed; the master key in KMS wraps that
  data key. Two layers, because they buy different things: the data key is per account (so no
  two accounts share one, and one compromised row says nothing about the next), and the master
  key never leaves KMS (so a database dump alone is unusable).
- The account id is bound **twice** - as the KMS `EncryptionContext` on the wrapped data key,
  and as the AES-GCM additional authenticated data on the seed. Moving a blob to another
  account's row fails in both places: locally, before any network call, and then at KMS.
- The envelope version is in the AAD too, so a future `cp-kms-2` blob cannot be relabelled
  `cp-kms-1` and fed to this code.

Where the pieces live, and why:

- **`src/wallet/custody/secret-envelope.ts`** - the format, and nothing else. Pure crypto and
  a strict parser; it has never heard of AWS, which is what keeps the format testable offline.
- **`src/wallet/custody/key-wrapper.ts`** - the `KEY_WRAPPER` port `SeedCustodyService` depends
  on, plus the three errors the contract can produce. The failures live next to the port
  because they are what a caller has to handle.
- **`src/wallet/custody/kms-key-wrapper.ts`** - the only file in the repo that imports
  `@aws-sdk/client-kms`. It classifies SDK failures, and probes the configured key once at boot.
- **`src/wallet/custody/seed-custody.service.ts`** - the API: `createSealedAccount()` returns a
  public key and an envelope (the `Keypair` never leaves the method), `openSeed(row)` returns a
  keypair for signing. It logs nothing, deliberately.
- **`stellar_accounts`** (Prisma migration `add_stellar_accounts`) - `encrypted_secret_key`,
  `data_key_arn`, `public_key`. The user relation is `ON DELETE RESTRICT`: deleting a user must
  not destroy sealed key material or orphan a funded account, so the database refuses it.

| Failure | Thrown as | What it means |
| --- | --- | --- |
| KMS unreachable, throttled, credentials rejected, key disabled, policy denies | `KeyCustodyUnavailableError` | The call did not happen; nothing about the stored row is in question. Retry later, or fix the key/policy. Never reported as corruption. |
| Key reference does not resolve (wrong region, deleted key, bad ARN) | `KmsKeyNotFoundError` | Configuration, not an outage. Aborts boot in production. |
| KMS refuses the blob/key/context pairing, or the GCM tag fails | `SecretEnvelopeError` | Tampering, a botched rotation, or a bug. Stop everything; do not retry. |

`AWS_KMS_KEY_ID` accepts what AWS accepts - a key ARN, a bare key id, or `alias/...` - and must
be a key in `AWS_REGION`, because KMS keys are regional and a key from another region is
reported as `NotFoundException` with no hint that the region is the problem. The boot probe
(`DescribeKey` plus a region comparison) is what turns that class of mistake into one clear
startup line. On failure it behaves differently by cause: a key reference that **cannot** work
aborts startup in production, while an **unreachable** KMS is only logged - the Step 3 rule that
a missing dependency must not put the container into a restart loop holds here too, and custody
fails closed regardless.

### Pointing KMS at a local emulator

`AWS_ENDPOINT_URL` redirects every KMS call elsewhere - in practice LocalStack, which serves KMS
on `http://localhost:4566`. It is optional, blank is refused, and `validate` refuses it outright
when `NODE_ENV=production`: custody aimed at a non-AWS endpoint is a different trust boundary,
not a convenience.

An emulator is **not** part of `docker-compose.yml`, and nothing in CI needs one. The opt-in
integration spec is the only thing that uses it:

```bash
docker run -d --name cashping-kms -p 4566:4566 -e SERVICES=kms \
  -e LOCALSTACK_AUTH_TOKEN=... localstack/localstack:latest      # ~2.5 min to become healthy
AWS_ENDPOINT_URL=http://localhost:4566 RUN_KMS_IT=1 npm run test:e2e
```

Two things worth knowing before relying on one: the key has to be created *in* the emulator
(`awslocal kms create-key`), because a shape-valid ARN that does not exist there is a
`NotFoundException`, and the vendor's free tier is licensed for non-commercial use - check their
terms before pointing this product's development at it.

### Tests

`npm test` covers the envelope (round trips, tampering, truncation, account and version
mismatches), the KMS failure classification and the service's behaviour, all offline: the AWS
client sits behind `KEY_WRAPPER` and `KMS_CLIENT_FACTORY`, so the suite needs neither network
nor credentials. The step's own audit - three accounts producing three different blobs, a
database row that reads as ciphertext, and a log grep for the seed pattern that comes back
empty - is reproducible with the two commands in the section above.

## Wallet endpoints (Step 20)

Two endpoints, both authenticated, both about the caller's own wallet:

```bash
GET /v1/wallet/account   # { accountId, publicKey, network, createdAt, funded, nativeBalance }
GET /v1/wallet/balance   # { asset: { code, issuer }, balance, trustline, funded }
```

`/account` is what the wallet *is* - the address it is paid at, the network that address is on,
and whether the ledger knows it yet. `/balance` is what is in it, which for this product means the
USDC line. Both read Horizon on the request: nothing is cached, and no balance is defaulted.

| Situation | Answer |
| --- | --- |
| No wallet provisioned for the user | `404` |
| Row exists, the ledger has never seen the key (funding did not complete) | `200`, `funded: false`, `null` balances |
| Horizon unreachable | `503` - the balance is *unknown*, not zero |
| No or invalid access token | `401` |
| Account suspended | `403` |

`balance` is Horizon's own decimal string, never a number: Stellar amounts are 7-decimal fixed
point and `Number('922337203685.4775807')` is `922337203685.4775`, so parsing one would round
every balance a user is shown. `null` means there is no line to read a balance *from*, and
`trustline` says which of three states the USDC line is in - `active`, `unauthorized` (the line
exists but the issuer has not authorised it, so payments to this wallet are rejected at the
sender) or `missing` (nothing can be paid in at all). `0.0000000` with `active` is an empty
wallet; the other two are states to do something about, and a response carrying only the number
would collapse them into one.

Where the pieces live, and why:

- **`src/wallet/balances/balance-lines.ts`** - the projection from Horizon's lines to the two
  numbers a wallet endpoint reports. Pure, total and offline, because this is the code that
  decides what a balance *is* and Step 20's audit compares its output with Horizon.
- **`src/wallet/balances/balances.service.ts`** - the one read both endpoints are projections of:
  the `stellar_accounts` row (three columns - the sealed envelope is deliberately not selected)
  and then Horizon. It is where the four states in the table above are decided.
- **`src/wallet/stellar/account-source.ts`** - `loadAccount` now returns the *loaded account*,
  balances included, because Horizon answers both in one response (`AccountResponse` is a
  `TransactionSource` **and** a balance sheet). `StellarService.loadBalances` passes the lines
  through untouched and takes no account lock: reading a balance consumes no sequence number, so
  a balance screen does not queue behind an in-flight payment for the same account.
- **`src/wallet/wallet.controller.ts`** - the HTTP surface. There is no `:userId` in either path,
  on purpose: the account reported is always the token's own, so there is nothing to enumerate.
  The guard is identity's `JwtAuthGuard`, read as a *file* import rather than by importing
  `IdentityModule` - identity imports the wallet module (Step 19), so importing it back would be
  a cycle.

`npm test` covers the states offline: `balance-lines.spec.ts` (active, unauthorized, missing, a
`USDC` line from a *different* issuer, other assets, a liquidity-pool share, and the largest
legal balance surviving as a string), `balances.service.spec.ts` (the four states, and that the
row read does not load the envelope) and `stellar.service.spec.ts` (the lines come off the loaded
account, and two reads overlap rather than queue). The live check registers and verifies a number
over HTTP - so provisioning really runs inside the verification - then compares both endpoints
with a plain `fetch` to Horizon for the same account, and moves the ledger to show the number is
a reading rather than a cache:

```bash
AWS_ENDPOINT_URL=http://localhost:5055 AWS_KMS_KEY_ID=<an arn in that endpoint> \
  RUN_STELLAR_IT=1 npm run test:e2e test/wallet.e2e-spec.ts
```

## Known gaps

Recorded rather than fixed, so that they stay decisions instead of surprises. Neither one
blocks a step in `docs/build-sequence.md`.

- **`test/auth.e2e-spec.ts` leaves user rows behind when a run is killed.** Its cleanup is
  two-sided on purpose - `beforeAll` deletes whatever a previous run left for the 40 numbers
  *this* run draws, and `afterAll` deletes exactly the numbers it registered - and both sides
  are keyed on numbers the run knows. A run that is interrupted (Ctrl-C, a crash, a killed
  test process) therefore leaves its rows for numbers no later run is likely to draw again,
  and they accumulate silently, because nothing counts them. Measured in the compose database
  on 2026-09-29: 19 `users` rows, all in the reserved `+2332…` range, in two batches (11 at
  2026-09-27 00:53 and 8 at 2026-09-29 01:22), 9 of them with `phone_verified_at IS NULL`
  and none with a `handle`, and `stellar_accounts` empty - so no leftover is a
  half-provisioned wallet and nothing user-visible depends on them. The fix is a bounded
  cleanup - by the reserved range, or by a run id written onto the row - not a wider
  assertion; the assertions are not what is wrong.
- **Five `src/wallet/custody` files predate the repo's prettier normalisation.** `ce9d165`
  normalised `src` and `test` to prettier (`printWidth 100`) and Step 18's files were written
  after it, so `npm run format` would rewrite `kms-key-wrapper.ts`, `secret-envelope.ts`,
  `seed-custody.service.ts` and their two specs - line-wrapping only. Nothing checks
  formatting in CI (`.github/workflows/ci.yml` runs lint, test and build), so this is a
  convention gap rather than a broken build. It is deliberately left out of Step 19's
  commits, so that "the files Step 19 touched are formatted" stays a statement about Step 19.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
