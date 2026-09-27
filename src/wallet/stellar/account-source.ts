import type { TransactionSource } from '@stellar/stellar-sdk';

/**
 * Where a transaction's starting sequence number comes from (Step 17).
 *
 * `StellarService` needs exactly one thing from Horizon: the source account as
 * the SDK's `TransactionSource` - an account id, its current sequence number, and
 * the call the SDK makes to advance that number for each transaction built from
 * it. Horizon's own `loadAccount` response *is* a `TransactionSource`, so the port
 * is thin on purpose: there is no reason to invent an intermediate shape, and no
 * reason for the wrapper to depend on the whole Horizon client.
 *
 * The port is what makes the race in Step 17's audit test reachable: a real
 * Horizon is a round trip, and the test needs to hold that round trip open and
 * count how many are in flight for one account. It is also the seam a second
 * Horizon host (the configured fallback) or a cache would be added behind.
 */
export const STELLAR_ACCOUNT_SOURCE = Symbol('STELLAR_ACCOUNT_SOURCE');

export interface StellarAccountSource {
  /**
   * The account as of now: its current sequence number, and a mutable copy that
   * the transaction builder increments as it builds.
   */
  loadAccount(accountId: string): Promise<TransactionSource>;
}

/**
 * Horizon answered, and the account is not there.
 *
 * This is a normal state, not an outage: a Stellar account exists from its first
 * funding transaction onwards, so every freshly generated keypair starts out
 * unknown to the network. Step 19 (provisioning) and Step 20 (balances) both have
 * to tell "not funded yet" apart from "could not reach Horizon", and the
 * difference is only visible here - which is why this is its own error type
 * instead of a generic failure with a message.
 */
export class StellarAccountNotFoundError extends Error {
  constructor(
    readonly accountId: string,
    options?: { cause?: unknown },
  ) {
    super(`Stellar account ${accountId} does not exist on this network`, options);
    this.name = 'StellarAccountNotFoundError';
  }
}

/**
 * Horizon could not answer: unreachable, timed out, 5xx, or a response that is not
 * an account. Distinct from `StellarAccountNotFoundError` because the correct
 * reaction is opposite - retry later, do not report anything about the account's
 * state, and never provision a new account on the strength of a failed lookup.
 */
export class StellarAccountSourceError extends Error {
  constructor(
    readonly accountId: string,
    options?: { cause?: unknown },
  ) {
    super(`Horizon could not load Stellar account ${accountId}`, options);
    this.name = 'StellarAccountSourceError';
  }
}
