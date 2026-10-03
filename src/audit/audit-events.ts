/**
 * Every kind of thing the audit log records (Step 32).
 *
 * `action` is a string in the database and a closed union here, and that split is the decision
 * `schema.prisma` records from the other side: a `CHECK` constraint would make a new sensitive
 * point a migration, and the person blocked by one would write the row directly instead of
 * widening the constraint. A union costs a recompile and catches the mistake at the call site.
 *
 * Each literal is `<area>.<event>`, and the prefix is load-bearing rather than decoration: the
 * table's second index is `(action, created_at)`, so "every custody event last week" and "every
 * payment event for this hour" are both prefix scans on it. `<area>` is the part of the system
 * that decided the event happened, not the table that was written.
 *
 * The list is short on purpose. An entry is worth a row only if somebody would one day ask the
 * question it answers, and every addition is a promise about context that has to be kept - so
 * this is the set Step 32's checklist names, and nothing that merely *could* be recorded.
 */
export const AUDIT_ACTIONS = [
  /**
   * A phone number was proved by a code, which is the moment an account becomes `ACTIVE`
   * (`AuthService.verifyOtp`). Registration is not a separate action: an account that exists and
   * has never been verified has not done anything yet, and the row that matters is this one.
   */
  'auth.otp.verified',
  /** A code sign-in succeeded on an existing account (`AuthService.login`). */
  'auth.login',
  /**
   * The transaction PIN was written where there was none (Step 34a).
   *
   * Two writers, distinguished by `metadata.source`: registration (`AuthService.register`,
   * `registration` for a first claim and `resend` for the pending-account path, which writes
   * the row - and its PIN - again) and `POST /auth/pin/change` on an account that has no PIN
   * (`PinService.change`, `set`, which is the state a Google-SSO account starts in).
   */
  'auth.pin.set',
  /**
   * The transaction PIN was replaced by a caller who proved the current one
   * (`PinService.change`). The proof itself is not a second entry: setting the new PIN *is*
   * the act this records.
   */
  'auth.pin.changed',
  /**
   * A correct PIN was presented at `POST /auth/pin/verify` (`PinService.verify`). This is the
   * moment a payment becomes possible, so it is worth a row even though no money moved.
   */
  'auth.pin.verified',
  /**
   * A PIN was not proved - and the outcome says which way.
   *
   * `failed`: a PIN of the right shape was presented and did not match, so the row is a guess
   * at the second factor (`PinService.recordWrongPin`), and `metadata.attemptsRemaining` says
   * what is left of the allowance.
   *
   * `denied`: no usable proof was presented at all, which is `StepUpAuthGuard` refusing a
   * payment, with `metadata.reason` naming whether the token was missing, invalid, or minted
   * for another account. Nothing was guessed, so nothing is counted.
   *
   * Those two outcomes are exactly why `denied` exists: folding them together would make
   * "someone is working through the ten thousand PINs" and "someone tried to pay without
   * their PIN" the same row, and the first of those is the one a lockout report is read for.
   */
  'auth.pin.failed',
  /**
   * The account password was written where there was none (Step 34b, `PasswordService.change`).
   *
   * The password is the *recovery* credential rather than the second factor the PIN is, so
   * its set is a sign-in concern rather than a money one - but it is still a credential, and
   * the moment one appears on an account is worth a row.
   */
  'auth.password.set',
  /**
   * An existing password was replaced, by proving the current one or by an SMS reset
   * (`PasswordService.change`, `PasswordService.set`). One literal for both writers: a change
   * and a reset are the same fact - "the password in force was replaced" - and `metadata`
   * does not distinguish them, because the difference is which proof was accepted and the
   * proof has its own entry below.
   */
  'auth.password.changed',
  /**
   * A password sign-in was attempted (Step 34b, `AuthService.loginWithPassword`).
   *
   * `ok`: a session was started. `denied`: the credential was not accepted - one outcome for
   * "no such account", "no password is set" and "wrong password", because the HTTP answer is
   * one message for all three and a row that split them would be the oracle the response
   * refuses to be. The existing `auth.login` keeps meaning "a *code* sign-in succeeded", so
   * a query for sign-ins has to ask for both - which is the honest shape, because the two
   * methods of proof are different facts.
   */
  'auth.password.login',
  /**
   * A forgot-password reset was started for an account (Step 34b,
   * `AuthService.requestPasswordReset`). Written only when the number resolved to an account:
   * a request for an unknown number sends nothing and changes nothing, so there is no row to
   * write - which is also why this entry is not an enumeration oracle despite the HTTP answer
   * being identical either way.
   */
  'auth.password.reset.requested',
  /**
   * A reset was completed: the SMS code was accepted and a new password written (Step 34b,
   * `AuthService.confirmPasswordReset`). The credential's change itself is `auth.password.changed`;
   * this entry is the *reset flow* finishing, which is what an operator looking for "how did
   * this account get back in" is actually asking.
   */
  'auth.password.reset.completed',
  /**
   * An email address was attached (or replaced) on an account (Step 34c, `EmailService.set`).
   *
   * `metadata` carries the `userId` and not the address: an address is a personal identifier,
   * and this table's rule - the one `maskPhoneNumber` and every `metadata` comment restate -
   * is that no identifier other than the account id appears in the clear.
   */
  'auth.email.set',
  /**
   * An attached email address was confirmed by a code (Step 34c, `EmailService.verify`). This
   * is the moment the address becomes usable for delivery, which is why it is a separate row
   * from the attach above: "we have an address for you" and "we can reach you at it" are
   * different facts, and the second is the one a receipt depends on.
   */
  'auth.email.verified',
  /**
   * A handle was claimed (`AuthService.register`). Registration is the only writer: there is no
   * change-handle endpoint, which is why the checklist item reads "handle change" and the entry
   * is named for the write that actually happens.
   */
  'user.handle.set',
  /** A payment row was created and its submission queued (`PaymentsService.create`). */
  'payment.initiated',
  /** The confirmation sweep saw the transaction in a closed ledger (`PaymentsConfirmationService`). */
  'payment.completed',
  /** The sweep resolved the payment to a definitive no, on-ledger or at submission. */
  'payment.failed',
  /** A data key was generated and wrapped under the master key: `SEAL` in, nothing out. */
  'custody.key.wrapped',
  /**
   * A wrapped data key was opened, which is one step from a seed. Recorded *before* the
   * signature, and recorded even when KMS refuses - `audited-key-wrapper.ts` says why the
   * failure is the more interesting of the two.
   */
  'custody.key.unwrapped',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The three answers an entry records.
 *
 * `failed` means the operation the entry names did not happen: a KMS call that was refused or
 * never reached the endpoint.
 *
 * `denied` arrived with its first writer (Step 34a) and means something narrower: the
 * operation was *not allowed to happen* because a second credential was missing or wrong -
 * `StepUpAuthGuard` refusing a payment that carried no fresh PIN proof. It is not a synonym
 * for `failed`: a payment that a bank rejected *failed*, and a payment refused before it was
 * ever attempted was *denied*, and a report that cannot tell those apart says the wrong thing
 * about both. Nothing wrote one until a guard existed to write it, which is the rule this list
 * follows - an outcome with no writer would be a guess about the future.
 */
export const AUDIT_OUTCOMES = ['ok', 'failed', 'denied'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
