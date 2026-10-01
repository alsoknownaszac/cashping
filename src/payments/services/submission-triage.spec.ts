import { describe, expect, it } from 'vitest';
import { SecretEnvelopeError } from '../../wallet/custody/secret-envelope.js';
import { KeyCustodyUnavailableError, KmsKeyNotFoundError } from '../../wallet/custody/key-wrapper.js';
import {
  StellarSubmissionRejectedError,
  StellarSubmissionUnavailableError,
} from '../../wallet/stellar/transaction-submitter.js';
import {
  NEVER_LANDED_TRANSACTION_CODES,
  PERMANENT_OPERATION_CODES,
  triageSubmission,
  type SubmissionIntent,
} from './submission-triage.js';

/**
 * Every row of Step 27's triage table, as a test rather than as prose (Step 27).
 *
 * The two worth reading first are the *asymmetric* ones, because they are the ones a future edit
 * is most likely to "simplify" wrongly:
 *
 * - `SecretEnvelopeError` is terminal with no record and a retry with one. The same error, two
 *   answers, decided by whether a transaction might already exist.
 * - `tx_bad_seq` is `superseded` on a rebuild and a retry on a first build. The same code, two
 *   answers, decided by whether this attempt built something over an existing record.
 *
 * Everything else is a refusal to conclude anything, which is what most of the table is.
 *
 * The other thing this file pins, because Step 28 measured it: the two prefixes `failure_reason`
 * uses belong to the *code*, not to whoever learned it. Every operation-level code, and
 * `tx_failed` itself, is a landed failure (`landed-unsuccessful:<code>`); the codes in
 * `NEVER_LANDED_TRANSACTION_CODES` are refusals no ledger saw (`submission-rejected:<code>`); and
 * a code in neither list earns no prefix at all. The last tests below say so over the lists
 * themselves, so the vocabulary cannot drift a code at a time.
 */

const REJECTED = (transactionCode: string, ...operationCodes: string[]) =>
  new StellarSubmissionRejectedError(transactionCode, operationCodes);

/** The name an intent carries, whichever field holds it: the reason for `failed`, else the detail. */
const nameOf = (intent: SubmissionIntent): string => {
  if ('detail' in intent) {
    return intent.detail;
  }

  return 'reason' in intent ? intent.reason : intent.kind;
};

describe('triageSubmission: the accepted case', () => {
  it('reports acceptance without looking at anything else', () => {
    expect(
      triageSubmission({ accepted: true, error: new Error('ignored'), rebuilt: true }),
    ).toEqual({ kind: 'accepted' });
  });
});

describe('triageSubmission: key custody', () => {
  it('fails the payment when the stored secret cannot be opened and nothing was submitted', () => {
    // A blob that cannot be opened is a fact about the row, not about availability: no retry
    // will change it, and the payment can never be submitted - so it is an answer, not a wait.
    expect(
      triageSubmission({
        accepted: false,
        error: new SecretEnvelopeError('authentication-failed', 'acct-1'),
        hadRecord: false,
      }),
    ).toEqual({ kind: 'failed', reason: 'secret-envelope:authentication-failed' });
  });

  it('refuses to conclude anything when a transaction was already recorded', () => {
    // The recorded transaction may be in a ledger. A key problem says nothing about that, so the
    // row keeps its record and the attempt is priced as a retry.
    expect(
      triageSubmission({
        accepted: false,
        error: new SecretEnvelopeError('authentication-failed', 'acct-1'),
        hadRecord: true,
      }),
    ).toEqual({ kind: 'retry', detail: 'secret-envelope:authentication-failed' });
  });

  it('treats a custody outage and a misconfigured key as waits, not verdicts', () => {
    const outage = new KeyCustodyUnavailableError('unwrap', 'AggregateError (ECONNREFUSED)');
    const misdeploy = new KmsKeyNotFoundError('arn:aws:kms:eu-west-1:000:key/abc', 'NotFound');

    // Neither may become FAILED: one is somebody else's outage, the other is a deploy that has
    // to be fixed, and neither is a statement about whether money moved.
    expect(triageSubmission({ accepted: false, error: outage })).toEqual({
      kind: 'retry',
      detail: 'custody:KeyCustodyUnavailableError',
    });
    expect(triageSubmission({ accepted: false, error: misdeploy })).toEqual({
      kind: 'retry',
      detail: 'custody:KmsKeyNotFoundError',
    });
  });
});

describe('triageSubmission: submission failures', () => {
  it('retries an unanswered submission, because the transaction may have landed', () => {
    // The reason this error type exists: a timeout and a connection that died after Horizon
    // committed are the same exception, and "it may have" is the only safe reading of it.
    expect(
      triageSubmission({
        accepted: false,
        error: new StellarSubmissionUnavailableError('Horizon did not answer (ECONNREFUSED)'),
      }),
    ).toEqual({ kind: 'retry', detail: 'submission:Horizon did not answer (ECONNREFUSED)' });
  });

  it('stops and is superseded when a rebuilt transaction hits a sequence conflict', () => {
    // The rebuild came from a fresh load whose sequence still equalled the recorded one, and
    // Horizon says a sequence that was equal has since been consumed: the *recorded*
    // transaction landed in the gap, so it is the truth and this attempt stops.
    expect(
      triageSubmission({
        accepted: false,
        error: REJECTED('tx_bad_seq'),
        rebuilt: true,
        hadRecord: true,
      }),
    ).toEqual({ kind: 'superseded', detail: 'submission-rejected:tx_bad_seq' });
  });

  it('retries a sequence conflict on a first build, because nothing has been recorded', () => {
    expect(
      triageSubmission({
        accepted: false,
        error: REJECTED('tx_bad_seq'),
        rebuilt: false,
        hadRecord: false,
      }),
    ).toEqual({ kind: 'retry', detail: 'submission-rejected:tx_bad_seq' });
  });

  it('asks for a rebuild when the recorded transaction is provably dead', () => {
    // Dead, not refused: the fence decides whether building one now is safe, which is why this
    // is a distinct answer from `retry` and from `failed`.
    for (const code of ['tx_too_late', 'tx_insufficient_fee']) {
      expect(
        triageSubmission({ accepted: false, error: REJECTED(code), hadRecord: true }),
      ).toEqual({ kind: 'rebuild', detail: `submission-rejected:${code}` });
    }
  });

  it('fails the payment for every operation code that means the money did not move', () => {
    // The prefix is `landed-unsuccessful:`, not `submission-rejected:` (Step 28's audit): an
    // operation code arrives inside a `tx_failed` result, and a transaction is *closed* to earn
    // one - the fee is charged and the sequence consumed - so the ledger has it. The same code
    // read back by the poller is written under the same prefix, which is the point of the
    // unification: the name describes the event, and the event is in a ledger.
    for (const code of PERMANENT_OPERATION_CODES) {
      expect(triageSubmission({ accepted: false, error: REJECTED('tx_failed', code) })).toEqual({
        kind: 'failed',
        reason: `landed-unsuccessful:${code}`,
      });
    }
  });

  it('finds the permanent code when Horizon names several operations', () => {
    // `getResultCodes()` returns the codes in operation order, and a future multi-operation
    // transaction must still report the code that actually failed.
    expect(
      triageSubmission({
        accepted: false,
        error: REJECTED('tx_failed', 'op_success', 'op_no_trust'),
      }),
    ).toEqual({ kind: 'failed', reason: 'landed-unsuccessful:op_no_trust' });
  });

  it('names a landed failure the same way whether the code is permanent or not', () => {
    // The half of the vocabulary Step 28's rename exists for: a `tx_failed` with no *permanent*
    // operation code is still a transaction a ledger closed, so it is named `landed-unsuccessful`
    // even though the verdict stays a retry - naming and concluding are separate questions, and
    // only the second is a money decision.
    expect(
      triageSubmission({ accepted: false, error: REJECTED('tx_failed', 'op_something_new') }),
    ).toEqual({ kind: 'retry', detail: 'landed-unsuccessful:tx_failed' });

    // The same for a `tx_failed` that evaluated nothing at all: the transaction-level code is all
    // Horizon said, and it says the transaction was closed and failed.
    expect(triageSubmission({ accepted: false, error: REJECTED('tx_failed') })).toEqual({
      kind: 'retry',
      detail: 'landed-unsuccessful:tx_failed',
    });
  });

  it('retries a refused submission that no ledger saw, keeping the submission-rejected prefix', () => {
    // A transaction-level refusal that never reached a ledger keeps Step 27's prefix, and it is
    // the only thing that does: `tx_bad_auth` means the network refused the envelope itself.
    expect(triageSubmission({ accepted: false, error: REJECTED('tx_bad_auth') })).toEqual({
      kind: 'retry',
      detail: 'submission-rejected:tx_bad_auth',
    });
  });

  it('claims no prefix for a code it cannot place', () => {
    // Neither list, so neither story: the code names itself and the reader is asked to look. The
    // alternative - borrowing `submission-rejected:` - would tell a reader that no ledger saw a
    // hash this app cannot know the fate of.
    expect(triageSubmission({ accepted: false, error: REJECTED('tx_something_new') })).toEqual({
      kind: 'retry',
      detail: 'unknown:tx_something_new',
    });
  });

  it('answers every never-landed code with the submission-rejected prefix, over the list itself', () => {
    // The reservation as a property rather than as eight hand-written rows: a code added to
    // `NEVER_LANDED_TRANSACTION_CODES` that no branch reaches, or a branch that prefixes a code
    // that is not in it, fails here. Which *answer* each code earns (`retry`, `rebuild`,
    // `superseded`) is a separate question, tested above.
    for (const code of NEVER_LANDED_TRANSACTION_CODES) {
      expect(
        nameOf(
          triageSubmission({
            accepted: false,
            error: REJECTED(code),
            rebuilt: false,
            hadRecord: false,
          }),
        ),
      ).toBe(`submission-rejected:${code}`);
    }

    // And the mirror: nothing outside the two lists may wear the prefix. `tx_failed` and the
    // operation codes are the landed half, and an unrecognised code is the `unknown:` detail.
    expect(nameOf(triageSubmission({ accepted: false, error: REJECTED('tx_failed') }))).toBe(
      'landed-unsuccessful:tx_failed',
    );
    expect(
      nameOf(triageSubmission({ accepted: false, error: REJECTED('tx_failed', 'op_underfunded') })),
    ).toBe('landed-unsuccessful:op_underfunded');
    expect(nameOf(triageSubmission({ accepted: false, error: REJECTED('tx_unknown_code') }))).toBe(
      'unknown:tx_unknown_code',
    );
  });

  it('retries anything it cannot name, including a non-Error', () => {
    expect(triageSubmission({ accepted: false, error: new Error('boom') })).toEqual({
      kind: 'retry',
      detail: 'unknown:Error',
    });
    expect(triageSubmission({ accepted: false, error: 'boom' })).toEqual({
      kind: 'retry',
      detail: 'unknown:string',
    });
    expect(triageSubmission({ accepted: false })).toEqual({
      kind: 'retry',
      detail: 'unknown:undefined',
    });
  });
});
