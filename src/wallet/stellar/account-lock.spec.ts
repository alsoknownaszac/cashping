import { describe, expect, it } from 'vitest';
import { AccountLock } from './account-lock.js';

/**
 * Step 17's audit item is about a race, so these specs are all about *overlap*: a
 * task that takes several event-loop turns is what a network round trip looks like
 * from the lock's point of view, and the assertion that matters is that two such
 * tasks for one account are never in flight at the same time.
 *
 * `setTimeout(0)` rather than `await Promise.resolve()` on purpose - microtask
 * turns are not enough to demonstrate a real interleaving, and a real Horizon load
 * is a macrotask away from instant.
 */

function afterEventLoopTurns(turns: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = turns;
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
      } else {
        setTimeout(tick, 0);
      }
    };

    setTimeout(tick, 0);
  });
}

/**
 * A task that records when it started and finished, and takes `turns` event-loop
 * turns to do it. `maxInFlight` is the whole point: with a working queue it never
 * rises above one per key.
 */
function createRecorder() {
  const started: string[] = [];
  const finished: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    started,
    finished,
    maxInFlight: () => maxInFlight,
    task:
      (name: string, turns = 2) =>
      async (): Promise<string> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(name);

        await afterEventLoopTurns(turns);

        finished.push(name);
        inFlight -= 1;

        return name;
      },
  };
}

describe('AccountLock', () => {
  it('runs one task at a time for a key, finishing them in the order they were queued', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    // A long task first, then two short ones: if the lock let either short task
    // start early, it would finish first and both orders would show it.
    const results = await Promise.all([
      lock.run('account', recorder.task('first', 6)),
      lock.run('account', recorder.task('second', 1)),
      lock.run('account', recorder.task('third', 1)),
    ]);

    expect(results).toEqual(['first', 'second', 'third']);
    expect(recorder.started).toEqual(['first', 'second', 'third']);
    expect(recorder.finished).toEqual(['first', 'second', 'third']);
    expect(recorder.maxInFlight()).toBe(1);
  });

  it('takes its slot before awaiting, so a task queued later cannot overtake one queued earlier', async () => {
    const lock = new AccountLock();
    const order: string[] = [];

    const slow = lock.run('account', async () => {
      order.push('slow:start');
      await afterEventLoopTurns(4);
      order.push('slow:end');
    });

    // Queued while `slow` is mid-flight. A lock that only registers its queue once
    // its own work has started (i.e. after an `await` inside `run`) would let this
    // run immediately, and `fast:end` would land before `slow:end`.
    const fast = lock.run('account', () => {
      order.push('fast');
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });

  it('serialises a burst of overlapping requests for one account', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    // Deliberately forced, not trusted: 25 requests issued in one synchronous
    // squall, the way a retrying client or a loop over pending payouts would.
    const results = await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        lock.run('account', recorder.task(`task-${index}`)),
      ),
    );

    expect(results).toEqual(Array.from({ length: 25 }, (_unused, index) => `task-${index}`));
    expect(recorder.maxInFlight()).toBe(1);
  });

  it('lets different accounts proceed in parallel', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    // The lock is per source account, not global: a payment from one wallet must
    // not wait behind an unrelated wallet's round trip.
    await Promise.all([
      lock.run('account-a', recorder.task('a', 5)),
      lock.run('account-b', recorder.task('b', 1)),
    ]);

    expect(recorder.maxInFlight()).toBe(2);
    expect(recorder.finished).toEqual(['b', 'a']);
  });

  it('reports a failure to its own caller and still runs the next task for that account', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    const failing = lock.run('account', async () => {
      await afterEventLoopTurns(1);

      throw new Error('horizon said no');
    });
    const following = lock.run('account', recorder.task('following'));

    // The failure is the failing caller's; the next caller is unaffected and does
    // not inherit the error. A queue that forwards its predecessor's error would
    // turn one Horizon hiccup into a failed payment for whoever came next.
    await expect(failing).rejects.toThrow('horizon said no');
    await expect(following).resolves.toBe('following');
  });

  it('is not poisoned by a rejected task: the account keeps working afterwards', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    await expect(lock.run('account', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    await expect(lock.run('account', recorder.task('after'))).resolves.toBe('after');
    expect(lock.queuedAccountCount()).toBe(0);
  });

  it('forgets an account once its queue drains', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    const first = lock.run('account', recorder.task('first'));
    const second = lock.run('account', recorder.task('second'));

    // While work is outstanding the account holds a queue...
    expect(lock.queuedAccountCount()).toBe(1);

    await Promise.all([first, second]);

    // ...and once it drains, the entry is gone: this lock lives for the life of
    // the process, so one entry per account ever paid would be a slow leak.
    expect(lock.queuedAccountCount()).toBe(0);
  });

  it('starts a fresh queue for an account it has already forgotten', async () => {
    const lock = new AccountLock();
    const recorder = createRecorder();

    await lock.run('account', recorder.task('first'));

    const results = await Promise.all([
      lock.run('account', recorder.task('second', 4)),
      lock.run('account', recorder.task('third', 1)),
    ]);

    expect(results).toEqual(['second', 'third']);
    expect(recorder.maxInFlight()).toBe(1);
  });

  it("never hands a queued task its predecessor's result", async () => {
    const lock = new AccountLock();
    const received: unknown[][] = [];

    const first = await lock.run('account', () => 'first-value');

    // The queue marker resolves with nothing at all, not with the previous task's
    // value or error: a task must not be able to mistake "the last one finished" for
    // "the last one succeeded". Recorded as a rest parameter so the assertion is
    // about what the lock actually passes to a queued task, which is no arguments.
    const second = await lock.run('account', (...args: unknown[]) => {
      received.push(args);

      return 'second-value';
    });

    expect(first).toBe('first-value');
    expect(second).toBe('second-value');
    expect(received).toEqual([[]]);
  });
});
