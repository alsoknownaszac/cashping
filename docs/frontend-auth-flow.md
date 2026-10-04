# Frontend flow: register, add an email, sign in

The client-side companion to Steps 10–34c. It answers three questions in the order the app
asks them: what *can* a client do today, what does each call return and refuse, and what
should the screen do with the answer.

**It is written against the code, not against the plan.** Every body, status code and rule
below was read out of `src/identity/auth.controller.ts` and `src/identity/auth.service.ts`
at Step 34c, and every path the frontend will hit has an e2e test behind it
(`test/auth.e2e-spec.ts`, `test/password.e2e-spec.ts`, `test/pin.e2e-spec.ts`,
`test/audit.e2e-spec.ts`).

**One thing this file deliberately does not describe: registering *with* an email.** There is
no such endpoint at Step 34c — `POST /v1/auth/register` takes `phoneNumber`, an optional `pin`
and an optional `handle`, and nothing else. (`pin` was required at Step 34c and is optional
now; section 1's table and Flow 1 below state the contract as it is today.) What exists is an
email as a *sign-in identifier on an account that already signed up with a number*. Section 7
drafts the email-first signup as a proposal and says plainly what has to be built before a
screen can rely on it; do not code against it in the meantime.

---

## 1. What exists today

Every route below is under the global `/v1` prefix (`GLOBAL_PREFIX`), so the URLs the client
calls are `…/v1/auth/...`. The interactive docs carry the same prefixed paths at `/api/docs`
(enabled outside production — see the README's *API docs and CORS*).

| Method & path | Body | Auth | Answer |
| --- | --- | --- | --- |
| `POST /v1/auth/register` | `{ phoneNumber, pin?, handle? }` | — | `201` `{ userId, phoneNumber, status: PENDING_VERIFICATION, expiresAt, codeLength, handle }` |
| `POST /v1/auth/otp/verify` | `{ phoneNumber, code }` | — | `200` `{ accessToken, accessTokenExpiresAt, refreshToken, refreshExpiresAt, userId, phoneNumber, status: ACTIVE, phoneVerifiedAt }` |
| `POST /v1/auth/login/otp` | `{ phoneNumber }` | — | `200` `{ phoneNumber, expiresAt, codeLength }` |
| `POST /v1/auth/login` | `{ phoneNumber, code }` | — | `200` token pair + `{ userId, phoneNumber, status, handle }` |
| `POST /v1/auth/login/password` | `{ phoneNumber \| email, password }` | — | `200` token pair + `{ userId, phoneNumber, status, handle }` |
| `POST /v1/auth/password/change` | `{ password }` or `{ currentPassword, password }` | Bearer | `200` `{ passwordSetAt }` |
| `POST /v1/auth/password/reset` | `{ phoneNumber }` | — | `202` `{ phoneNumber, expiresAt, codeLength }` |
| `POST /v1/auth/password/reset/confirm` | `{ phoneNumber, code, newPassword }` | — | `200` `{ passwordSetAt }` |
| `POST /v1/auth/email` | `{ email }` | Bearer | `200` `{ email, expiresAt, codeLength }` |
| `POST /v1/auth/email/verify` | `{ code }` | Bearer | `200` `{ email, emailVerifiedAt }` |
| `POST /v1/auth/pin/change` | `{ pin }` or `{ currentPin, pin }` | Bearer | `200` `{ transactionPinSetAt }` |
| `POST /v1/auth/pin/verify` | `{ pin }` | Bearer | `200` `{ stepUpToken, expiresAt }` |
| `POST /v1/auth/refresh` | `{ refreshToken }` | — | `200` token pair (rotated) |
| `POST /v1/auth/logout` | `{ refreshToken }` | — | `204`, no body |
| `GET /v1/auth/session` | — | Bearer | `200` `{ userId, phoneNumber, status, handle }` |

There is **no** `POST /v1/auth/google` yet (Step 34d, not built), and **no** email-code sign-in:
codes are only ever texted to a number. `POST /v1/auth/login/password` is the only route that
accepts an email.

## 2. Conventions every screen inherits

**Base URL.** `{API_URL}/v1`. The OpenAPI document is at `{API_URL}/api/docs-json` if the
client is generated rather than hand-written; the prefix is in both, so a generated client
needs no path rewriting.

**CORS.** The browser is only allowed to call from an origin on `CORS_ALLOWED_ORIGINS`
(default `http://localhost:3000` and `http://localhost:5173`). There is no wildcard mode, so a
new deployed frontend origin has to be added server-side — an origin that is missing gets a
response with no `Access-Control-Allow-Origin` header, which the browser reports as a CORS
error carrying no status code. That is a deployment task, not a client bug.

**Errors are one shape, everywhere.**

```json
{ "statusCode": 400, "error": "Bad Request", "message": "…", "path": "/v1/auth/email", "timestamp": "2026-10-03T10:04:12.345Z" }
```

`message` is the sentence to show. It is a *string* for every refusal the services write, and a
**string array** when the global validation pipe refused the body (one entry per broken field —
the PIN's shape, the code's length, a missing `password`). Render it either way, and never
pattern-match on the wording: several endpoints answer "wrong code" and "that code has expired"
with different words on purpose.

**Tokens.**

- `accessToken` — a JWT for `Authorization: Bearer <token>`, good for 15 minutes
  (`ACCESS_TOKEN_TTL_MINUTES`). Never decode it for user data: `GET /auth/session` is the answer
  to "who am I", and it reads the row as it is *now*, not as it was when the token was signed.
- `refreshToken` — opaque, single-use, rotated on every refresh, good for 30 days
  (`REFRESH_TOKEN_TTL_DAYS`). Store it in the platform's secret store (Keychain / Keystore) —
  not in `localStorage`, not in `AsyncStorage`.
- `accessTokenExpiresAt` / `refreshExpiresAt` — ISO-8601 strings, so a client can refresh on a
  timer instead of discovering the expiry as a 401.

Three obligations follow, and they are obligations rather than advice:

1. Store the *new* `refreshToken` from every refresh response; the old one is dead the moment
   the new one is issued.
2. Never refresh twice in parallel with the same token. Rotation makes the loser of that race
   look exactly like a stolen token being replayed — and the server's answer to a replay is to
   revoke the whole token family, i.e. every session for that user. One refresh at a time,
   behind a single in-flight promise.
3. On `401` from an authenticated call: refresh once, retry once; if the refresh itself is
   `401`, clear the stored tokens and go to the sign-in screen. A `403` is not that — it means
   the account is `SUSPENDED`, so end the session and show the support copy rather than
   retrying. `POST /auth/logout` answers `204` even for a token it does not recognise, so a
   local sign-out never fails.

**Rate limits are answers, not failures.** `429` messages carry the wait ("try again in N
minutes", computed from the counter's own TTL), and `503` means a dependency (SMS, email, or
Redis) could not be reached — nothing was sent, and "try again in a moment" is the right copy.
Neither should be rendered as a generic "something went wrong".

## 3. Flow 1 — Create an account (phone first)

Four screens, of which three call the API. This is the only account-creation path that exists
today; section 7 is the draft of the other one.

```
[Number + PIN?]  --register-->  [Code sent]  --otp/verify-->  signed in  -->  [Add email]  -->  [Set a password]
```

**Step 1 — `POST /v1/auth/register` `{ phoneNumber, pin?, handle? }`**

- `phoneNumber` is the *raw* submission (`024 123 4567`), not E.164: the server normalizes it
  against `PHONE_DEFAULT_REGION` (default `GH`) and stores strict E.164. So the field accepts
  what the user types, and the response's `phoneNumber` is what to display afterwards.
- `pin` is optional. When it is sent it is exactly four digits — `^\d{4}$`. It is the credential
  every payment is proved against, so collecting it here is what spares the user a later screen —
  but an account can be created without one: it is then simply not payable until a PIN is set,
  and `POST /v1/auth/pin/change` installs one with no `currentPin`. When it is sent, collect it
  with a confirm field and send it once.
- `handle` is optional, `a-z0-9_`, 3–32 characters, `@` accepted on input, stored lower-cased.
- `201` comes back with `status: 'PENDING_VERIFICATION'`, `expiresAt` (10 minutes,
  `OTP_TTL_MINUTES`) and `codeLength` (6, `OTP_CODE_LENGTH`). **The code is not in the
  response** — the SMS is its only route to the user — so the code screen is entered with
  `codeLength` inputs and a countdown to `expiresAt`.

| Answer | Meaning, and the screen's move |
| --- | --- |
| `201` | Go to the code screen. A *resend* is the same call, not a different one: the pending row is reused and the previous code is invalidated. |
| `400` | Bad number or bad PIN shape. `message` is a string array naming the field. |
| `409` | The number is already `ACTIVE`. Show "you already have an account — sign in" and route to Flow 3. |
| `403` | The number is `SUSPENDED`. Show the support copy; there is no client-side recovery. |
| `429` | Over the send allowance (3 requests per 15 minutes per number, `OTP_REQUESTS_PER_WINDOW` / `OTP_REQUEST_WINDOW_MINUTES`). Disable resend and show the wait from `message`. |
| `503` | No SMS was sent (provider or the request counter unreachable). Keep the user on the form. |

The send allowance is counted **only when a message really went out**, so retrying after a
`503` does not cost the user a request.

**Step 2 — `POST /v1/auth/otp/verify` `{ phoneNumber, code }`**

The same raw-format `phoneNumber` as step 1, and the code the user typed.

- Success is `200` **with a token pair already attached** plus `phoneVerifiedAt`. Verification
  *is* the sign-in: there is no second code to enter on a fresh account, which is the whole
  point of returning the session here. Store the tokens and go to whatever the account still
  needs (Flow 2 is optional; the PIN was set in step 1, or was skipped there and is still owed
  before the account can pay).
- `400` — wrong code (`message` says how many attempts are left; 5 per code, `OTP_MAX_ATTEMPTS`)
  or expired (the code is consumed, so "resend" is the only move). Same status on purpose:
  render `message`, do not discriminate on the wording.
- `429` — the code's attempts are spent. Request a new one.
- `404` — no account for that number: the user is in the wrong flow, send them to step 1.
- `409` — the account is already verified. Treat as "signed in already" and route to Flow 3.

**Step 3 (optional, recommended) — set a password, in settings.** See section 6. A password is
what makes sign-in stop depending on an SMS arriving, and it is what makes Flow 4 work.

## 4. Flow 2 — Add and verify an email on a signed-in account

This is Step 34c, and it is the reason a user can later sign in with an email. Both calls need
the access token, so the account must already be signed in — there is no anonymous
"email verification" route, deliberately: the address is attached to an *account*, not to a
session being created.

```
[Settings: email]  --POST /auth/email-->  [6-digit code]  --POST /auth/email/verify-->  "Email confirmed"
```

**Step 1 — `POST /v1/auth/email` `{ email }` → `200 { email, expiresAt, codeLength }`**

- The address is normalized (trimmed, lower-cased) before it is stored, and the response's
  `email` is the **stored** form. Show that back ("we sent a code to miriam@example.com"),
  never the raw input, so a user who typed `Miriam@Example.com` sees what was recorded.
- Attaching again **replaces** the address and clears its confirmation. That is what makes a
  typo recoverable: an address stops being an identifier the moment it is replaced, so a
  mistyped mailbox can never keep receiving receipts.
- `codeLength` and `expiresAt` drive the code screen — the same 6 digits and 10 minutes as the
  SMS code, because it *is* the same OTP machinery with a different destination.

| Answer | Screen's move |
| --- | --- |
| `200` | Go to the code screen; render `codeLength` inputs and a countdown to `expiresAt`. |
| `400` | Malformed address. `message` names the rule that broke, and for a too-long one it quotes the ceiling. |
| `401` | Refresh, retry once, then sign in again. |
| `403` | Account suspended: end the session. |
| `409` | Another account holds that address. Offer "use a different address", or better, "sign in with that email instead". |
| `503` | The email was not sent. Stay on the form; retrying is safe and costs nothing. |

**Step 2 — `POST /v1/auth/email/verify` `{ code }` → `200 { email, emailVerifiedAt }`**

- Only the code is sent. The address is already on the account, so re-submitting it would be a
  second source of truth for what is being verified.
- `200` means mail may now be sent to that address, and — from this moment — **the address also
  works as the identifier on the password sign-in** (Flow 3). Show `emailVerifiedAt` from the
  response rather than from what the client believes it attached.
- `400` — wrong or expired code, with the attempts left in `message`. Only a well-formed code
  that does not match spends an attempt, so a fat-fingered paste does not cost the user one.
- `409` — two account-shaped refusals share the status and differ in the message: *nothing is
  attached yet* (send the user back to step 1) and *already confirmed* (nothing to do — treat as
  success and move on).
- `429` — the code's attempts are spent; call step 1 again with the same address for a fresh code.
- Resend is **step 1 again**, not a separate endpoint.

**A gap the client has to work around.** No route reports the attached or verified email:
`GET /v1/auth/session` answers `userId`, `phoneNumber`, `status` and `handle` only. So the
settings screen keeps the state it just wrote or confirmed, and treats `409` "already verified"
as "this is done" on a later visit. The clean fix is server-side — put `email` and
`emailVerifiedAt` on the session response — and it is recorded in section 8 rather than patched
around in the client with a call whose only way to answer is to fail.

## 5. Flow 3 — Sign in

Three combinations work today, and one is missing:

| Identifier | Factor | Calls |
| --- | --- | --- |
| Phone number | SMS code | `POST /v1/auth/login/otp { phoneNumber }`, then `POST /v1/auth/login { phoneNumber, code }` |
| Phone number | Password | `POST /v1/auth/login/password { phoneNumber, password }` |
| **Verified email** | Password | `POST /v1/auth/login/password { email, password }` |
| Email | SMS code | **Does not exist.** Codes are only ever texted to a number. |

**One screen, one identifier field.** Send `email` when the input contains `@`, `phoneNumber`
otherwise, and never both: sending both is a `400` ("Send either phoneNumber or email, not
both."), refused before any lookup, limiter or audit write. Both are accepted in the user's own
format — `024 123 4567` and `Miriam@Example.com` both work, because the server normalizes
before it looks anything up, and the address is matched against the *stored* lower-cased value.

**The factor is the user's choice, not something the client can look up.** Nothing reports
whether an account has a password, so the screen must offer both ("text me a code" / "use my
password") rather than deciding for the user. A `401` from the password path deliberately does
not say which of *no account*, *no password set*, *wrong password*, *address never verified* or
*account not active* happened — one message for all five, so the client shows one thing: "check
your details and try again".

`POST /v1/auth/login/password` answers:

| Answer | Meaning, and the screen's move |
| --- | --- |
| `200` | Token pair + `{ userId, phoneNumber, status, handle }`. `phoneNumber` is the account's own number, so an email sign-in still fills the profile. |
| `400` | Both identifiers, neither, or a malformed one. `message` names it. |
| `401` | Any of the five cases above. Clear the password field; never branch on the message. |
| `403` | The account is suspended. Checked *before* the password is read, so this answer does not depend on the password being right. |
| `429` | The identifier's attempt allowance is spent. The counter is the OTP limiter's, keyed on the normalized identifier — a number and an address on one account have an allowance **each**, 3 per 15 minutes. `message` carries the wait. |
| `503` | The counter itself was unreachable. Nothing was checked; retry shortly. |

A refused password login also writes an audit row (`auth.password.login`, outcome `denied`), so
the 429/401 split is the *only* thing the user sees and support can see the rest.

The code path (`login/otp` → `login`) is the same two-step as registration's, with different
answers up front, and the client should map them to different screens:

| Answer | From `login/otp` | Screen's move |
| --- | --- | --- |
| `200` `{ phoneNumber, expiresAt, codeLength }` | code sent | Show the code screen. Calling again is a resend and invalidates the previous code. |
| `404` | no account for that number | Route to Flow 1 (registration). The server chose 404 over a silent 200 precisely so nobody waits for an SMS that is not coming. |
| `409` | account exists but is `PENDING_VERIFICATION` | Send the user back to finish registration (Flow 1), which reuses the pending row. |
| `403` | suspended | Support copy. |
| `429` / `503` | allowance spent / SMS not sent | Show the wait, or "try again in a moment". |

`POST /v1/auth/login` itself spends the code and answers `200` with the token pair and profile;
a wrong, expired or already-used code is the same `400`/`429` the OTP verify path gives, and its
message is the copy to show.

**After any successful sign-in**, call `GET /v1/auth/session` with the access token to hydrate
the profile the app will render — the sign-in responses carry enough to get started, and the
session call is the one that reflects later changes (a handle set on another device, for
instance).

## 6. Flow 4 — Password: set, change, forget

**Set or change — `POST /v1/auth/password/change` (Bearer).** Send `{ password }` when the
account has none, `{ currentPassword, password }` to change one. The password must be at least
8 characters (`PASSWORD_MIN_LENGTH`) and at most 128 (`PASSWORD_MAX_LENGTH`); the floor is
checked at the door, so a too-short one is a `400` that never reaches the hasher. The response
is `{ passwordSetAt }` — no password, no hash.

| Answer | Meaning, and the screen's move |
| --- | --- |
| `200` | `passwordSetAt` is when the password now in force was written. Show "saved". |
| `400` | Too short, too long, or missing `password`. `message` is the array to render. |
| `401` | Refresh, retry, then sign in again. |
| `409` | *"This account already has a password. Send currentPassword to change it."* — i.e. the form was in "set" mode and the account has one. Switch it to "change" mode and re-submit. |
| `409` | *"That current password is not correct."* — a `409` rather than a `401` on purpose: the caller is authenticated, and this is a statement about the account's state, not about who they are. |

That first `409` is also the **only** way a client can learn whether a password exists: nothing
in `GET /auth/session` says so. So a settings screen that wants to render "Set a password" vs
"Change password" either remembers what it wrote, or probes by submitting `{ password }` and
reading the `409` — the same discovery shape the PIN endpoints use (`POST /auth/pin/change`
without `currentPin` on an account that has one answers `409`, and `not_set` is its own `409`).

**Forgot it — `POST /v1/auth/password/reset { phoneNumber }` → `202`.** This is the recovery
path, and it is deliberately **not an oracle**: a number with an account and a number without
one get byte-identical `202 { phoneNumber, expiresAt, codeLength }` responses, and only the
account that exists pays for an SMS. The screen's copy must match that behaviour — *"If that
number has an account, we've texted a code"* — because claiming "code sent" would be a lie half
the time and claiming "no account" would leak which numbers are registered.

**Finish it — `POST /v1/auth/password/reset/confirm { phoneNumber, code, newPassword }` → `200
{ passwordSetAt }`.** The code is the same OTP a sign-in uses (6 digits, 10 minutes, 5 attempts,
spent on use):

- `400` — wrong or expired code, a spent one, a `newPassword` under 8 characters, or a number
  with no code outstanding (`202` was answered before, so there is nothing to confirm).
- `429` — the code's attempts are spent; request a new one.
- `403` — suspended.

Resetting does not sign the user in: after a successful reset, send them to Flow 3 with the new
password. It also does not end any session that was already live — neither the change nor the
reset retires outstanding refresh tokens (`TokenService.revokeAllForUser` is called only when a
replayed token is detected), so "sign out everywhere" is a separate feature with a separate
route, and it does not exist yet.

**Not available: resetting *by* email.** `reset` takes `phoneNumber` only, so a user who has
lost both the password and access to the SIM has no self-service route today — see section 8.

## 7. Draft — registering *with* an email (not implemented)

**Status: proposal. Nothing below exists at Step 34c.** `POST /v1/auth/register` accepts
`phoneNumber`, an optional `pin` and an optional `handle`; `POST /v1/auth/otp/verify` accepts
`{ phoneNumber, code }`; the account's activation is about the number, and `emailVerifiedAt` is
set only by Flow 2 or (when 34d lands) by Google. A client built against this section before the
server changes will fail at its first call, so build Flow 1 + Flow 2 + Flow 3 now and treat this
as the spec to align on.

### 7.1 The two shapes "register with email" can take

**Variant A — an email is enough to sign up (an account with no phone).** The user proves
control of a mailbox, and the phone becomes something they add later, before money moves.
This is the reading a user has when they ask for it, and it is the larger change:

1. `RegisterDto` gains `email` beside `phoneNumber`, and *exactly one* of the two is required —
   the same rule `signInIdentifier` already enforces on sign-in, so the refusal ("Send either
   phoneNumber or email, not both.") and its status are already decided in one place.
2. Registration sends the code to the address (`NotificationsService.sendEmailVerification`)
   instead of by SMS, and the `201` says which channel was used — a `verificationChannel:
   'email' | 'sms'` field, because the code screen's copy ("check your inbox" vs "check your
   messages") is not something the client can infer.
3. Verification takes the same identifier the registration did. The cleanest route is a
   channel-neutral body (`{ identifier, code }`) or an added `email` field; a *renamed* body is a
   breaking change for clients already in the field, so it is a versioning decision rather than
   a naming one.
4. `emailVerifiedAt` becomes what `phoneVerifiedAt` is today: the field that makes the account
   `ACTIVE` and triggers wallet provisioning. **This is the load-bearing decision** — today
   `phoneNumber` is required on `User` and is what everything downstream keys on, so an
   email-first account needs either an optional `phoneNumber` with every reader taught about the
   null (which 34d's plan already anticipates for Google accounts), or a phone that arrives in
   the same transaction.
5. A way to attach and verify a phone later — `POST /auth/phone` + `POST /auth/phone/verify`.
   34d's spec says a Google-only account "is not payable until it adds and verifies a phone", so
   that endpoint is coming for 34d regardless; variant A must not be built without it, or the
   account can sign in and never receive money.
6. One uniqueness question to settle first: `users.email` is already `@unique`, so an address
   that another account has *attached but not verified* still collides. The honest answers are
   a `409` (and "sign in with that address instead" in the client) or a takeover rule; there is
   no third option that is not a security bug.

**Variant B — an optional email and a choice of channel at signup.** `register` gains an
optional `email` and a `verifyBy: 'sms' | 'email'`, and the code goes wherever the user chose.
This is the smaller change and it is genuinely useful (no SMS cost for users who prefer email),
and it is worth being explicit that it does **not** satisfy "register with email": the account
is still created against a number, so a user with no phone still cannot sign up. It is also not
a step towards variant A on its own — it shares the delivery seam and nothing else.

### 7.2 The frontend flow variant A would unlock

```
[Email + PIN]  --register-->  [Inbox code]  --otp/verify-->  signed in, nextStep: 'ADD_PHONE'
      -->  [Add a phone]  --phone + verify-->  payable  -->  later: sign in with email + password
```

| Step | Call | Screen |
| --- | --- | --- |
| 1 | `POST /v1/auth/register { email, pin, handle? }` | One identifier field that accepts an email or a number, the 4-digit PIN, and a confirm. |
| 2 | `POST /v1/auth/otp/verify { email, code }` | The same code screen as Flow 1 with email copy, `codeLength` inputs and a countdown to `expiresAt`. The response is the token pair, so this is also the sign-in. |
| 3 | `POST /v1/auth/phone` then `/auth/phone/verify` | "Add your number to send and receive money" — skippable, and the account is not payable until it is done. |
| 4 | `POST /v1/auth/login/password { email, password }` | Flow 3 unchanged: the user may sign in with the address from the moment it is verified. |

Two things that flow should do **now**, before the endpoints exist, because they are cheap and
they are what makes the later change a drop-in: route on the `nextStep` field when a response
carries one (34d's spec already plans `nextStep: 'SET_PIN'` for a Google sign-up) rather than
hard-coding "signup is followed by the email screen"; and keep the identifier field
channel-agnostic — the sign-in screen already is, since it decides between `email` and
`phoneNumber` from the input itself.

## 8. Recorded gaps and open questions

Things a frontend engineer will otherwise rediscover, each with the honest state of it:

1. **`GET /auth/session` carries no email state.** The settings screen cannot read back
   "attached", "verified" or the address itself, so it has to remember what it wrote. The fix is
   small and server-side (`select` the two columns, add `email` and `emailVerifiedAt` to
   `SessionResponseDto`, which the same shape `LoginResponseDto` shares) and it is worth doing
   before the settings screens multiply.
2. **No email code sign-in.** Codes are SMS-only, so a user whose password is unset and whose
   SIM is unavailable cannot get in. Adding it is a channel decision for the OTP endpoints, not
   a client change — and the attempt allowance is already per-identifier, so a second channel
   would not need a second counter.
3. **No email-based password reset.** Same root as (2): `password/reset` takes a number. Until it
   changes, a locked-out user with no SIM goes through support.
4. **Registering with an email does not exist** (section 7) — the one gap behind the
   "register with email" question itself.
5. **Google SSO does not exist yet** (Step 34d). Its response is specified to add a `nextStep`
   field (`'SET_PIN'`) for an account that lands without a PIN, so build the routing on
   `nextStep` now rather than assuming every signup is followed by the email screen.
6. **Nothing reports whether a password or a PIN is set.** For the PIN, `GET /auth/session` will
   need a field the day 34d lands (an account can exist without one). For the password, the
   `409` from `POST /auth/password/change { password }` is the sanctioned discovery path today
   (section 6).
7. **`409` on attach is one bit of information** — "some account holds this address". That is
   deliberate, the same class of answer as registration's `409` for a taken number, and it is
   why there is no "is this email free?" endpoint: an unauthenticated one would be an
   enumeration oracle. The client's answer to that `409` is "sign in with that email instead".

## 9. Running the proofs

Everything above is asserted by tests that can be run again. Counts carry the step they were
measured at.

```bash
# The service's own decisions, including the sign-in identifier rule (Steps 34b, 34c).
npx vitest run src/identity/auth.service.spec.ts      # 61 tests passed as of Step 34c

# The whole unit suite.
npx vitest run                                        # 59 files, 981 tests passed as of Step 34c

# The credential flows over HTTP. Needs the compose stack and a .env:
#   docker compose up -d postgres redis
npm run test:e2e test/password.e2e-spec.ts            # 13 tests passed as of Step 34c
npm run test:e2e test/auth.e2e-spec.ts                # registration, verification, sign-in, session

# The repository's lint gates (oxlint, money discipline, status discipline).
npm run lint                                          # 216 files scanned, 0 violations as of Step 34c
```

`test/password.e2e-spec.ts` is the file that covers this document's Flow 3 and Flow 4 end to
end — sign-in by number and by verified address, an unverified address refused, both
identifiers refused, the per-identifier allowance, and the reset request that answers the same
for a known and an unknown number. It substitutes the three seams that path reaches —
`SMS_SENDER`, the `EMAIL_SENDER` this step added, and `AccountProvisioningService` (no KMS, no
Horizon) — so the passwords, the codes, the counters and the audit rows are real.

---

This file is the client-facing companion to `docs/build-sequence.md` (Steps 34a–34d, Day 6).
Where the two disagree, the build sequence's reasoning wins; where both disagree with the code,
the code wins, and this file is the thing to fix.
