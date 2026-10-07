# Pre-production hardening

**Status: Sections 1 and 2 are closed; Section 3 has not been run.** The environment it needs does
not exist yet: `render.yaml` has been checked against Render's schema and never synced, so there is
no staging URL to point a smoke test at (Section 3, step 0). Everything Section 3 asserts is
therefore written to be *executed*, not read as though it had been.

This document is the pre-production pass on top of Day 5's audit. It exists because the two
questions are different ones: Day 5 asked "does the code do what the plan's Section 5 says", and
answered it locally, against a real Postgres and a real Redis; this asks "does the artifact that
runs on a host — the migration in the start command, the real KMS, the real SMS provider, the
free-tier clock — behave", and nothing local can answer that.

---

## Section 1 — Where the evidence lives

Nothing here is restated. The proofs are already in the repository, in four places:

| Where | What it holds |
| --- | --- |
| `docs/build-sequence.md`, the **Day 5 ticks** (Steps 30–34) | The Section 5 walk itself: transaction integrity, data protection, auth, the API-hardening gap and its fix, and Stellar-specific risks — each with the file, the line and the measured run behind it. |
| `docs/build-sequence.md`, the **credentials checklist** (Steps 34a–34d) | 34a, 34b and 34c ticked with their evidence (`pin.e2e-spec.ts` 19 tests, `password.e2e-spec.ts` 13, `email.e2e-spec.ts` 9, `audit.e2e-spec.ts` 10). 34d (Google SSO) is open on purpose: it does not exist yet. |
| Commit **`9e0f2b9`** — *"feat(http): a baseline of security headers on every response (Step 34)"* | The one gap Day 5 actually found. Five files: `src/common/http/security-headers.ts` (the headers), `src/main.ts` (applied ahead of `configureCors`, so it covers every route), `security-headers.spec.ts` (4 unit tests over real responses, a 404 included), `test/app.e2e-spec.ts` (asserted against the real `AppModule`), and the build-sequence tick. Hand-written rather than `helmet`, with CSP and Permissions-Policy deliberately omitted so the served Swagger UI keeps working — recorded in the file as a decision. |
| Commit **`0abc953`** — *"docs: tick Steps 34b and 34c, with the tests that prove them"* | The credentials ticks, docs-only, kept separate from the code commits that earned them. |

The full suite those ticks rest on, taken with the compose stack up (`docker compose up -d postgres
redis`, with `POSTGRES_HOST_PORT=5433` / `REDIS_HOST_PORT=6380` so the ports match `.env`) and
migrations current:

```bash
npm run test:e2e     # 13 files passed | 3 skipped (16); 151 tests passed | 20 skipped (171); exit 0
```

---

## Section 2 — What that proves, and what it cannot

**Proven locally, and by what.** Every route in the flow below has been exercised over real HTTP
against the real `AppModule` — real Postgres, real Redis, the real services — with exactly three
providers substituted, and they are the three that reach the outside world: `SMS_SENDER` (so codes
can be read), `EMAIL_SENDER` (the same, for the other channel), and `AccountProvisioningService`
(so a verify reaches no KMS and no Horizon). The suite is `test/auth.e2e-spec.ts`,
`test/pin.e2e-spec.ts`, `test/password.e2e-spec.ts`, `test/email.e2e-spec.ts`,
`test/recipients.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/payments-history.e2e-spec.ts`,
`test/audit.e2e-spec.ts` and `test/app.e2e-spec.ts`.

**Not proven — and this is the whole reason Section 3 exists.** Four things, each of which only a
deployed instance can settle:

- **Nothing has ever run on Render.** The Blueprint is documented as *never synced to a workspace*
  (README, "known gaps"): the first Create attempt was refused — `preDeployCommand` and
  `maxShutdownDelaySeconds`, both "not supported for free tier services" — and both were fixed
  after the refusal. A sync is the only check that counts, and it has not happened.
- **The KMS boot probe has only ever *failed*.** Every local e2e run prints
  `[boot] KMS DescribeKey failed after ~1000ms — … UnrecognizedClientException`, which is correct
  locally (a placeholder ARN and no AWS credentials) and says nothing about whether the path works
  with real ones. Staging is the first place the probe is expected to *answer* — and the first
  place a key in the wrong region, or a key that is disabled, would be caught by it.
- **The migration has never run where it runs in production.** `migrate deploy` in a `startCommand`
  was measured against a throwaway local Postgres (7 migrations, then idempotent re-runs), not
  against a Render instance that wakes from sleep by re-running that very command.
- **The notifications have never left the process.** The substituted senders are the seam; the real
  Africa's Talking call and the real email delivery are unproven, and a sandbox key against the live
  host (or the reverse) is a 401 neither side of a local run can produce.

Both datastores on staging are Render's `free` plan, so Section 3 also meets the clock: the web
service sleeps after 15 idle minutes, the database expires 30 days after creation, and the Key Value
instance keeps nothing across a restart.

---

## Section 3 — The staging smoke test

The register → verify → provision → email → search → pay → confirm → history flow, run against the
**deployed** staging environment. Every request below is a real one; every expected answer was read
out of the DTOs, so a mismatch is either a finding or a stale document and both are worth knowing.

```bash
BASE=https://<service-name>.onrender.com     # the URL the Blueprint reports once it is synced
```

Steps 1 and 2 come before the flow rather than after it, because a boot that fails its own probes
does not deserve a flow run against it.

### 3.0 Prerequisites

**(a) Warm the service first.** A free instance is spun down after 15 minutes with no inbound
traffic and takes about a minute to wake. The first assertion against a cold instance is a timeout
that says nothing about the deployment:

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' "$BASE/v1/health"   # warm-up; may be slow
```

**(b) Create the environment — New → Blueprint.** Nothing is deployed yet, so this is the first
thing that has to happen. In the Render Dashboard: **New → Blueprint**, point it at this repository
(`alsoknownaszac/cashping`), leave **Blueprint Path** at its default (`render.yaml`). Render parses
the file and offers the three resources — `cashping-staging-db`, `cashping-staging-kv` and the API
`cashping-staging`, all `plan: free`, region `frankfurt`.

**It will prompt for the nine `sync: false` values.** That is expected on a fresh sync — they are
the values no file can carry — and they are the only part a person supplies:

| Key | What to have ready |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | A real frontend origin, comma-separated, scheme and host, no trailing slash (`https://app.example.com`). Validated at boot, so a value a browser would never send stops the boot rather than the request. Empty is better than guessed. |
| `AFRICASTALKING_API_KEY` | The Africa's Talking API key. |
| `AFRICASTALKING_USERNAME` | Their username — `sandbox` for the sandbox host, anything else for the live host. These two have to agree: the username picks the host, and a sandbox key is refused by the live host with a 401. |
| `SENTRY_DSN` | The Sentry DSN. Staging is tagged `SENTRY_ENVIRONMENT=staging`, so its noise is separable on sight. |
| `AWS_REGION` | The region the KMS key lives in. |
| `AWS_ACCESS_KEY_ID` | Credentials for the custody principal — exactly the three actions the code calls (`kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey`), on that one key ARN and nothing broader. `README.md` → *What the KMS credentials are allowed to do* has the policy, and says why leaving `DescribeKey` out loses the boot probe rather than narrowing the policy. |
| `AWS_SECRET_ACCESS_KEY` | The secret half of that pair. |
| `AWS_KMS_KEY_ID` | The key's ARN, bare id, or `alias/…`. **It has to be a key in `AWS_REGION`**: KMS keys are regional, and a key from another region answers `NotFoundException`, which reads like a deleted key. |
| `STELLAR_USDC_ISSUER` | The USDC issuer for this network. For staging that is the self-issued Testnet keypair in `docs/environment-switching.md` §6b (`GD7LC7…`), **not** Circle's Testnet issuer: the app can never mint, so on-demand test USDC needs an issuer whose secret the operator holds. It is `sync: false` so no Testnet issuer is ever committed to `render.yaml`. A trustline is on-chain, so set it **before the first registration**. |

Two things are deliberately *not* on that list, and each is a decision rather than an omission:

`JWT_SECRET` is `generateValue: true`, so Render generates it on the first sync and keeps it from
then on. `AWS_ENDPOINT_URL` is absent and must stay absent, because `NODE_ENV=production` makes the
validator refuse to boot when it is set — custody aimed at a non-AWS endpoint while `AWS_KMS_KEY_ID`
still names an AWS key is a different trust boundary, and the guard firing on a misconfigured staging
is the guard working.

> The full staging↔production matrix — every value that differs, the USDC issuer explained in three
> parts, and what must never be reused as-is — is `docs/environment-switching.md`. This section is the
> setup half (getting staging running); that document is the teardown half (going to production).

**Two cautions that come with the `AWS_*` values.** The principal should hold exactly the three
actions the custody code calls, and no key administration — the policy is in `README.md` → *What the
KMS credentials are allowed to do*. And the master key **cannot be rotated by this application**:
nothing re-wraps an existing row, so disabling or rotating the old key strands every account sealed
under it. If credentials are what leaked, rotate the access key instead — a new principal can unwrap
the same rows.

A reader who has not worked with AWS before, or who wants the reason each of the three actions is
there rather than a list of them, has a plain-language companion to this section:
[`docs/kms-credentials-explained.md`](kms-credentials-explained.md). It also carries the sweep that
checks the live policy is still three actions on one key ARN, and what a bad result looks like.

**(c) The sender needs USDC, and the faucet that supplies it is public — start there.** A freshly
provisioned Testnet account is funded with XLM by the friendbot and given a USDC trustline, so
`GET /v1/wallet/balance` answers `balance: "0.0000000"` with `trustline: "active"` — an empty wallet,
not a broken one. A payment of a positive amount from an empty wallet is a **409**, which is correct
behaviour and not a deployment finding.

Circle's own faucet dispenses exactly the asset a deployment *still pointed at Circle's Testnet
issuer* — `.env.example`'s default — expects, so for such a deployment the baseline needs no config
change at all. Staging now points at the self-issued issuer of §6b, so the faucet does **not** serve
it; staging mints its own. It is the one step in this section that a person must do in a browser,
because the faucet sits behind reCAPTCHA:

1. Read the sender's address off the API — `GET $BASE/v1/wallet/account` → `publicKey` (a `G…`).
2. Open <https://faucet.circle.com/>, leave the asset on **USDC**, and choose **Stellar Testnet** from
   the network dropdown. Paste the `publicKey` and send. There is no account and no login; the limit
   is 20 USDC per address per network every 2 hours, and §3.2 moves 1.25 USDC.
3. Confirm it arrived with a **fresh** `GET $BASE/v1/wallet/balance`. The balance is read from Horizon
   on every call rather than cached, so a number that has changed cannot be a stale one.

That sends from `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, Circle's Testnet
issuer — the asset a deployment that has *not* switched to a self-issued one (§6b) is configured
for. Two things to watch, both of which look like other failures:

- **Fund after provisioning, never before.** The faucet pays USDC *to* the address, and a Stellar
  payment to an account that has not trusted the issuer fails on the *sender's* transaction
  (`op_no_trust`). The trustline is created by provisioning, inside the `verify-otp` request, so the
  order is register → verify → fund.
- **If the balance stays at zero, check the issuer before doubting the faucet.**
  `UsdcTrustlineService` matches a balance line on code *and* issuer, so USDC arriving from a
  different issuer is not the asset this deployment looks for. `trustline: "active"` with
  `balance: "0.0000000"` immediately after a faucet send means exactly that, and Horizon's raw
  account answer names the issuer that actually paid.

If the faucet is rate-limited or unavailable, the fallback is a **self-issued** asset: create a
keypair, fund it from the friendbot, point `STELLAR_USDC_ISSUER` at that public key, re-sync, and mint
to the sender with a payment *from* the issuer. It runs the same code path — the asset code is a
constant and only the issuer is configuration (`usdc-trustline.ts`) — with two costs worth naming: it
stops proving that the real Circle asset is what lands, and the issuer has to be changed **before the
first registration**, because a trustline is on-chain and a wallet provisioned against the old issuer
has a line the new configuration will not match (reconciliation compares that identity back). A keypair
for exactly this has since been created for staging —
`GD7LC7NGLRLX23Z6PWGVSYD6WYLHH27AMLEKQUMELCZG3I2KIIQVYKHL` (its secret is outside the repo); see
`docs/environment-switching.md` §6 for that issuer, and §6c for why the *mainnet* issuer is a value
that does not exist in this repository yet and must be looked up on the day, never copied from here.

**Record which of the two you used.** "The payment failed on balance" and "the payment failed" are
easy to confuse in a report.

**(d) What this run needs in hand:** a phone that can receive a real SMS (the code exists only in
the message — nothing echoes it, for the email code either), a mailbox for the email step, a browser
for the one reCAPTCHA-gated faucet send in (c), and `curl` with `jq`.

### 3.1 The boot, before any flow

**1. Liveness.** `GET $BASE/v1/health` → `200`:

```json
{ "status": "ok", "uptimeSeconds": 12.345, "timestamp": "2026-10-04T10:15:41.000Z" }
```

No database and no Redis call is made here, deliberately: green means "the API process is up", not
"every dependency is healthy". That is why the next two checks exist.

**2. The docs are mounted.** `GET $BASE/api/docs` → `200` (Swagger UI; the OpenAPI 3 document itself
is at `/api/docs-json`). Swagger is on for staging on purpose — the frontend team reads it — and it
is also the cheapest proof that the route prefix, the validation pipe, the security headers and the
global exception filter all mounted.

**3. The `[boot]` markers in Render's log — the KMS probe above all.** A healthy boot prints these to
**stderr**, in this order:

```text
[boot] bootstrap entered
[boot] config validated (NODE_ENV=production)
[boot] Sentry initialised
[boot] Nest application created (module graph constructed)
[boot] HTTP layer configured (global prefix, pipes, security headers, CORS, Swagger)
[boot] dependencies verified (Postgres, Redis)
[boot] calling KMS DescribeKey...
[boot] KMS DescribeKey answered in <tens of milliseconds>: arn:aws:kms:<region>:…:key/… (<KeyState>)
[boot] modules initialised (every onModuleInit resolved)
[boot] listening on port <PORT>
```

The KMS pair sits between the dependency check and `modules initialised` because the probe is an
`onModuleInit`, and `app.init()` is what invokes those. Read the list as a diagnosis: **the last
marker that appears names the stage that completed**, so the one that should have followed names the
call that never returned. The lines go through a synchronous `writeSync(2, …)` rather than
`console`, for a reason worth knowing while reading them — under Render both streams are pipes, and
`process.exit()` does not wait for an asynchronous write, so a boot that died before Nest's first
line would otherwise leave an empty log.

This is the check that a local run *cannot* make. Locally the probe always fails, and correctly so:

```text
[boot] KMS DescribeKey failed after ~1000ms — KeyCustodyUnavailableError: … UnrecognizedClientException
```

On staging the expected line is the answered one. Two readings are available from it:

- **The elapsed time says which kind of answer it was.** Tens of milliseconds is a real answer from
  KMS — and therefore a rejection of the key, the region or its state if anything is wrong. Around
  `KMS_PROBE_TIMEOUT_MS` is the cap being hit, which means the endpoint was unreachable rather than
  wrong.
- **A key reference that cannot work aborts the boot in production**, while an unreachable KMS is
  only logged (the Step 3 rule: a missing dependency must not put the instance into a restart loop —
  custody fails closed regardless). So a `NotFoundException`-shaped failure is expected to end the
  log before `listening on port`: the instance never answers `healthCheckPath`, and the deploy fails
  with the previous version still serving. That is the desired outcome for a bad key, not a bug.

**4. The migration, in the same log.** The start command is
`./node_modules/.bin/prisma migrate deploy && exec node dist/main.js`, so the deploy log also carries
`prisma`'s own output ahead of `[boot] bootstrap entered`. On a first deploy that is the ten
migrations; on every wake from sleep it is `No pending migrations to apply`. Either way it has to
exit 0, or the app never starts.

### 3.2 The flow

One call per step, with the answer that makes it a pass. Read the **status** first and the body
second: the status is the contract, and a right body behind a wrong status is still a finding.

**5. Register.**

```bash
curl -sS -X POST "$BASE/v1/auth/register" -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"024 123 4567","pin":"1234"}' | jq
```

→ `201` `{ userId, phoneNumber, status: "PENDING_VERIFICATION", expiresAt, codeLength: 6 }`

The number goes in however the user typed it and is normalized to strict E.164 before it reaches a
query or a write, so the `phoneNumber` in the answer is the canonical spelling — that is the
response's job, and it is how this run learns the form the rest of it uses. `pin` is required at
registration (Step 34a), exactly four numeric digits, hashed before it is stored and returned by no
endpoint. The plaintext code is never stored and never logged: it exists only in the SMS, which is
why a real phone is on the prerequisites list. A `409` means the number is already `ACTIVE` — use
another number, or sign in with this one.

**6. Verify the number — the call that provisions the wallet.**

```bash
curl -sS -X POST "$BASE/v1/auth/otp/verify" -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"<E.164 from step 5>","code":"<the 6 digits from the SMS>"}' | jq
```

→ `200` `{ userId, phoneNumber, status: "ACTIVE", phoneVerifiedAt, accessToken, accessTokenExpiresAt, refreshToken, refreshExpiresAt }`

The token pair comes back from **this** call rather than from a separate sign-in, and that is a
deliberate design choice worth noting while smoke-testing: verification is the moment the account
becomes usable, and the alternative is asking a user who has just proved their number for a *second*
code — another SMS at real cost, to answer a question the first one already answered. So `$TOKEN` for
every step that needs a bearer header comes from here (or from `POST /v1/auth/login` on a later
launch, when no such code has just been spent).

Verification is also the provisioning trigger: this call reaches KMS, funds the account on Testnet
and adds the USDC trustline. It is therefore the first place a wrong `AWS_KMS_KEY_ID` shows itself —
and it shows itself *here*, at a request, rather than at boot, when the key is unreachable rather
than unusable. A wrong code is a `400` carrying the attempts left, the fifth is a `429`, and a `503`
means nothing was sent (Redis failed closed, or the provider refused).

**7. The wallet.**

```bash
curl -sS "$BASE/v1/wallet/account" -H "Authorization: Bearer $TOKEN" | jq
curl -sS "$BASE/v1/wallet/balance" -H "Authorization: Bearer $TOKEN" | jq
```

→ `200` `{ accountId, publicKey, network: "TESTNET", createdAt, funded, nativeBalance }`
→ `200` `{ asset: { code: "USDC", issuer: "GBBD47IF…" }, balance, trustline, funded }`

A real `publicKey` with `funded: true` is the proof that provisioning reached the ledger rather than
only the database. On `trustline`, the three values mean three different wallets: `"active"` with
`balance: "0.0000000"` is an empty wallet (**see 3.0(c) — fund it before step 11**), `"missing"` is
one that cannot be paid at all, and `"unauthorized"` is one whose USDC line the issuer has not
approved. A `404` here means provisioning did not get as far as writing the account row; a `503`
means Horizon did not answer, and says nothing about the wallet.

**8. Attach and confirm an email address.**

```bash
curl -sS -X POST "$BASE/v1/auth/email" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"email":"smoke@example.com"}' | jq
# read the 6-digit code from the mailbox, then:
curl -sS -X POST "$BASE/v1/auth/email/verify" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"<the code>"}' | jq
```

→ `200` `{ email, codeLength: 6, expiresAt }` then `200` `{ email, emailVerifiedAt }`

This is the first time the email seam carries a real message: the binding is `ResendEmailSender`, so this
step sends through Resend rather than through a sender that refuses. That matters to the run: until a
sending domain is verified in the Resend dashboard the sender is Resend's shared test address
(`onboarding@resend.dev`, the `DEFAULT_EMAIL_FROM`), which **delivers only to the mailbox the Resend
account itself is registered under** — put that address in place of `smoke@example.com` above, or the
attach is answered with Resend's own `403` ("you can only send testing emails to your own address")
rather than a code. Neither answer echoes the code — an echoed code is a code anyone who can read one log
line has. Attached is not verified:
`emailVerifiedAt` is null until the code comes back, and only a verified address is a delivery target
for a receipt. A wrong code is a `400` counting down, the fifth is a `429`, and a `409` means another
account has already verified that address.

**9. Find somebody to pay — which takes a second account.**

`recipients/search` never returns the caller, deliberately ("offering yourself in it would be noise"),
and `PaymentsService` refuses a self-payment outright (`assertNotSelf`). So this step needs a **second
registered and verified account** — steps 5 and 6 again, on a different phone that can receive an SMS
(this run registered `024 123 4567` as the sender, so `024 122 2333` here):

```bash
curl -sS -X POST "$BASE/v1/auth/register" -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"024 122 2333","pin":"4321"}' | jq
curl -sS -X POST "$BASE/v1/auth/otp/verify" -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"+233241222333","code":"<the 6 digits from the SMS>"}' | jq
```

Its token pair is discarded on purpose: `$TOKEN` stays the sender's for every step that follows.

That second verification is also what makes the recipient payable, and it is worth seeing why: it runs
provisioning, so the account gets funded and trusted exactly as the sender's did — and a trustline is
the right to *receive* the asset, so **nothing has to be funded on that side**. The sender is the only
wallet that needs USDC (3.0(c)).

Then search, from the sender's token:

```bash
curl -sS "$BASE/v1/recipients/search?q=0241222333" -H "Authorization: Bearer $TOKEN" | jq
curl -sS "$BASE/v1/recipients/<id from the search>" -H "Authorization: Bearer $TOKEN" | jq
```

→ `200` `{ matchedBy: "phone" | "handle", results: [{ id, handle, displayName }], hasMore }`

`q` is read as a phone number first and a handle prefix second, which is why `matchedBy` is in the
answer: an empty `results` means "that number is not on Cashping" or "no handle starts with that",
and those are different things to tell a user. A number is matched **exactly** and returns at most
one account; a handle is matched by prefix. No phone number is ever returned by this endpoint — a
directory lookup does not hand out numbers — so the client renders the number it typed itself. This
is the most enumerable route in the API, so lookups are capped per caller: a `429` is the allowance,
not a fault.

**10. Prove the PIN — the step-up call.**

```bash
curl -sS -X POST "$BASE/v1/auth/pin/verify" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"pin":"1234"}' | jq
```

→ `200` `{ stepUpToken, stepUpTokenExpiresAt }`

A step-up token is deliberately not a session: it is a second, narrower credential saying "the PIN
was proved seconds ago". It expires in minutes rather than days and cannot renew itself — the way to
get another is to prove the PIN again. It is what `POST /v1/payments` demands, and without it the
payment is refused with a `403` whose message names the header, audited as `auth.pin.failed` with
outcome `denied`. That outcome is doing real work: `denied` means "somebody tried to pay without
their PIN" while `failed` means "somebody is working through the ten thousand PINs", and those are
different findings. Note that there is no "set a PIN" step in this run — Step 34a made the PIN
mandatory at registration — which is one of the things 3.4 flags as about to change.

**11. Create the payment.**

```bash
curl -sS -X POST "$BASE/v1/payments" \
  -H "Authorization: Bearer $TOKEN" -H "x-step-up-token: $STEP_UP" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"recipientId":"<id confirmed in step 9>","amount":"1.25"}' | jq
```

→ `202` `{ id, status: "PENDING", amount: "1.25", recipientId, createdAt }`

Three things in this one call are worth checking deliberately rather than incidentally:

- **`amount` is a string.** Sending `1.25` as a JSON number is a `400` naming the field, because the
  alternative is accepting whatever the client's formatter produced — which is how a seventh decimal
  disappears. A body carrying a `total` (or any undeclared field) is refused rather than ignored.
- **The `amount` in the answer is re-read from the row**, not echoed from the request, so the response
  proves the round trip through the `numeric(20,7)` column.
- **Send the same `Idempotency-Key` twice.** The second call must not write a second payment.

`202` is the honest split: a `PENDING` row exists and the amount is reserved against the sender, and
nothing has been offered to Stellar yet. A `409` whose message carries an available figure means the
sender's balance — see 3.0(c). The amount here is **1.25 against the faucet's 20**, so a `409` on this
step is a funding problem and never a ceiling problem; raising the amount past what the wallet holds
produces the same `409`, and a second faucet request is two hours away.

**12. Poll to a verdict.**

```bash
curl -sS "$BASE/v1/payments/$ID" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.status,.stellarTxHash,.failureReason'
```

`PENDING` → `PROCESSING` → `SUCCESSFUL` or `FAILED`, and the last two are final. This is the step
that exercises the queue for real: the BullMQ submission worker and the confirmation sweep run
*inside this process*, and a free instance runs nothing while it sleeps — so a queued submission
waits for the request that wakes it. Poll with the service warm (`/v1/health` between polls is
enough to keep it awake). `stellarTxHash` is the hash to paste into a Testnet explorer;
`failureReason` is a raw machine code, and `landed-unsuccessful:…` is the ledger having an opinion
rather than a bug in the deployment.

**13. The receipt, over both channels.** On `SUCCESSFUL` the settlement texts the sender — and,
because the address is verified, emails them as well: one template, two transports, the same string.
Check the mailbox. Filter by subject, because the verification code from step 8 arrived at the same
address and is a different message.

**14. History.**

```bash
curl -sS "$BASE/v1/payments?direction=sent&status=SUCCESSFUL&limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq
```

→ `200` `{ items: [{ id, status, amount, direction, recipientId, createdAt }], hasMore }`

The scope is not a parameter: `direction` chooses which side of *the caller's own* payments to read
and can never widen that. `failureReason` and `stellarTxHash` are absent here on purpose — this DTO
carries the fields a list sorts and renders. `limit` is clamped rather than refused (`limit=1000` is
answered, not rejected), and an empty `items` is an ordinary answer, not a `404`.

**15. The session.**

```bash
curl -sS "$BASE/v1/auth/session" -H "Authorization: Bearer $TOKEN" | jq
```

→ `200` `{ userId, phoneNumber, status, handle }`, with `handle` as claimed at registration or `null`.

### 3.3 What to record

Fill this in as the run goes. It is not bookkeeping: the second pass in 3.4 is only a comparison if
these answers exist.

| Step | Expected | Observed | Notes |
| --- | --- | --- | --- |
| 3.1.3 boot markers | all ten, KMS **answered** | | paste the KMS line and its elapsed ms |
| 3.1.4 migration | `migrate deploy` exit 0 | | first deploy vs wake-from-sleep |
| 1–2 health, docs | `200`, `200` | | timings, warm vs cold |
| 5 register | `201` | | the normalized `phoneNumber` |
| 6 verify | `200`, token pair | | did provisioning succeed here? |
| 7 wallet | `funded: true`, `trustline: "active"` | | record `publicKey` |
| 8 email | `200`, then `200` | | did the real email arrive? |
| 9 second account + search | `200`; `matchedBy: "phone"`, one result | | the recipient's id, and that its `verify` provisioned a wallet too |
| 10 step-up | `200` | | |
| 11 payment | `202`, `PENDING` | | and the same-key replay |
| 12 poll | `SUCCESSFUL` | | `stellarTxHash`, and how long it took |
| 13 receipt | email **and** SMS | | |
| 14 history | the payment, `direction: "sent"` | | |
| 15 session | `200` | | |

### 3.4 Before the next pass: registration and sign-in are being reworked

**This section is a baseline, and it is about to become a stale one — run it now anyway.**

Registration and the login endpoints are changing: a **password** field is being added, distinct from
the four-digit transaction PIN, and **PIN-setting is moving later in the flow** (it is mandatory at
registration today, per 34a). That rework changes the exact request shapes this document exercises —
at minimum steps 5, 6, 10 and 11, since the register body gains a field, the PIN becomes a later
step, and the step-up call may be reached from a screen rather than immediately after verification.

Running Section 3 *now* is still worth doing, and not only to fill the table in: it is the first
execution of the deployment itself — the Blueprint sync, the migration in the start command, the KMS
probe answering for the first time, the real Africa's Talking call, the real email, the queue on a
free instance. Those are proven or refuted independently of which fields this flow happens to carry,
and a later shape change does not un-prove them.

So run it as the **deployment baseline**, and expect a **second, shorter pass** over the changed
steps once the password/PIN rework lands — steps 5, 6, 10 and 11 at minimum, with the rest re-run
only if the change touches token or session handling. The observed column in 3.3 is what makes that
second run a comparison rather than a fresh start.

