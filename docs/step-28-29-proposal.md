# Steps 28–29 — Confirmation polling, and a status the state machine owns (proposal)

**Status:** approved and implemented. Step 28 (the polling sweep) and Step 29 (the state machine plus the
lint that protects it) shipped together, because the second is what makes the first's writes the only ones
in the repository. `docs/build-sequence.md` records what the Day 4 audit checklist item still requires —
a real Testnet run — and cites this document for the decisions behind the code. **One amendment since it
shipped:** the real-network run falsified the reason prefix Step 27's table used for a refused operation, so
the vocabulary was unified behind the code rather than behind the caller that learned it (§6).

**Scope:** `PROCESSING` → `SUCCESSFUL | FAILED` (Step 28), and the rule that no other code writes
`status` at all (Step 29). Nobody's HTTP surface changes: `GET /v1/payments/:id` is Step 30's.

---

## 1. The invariant this step has to hold

> **A payment that was submitted to Stellar ends up as an answer — `SUCCESSFUL` or `FAILED` with a
> reason — and one that was never submitted is never reported as if it had been.**

Step 27 closed the *submission* half of that sentence and deliberately left the other half open: Horizon
accepting a signed transaction is not the same as the ledger containing it, and `PROCESSING` was the honest
state to hand over. What that left behind was one failure mode with no bound on it (a row in `PROCESSING`
for ever), and Step 28 exists to bound it.

## 2. A sweep, not a timer per payment

One repeatable job over the in-flight set (`confirm-payments`, registered with BullMQ's job scheduler by
`PaymentsQueueService.ensureConfirmationScheduler`), rather than a delayed job scheduled per payment at
submission time.

The rejected alternative is worth naming because it looks tidier: with a per-payment delayed job the work
list lives in Redis, so a `FLUSHDB`, a lost job to a retention policy, or a deploy that drops a
queued-but-not-yet-scheduled entry leaves a payment `PROCESSING` with **nothing that will ever look at it
again** — the same silent non-event Step 27 refused to leave in `PENDING`. With a sweep, the work list is
the `transactions` table: the only way a payment stops being polled is if it stops being `PROCESSING`, and
a lost tick costs a delay rather than a payment.

The scheduler is **off by default**. `PAYMENTS_CONFIRMATION_INTERVAL_MS=0` registers no schedule at all (not
a zero-delay one, which would be a spin loop spending Horizon calls), and boot logs a line saying so. The
asymmetry is deliberate: a deployment that forgets to configure polling leaves rows `PROCESSING` and can
find out from one log line, while a deployment that starts writing verdicts on a timer without anybody
deciding to is a change in behaviour nobody approved. A tick can always be added by hand
(`enqueueConfirmation`), which is also the incident tool.

## 3. The batching, and why oldest-first

`CONFIRMATION_SWEEP_BATCH = 50` rows per tick, ordered by `submissionDeadline` ascending. A tick's duration
is (rows × Horizon latency), and the worker that drains this queue is also the worker that submits; an
unbounded sweep over a backlog would delay every submission behind it. Oldest deadline first means the rows
closest to being decidable are the ones looked at, and the rest arrive on the following tick.

## 4. The deadline, and the grace window

`not found` is not a verdict on its own: a transaction submitted two seconds ago and one that will never
exist are the same answer from Horizon. What separates them is the deadline the row recorded *before*
submitting — the transaction's own `maxTime` — and only after it has passed can "not found" mean "this can
never be valid again".

`CONFIRMATION_GRACE_MS = 60_000` is a second window on top of the deadline, and it is a *reading* of the
network rather than a product choice: Horizon's history is fed from what the ledger closes, so a
transaction included in the last ledger before its deadline can still be missing from a fetch a moment
later. It is safe because it is bounded and it errs towards waiting — a payment resolved a minute late
costs a minute, while one resolved early claims a payment failed that then appears in a ledger with the
money moved.

A `PROCESSING` row with a hash but **no** deadline is not decided at all (`no-deadline-recorded`, counted
as `unresolved`): `recordEnvelope` writes the hash, the sequence and the deadline together, so a row
missing one of them was not written by this app, and claiming it failed would be inventing the deadline.

## 5. Which of Step 27's `PROCESSING`-for-ever cases this closes, and which it does not

Step 27 could leave a row in `PROCESSING` four ways. Three of them have a recorded hash, and a recorded
hash is exactly what a poller needs:

| Step 27 leaves the row | What Step 28 does |
| --- | --- |
| Horizon accepted, and the ledger never took it (expired before inclusion) | after the deadline + grace: `FAILED`, `not-found-after-deadline` |
| Horizon accepted and the ledger took it, but the transaction failed on-ledger | `FAILED`, `landed-unsuccessful:<code>` |
| Horizon never answered (`StellarSubmissionUnavailableError`, attempts exhausted) | looked up until it either appears (`SUCCESSFUL`) or its deadline passes (`FAILED`) — the attempt that "failed" may well have landed |
| The claim landed and the process died before `recordEnvelope` wrote anything | **not closed here.** `PROCESSING` with no hash is not a poller's question: there is nothing to look up. Counted as `stuckWithoutHash` once `updatedAt` is over five minutes old, and reported rather than written |

The last row is the deliberate gap, and the reason it is *reported* rather than guessed at: the three ways
out of it — re-submit, fail it, or release the claim back to `PENDING` — are all submission decisions, and
each interacts with the sequence fence and with custody. A poller that could do any of them would be a
second path to a signature, which is what `StellarService`'s one-door rule exists to prevent. What this
step owes that case is visibility, and the count does that: it is in the tick's result, in the log, and
(from Step 41) in alerting.

## 6. Reasons, and who is told

`failure_reason` is a short machine code, never prose: `landed-unsuccessful:tx_failed`,
`landed-unsuccessful` (the result XDR could not be read), `not-found-after-deadline`. It shares one
vocabulary with Step 27's submit path — the amendment below is where the two were unified — so a row's reason
is always greppable and always the same shape. The code comes from the transaction *result* XDR — a fetched
Horizon record has no `result_codes` field at all, verified against a real failed Testnet transaction, so
`transactionCodeOf` decodes `result_xdr` and maps the SDK's variant name (`txFailed`) to Horizon's
(`tx_failed`).

A refused submission leaves the row holding the hash of the envelope that was **built**, and `markFailed`
keeps it deliberately (`transaction-status.ts`): it is the fingerprint of the attempt, and nothing else can
collide with it. What such a hash then *is* was the one thing this step got wrong first and then measured, so
it is worth stating exactly. A transaction whose operation fails is **closed by a ledger** — that is what a
`tx_failed` result is, and it is why the fee is charged and the sequence consumed — and Horizon answers the
*submission* that produced it with an HTTP 400 carrying the operation code. So the refusal is real, the
ledger entry is real, and `GET /transactions/<hash>` answers `successful: false` for the hash on a `FAILED`
row from either path; the gated run asserts exactly that, in the second and third of Step 28's cases, by
asking Horizon for the recorded hash — `successful: false` both times.

### The vocabulary: one prefix per code, not per caller (decided here, amending Step 27's table)

The measurement above settles a naming question this step first left open. Step 27's table named a permanent
operation code's reason `submission-rejected:<code>`, and the run showed that a `tx_failed` rejection is the
outcome of a transaction the ledger **has**: the old name claimed the opposite of what happened, and a reader
who believes a hash was never in a ledger may treat it as safe to build past. The prefixes therefore belong
to the *code*, not to whichever caller learned the outcome first:

- `landed-unsuccessful:<code>` — a ledger closed the transaction and the money did not move: every `op_*`
  code, and `tx_failed` itself, which is what a transaction earns by being closed unsuccessfully.
- `submission-rejected:<code>` — the submission was refused and no ledger ever saw it, reserved for the codes
  that say so: `tx_bad_seq`, `tx_too_late`, `tx_malformed`, `tx_insufficient_fee`, `tx_bad_auth`,
  `tx_no_source_account`, `tx_insufficient_balance`, `tx_internal_error`
  (`NEVER_LANDED_TRANSACTION_CODES` in `submission-triage.ts`, asserted over the list itself by its spec, so
  a code cannot drift between the two columns unnoticed).
- **No prefix** — `unknown:<code>` — for a code in neither list. Guessing there is the one mistake with a
  money-shaped consequence, so the vocabulary asks a human to look instead of borrowing a claim.

Only the *name* changed. A code answered `retry` is still `retry`, and `op_underfunded` is still `failed`:
naming is a claim about the ledger, concluding is a decision about money, and the amendment touches only the
first. Both detection paths now write the same name for the same event - the gated run's third case (a
submit-time refusal) asserts the same `landed-unsuccessful:` prefix the second case's poll asserts, and that
run is the evidence for the unification rather than this paragraph. Step 27's proposal records the amendment
in its §4, where the old vocabulary is what a reader will find first.

The sender is told **after** the row is written, from the stored row (`amount`, `recipient.handle`) rather
than from the request, and a provider failure is logged with the payment id and swallowed. That ordering is
the whole of "notify once per resolution": the compare-and-set decides who resolved the payment, the winner
sends the message, and an SMS outage cannot turn a settled payment back into an unsettled one or make the
job fail (which would retry a resolution that already happened). The failure wording says what it means for
the money — "did not go through. No USDC left your wallet." — rather than naming a code; the code is for
the row and the log.

A tick carries **no retry policy of its own** (no `attempts`, no `backoff`): the interval *is* the retry
policy. BullMQ retries on top of a schedule would ask a failing Horizon twice per interval, multiplied by
the number of replicas, and the counters in the job result are what make a failing tick visible.

## 7. Step 29: one writer, and a lint that keeps it that way

`src/payments/services/transaction-status.ts` holds the transition table and **every** write of the
`status` column:

- `claimForSubmission` — `PENDING` → `PROCESSING`, conditional on `PENDING` (Step 27).
- `recordEnvelope` / `restoreEnvelope` — the record half: hash, sequence, deadline. They write no status at
  all, which is the point: recording an envelope does not move a payment.
- `markFailed` — `PROCESSING` → `FAILED`, with the reason.
- `markSuccessful` — `PROCESSING` → `SUCCESSFUL`.

Two layers, doing different jobs. The **guards** (`assertTransition`, `canTransition`) refuse an illegal
move before the database is touched, so a programming error is a stack trace naming the payment rather than
a row that quietly disagrees with the table. The **conditional write** is the lock: every writer is an
`UPDATE ... WHERE id = ... AND status = <expected>`, so of two callers racing to move the same row exactly
one updates a row and the other is told `false`. That `false` is not an error — it means somebody else
resolved the payment microseconds ago — and it is what makes "one resolution, one notification" a property
of Postgres rather than of a caller's timing.

Creation is deliberately *not* a writer: a payment is created `PENDING` by the column's own
`@default(PENDING)`, so the schema is the single statement of what a payment starts as and the state
machine is the single writer of what it becomes. Making creation a write through this file would drag
`amount`, `senderId` and `idempotencyKey` into the state machine for no gain — and turning the rule on
removed three restatements of the default (`PaymentsService.create` and two e2e fixtures) on the lint's
first run, which is the lint doing exactly what it is for.

**The lint** is `npm run lint:status` (`src/payments/status-discipline.ts` + `check-status-discipline.ts`),
wired into `npm run lint` beside the money rule, so CI runs it. It scans every `.ts` file under `src/` and
`test/` for three things:

1. `transaction.<create|createMany|update|updateMany|upsert>({ ... data: { status: ... } })` outside
   `src/payments/services/transaction-status.ts`. The model is part of the pattern because `auth.service.ts`
   writes `user.status` in exactly that shape; the method is part of it because `where: { status: ... }` is
   how every read in this codebase asks about payments.
2. `SET status =` (case-insensitive) — the one path that leaves TypeScript, because a template handed to
   `$executeRaw` is a string until Postgres reads it.
3. The exemption pointing at a file that does not exist. An allowlist whose file has been moved permits
   everything, so that is a violation rather than a silently empty exemption.

It prints `file:line  [rule] what to write instead`, and a *passing* run prints what it read — `155 files
scanned, 3 status writes in the sanctioned writer, 0 violations` — so a clean run cannot be mistaken for a
run that read nothing. It runs the TypeScript directly (`node src/payments/check-status-discipline.ts`),
which is why the checker uses no `enum` and no `namespace`: Node's type stripping erases types but does not
transform syntax, so a generated Prisma enum cannot be imported there. The four status names are spelled
again in that file, and `status-discipline.spec.ts` asserts the array *is* the enum's members.

## 8. What the lint cannot see, stated rather than discovered

- A status smuggled through a variable (`const patch = { status: 'FAILED' }; transaction.update({ where,
  data: patch })`). The rule is therefore written as "a write of the column must be spelled out at its call
  site", and the gap is named in the checker's docblock and in its spec — the same gap the money rule names
  about aliases.
- A file that reaches Postgres some other way than through this client. Nothing in the API does today;
  `SET status =` covers the raw-SQL door, which is the one a future migration or script would use.
- A **fixture** that writes a status directly (a test seeding a `FAILED` row). Today none does; a future
  one should build its state through the writers (claim → record envelope → resolve), which is also more
  honest about what it is testing.

The rule is a lint, not a type: it can be satisfied by a `// eslint-disable`-shaped lie in the same way any
scan can. What it buys is that the *default* is now correct and the exception is visible in a diff.

## 9. How each audit item is proven

| Audit item | Where it is proven |
| --- | --- |
| A real submitted transaction resolves to `SUCCESSFUL` | The gated Testnet run in `test/submission.e2e-spec.ts` — the run recorded in `docs/build-sequence.md`, with the payment, the hash, the ledger and the balances read back from Horizon by something other than this codebase; the decision itself by `confirmation-triage.spec.ts` and `payments-confirmation.service.spec.ts` |
| A deliberately-invalid transaction resolves to `FAILED` with a readable reason rather than hanging in `PROCESSING` | Same gated run, in both shapes the network refuses: the third case drives a real payment that Horizon refuses at submission (HTTP 400, `op_underfunded`, so the row is `FAILED` before any poll is owed) through the app's own submission path, and then asserts what the refusal left behind — the hash the row keeps resolves on Horizon as `successful: false` in a closed ledger, the outcome it returned carries no hash, USDC is unchanged and a second attempt is `skipped`; the second case resolves a landed-but-refused transaction to `FAILED` with `landed-unsuccessful:tx_failed`, and the third asserts `landed-unsuccessful:op_underfunded` — one prefix for one event, whichever path learned it (§6); plus the unit specs, including the reservation of `submission-rejected:` asserted over the code list itself, and no ledger before the deadline + grace → `not-found-after-deadline` |
| A direct status write from outside the guard is structurally caught | `src/payments/status-discipline.spec.ts` (19 cases), and the CLI run recorded in `docs/build-sequence.md` — a rogue write added by hand is reported with its `file:line` and exits 1 |
| The sweep is off unless configured | `payments-queue.service.spec.ts`: interval `0` registers nothing and logs why; a positive interval upserts one stable scheduler id |

## 10. Left to later steps, deliberately

- **What a client sees.** This step resolves rows; it does not expose them. Which of the four statuses a
  client is told about, whether `failure_reason` is part of a response at all, and how a `PROCESSING`
  payment is worded ("on its way" rather than a status name) is Step 30's decision — it is the step that
  reads payments out, and a DTO written here would be a second opinion about a shape Step 30 owns.
- **Alerting on the two counts that mean "something is wrong"** (`stuckWithoutHash`, and `unresolved`
  with `polled`) is Step 41's; today they are in the job's result and the log.
- **A re-drive decision for the no-hash row** (re-submit, fail, or release the claim) — see §5. It is
  submission work, not polling work.
- **Tuning the lookup itself.** The port does one call with the SDK's own timeouts and no retry: a tick
  that cannot read a row leaves it for the next tick, so a retry loop would only make one failure cost
  more. If Horizon's latency ever makes a 50-row tick too slow, the batch is one constant
  (`CONFIRMATION_SWEEP_BATCH`) and the interval is a deployment setting.



