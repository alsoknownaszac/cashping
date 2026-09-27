/**
 * Per-source-account serialisation (Step 17).
 *
 * Stellar's sequence number is the reason this exists. A transaction is built
 * against a snapshot of its source account's sequence number, and the network
 * accepts exactly one transaction per (account, sequence number) pair. Two builds
 * that read the same snapshot therefore carry *the same* sequence number, and the
 * one that gets submitted second is rejected - `tx_bad_seq` - after the fee has
 * been paid and after the user has waited for a confirmation that never comes.
 * Nothing in Stellar prevents this, so the only fix is to never have two builds
 * in flight for one source account at the same time.
 *
 * Two properties of the implementation matter more than the queue itself:
 *
 * 1. **Ordering is FIFO, and it is registered before the first `await`.** The map
 *    entry is written synchronously in `run`, so work started later cannot
 *    overtake work started earlier. A "lock" that only registers itself after an
 *    `await` is the classic way this bug survives review: it looks like a lock
 *    and behaves like a race.
 * 2. **A failing task must not wedge the account.** The next task runs whether
 *    its predecessor resolved or rejected, and the predecessor's error is handed
 *    back to the predecessor's own caller - never to the next one, and never as
 *    an unhandled rejection.
 *
 * What this deliberately is *not*: a distributed lock. Every process holds its
 * own map, so with more than one instance of the API running, two processes can
 * still read the same sequence number. That gap is acceptable for a
 * single-instance deployment and unacceptable the moment the API scales out - at
 * which point the fix is a Redis lock (`RedisService` already exists for exactly
 * this kind of shared state) or, more cheaply, owning each hot source account (the
 * treasury) in one process. Stellar's own rejection remains the backstop either
 * way, so the failure mode stays "one transaction is refused", never "money moves
 * twice".
 */
export class AccountLock {
  /** One tail promise per key; absent means the key is idle and unlocked. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `work` once every previously queued task for `key` has settled, and
   * resolves with `work`'s result.
   *
   * The returned promise rejects if `work` throws - that is the caller's own
   * failure, and it does not affect anything else queued for `key`.
   */
  run<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Run after the predecessor settles either way, rather than only after it
    // succeeds - and invoke `work` with *no* arguments. `then` would otherwise pass
    // it the predecessor's settled value, which today is `undefined` only because
    // `settle` is a no-op: one refactor of the tail away from handing the next task
    // "what the last one returned", or "why it failed", to be read as a result.
    const result = previous.then(
      () => work(),
      () => work(),
    );

    // The queue marker must never reject: it is read by strangers (the next
    // caller), and an unhandled rejection here would be about a task that was
    // already reported to its own caller.
    const tail = result.then(settle, settle);
    this.tails.set(key, tail);
    void tail.then(() => {
      // Only drop the entry if nothing newer has taken over, so a burst of work
      // for one account does not delete a live queue and let the next caller in
      // ahead of it.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }

  /**
   * How many accounts currently hold a queue. Zero when idle: the map is cleaned
   * up as work finishes, so a long-running process does not accumulate one entry
   * per account ever touched (`AccountLock`'s spec asserts this).
   */
  queuedAccountCount(): number {
    return this.tails.size;
  }
}

/** Fulfilment and rejection both become `undefined`, so a tail never rejects. */
function settle(): void {}
