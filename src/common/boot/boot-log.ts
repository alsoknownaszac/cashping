import { writeSync } from 'node:fs';

/**
 * The stderr writers every boot-diagnosis line goes through, and why they are not
 * `console`.
 *
 * Node writes to `process.stdout`/`process.stderr` asynchronously when they are pipes -
 * which is what they are under Render - and `process.exit()` does not wait for such a
 * write to land. A boot that dies before Nest prints its first line therefore leaves an
 * empty log, which is a failed deploy with no cause in it. `writeSync(2, ...)` returns
 * only once the bytes are in the pipe, so the message survives even when it is the last
 * thing the process does.
 *
 * That is also why `process.stderr.write` is deliberately not used here, even though it
 * looks like the same thing: it is the same asynchronous writable, and the difference
 * between the two is invisible until the one run where the message matters.
 *
 * A broken stderr (a closed pipe) is swallowed rather than thrown: there is nowhere left
 * to report to, and a crash inside the crash handler explains nothing.
 */
export function reportFatal(message: string): void {
  writeToStderr(message);
}

/**
 * Marks a boot stage. The last marker that appears names the stage that completed, so the
 * one that *should* have followed names the call that never returned - which is the whole
 * of the diagnosis on an instance that offers no shell.
 */
export function markBootStage(stage: string): void {
  writeToStderr(`[boot] ${stage}`);
}

/**
 * Renders an unknown thrown value into the text a fatal line carries.
 *
 * The whole stack rather than `message`: a rejection reason is not required to be an
 * `Error` at all, and when it is, the frames are the part a reader would otherwise have to
 * reconstruct by hand.
 */
export function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : String(error);
}

function writeToStderr(line: string): void {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // stderr is gone - there is nowhere left to report to.
  }
}
