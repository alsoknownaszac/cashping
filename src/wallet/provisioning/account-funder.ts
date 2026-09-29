/**
 * Where a newly created account gets its first XLM from (Step 19).
 *
 * A Stellar account does not exist until something pays it: there is no
 * "create account" call, only a `create_account` operation or a funder that issues
 * one on the caller's behalf. So provisioning is two halves - a keypair and a
 * funder - and the funder is the half that depends on where the app is running:
 * Testnet has friendbot, production has a treasury account the operator funds, and a
 * local Stellar node has either.
 *
 * That is why this is a port and not a function: the *flow* (generate, seal, store,
 * fund, trust) is the same everywhere and is what Step 19 is specified as, while the
 * funder is the part that changes between Testnet, a local node and production. The
 * build sequence names Testnet friendbot and a real treasury account as the first
 * two bindings; today only friendbot exists, and `WalletModule` binds it.
 *
 * ## The two failures, and why only two
 *
 * The same split `key-wrapper.ts` and `account-source.ts` record, for the same
 * reason: the reaction differs, and everything else is a variation of one of these.
 *
 * - `AccountFundingUnavailableError` - the funding did not happen and the state of
 *   the account is unchanged: the funder was unreachable, timed out, or answered
 *   5xx. Retrying later is the right response, and it is safe because nothing was
 *   written on the network.
 * - `AccountFundingMisconfiguredError` - the funder answered, and its answer says
 *   the *request* or the *configuration* is wrong: a rejected `addr`, a funder whose
 *   URL is not a funder, a network with no funder bound at all. Retrying changes
 *   nothing; a human has to.
 *
 * There is deliberately no "already funded" error: for a funder that is idempotent
 * (friendbot is, and a treasury that pays a fixed amount can be made so) already
 * funded is a *success* - the account has its XLM, which is the only thing the
 * caller wanted - so it is an outcome, not a failure. `FundingOutcome` says which.
 */

/** The funder `AccountProvisioningService` depends on. Bound in `WalletModule`. */
export const ACCOUNT_FUNDER = Symbol('ACCOUNT_FUNDER');

/**
 * What a funding request did.
 *
 * `funded` and `already-funded` are both success: the caller's question is "does this
 * account have XLM now", and both answers are yes. They are distinguished anyway
 * because the *log* should say which, and because a run of `already-funded` answers
 * where `funded` was expected is how a retry loop or a double-provisioning bug
 * becomes visible before it becomes a support ticket.
 */
export type FundingOutcome = 'funded' | 'already-funded';

/** What `AccountFunder.fund` reports back. */
export interface FundingResult {
  readonly outcome: FundingOutcome;
  /**
   * The funding transaction's hash, when the funder named one.
   *
   * `undefined` for the funders that report a success without naming a transaction -
   * friendbot's "already funded" answer short-circuits before paying anything, so
   * there is nothing to name, and a treasury funder that queues its payments has not
   * got a hash yet either. It is carried anyway because for the funders that *do*
   * create the account it is the only record of what the XLM came from, and "which
   * transaction funded this account" is the first question anyone auditing Step 19
   * asks.
   */
  readonly transactionHash: string | undefined;
}

export interface AccountFunder {
  /**
   * A short, non-sensitive name for the funder, for log lines: `friendbot`,
   * `treasury`. Not a URL - a URL in a log is an invitation to paste a
   * misconfigured one into a bug report and call it a diagnosis.
   */
  readonly kind: string;

  /**
   * Creates `publicKey` on the network with a starting XLM balance, or reports that
   * it is already there.
   *
   * `publicKey`, never a secret: no funder needs the ability to sign for the account
   * it funds, which is what keeps "who can spend this account's money" a property of
   * KMS custody rather than of whatever the funder is.
   *
   * The contract is deliberately *not* "pays exactly once". Friendbot's two
   * endpoints disagree about repeats - `friendbot.stellar.org` refuses a second
   * request with "already funded to starting balance", while
   * `horizon-testnet.stellar.org/friendbot` pays the starting balance again - and a
   * treasury funder can be built either way. What the port promises is the thing the
   * caller actually needs: after a successful call, the account exists and has XLM.
   * Provisioning therefore calls a funder once per account and never treats funding
   * as a step it can safely repeat for a different reason.
   */
  fund(publicKey: string): Promise<FundingResult>;
}

/**
 * The funding did not happen. Nothing about the account changed, and no key material
 * was touched - the account simply does not exist yet, which is the state it was in
 * before the call.
 */
export class AccountFundingUnavailableError extends Error {
  constructor(
    /** Which account was being funded, so the log line names it. */
    readonly publicKey: string,
    /** A short classification, as `StellarSubmissionUnavailableError` uses. */
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not fund Stellar account ${publicKey}: ${detail}`, options);
    this.name = 'AccountFundingUnavailableError';
  }
}

/**
 * The funder answered, and the answer says something has to change here.
 *
 * Reached in three ways, and they read the same to an operator because the fix is
 * the same shape in all three: the funder refused the request as malformed (its
 * `addr` was not an account - a bug, since the address is generated), the endpoint
 * answered something that is not a funding response (a URL pointing at something
 * else), or there is no funder for this network at all (a public-network deployment
 * with no treasury configured). The last one is the one that must never be a retry:
 * funding a mainnet account from a faucet is not a thing, and the app says so by
 * name rather than by timing out against an endpoint that does not exist.
 */
export class AccountFundingMisconfiguredError extends Error {
  constructor(
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Stellar account funding is misconfigured: ${detail}`, options);
    this.name = 'AccountFundingMisconfiguredError';
  }
}
