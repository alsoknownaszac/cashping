# Step 27 — Transaction submission job (proposal)

**Status:** approved. The four decisions flagged in the review were approved exactly as written, plus one
addition made during that review: an explicit `commandTimeout` on the queue's Redis connection, shipped in
this step rather than logged as a deferred gap (§7). This document is the durable record of what was agreed;
`docs/build-sequence.md` and the Step 29 docblocks cite it as "the approved proposal". **One name was amended
afterwards:** Step 28's audit of this step's vocabulary renamed the reason a permanent operation code earns
from `submission-rejected:<code>` to `landed-unsuccessful:<code>` (§4, "One vocabulary, amended"). Every
answer this step approved still stands - what changed is what the prefix claims about the ledger.

**Scope:** `PENDING` → `PROCESSING` (and `PROCESSING` → `FAILED` for a definitive no). Submission only —
resolution to `SUCCESSFUL` is Step 28's polling, and the status guard around every write is Step 29's.

---

## 1. The invariant this step has to hold

> **At most one live Stellar transaction per payment, and a payment whose transaction was never built is
> never reported as submitted.**

Everything below is a consequence of that sentence. Two failure modes it exists to prevent:

1. **Double submission** — one payment, two transactions, two debits. The trigger is mundane: a BullMQ
   stalled-job retry, a redeploy mid-flight, an operator re-running a job, a Horizon timeout that did land.
2. **Silent non-submission** — a `PENDING` row with no job on the queue, which looks exactly like a payment
   that is about to be submitted, forever. No retry, no failure, no alarm.

Where the two conflict, this step chooses the loud failure over the silent one.

## 2. The submission flow

### 2.1 Shape (mirrors `src/wallet/provisioning/usdc-trustline.ts`)

```
read the row ──> [PENDING? claim it] ──> fence check ──> openSeed(row)  ──┐
                                                                        │
   withAccount(sender publicKey, session => {                           │
     sequence = session.sequenceNumber                                  │  per-account
     tx = session.build([payment op], { timeoutSeconds })               │  sequence lock
     tx.sign(keypair)                                                   │  (Step 17)
     hash = tx.hash()          // includes signatures: computed *after* signing
     record(hash, sequence, deadline)   // Postgres, before Horizon      │
     stellar.submitTransaction(tx)                                      │
   })                                                                   │
                                                                        │
   outcome ──> triage ──> { accepted | deferred | superseded | retry | failed }
```

- **`openSeed` before `withAccount`.** Unwrapping the seed is a KMS round trip; holding a per-account
  sequence lock across a call to a different service would serialise every transaction for that account
  behind a key fetch. `usdc-trustline.ts:208-224` is the precedent, deliberately followed.
- **The keypair is a stack local.** It is never logged, never serialised, never attached to an error, never
  returned. `JSON.stringify(keypair)` includes the secret seed (recorded in `SeedCustodyService.openSeed`),
  so nothing here hands a keypair to anything that might.
- **`hash()` after `sign()`.** The transaction hash is taken over the signature base, so it is the hash of
  the *signed* envelope — the value Horizon echoes back and the value an operator can paste into an
  explorer.
- **Write-then-send.** The hash, the sequence number and the deadline are committed to Postgres *before*
  `submitTransaction` is called. A crash between the two leaves a row that says "this transaction may
  exist", which is the only reading that is safe to act on.

### 2.2 The fence (approved as proposed)

A rebuild is permitted **only** when both halves hold:

| condition | why |
| --- | --- |
| `now > submission_deadline` | Before it, the recorded transaction is still submittable, so a second one would be a second live transaction for the same payment. |
| `fresh_sequence == recorded_sequence` | A loaded sequence equal to the recorded one means the recorded transaction never consumed it — it never landed. A sequence that has moved *past* it means the recorded transaction landed, so there is nothing to rebuild. |

and the "restore and stop" rule that goes with it:

- **`tx_bad_seq` on a rebuild** (the new transaction was built after the deadline, from a fresh load, and
  Horizon rejected it because a sequence that was still equal has since been consumed) means the
  *previously recorded* transaction landed in the gap. The previous `(hash, sequence, deadline)` is restored
  over the new one and the attempt **stops** — the recorded transaction is the one to poll, and Step 28 is
  what polls it.
- **`tx_bad_seq` with no record** (a first build, no prior hash) is a race with another writer of the same
  sequence, so it is a retry, not a terminal failure.

The fence is what lets a later re-drive (Step 28's poll finding nothing, or an operator re-running the job)
happen *safely*, and it is why this step does not need a "has it landed yet?" query: it never creates the
ambiguity that query would resolve.

## 3. Job identity and idempotency (question 4, answered)

**`jobId = transaction.id`**, the payload is `{ transactionId }`, and the handler is a pure function of the
row: every attempt re-reads the row, and the row's current state decides what happens.

- **The arbiter is a conditional `UPDATE` in Postgres** (compare-and-set on `id` + the status it expects),
  never a Redis key.
- **`jobId` is a courtesy, not the guarantee.** It stops a second job for the same payment from being queued
  while the first still exists. It cannot be the guarantee, because BullMQ forgets a completed job the
  moment its retention policy fires — and the case this step must survive is precisely a re-drive *after*
  that.
- **Step 24's idempotency pair is not reused as the worker mechanism.** It is reused only as the *reason* at
  most one job exists per payment: the client key and its unique index make "one key, one payment" a
  property of the database, so `jobId = transaction.id` and BullMQ's dedupe are enough. The pair itself is
  client-scoped; the worker's question is system-scoped; and Redis is the wrong side of the failure line for
  money when the authoritative state is already a Postgres row.

Per-job options (the queue keeps no `defaultJobOptions`):

| option | value | why |
| --- | --- | --- |
| `attempts` | 3 | A transient Horizon/KMS failure is worth two retries; a permanent one fails fast. |
| `backoff` | exponential, 2s | 2s, 4s — inside the 3-minute transaction window, so a retry is still submittable. |
| `removeOnComplete` / `removeOnFail` | `true` | The row is the durable record and the log line is the incident trail; a lingering job would make a legitimate re-drive a silent no-op. |

## 4. The triage table (a pure function)

`src/payments/services/submission-triage.ts`, DI-free, so every row below is a test and not a hope:

| what happened | decision | the row |
| --- | --- | --- |
| Horizon accepted | `accepted` | keeps its hash; stays `PROCESSING` (accepted is not closed; Step 28 confirms) |
| `SecretEnvelopeError` (with no prior record) | `failed` | `FAILED`, reason `secret-envelope:<reason>` — the stored secret cannot be opened, and a retry does not fix data |
| `SecretEnvelopeError` (with a prior record) | `retry` | unchanged: the recorded transaction's fate is unknown, so nothing may be concluded |
| `KeyCustodyUnavailableError`, `KmsKeyNotFoundError` | `retry` | an outage or a misdeploy is not a verdict on money |
| `StellarSubmissionUnavailableError` | `retry` | fate unknown — never read as "it did not happen" |
| rejected: `tx_bad_seq`, via a rebuild | `superseded` | restore the previous record, stop (§2.2) |
| rejected: `tx_bad_seq`, first build | `retry` | a race, and a fresh load fixes it |
| rejected: `tx_too_late`, `tx_insufficient_fee` | `rebuild` | the recorded transaction is dead; the fence decides whether a fresh one may be built now |
| rejected: permanent operation codes (`op_underfunded`, `op_low_reserve`, `op_no_trust`, `op_not_authorized`, `op_src_no_trust`, `op_no_destination`, `op_malformed`) | `failed` | `FAILED`, reason `landed-unsuccessful:<code>` — money that provably did not move (the prefix this table shipped was renamed in Step 28's audit: see "One vocabulary, amended" below) |
| rejected: any other code | `retry` | unknown is not a verdict |
| any other error | `retry` | unknown is not a verdict |

Reason strings are short machine codes (`landed-unsuccessful:op_underfunded`), never Horizon's prose: an
error body carries URLs and arbitrary length, and this text is stored in a column and may be rendered. The
prefix follows the *code* rather than the caller that learned it, which is what the amendment below fixes.

### One vocabulary, amended (Step 28's audit of this table)

The table above as approved named a permanent operation code's reason `submission-rejected:<code>`. That
prefix was wrong, and Step 28's real-network run is what showed it. Horizon's `submitTransaction` blocks
until the ledger closes the transaction, so the HTTP 400 carrying `op_underfunded` is the *outcome* of a
transaction the ledger already has - closed unsuccessful, fee charged, sequence consumed - and not the
absence of one. "Submission rejected" reads as "no ledger saw this"; a reader who believes that may treat a
`stellar_tx_hash` as safe to build past, which is the one mistake here with a money-shaped consequence.

Two prefixes now, and the code alone decides which one:

| code | prefix | what the name claims |
| --- | --- | --- |
| every `op_*` code, and `tx_failed` itself | `landed-unsuccessful:<code>` | a ledger closed the transaction and the money did not move |
| `tx_bad_seq`, `tx_too_late`, `tx_malformed`, `tx_insufficient_fee`, `tx_bad_auth`, `tx_no_source_account`, `tx_insufficient_balance`, `tx_internal_error` | `submission-rejected:<code>` | the submission was refused and no ledger ever saw it |
| anything else | no prefix (`unknown:<code>`) | the code is in neither list, so it is evidence of neither |

`NEVER_LANDED_TRANSACTION_CODES` in `submission-triage.ts` is the middle row, and its spec asserts the
reservation over that list, so a code cannot drift from one column to the other without a test failing.
No *verdict* changed: `op_underfunded` was `failed` before and is `failed` now, and a code this table
answered `retry` still is - what changed is only what the name claims, which is why this is an amendment to
a name rather than to a decision. `docs/step-28-29-proposal.md` §6 carries the measurement and the reasoning.

## 5. Schema (approved as proposed)

Four columns on `transactions`, plus the unique index:

| column | type | why |
| --- | --- | --- |
| `stellar_tx_hash` | `text`, `@unique` | the handle for what landed, and the one value an operator pastes into an explorer. Unique because two payments sharing a hash would mean one of them is not the payment it claims to be. |
| `stellar_tx_sequence` | `varchar(20)` | the sequence the built transaction used. **Text, not a number**: a Stellar sequence is an int64, and `Number` silently rounds above 2^53 — the same argument `StellarAccountSession` records. Compared with `BigInt`. |
| `submission_deadline` | `timestamptz` | `maxTime` of the built transaction, which is the fence's first half. |
| `failure_reason` | `text` | the short code from §4. |

## 6. Where the enqueue sits (approved as proposed)

The last statement **inside** `PaymentsService.create`'s `$transaction`, before the commit:

```
begin ── lock ── in-flight sum ── insert ── enqueue ── commit
```

- Commit-then-enqueue has a silent gap: a crash between the two leaves a `PENDING` row with no job — failure
  mode 2, invisible.
- Enqueue-then-commit has a loud gap: a rollback (or a crash) leaves a job for a payment that does not
  exist. The handler fails with a specific message, the failure is logged with the job's id, and no money
  moves. Failure mode 1 cannot occur, because a job whose row does not exist cannot submit anything.

The rare orphan job is the accepted cost, and §7 is what bounds its price.

## 7. The `commandTimeout` addition (made during review, implemented in this step)

**Decision:** the Redis connection the *producer* uses carries `commandTimeout: 3000`.

**Why it is not optional.** The enqueue runs inside the sender's `SELECT ... FOR UPDATE` on
`stellar_accounts` (§6), so its duration is the duration of that row lock. An unbounded hang there is an
availability cascade onto every other payment from that sender — a real risk on the money-movement path.

**Why it is on a second connection rather than the shared one.** `commandTimeout` is an ioredis option
applied to *every* command on the connection, blocking commands included
(`ioredis/built/Redis.js:368` → `command.setTimeout()`; `Command.js:204` rejects with `Command timed out`).
BullMQ's worker blocks on `BZPOPMIN` for `drainDelay` (5s when idle) and up to `maximumBlockTimeout` (10s
when a delayed job is pending — and backoff retries *are* delayed jobs). A 3s bound on the worker's
connection would time out every idle block, and after a blocking failure the worker emits `error` and waits
`runRetryDelay` (`worker.js:39-51`) — so the "fix" would be an error storm plus multi-second submission
latency. The producer therefore gets its own `Queue` with the bound; the worker keeps the shared connection,
untouched, and `payments-queue.module.spec.ts` still pins the root options to `{ connection: { url } }`
exactly.

**Documented limits of the bound** (stated, not hoped):

- It bounds a command that has been handed to ioredis (sent, or queued while the connection is not writable).
  It does not bound the connection handshake itself: a Redis that accepts TCP and never completes the
  handshake leaves `waitUntilReady` unresolved. A *slow* Redis — paused, overloaded, a black-holed
  established connection — is the case this closes, and is the case the test manufactures.
- After a timeout the connection stays up; the failure is bounded and transient, not poisoned. The e2e
  asserts recovery, not just failure.

**Measured, from the runs this was implemented against** (`test/submission.e2e-spec.ts`, ungated):
with Redis wedged by `CLIENT PAUSE 6000 ALL`, the payment fails after `3044`, `3122`, `3206` and
`3251` ms across four runs against the 3000 ms bound; no `transactions` row is written; the producer's
connection then round-trips a probe; and the orphan job Redis eventually runs (the abandoned Lua
script executed when the pause lifted, for a row that was rolled back) is rejected by the handler
rather than acknowledged - which is §6's trade, observed rather than argued.

Fifth run, after the e2e's unused imports were removed: `3353` ms - inside the same bound, with all four
of the assertions above passing.

## 8. Files

| file | what |
| --- | --- |
| `prisma/schema.prisma` + a migration | §5 |
| `src/payments/services/transaction-status.ts` + spec | the transition table as data, and the guard the two writes in this step go through (Step 29 adds the enforcement scan) |
| `src/payments/services/submission-triage.ts` + spec | §4 |
| `src/payments/services/payments-submission.service.ts` + spec | §2 |
| `src/payments/jobs/payments-queue-connection.ts` + spec | §7 |
| `src/payments/jobs/payments-queue.ts` | `submit-payment`, its payload, its result |
| `src/payments/jobs/payments-queue.service.ts` + spec | `enqueueSubmission` and the per-job options |
| `src/payments/jobs/payments.processor.ts` + spec | the handler, which is the only thing the worker knows about payments |
| `src/payments/jobs/payments-queue.module.ts` + spec | the two connections, and the submission provider |
| `src/payments/services/payments.service.ts` + spec | §6 |
| `src/wallet/wallet.module.ts` | exports `StellarService`, `SeedCustodyService`, `UsdcTrustlineService` — Step 27 is the first caller outside the wallet, and the USDC asset has exactly one definition (`UsdcTrustlineService.asset()`) |
| `test/submission.e2e-spec.ts` | the Testnet run (gated on `RUN_STELLAR_IT=1`) and the enqueue bound (ungated) |
| `README.md`, `docs/build-sequence.md` | the Step 27 section and the audit evidence |

## 9. Known gaps, stated rather than discovered later

1. **A re-drive after the deadline belongs to Step 28.** This step builds the fence and the rebuild path;
   nothing re-enqueues a `PROCESSING` payment whose transaction never landed until the polling job exists
   (or an operator re-runs the job). A `tx_insufficient_fee` rejection inside the deadline therefore leaves
   the row `PROCESSING` — safe, visible, and not self-healing yet.
2. **`PROCESSING` is not provably terminal-free.** Nothing in this step can distinguish "in a ledger,
   unnoticed" from "lost", which is exactly why the row stays `PROCESSING` and Step 28 owns the
   distinction.
3. **Concurrency is left at BullMQ's default of 1.** How many signatures may be in flight at once is a
   signing/HSM question, and the per-account lock already serialises per sender.
4. **The seal of a keypair is honest, not absolute.** "Discard the key" means it goes out of scope; the
   `Keypair` object and the seed string cannot be zeroed in JavaScript. What is enforced is that nothing in
   this path logs, serialises, returns or error-wraps them.

## 10. How this step is audited (same standard as Step 18)

- A real signed submission to Testnet, with the hash and the row's state reported from a real run.
- A deliberately re-run job (the same `transactionId` twice) produces **no** second transaction — asserted
  against the network (the account's sequence does not move), not against the code.
- The key-material sweep: the seed is searched for in every captured log line and payload the run produced.
- The enqueue bound: a wedged Redis fails the payment within the bound and the connection recovers after.
