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

## Money precision and the money rule (Step 23)

An amount is a **string on the wire, an `Amount` in code, and `numeric(20, 7)` at rest**. It is
never a JS `number` anywhere in between: a double carries about 15 significant digits, and the
largest legal USDC amount here is 13 integer digits plus 7 decimals, so the values this system
must not round are exactly the ones a double silently rounds.

That is a rule, not a convention, because the loss is undetectable once it has happened - a
rounded amount looks like a correct amount. `npm run lint` runs two things, and the second one is
the rule:

```bash
npm run lint:money   # node src/common/money/check-money-discipline.ts
```

```
Money discipline: 148 files scanned, 0 violations    (the tool's output, as of Step 27)
```

It exits non-zero, naming `file:line` and the reason, on each of four shapes:

- a money-named column typed `Float`, `Real` or `DoublePrecision` in `prisma/schema.prisma`;
- a money-named member typed `number` or `Decimal` in any `*.dto.ts` (a DTO carries strings);
- a money-named value typed `number` in any other `.ts` file (a repository boundary, a Horizon
  response, a service return);
- an import of `decimal.js` from outside `src/common/money/` - one place knows how decimals work.

`"amount: string"` is fine and is the intended spelling; the rule reads types, so it is what a
reviewer would check, checked every push. `docs/build-sequence.md`'s Step 23 records what each
rule was proven against, including a deliberately-violating tree that makes the whole `lint` job
go red.

`src/common/money/amount.ts` is then the only way a money value can exist - the constructor is
private - and it has exactly two factories, because entry and exit are different problems:

- `Amount.fromString(s)` for untrusted text. Strict about *spelling*: a sign, `1e3`, whitespace, a
  thousands separator, a leading or trailing `.`, and more than 7 decimals are each refused with a
  reason, so a 400 explains itself.
- `Amount.fromDatabase(v)` for whatever the driver handed back, judged by *value* rather than by
  spelling. This is the one lenient path on purpose: Prisma returns a `Decimal` whose `toString()`
  is the shortest exact form - `1` for a stored `1.0000000`, `1e-7` for the smallest unit - so what
  arrives is spelled differently from what was sent, and the e2e asserts both spellings. It throws
  on the 17-decimal shape a float leaves behind.
- One canonical `toString()` for both the database and JSON - `toJSON()` returns it, so a response
  body cannot carry anything else - plus `toStellarAmount()` for Day 4 and `isPositive()` for
  validation. That last one is `greaterThan(0)` and deliberately *not* decimal.js's own `isPositive()`,
  which is true for zero: the first version of this method had exactly that bug, and `amount.spec.ts`
  pins `0`, `0.0000000` and `0.0000001` separately because of it.
- One subtraction and one comparison, added in Step 25 because the overdraft check is the first code
  that needed arithmetic: `minus()` and `isAtLeast()`. `minus()` is computed at
  `MONEY_ARITHMETIC_PRECISION` (40) on a *clone* of decimal.js rather than through `Decimal.set`,
  which is global - 20 significant digits, the library default, is not enough for two 13-integer-digit
  operands, and the spec asserts the 21-digit case that the default rounds. A negative *result* is
  allowed and does not throw (`fromString` and `fromDatabase` still refuse a negative *amount*): an
  over-committed wallet is a real state, and it is the comparison that turns it into a refusal.

```bash
npm test                              # 78 tests: amount.spec.ts (58) + money-discipline.spec.ts (20)
npm run test:e2e test/money.e2e-spec.ts   # 14 tests, against a real Postgres
```

The e2e proves the round trip through the real database rather than through a mock: the column is
asserted `numeric(20, 7)` from `information_schema`, `123456789012.1234567` survives create →
store → display byte-for-byte, and the *same* value written to a `double precision` column in the
same row comes back `123456789012.12346` - a digit gone, quietly. Since Step 25 it also reads
`transactions.amount` out of `information_schema`, so the prescribed type is asserted on the table
that really uses it and not only on a table this file made. It creates and drops its own
`money_round_trip_probe` table and writes no row of any real table. It needs the compose database
(`docker compose up -d postgres redis`), so it is local-only in the same way `auth.e2e-spec.ts` and
`recipients.e2e-spec.ts` are - CI runs lint, the unit tests and the build, and no e2e suite at all.
Unlike the `RUN_KMS_IT` and `RUN_STELLAR_IT` files it asks for no flag: a database is the only
thing it needs, and a flag would only mean the round trip goes unproven by default.

## Making a payment (Steps 24-25)

`POST /v1/payments` **writes** a payment and reserves its amount; it does not send one yet. That is
the honest split, and the `202 Accepted` says it: a `PENDING` `transactions` row exists, the money
is spoken for, and Day 4's jobs (Steps 26-29) turn `PENDING` into a verdict from Stellar. The
response carries the transaction id, which is what the client polls and what a support
conversation can be keyed on.

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"recipientId":"0f8fad5b-d9cb-469f-a165-70867728950e","amount":"25.5"}'
```

The body has exactly two fields, and the amount is a **string**. `25.5` as a JSON number is refused,
because the alternative is accepting whatever the client's formatter produced - which is how a
seventh decimal disappears. A `total`, a `fee` or any other undeclared field is refused by the
global `ValidationPipe` rather than ignored: a request built on "my client added it up" is not
silently reinterpreted, and `test/payments.e2e-spec.ts` asserts that.

### What fits is decided by the server, from two numbers

```
spendable = Horizon's USDC balance for the sender  -  the sender's in-flight payments
```

- The balance is read **from Horizon on every request** through `BalancesService` - the wallet's own
  definition of what a wallet holds, not a second implementation inside payments. `Horizon silent`
  is a 503 and `no trustline` is a 400, both of which are refusals rather than guesses: the one
  answer this endpoint must never give is "we assumed zero".
- In-flight means the sender's `PENDING` and `PROCESSING` transactions - money committed and not yet
  debited on the network, which is exactly the part Horizon cannot see. `SUCCESSFUL` rows are *not*
  subtracted (Horizon already reflects them) and `FAILED` ones never happened.
- Not enough is a **409** whose message carries the spendable figure, because it is the sender's own
  balance and the number a client renders as "you can send up to X". The state may change a minute
  later, which is what makes it a conflict rather than a bad request.

### Two payments at once cannot overdraw the wallet

The check and the insert happen inside one `Prisma.$transaction`, and the first statement in it is
the one deliberate **raw SQL** in this codebase:

```sql
SELECT "id" FROM "stellar_accounts" WHERE "user_id" = $1::uuid FOR UPDATE
```

Prisma exposes no row lock, and no transaction isolation Prisma can ask for stops two transactions
from both reading the same balance and both inserting. A lock does: the second request waits on the
sender's wallet row, and when it is let in, its `SUM` of in-flight amounts sees the first request's
committed row. The lock is per *sender* - the wallet row is the thing whose spending decision has to
be indivisible - so two people paying at once never wait for each other.

Two things about it are deliberate, and worth knowing before changing this code:

- **The Horizon read happens before the transaction opens, not inside it.** A network round trip is
  not something to hold a row lock across: a slow Horizon would block every payment for that sender
  for as long as it was slow. The read is a snapshot taken at the start of the request, which is
  what it would be inside the lock too - Horizon was never part of this transaction.
- **The in-flight `SUM` happens after the lock, inside the transaction.** That is the read the lock
  exists to serialise, and it is a local index scan (`@@index([senderId, status])`).

The proof is a forced race, and it is *mutation tested* the way Step 17's `AccountLock` was: five
concurrent payments of 3 against a wallet of 10 must produce exactly three rows and 9 committed;
delete `FOR UPDATE`, run it again, and five are accepted. Both runs are recorded in
`docs/build-sequence.md`.

### One key is one payment (Step 24)

A client on a flaky connection retries, and a retry of a payment must not be a second payment. So
the endpoint **requires** `Idempotency-Key` (8-255 characters), and the key is scoped to the route
and the caller:

| The request | What happens |
| --- | --- |
| first request with a key | claims the key, writes the transaction, stores its response |
| same key, same body, after it finished | `202` with the *stored* body - the same transaction id - plus `Idempotency-Replayed: true`. No second row. |
| same key, same body, while it is still running | `409` "already in flight". The honest answer is "not yet": inventing one would have the client act on a payment that may not exist. |
| same key, **different** body | `400`. A key names a request, so replaying the first answer would tell the client a payment happened that it did not ask for. |
| no key at all | `400`, refused before anything is written. |
| the request it named was refused | the claim is released, so the client can fix the request and retry with the same key. |

There are two layers, and they do different jobs. Redis (`idempotency:<route>:<userId>:<key>`,
`SET ... NX` as the atomic claim, 24-hour TTL) is what makes the *answer* right - it is the only
place the first response is remembered. The database is what makes the *row count* right:
`@@unique([senderId, idempotencyKey])` on `transactions`. A claim that expired, a Redis flush, a
second instance that never saw the key, or a bug in the interceptor all end at that constraint, and
`PaymentsService` turns the violation into a 409 rather than a 500. The e2e asserts the row count,
because one row is the guarantee and a replayed response is the convenience.

Redis unreachable is a **503**. That is the same fail-closed decision `RecipientLookupRateLimiter`
records, for a stronger reason: an unreadable lookup counter means an uncounted sweep, while an
unreadable key means a payment whose duplicate cannot be detected.

### Where the pieces live

| File | What it is |
| --- | --- |
| `src/payments/controllers/payments.controller.ts` | `POST /v1/payments`: the guard, the interceptor, the documented statuses. No logic. |
| `src/payments/services/payments.service.ts` | The four checks in order, the `$transaction`, the lock, the insert, and each failure's status. |
| `src/common/interceptors/idempotency.interceptor.ts` | Step 24's policy: claim, replay, refuse, release. |
| `src/common/interceptors/idempotency-store.ts` | `RedisIdempotencyStore` - the claim protocol, and the one place the Redis key's shape is decided. |
| `src/payments/dto/create-payment.dto.ts` | Two fields, and the docblock that says why there is no `total`. |
| `prisma/schema.prisma` (`Transaction`) | `amount Decimal @db.Decimal(20, 7)`, `@@unique([senderId, idempotencyKey])`, both relations `Restrict`. |

`PaymentsService` asks `RecipientsService.assertPayableRecipient` who may be paid rather than
repeating the query, so "unknown, unverified and suspended are one 404" holds on both paths; and
that method deliberately spends no lookup allowance (the limit prices *sweeping the directory*, not
the recipient half of one confirmed payment).

### Running the proofs

```bash
npm test                                    # 629 tests (35 files); 50 of them are new here
npm run test:e2e test/payments.e2e-spec.ts  # 15 tests: real Postgres, real Redis, faked Horizon
```

Those 50 are `idempotency.interceptor.spec.ts` (13), `idempotency-store.spec.ts` (11),
`payments.service.spec.ts` (17) and the nine `amount.spec.ts` gained for `minus`, `isAtLeast` and
the column-width refusal.

The e2e substitutes three providers - `SMS_SENDER`, `AccountProvisioningService` and
`StellarService` - and nothing else. `StellarService` is the Horizon seam: a funded Testnet wallet
is not a fixture a test can create, and the whole point of the overdraft check is arithmetic against
a *known* balance, so the network is faked and everything above it (the `stellar_accounts` row, the
trustline decision, `readBalances`, the subtract-and-compare, the lock, the insert) runs for real.
It creates its own accounts, writes their wallet rows, and deletes its transactions before its users
(both relations are `ON DELETE RESTRICT`, so the database insists on that order).


## The payments queue (Step 26)

Step 26 registers the queue and the worker that drains it, and deliberately nothing else: no code in
this application put a *payment* on it, because that is Step 27 - which is also why the queue was
handed over with no `defaultJobOptions` and no submission job. What exists here is the plumbing, live
end to end; the section that follows is what now puts payments on it.

| File | What it is |
| --- | --- |
| `src/payments/jobs/payments-queue.ts` | The names: `payments` (the queue), `probe` and `submit-payment` (the jobs), and the shapes they move - literals here rather than in each of the three files that need them. |
| `src/payments/jobs/payments-queue.module.ts` | The shared connection (`redis.url`, read through `ConfigService`), `forRootAsync` (registered once for the whole app), `registerQueue`, the producer (`PaymentsQueueProducer`) and the providers. |
| `src/payments/jobs/payments-queue-connection.ts` | The producer's *own* connection: the same Redis, with one command bounded - see *The bound on Redis* in the next section. |
| `src/payments/jobs/payments.processor.ts` | The worker: answers a probe, hands a submission to `PaymentsSubmissionService`, and **throws** on any other job name. |
| `src/payments/jobs/payments-queue.service.ts` | The only way onto the queue - `enqueueProbe()` and `enqueueSubmission(transactionId)`, with the submission job's retry policy in `submissionJobOptions`. |

Three decisions, each recorded where it was made:

- **BullMQ gets its own connections, from the same URL.** It cannot share `RedisService.client`:
  BullMQ blocks on connections and needs `maxRetriesPerRequest: null`, while that client sets `2` on
  purpose so a rate-limit or idempotency command *rejects* instead of hanging forever. Same Redis,
  separate sockets, one shared value. Step 27 added a second BullMQ connection for the producer, for a
  different reason, and that is argued in the next section.
- **The queue has no `defaultJobOptions`, and it still does not.** Attempts, backoff and retention
  *are* the retry policy, and the retry policy is what decides whether "the job ran twice" is
  survivable on a money path. Step 27 wrote it where the job is added instead
  (`submissionJobOptions`), so each job carries exactly the options it was argued for.
- **The worker runs inside the API process**, at BullMQ's default concurrency of 1. A second
  deployable buys nothing at one payment at a time, and its two costs are stated rather than
  discovered: a redeploy restarts the consumer (BullMQ's stalled-job check re-queues what was in
  flight), and a job name no handler knows is **thrown** rather than acknowledged, because a job
  marked done without being attempted is a payment reported as submitted.

### What the probe is for

A worker that never started, a queue registered under a name nothing consumes, and a worker pointed
at a *different* Redis are three failures that look exactly like a working queue until something is
added to it. `probe` is the job that tells them apart: it carries no payload and answers
`{ pong: true, workerPid: <pid> }`, written by the handler - so an answer coming back proves Redis is
reachable, the queue's keys are being written, a consumer is running, and the consumer is this
codebase. It sets `removeOnComplete` per job, so it can be fired as often as someone wants to know,
without Redis growing by one job per question asked.

### Running the proofs

```bash
npm test                                  # 692 tests (42 files) as of Step 27
npm run test:e2e test/queue.e2e-spec.ts   # 3 tests: real Redis, real worker, no substitutions
```

The e2e asserts the three things a diff cannot show - the queue is registered under its name in the
real application, the worker is consuming there, and a job added through the application's own
enqueue path is answered and gone again (`getCompletedCount` unchanged, which is `removeOnComplete`
doing its job). It then adds a job named `submit-payment-that-does-not-exist` and asserts that it is
*rejected*, not acknowledged.

The one thing it deliberately does not assert is that the answering pid is the test's own process.
Every e2e file here boots this same application and vitest runs files in parallel, so several
processes may each have a worker on this queue; BullMQ hands each job to exactly one of them, and
which one is not a property this step has. `workerPid` is still returned - comparing two probe
answers is how you learn there is more than one consumer - but the assertion is "a live process
answered", not "this one did".


## Submission (Step 27)

This is the step where the application signs a real key and moves real money, so it was proposed and
approved before it was written: `docs/step-27-proposal.md` is the design, and this section is what
shipped. Scope is submission only - `PENDING` → `PROCESSING`, and `PROCESSING` → `FAILED` for a
definitive no. Resolving to `SUCCESSFUL` is Step 28's polling, and the guard around every write is
Step 29's.

| File | What it is |
| --- | --- |
| `src/payments/services/payments-submission.service.ts` | The whole of the write path: claim, fence, build, record, submit, triage. A pure function of the row, so "the job ran twice" is a question about Postgres and not about Redis. |
| `src/payments/services/submission-triage.ts` | A pure function from one failure (plus two facts about the attempt) to `accepted` / `retry` / `rebuild` / `superseded` / `failed`. Every row is a test; the default is "do not conclude anything". |
| `src/payments/services/transaction-status.ts` | The state machine as data, and `assertTransition` - the guard the two writes here go through. |
| `src/payments/jobs/payments-submission.*` (queue, service, processor) | The enqueue (`enqueueSubmission`), the handler (a payload check and one call), and the job's options. |

### The invariant

> **At most one live Stellar transaction per payment, and a payment whose transaction was never built
> is never reported as submitted.**

Two failure modes, and the second is the one that is easy to overlook: a **double submission** (a
stalled-job retry, a redeploy mid-flight, a Horizon timeout that did land) and a **silent
non-submission** (a `PENDING` row with no job on the queue, which looks exactly like a payment about
to be submitted, forever). Where they conflict, this chooses the loud failure - which is why the job
is enqueued *inside* `PaymentsService.create`'s transaction, before the commit: a rollback can leave a
job for a payment that does not exist (the handler throws "does not exist, so there is nothing to
submit"), while a committed row can never be left without one.

### The fence

The hash, the sequence number the transaction consumed, and its own `maxTime` are written to
`transactions` **before** Horizon is told anything, so a crash between the two leaves a row that says
"this transaction may exist" - the only reading that is safe to act on. That record is then a fence:

- While `now <= submissionDeadline` the recorded transaction may still land, so an attempt **defers**
  to it and does nothing at all - not even opening the seed.
- After the deadline a rebuild is allowed **only** if a freshly loaded sequence still equals the
  recorded one, which means the recorded transaction never consumed it. A sequence that has moved
  past it means the recorded transaction landed, so there is nothing to rebuild.
- A `tx_bad_seq` on a rebuild means the *recorded* transaction landed in the gap: the previous record
  is put back and the attempt stops, because that is the hash a poller has to look for.

### What a failure becomes

`retry` (the row is untouched and the error travels, so BullMQ prices the attempt) covers every case
with no verdict - including `StellarSubmissionUnavailableError`, whose fate is unknown and may have
landed. `failed` is reserved for a definitive no: an unopenable stored secret with nothing recorded,
or a permanent operation code, written as `failure_reason = landed-unsuccessful:op_underfunded`.
`rebuild` is a retry whose next attempt the fence decides. The rule behind the split: retrying costs
an attempt, concluding wrongly costs money.

The prefix on that reason belongs to a vocabulary the whole payment path shares, and it records what the
*network* did rather than which caller asked: `landed-unsuccessful:<code>` for a transaction a ledger closed
unsuccessfully (every operation code, and `tx_failed` itself), `submission-rejected:<code>` for a refusal no
ledger ever saw (`tx_bad_seq`, `tx_too_late`, `tx_malformed`, `tx_insufficient_fee`, `tx_bad_auth`,
`tx_no_source_account`, `tx_insufficient_balance`, `tx_internal_error`), and no prefix at all
(`unknown:<code>`) for a code outside both lists - because a code nobody in this app has classified is
evidence of neither story, and guessing is the mistake with a money-shaped consequence. A submit-time refusal
and a poll that reads the same code back therefore write the same name: as the gated run measured, Horizon's
`submitTransaction` blocks until the ledger closes the transaction, so the 400 is the *outcome* of a
transaction the ledger has, not the absence of one. See `docs/step-28-29-proposal.md` §6.

### The bound on Redis

The enqueue runs inside the sender's `SELECT ... FOR UPDATE`, so its duration *is* the duration of
that row lock - an unbounded hang there is an availability cascade onto every payment from that
sender. The producer's connection therefore carries `commandTimeout: 3000`
(`PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS`). It is a **second** connection, and that is the interesting
part: ioredis arms a command timeout for blocking commands too, and BullMQ's worker blocks for
`drainDelay` (5s idle, up to 10s with a delayed job pending), so a few-second bound on the shared
connection would turn every idle worker tick into an error plus a retry delay. `@nestjs/bullmq`
cannot express that split (`registerQueue` and `@Processor` both exclude `connection`), so the
producer is constructed as a provider of its own, closed on shutdown, while the worker keeps the
shared connection untouched - still pinned by `payments-queue.module.spec.ts` to `{ connection: { url } }`
and nothing else.

### Running the proofs

```bash
npm run test:e2e test/submission.e2e-spec.ts   # 4 tests: 1 ungated (the enqueue bound), 3 gated
RUN_STELLAR_IT=1 npm run test:e2e test/submission.e2e-spec.ts
```

The ungated test boots the real application, writes a real payment row, wedges Redis with
`CLIENT PAUSE` and asserts that the payment fails *inside the bound* (`3044`, `3122`, `3206`, `3251`, `3353` ms
across runs, against `PAYMENTS_QUEUE_COMMAND_TIMEOUT_MS = 3000`), that no row was written, that the
producer recovers, and that the orphan job Redis eventually runs is rejected by the handler.

The gated test is the Day 4 audit item, and the run it was written after is quoted in
`docs/build-sequence.md`: a real signed submission to Testnet (`e9da1c48…36ec0d`, ledger `4943111`)
with Horizon asked directly for the transaction and both balances; the same `transactionId` submitted
a second time answering `deferred` with the sender's **sequence unchanged** on the network; and the
sender's seed - opened through the real KMS for the sweep - absent from all 46 captured log lines,
both rows and the job result. The only substitution is the USDC issuer: Circle's Testnet USDC has no
programmatic faucet, so the run creates and funds its own issuer and mints from it.

## Confirmation and the status rule (Steps 28–29)

Submitting a payment gets it *accepted* by Horizon; it does not put it in a ledger. Steps 28–29 are the
half that turns acceptance into an answer — and the rule that keeps the answer in one place.

### The sweep

A repeatable BullMQ job (`confirm-payments`, one schedule registered under the id `confirmation-sweep`)
polls Horizon for every `PROCESSING` row that has a hash and resolves it. It is a *sweep* rather than a
timer per payment because the work list is then the `transactions` table: a flushed Redis, a redeploy or a
retention policy costs a delay rather than a payment nothing will ever look at again.

**It is off by default.** `PAYMENTS_CONFIRMATION_INTERVAL_MS=0` registers no schedule at all — not a
zero-delay one, which would be a spin loop of Horizon calls — and says so at boot:

```
The confirmation sweep is off (payments.confirmationIntervalMs=0), so payments stay PROCESSING until a
sweep is run - see the README
```

To poll, set the interval in milliseconds (`30000` is a sensible start) and restart the API. To run a
single tick on demand — during an incident, or to see what a deployment is holding — add the job through
the same path the schedule uses (`PaymentsQueueService.enqueueConfirmation()`, which is also what a
script or a REPL would call).

### What a tick decides

| what Horizon says | the row's deadline | the row becomes |
| --- | --- | --- |
| it is in a ledger, successful | — | `SUCCESSFUL` |
| it is in a ledger, not successful | — | `FAILED`, reason `landed-unsuccessful:<tx code>` |
| it has never seen the hash | still ahead, or within 60s past | unchanged — `PROCESSING` |
| it has never seen the hash | past by more than 60s | `FAILED`, reason `not-found-after-deadline` |
| it did not answer | — | unchanged, counted as `unresolved` |
| it has never seen the hash | no deadline recorded | unchanged, counted as `unresolved` |

The 60-second grace window past the deadline reads Horizon's own ingest lag: the ledger has closed the
transaction and Horizon has not served it yet. Waiting costs a minute; deciding early claims a payment
failed that then appears in a ledger with the money moved.

The tick's result is its counters and nothing else — `{ polled, confirmed, failed, waiting, unresolved,
stuckWithoutHash }` — which is how "quiet" and "broken" are told apart: `polled > 0` with everything
`waiting` is an ordinary minute on a slow network, `unresolved` alongside `polled` is Horizon not
answering, and `stuckWithoutHash` is the one case this step cannot fix (see *Known gaps*).

The sender is told **after** the row is written, and from the row rather than from the request, so the
message cannot disagree with the database. A provider failure is logged with the payment id and does not
undo the resolution — the money fact is the row.

### The status rule

`src/payments/services/transaction-status.ts` is the only file in the repository that writes a payment's
`status`, and `npm run lint:status` is what keeps that true:

```bash
npm run lint:status
# Status discipline: 158 files scanned, 3 status writes in the sanctioned writer, 0 violations
```

A `data: { status: ... }` on a `transaction.create` / `createMany` / `update` / `updateMany` / `upsert`
anywhere else — or raw SQL that does `SET status = ...` — fails that command, and therefore `npm run lint`,
and therefore CI, with the `file:line` and the writer to call instead. A payment's *initial* status is not
a write: it is the column's own `@default(PENDING)` in `schema.prisma`, which leaves one statement of what
a payment starts as and one writer of what it becomes.

### Running the proofs

```bash
npm test                       # the decisions: 753 unit tests, 46 files
npm run lint                   # oxlint, then lint:money, then lint:status
RUN_STELLAR_IT=1 npm run test:e2e test/submission.e2e-spec.ts   # the real-network half
```

The decision itself is what the unit tests pin, and they pin it on the boundaries rather than in the
middle: `confirmation-triage.spec.ts` walks every row of the table above, including `now == deadline + 60s`
(waiting) and one millisecond later (failed); `payments-confirmation.service.spec.ts` asserts the
work-list query whole, that each resolution is exactly one compare-and-set, that `waiting` and
`unresolved` write nothing and notify nobody, that a resolution won by another caller sends no second
message, and that a provider outage cannot un-resolve a payment; `horizon-transaction-lookup.spec.ts`
pins Horizon's 404 as a normal `not-found` and a 5xx as `unavailable`. The gated run is the Day 4 audit
item: it submits a real transaction to Testnet, shows that same row leaving `PROCESSING` for
`SUCCESSFUL`, and shows a payment the network refuses outright — `op_underfunded`, answered with an HTTP
400 — landing on `FAILED` with a readable reason instead of waiting on a poll that has nothing left to find
out. That refusal is worth reading the way the run reads it, because the run is where the difference
showed up: Horizon's 400 is its answer to the *submission*, while the ledger still closes the envelope as
unsuccessful and charges its fee, so the hash on a refused `FAILED` row resolves on an explorer — and the
reason's prefix, `landed-unsuccessful:op_underfunded`, is the same one the poll writes when it reads that
code back off a record, because both describe the ledger rather than the caller. `docs/build-sequence.md`
records the run
that was made and what it showed: the hashes, the ledgers, and the balances read back from Horizon by
something other than this codebase.

## Payment history (Step 30)

`GET /v1/payments` answers a filtered page of the caller's own history; `GET /v1/payments/:id` answers
one payment the caller is a party to. Both are `JwtAuthGuard`ed, both delegate to `PaymentsService`, and
both read the *meaning* of a request from one module, `src/payments/history/payment-history-query.ts` -
the same split Step 21's `classifyRecipientQuery` makes.

| File | What it is |
| --- | --- |
| `src/payments/history/payment-history-query.ts` | The vocabulary and the `WHERE` clause: `parsePaymentHistoryQuery`, `membershipWhere`, `buildPaymentHistoryWhere`, `PAYMENT_HISTORY_ORDER`, `directionFor`, `takePage`, and the constants the two DTOs quote. |
| `src/payments/dto/list-payments.dto.ts` | The query as Swagger documents it. Every member is a `string` here on purpose: the rules live in the module, including the one that *clamps* rather than refuses. |
| `src/payments/dto/payment-list-response.dto.ts` | One page: `items` (six fields per row) and `hasMore`. |
| `src/payments/dto/payment-response.dto.ts` | One payment: the same six fields plus `failureReason` and `stellarTxHash`. |
| `src/payments/services/payments.service.ts` | `history()` and `findOne()`: the two reads, the two status codes, and no filter logic of their own. |
| `src/payments/controllers/payments.controller.ts` | The two routes, and `@Get()` declared before `@Get(':id')`. |

### Membership is the access control, and it is not a parameter

Both reads call the same predicate, `membershipWhere(userId, direction)`, and the caller's id is the
*first* argument rather than a value a client can send. A payment is visible to the two accounts on the
row - the sender and the recipient - which is what makes one payment appear once on each side of a
transaction, and it is what `GET /v1/payments/:id` uses with `direction: 'both'`.

The consequence for the detail route is the interesting part: **a payment that belongs to two other
people answers exactly what a made-up id answers.** There is no second check and no `403`, because there
is nothing to check: a stranger's id reaching `membershipWhere` matches no row, the service sees `null`,
and a `null` row is a 404 either way. This endpoint is therefore not an oracle for which payment ids
exist, and the two answers differ only in `path` and `timestamp` - which the e2e asserts by comparing the
five fields that matter (`message`, `error`, `statusCode`) individually and the key *set* of the whole
body, rather than by comparing responses that were never going to be byte-identical.

An id that is not a UUID is a **400** before any row is looked for (`new ParseUUIDPipe()` on the
parameter), because "fix the request" and "stop looking" are different instructions - the same choice
`RecipientsController.confirm` records for account ids.

| Situation | `GET /v1/payments` | `GET /v1/payments/:id` |
| --- | --- | --- |
| Matched | `200`, a page of `items` plus `hasMore` | `200`, the payment |
| Nothing matched | `200`, `items: []` - an empty page, not a 404 | `404` - one payment was asked for by name, and `GET`ing a list is how a client asks "do I have any" |
| A filter could not be read | `400`, naming the parameter and the values that work | - |
| `id` is not a UUID | - | `400`, before any row is read |
| No or invalid access token | `401` | `401` |
| Account suspended | `403` | `403` |

The asymmetry on the second row is the route, not the scope: a list that matched nothing is a history
with nothing in it, and an id that matched nothing at *this* scope is a payment the caller may not see.

### What the filters accept

| Parameter | Values | Default |
| --- | --- | --- |
| `direction` | `sent`, `received`, `both` | `both` |
| `status` | `PENDING`, `PROCESSING`, `SUCCESSFUL`, `FAILED` | no filter |
| `from` / `to` | ISO-8601 instants, both bounds **inclusive** on `createdAt` | no bound |
| `limit` | a whole number of payments, clamped to `[1, 50]` | `20` |

Filters are spread *on top of* membership, never beside it, so no combination can widen what the caller
is allowed to see - a filter can only ever narrow it.

`?direction=` and `?status=` sent **empty** mean "not provided": "no filter" is a real request, and an
always-appended key with nothing in it is how a client spells it. `?from=`, `?to=` and `?limit=` are
**refused** when empty, because each names a specific value and the empty string is not one. That
asymmetry is deliberate and is asserted rather than left to be inferred from the code.

A date-only `from`/`to` is midnight UTC of that day and nothing else, so `to=2026-09-30` includes
nothing that happened during the 30th. A client that wants the whole day passes
`to=2026-09-30T23:59:59.999Z`, because silently widening a bound to the end of its day would be a hidden
`+23:59:59.999` inside a filter a person is reading numbers out of. `2026-02-31` is refused - it is not
an instant, and `new Date()` would have quietly rolled it into March.

### A cap, where Step 21 refused

Asking for `limit=1000` is answered rather than refused: it is the cap - fifty rows, or the caller's
whole history if it is shorter - with `hasMore` saying whether there is another page. That is the one
place this endpoint deliberately differs from the directory search, and the difference is who is paying
for the query: Step 21's `limit` prices *sweeping other people's handles*, so silently returning twenty
to someone who asked for a thousand would hide a refusal from a sweep. Here the caller is reading their
own money: there is nothing to protect, and a page is a page. A whole number out of range is clamped, so
`limit=0` becomes one row - the smallest page that is still a page - while a value that is not a whole
number at all (`-1`, `1.5`, `twenty`, empty) is a 400 naming the parameter, because a page size that is
not a number is a typo and answering a typo with a default hides it.

The bound lives in the module (`PAYMENT_HISTORY_MAX_LIMIT`, `PAYMENT_HISTORY_DEFAULT_LIMIT`) and *not*
as `@Max()` on the DTO, so there is one statement of it rather than two that are free to drift: a pipe
that refused a `limit` the code is written to clamp would be a second, disagreeing answer.

### `hasMore`, and the order a page needs

`hasMore` comes from reading `limit + 1` rows and discarding the extra one, not from a second `count()`.
A count is a different query at a different moment, so it can disagree with the page the client is
actually holding; one extra row cannot. `items.length === limit && hasMore` is therefore exactly "there
are more, ask for a bigger page", and the e2e asserts both halves of that seam at the default page size
against thirty real rows.

The order is `createdAt` descending **with the id as a tiebreak** (`PAYMENT_HISTORY_ORDER`), and the
tiebreak is not decoration: two rows written in the same millisecond order arbitrarily without it, and a
page boundary drawn on an unstable order can show a client the same payment twice while hiding another
one entirely. Thirty rows an hour apart cannot tell "newest first" from "newest first, ties broken", so
the e2e carries a pair written at the same instant - the two control payments between the other two
accounts. Read from the stranger's side that page is two rows with one `createdAt` and no chronology to
sort them by, and the assertions are that the order is `id` descending, that each row is on its own
side (`sent`, `received`), and that a second request returns the same order.

### Six fields in a list, eight for one payment

`PaymentListItemDto` carries `id`, `status`, `amount`, `direction`, `recipientId`, `createdAt` - the
fields a list sorts and renders. `failureReason` and `stellarTxHash` are on `PaymentResponseDto` only,
and that is a disclosure decision as much as a size one: `failureReason` is a raw machine code
(`landed-unsuccessful:tx_failed`), never Horizon's prose, and the fewer rows that carry one the fewer
places it can be rendered as a sentence somebody wrote for a person. The e2e asserts the absence with
`toHaveProperty`/`Object.keys` rather than by trusting the mapper.

`direction` is derived per caller (`directionFor`) from the row, not from the query: the same payment is
`sent` to its sender and `received` to its recipient, both reach the detail route with the same id, and
the id is the only thing the client knows.

### Running the proofs

```bash
npm test                                             # 841 tests (47 files) as of Step 30
npm run test:e2e test/payments-history.e2e-spec.ts   # 25 tests: real Postgres, real Redis
npm run lint                                         # oxlint, then lint:money, then lint:status
```

The unit half is `payment-history-query.spec.ts` (71 tests) and it drives the *parser* exhaustively -
every value a parameter accepts, every empty string, both ends of the clamp, a reversed range, `2026-02-31`
- because a filter's interesting half is the reading of what a client sent, and that half needs no
database. `payments.service.spec.ts` then pins the two reads against a fake Prisma client: the exact
`where`, the `limit + 1` read, and that a missing row is a 404 while a filter the module refused is a
400.

The e2e is the audit item - "against real data, not just a small fixture that happens to pass" - and it
is built to make a small fixture impossible: **thirty rows, one per hour from 2026-06-01T00:00Z**, written
straight into `transactions` through the Step 29 state machine (so each one is a real `PROCESSING` or
`SUCCESSFUL` or `FAILED` row with a real envelope, not a status written by hand), plus a **control pair**
at `2026-06-01T10:00Z` belonging to two other accounts - one each way, both at the same instant as the
caller's tenth row. Thirty is more than one page, which is what makes the seam testable: the twentieth
row, the page that must not claim to be the whole answer, and the `from`/`to` bound placed exactly on a
row's `createdAt`. The control pair is both assertions at once: membership (it is invisible in every page
and filter, its detail request 404s for everyone else, and each of its two parties reads its own side)
and order (two rows in one millisecond are the only rows whose page order is the tiebreak itself).

## Staging on Render (render.yaml)

`render.yaml` at the repository root is a Render Blueprint: created once in a workspace (`New -> Blueprint`,
pointed at this repository - the Blueprint Path is `render.yaml`, which is the default), it provisions the
whole environment in one sync - a Postgres database, a Key Value instance, and the API built from the
Dockerfile that is already here. A `main` push redeploys the API (`autoDeploy: true`); a change to the file
is applied by re-syncing the Blueprint.

**It is staging, and three things in the file say so.** `STELLAR_NETWORK=TESTNET`, with the Horizon URL and
the USDC issuer that exist on that network, so nothing in this environment can move real money.
`NODE_ENV=production`, so the custody guards (Step 18) are *exercised* rather than bypassed - which is why
`AWS_ENDPOINT_URL` is absent from the file and has to stay absent: the validator refuses to boot when it is
set in production, and that refusal on a misconfigured staging is the guard working. And
`ENABLE_SWAGGER=true`, which `.env.example` advises against on a public production host but is the point of
staging: the frontend calls the real API and reads `/api/docs` while they do it.

| Decision | Why |
| --- | --- |
| `numInstances: 1` | The BullMQ worker and the confirmation sweep run *inside the API process* (Step 26). A second replica would be a second consumer of one queue and a second registrant of one schedule, for throughput this stage does not need. |
| Paid datastore plans | A Free Postgres instance expires 30 days after creation, and a Free Key Value instance keeps nothing on disk - a staging database that disappears mid-demo, and jobs plus idempotency records lost on any restart. |
| `maxmemoryPolicy: noeviction` | BullMQ holds job state in keys, and Render's default (`allkeys-lru`) could evict a queued submission. Step 26 makes the work list the `transactions` table, so an eviction costs a delay rather than a payment nothing will look at again - a preference, not a load-bearing setting. |
| `postgresMajorVersion: '16'` | The version `docker-compose.yml` runs, and therefore the one every migration and every e2e run in this repository was executed against. Left unset, Render would use its newest supported major. |
| `healthCheckPath: /v1/health` | The liveness endpoint: no auth, no database call, no Redis call. It is the URL `HealthController`'s own docblock says a load balancer is pointed at. |
| `preDeployCommand` | `npx --no-install prisma migrate deploy` runs in the newly built image, with this service's environment, *before* it takes traffic - so a failed migration fails the deploy and the previous version keeps serving. The Dockerfile copies `prisma/`, the migrations and `prisma7.config.ts` into the runtime stage for this one line (and `dotenv`, which that config imports). |

### The values that are not in the file

`sync: false` marks the variables prompted for in the Dashboard on the first sync, because none of them can
live in a repository: `CORS_ALLOWED_ORIGINS`, `AFRICASTALKING_API_KEY`, `AFRICASTALKING_USERNAME`,
`SENTRY_DSN`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_KMS_KEY_ID`. `JWT_SECRET`
is not on that list because Render generates it (`generateValue: true`), and `PORT` is not either because
Render supplies it and `main.ts` listens on the validated `PORT` rather than a hardcoded 3000.
`AFRICASTALKING_USERNAME` is prompted for next to the key on purpose: the username is what picks the API
host, so a sandbox key under a live username is a 401 that reads like an outage.

`STELLAR_FRIENDBOT_URL` is left unset deliberately: on Testnet the default is Stellar's own faucet, so new
accounts are funded with nothing to configure.

## Documentation conventions

Rules these docs and this repository's commit messages follow. They exist because a document that is
right when it is written and quietly wrong later is worse than one that never claimed anything.

- **A count carries the step it was measured at.** The lint scanner counts files and the test runner
  counts tests, and both grow with every step, so a bare `131 files scanned` is a fact about one
  afternoon and a false statement by Step 27. Written as **131 files scanned, 0 violations as of
  Step 25** it stays true forever, and a reader can see how old the measurement is without going to
  the log. A count that is re-measured later is *appended* with its own label rather than edited in
  place: the Step 23 audit line in `docs/build-sequence.md` carries both `121 files, 0 violations as
  of Step 23` and `131 files, 0 violations as of Step 25`, because the older number is evidence about
  a smaller tree, not a mistake to be corrected. Re-measured again at Step 27: **148 files scanned, 0
  violations as of Step 27**; and again at Step 30: **164 files scanned, 0 violations as of Step 30**,
  where the status rule prints a finer line of its own - `164 files scanned, 3 status writes in the
  sanctioned writer, 0 violations` - because for that rule "nothing was found" and "nothing was read"
  have to be different sentences.
- **A heading that names a step does not label the counts inside it.** `## Money precision and the
  money rule (Step 23)` says when the *feature* landed; it says nothing about when the *number* under
  it was measured. The number needs its own label.
- **Numbers come from a real run, and say which one.** Every count in these docs is the output of a
  command that can be run again - `npm test`, `npm run lint`, `npm run test:e2e <file>` - quoted from
  the run that was made rather than rounded, extrapolated or remembered. Where the number *is* the
  claim (the 202/409 split of the forced overdraft race, `SUM = 9`), the command that reads it is
  named next to it.
- **Commit messages are documents that happen to be immutable**, so the same rule applies to a count
  in a commit body.

## Known gaps

Recorded rather than fixed, so that they stay decisions instead of surprises. None of them
blocks a step in `docs/build-sequence.md`.

- **A `PROCESSING` row with no recorded hash is reported, never resolved.** It is the one case Steps 27–28
  leave open: a claim (`PENDING → PROCESSING`) whose process died before `recordEnvelope` wrote the hash,
  the sequence and the deadline. There is no hash to poll, and the three ways out — re-submit, fail it, or
  release the claim back to `PENDING` — are all submission decisions that interact with the sequence fence
  and with custody, so a poller taking any of them would be a second path to a signature. The sweep counts
  such rows (`stuckWithoutHash`, `updatedAt` older than five minutes) and logs a warning naming them, and
  that is the whole of its handling: deciding what to do with one needs an operator or a later re-drive
  step. `docs/step-28-29-proposal.md` §5 is where the case is argued.

- **The money rule matches names, so it can only see money that is named like money.** A value of
  an amount called `total` or `x` typed `number` is invisible to it, and so is a `Float` column
  whose name carries none of `MONEY_WORDS` - `amount`, `balance`, `fee`, `price`, `total`, `subtotal`
  and their plurals, matched on snake_case boundaries. This is deliberate - the alternative is a
  type-checker that cannot exist without a branded type threaded through every boundary, and the
  columns the build is about are all named `amount` - but it means the rule is a strong net rather
  than a proof: Step 25's `Transaction.amount` and the queue payloads Steps 26-28 will carry are
  covered by name, and a future money value must be named accordingly or added to `MONEY_WORDS`.
  The repo-wide case in `money-discipline.spec.ts` asserts the rule ran over every file in `src` and
  `test`; it cannot assert that every money value is named, and does not pretend to.
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
- **Nothing retries Stellar provisioning automatically - but a half-provisioned account is now
  completed by calling the service again.** `AccountProvisioningService.provisionFor` still has
  exactly one caller in `src` - `AuthService.verifyOtp` (`src/identity/auth.service.ts:404`) - and
  nothing puts it on the queue: `@nestjs/schedule` is still not a dependency, the payments queue
  (Step 26) carries two jobs **as of Step 27** - a probe, and `submit-payment` - and neither is any
  provisioning work, and the only `setTimeout` calls in `src` are the provisioning deadline and the
  Stellar SDK's transaction timeout. So a verify that comes back `incomplete` (a friendbot `429` or
  `5xx`, a Horizon `5xx`, or the 30s deadline) is still the last *automatic* attempt that user's
  wallet gets: the way back cannot be a second verify, because the OTP row is spent by then, and
  `/v1/wallet/account` and `/v1/wallet/balance` are reads that throw `NotFoundException` instead
  of provisioning (`src/wallet/balances/balances.service.ts:133-149`), so nothing a client can
  call reaches `provisionFor` again.
  What changed (2026-09-29) is that the retry path those docstrings promised now exists *and
  works*. `provision` no longer answers from the row: a user who already has a `stellar_accounts`
  row goes through `outstandingFor`
  (`src/wallet/provisioning/account-provisioning.service.ts:440`), which asks Horizon once
  (`StellarService.loadBalances`) what is still missing. A load that resolves *is* the account
  existing on the ledger, and `UsdcTrustlineService.isUsdcLine`
  (`src/wallet/provisioning/usdc-trustline.ts:194`) is whether one of the lines that came back is
  this deployment's USDC - code *and* issuer, never the code alone. Only what is missing is then
  done: funding is skipped when the account already exists (`ALREADY_FUNDED`, `:550`, so no second
  starting balance from the endpoint that pays repeats), and `ensureFor` runs only when the
  trustline is absent - which is why a repeat call for a finished account still submits nothing at
  all. `already-provisioned` is now Horizon's answer rather than the row's (`:351-362`), and
  resuming uses the *stored* row: the key that was already sealed is the one funded and signed
  for, never a second keypair. The docstrings were corrected with the code - the one that claimed a
  queue consumer as a retry path (`:166-169` before this change) now states what is true (an
  operator's script) and names what is still missing.
  That closes what this note used to record: an account that was stored but never funded, or
  funded but never trusted, was reported as done by every later call and could not be finished by
  anyone, however many times the service was called - while the two layers that *were* built to be
  safe to repeat (friendbot tolerating "already funded", `friendbot-funder.ts:162-184`;
  `changeTrust` being a no-op at the ledger level, `usdc-trustline.ts:96-104`) were never reached
  for such a row. The spec that used to assert the short-circuit
  (`account-provisioning.service.spec.ts:427`, "a user who already has an account as
  already-provisioned, and funds nothing", 24/24 passing) now asserts the same outcome for the
  reason that makes it honest - a *finished* account, as Horizon reports it - and the resumption
  block below it (`:618`) covers the half-provisioned ones: "completes an account that was stored
  but never funded", "gives a funded account the USDC trustline it is missing, without asking the
  funder again", "does not take a USDC line from another issuer for the trustline this app
  establishes", and "provisions nothing on the strength of a lookup Horizon did not answer". That
  is 29 tests in the file, was 24. The live run re-ran green end to end - 3/3, including
  `test/provisioning.e2e-spec.ts:356`, which seals a real row through KMS, confirms Horizon has
  never seen that key, and then completes it on Testnet (`funded 4769c489…`, `trustline
  3b04d58f…`) - and the repeat-call invariant still holds against the chain: `funder_calls=1`,
  sequence unchanged, one USDC trustline. The `stage` such a failure reports is logged (`warn`
  for the retryable failures, `error` for the ones needing a human) but not stored -
  `stellar_accounts`
  has no status column - so after a restart the only trace is a log line.
  **What is still open is the caller, not the flow.** Nothing invokes `provisionFor` on its own,
  and the deadline is still not what strands a user: `withDeadline` rejects the caller but
  deliberately does not cancel the work it stops waiting for, so a slow-but-eventually-successful
  provisioning completes in the background and only the *report* is lost. The attempt that no later
  call can rescue is the one that fails *after* its deadline was reported - the work carried on in
  the background, then failed, and its outcome was dropped - and nothing sweeps for it. Closing
  that needs a sweep that reprovisions rows whose account is unfunded or has no USDC trustline, or
  a queue to run the flow again; neither exists, so recovery from that one case is still manual.
  Found by reading the paths rather than by a failure being observed (2026-09-29): the
  verification run that day provisioned fully on the first attempt.
- **The development KMS is an in-memory emulator, so the keys wallets are sealed under do not
  outlive it.** Custody calls go to `motoserver/moto:5.2.3` (container `cashping-kms-moto`),
  started by hand with `docker run`, and `docker inspect` shows why it cannot be relied on: an
  empty `Mounts` list, a default entrypoint (`/usr/local/bin/moto_server -H 0.0.0.0`, no
  persistence flag), and no `MOTO_*` variable in its environment - so the master key lives in that
  container's memory, under Moto's default account id (`123456789012`). The endpoint and key
  come from the launching shell, as the wallet integration test's docblock describes:
  `AWS_ENDPOINT_URL=http://localhost:5055` and
  `AWS_KMS_KEY_ID=arn:aws:kms:eu-west-1:123456789012:key/5b58f5b1-fbc7-480f-8de8-dbf86825341a` -
  not from `.env`, whose `AWS_ENDPOINT_URL` is commented out and whose `AWS_KMS_KEY_ID` is the
  all-zero placeholder. A restart, a `docker rm`, or a rebuilt container loses the key, and with
  it the ability to open any envelope sealed against it: the `stellar_accounts` row survives and
  the Testnet account survives, but nothing can sign for that wallet any more. Accepted rather
  than fixed (2026-09-29) - development should not need real AWS credentials, and the round trip
  is exercised for real either way, since a Testnet `changeTrust` signed through this emulator was
  accepted for account `GBTISMWS76ZFPUT3ACDW4LIQKQU4FCRVRVSWDTTLHOEJSAGNYYFVPU5E`. Anything that
  has to outlive the container needs a real KMS, or an emulator configured to persist its state -
  not the container as it is run here. See also [Pointing KMS at a local
  emulator](#pointing-kms-at-a-local-emulator).

- **A payment is created against a balance, and Horizon's balance is a snapshot read before the
  lock.** `PaymentsService` reads the wallet's USDC from Horizon *outside* the transaction that
  takes the row lock (holding a lock across a network round trip was the worse problem), so what the
  overdraft check subtracts from is the balance as of the start of the request, plus the in-flight
  sum read under the lock. Two consequences, both accepted: a sender whose money arrived a
  millisecond ago is measured against the older number (they can retry, and the retry sees the new
  one), and a `PROCESSING` payment whose submission actually landed but whose status has not been
  updated yet is subtracted *and* already reflected in Horizon - so the sender is briefly charged
  twice against their own balance. That second one is what Step 31's reconciliation is for: it
  compares the internal ledger against Horizon and reports drift, which is the honest instrument for
  "the two disagree" rather than a second cache of the truth.
- **The idempotency claim is Redis, so a Redis outage stops payments even though the database alone
  would have been enough.** Failing closed is deliberate (an unreadable key is a duplicate that
  cannot be detected), but the cost is real: with Redis down, `POST /v1/payments` answers 503 for
  everyone, while `@@unique([senderId, idempotencyKey])` could still have refused every genuine
  duplicate. The mitigation if that ever matters is to make the Redis claim *advisory* - proceed
  without it and let the unique index decide - which trades a replayable response (the client gets a
  409 instead of the original transaction) for availability. Not done now: with one API instance and
  a 24-hour claim, the outage is the more likely event by far.
- **A lost claim degrades a retry from "here is your payment" to a 409.** If Redis loses the key
  (flush, eviction, expiry, a deploy that never wrote it) and the client retries, the database
  refuses the second insert and `PaymentsService` answers 409 with "this Idempotency-Key already
  created a payment" - correct, but not the *original body*. Since Step 30 the client can recover the
  payment itself: it will be the newest row that account is a party to in `GET /v1/payments`. What
  does *not* exist is a lookup by key - no route takes an `Idempotency-Key` as a filter - so recovery
  means recognising your own payment by its amount and time, which is why the 409 still names the key.
- **History pages by time window, not by cursor.** `GET /v1/payments` takes `limit` and no `offset` or
  cursor, so paging deeper than one page means narrowing `to` to the `createdAt` of the last row seen
  and de-duplicating the boundary row yourself: that row is the newest of the next page and the oldest
  of the previous one. `hasMore` says a page was cut short; it does not say what to ask for next. The
  order is total (`createdAt` desc, then id), which is what makes the boundary safe for rows written in
  the same millisecond - but the id tiebreak is not exposed as a value a client could pass back, so a
  single millisecond holding more than `limit` rows cannot be crossed by a window alone. There is also
  no `total`: a client cannot render "3 of 47", and that is deliberate rather than missing, because a
  count is a second query that can disagree with the page in hand. A cursor is the fix if a client ever
  needs one; the request a wallet client actually makes ("my newest twenty") is answered exactly.
- **Nothing caps a single payment's size.** `numeric(20, 7)` bounds it at 13 integer digits, and
  `Amount.fromString` refuses anything wider with a 400 (a wider value reaches Postgres as
  `numeric field overflow`, i.e. a 500 for a bad request), but there is no *product* limit - no
  per-transaction maximum, no daily ceiling, no velocity rule. Step 25's text called the ceiling "its
  product rule" and no rule was specified, so inventing one inside the money type would have hidden a
  product decision in the code that every money path has to use. A real limit belongs with the
  product owner, applied as its own check in `PaymentsService`.
- **Paying yourself is refused, which is a product rule this step chose.** `recipientId === senderId`
  is a 400 ("sending to your own account would move nothing"), while the confirmation endpoint still
  allows confirming your own id, because that read is how the frontend answers "this one is you". The
  asymmetry is deliberate: a read of yourself is not a payment. If self-transfers ever need to be
  allowed (moving funds between two wallets a user owns), this is the check to revisit - and it will
  need a story for what the history shows.
- **Nothing tells Sentry about a failed job.** The global exception filter (Step 6) reports what a
  *request* did, and the worker has no equivalent: `PaymentsProcessor` logs a failed job with its
  name, id and attempt count, which is enough to find it in Redis and in the log and not enough to
  be paged about. Step 27 shipped what a failed *submission* reports without wiring a reporter: the
  row carries `failure_reason` (`landed-unsuccessful:op_underfunded`), the processor logs the job with
  its id, name and attempt count, and the job result records the decision - three places to find it,
  and still no page. Wiring a reporter here stays the open decision this bullet records, and the
  argument for it is unchanged: a submission that failed is money that did not move - a different
  category from a probe that failed. Recorded so that it stays a decision instead of a surprise
  during the first incident.

- **The Render blueprint has been checked against Render's schema, never against a workspace.**
  `render.yaml` parses, and every key in it — `preDeployCommand`, `maxmemoryPolicy: noeviction`,
  `fromService`, `ipAllowList` — exists in Render's published Blueprint schema
  (`https://render.com/schema/render.yaml.json`), which is a statement about the file and not
  about a deployment: no sync has been run, so the plan slugs (`0.1c-256mb` for Postgres, and
  `0.5c-512mb` and `256mb` for the API and the Key Value instance), the `frankfurt` region and
  the behaviour a reader would test first — that a failing `prisma migrate deploy` aborts the
  deploy and leaves the previous version serving — are Render's documented answers rather than
  anything this repository has seen. What has been observed is the image: the Dockerfile's
  runtime stage now carries `prisma/`, the migrations, `prisma7.config.ts` and `dotenv`, so
  `npx --no-install prisma migrate deploy` has a schema and a datasource to read instead of
  dying on an unresolved import. The environment the e2e suites run against is still
  `docker-compose.yml`'s Postgres and Redis on their own ports, and no API request in this
  repository has ever been served by the staging service.

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
