import type { TransactionSource } from '@stellar/stellar-sdk';

/**
 * The part of a Horizon balance line this app reads (Step 20).
 *
 * A narrowed shape rather than the SDK's `HorizonApi.BalanceLine` union, because the app
 * reads a handful of fields and the union's other member - a liquidity-pool share, which
 * has no code and no issuer at all - is exactly what a filter over these lines has to be
 * able to *skip* rather than fail to represent. Everything but the balance and the asset
 * type is optional for the same reason: a native line has no `asset_code`, a pool-share
 * line has neither code nor issuer, and required fields would make those lines
 * unrepresentable instead of skippable.
 *
 * `balance` is a string and stays one. Stellar amounts are 7-decimal fixed point
 * (`922337203685.4775807` is a legal balance) and `Number()` would silently round it - the
 * same argument `StellarAccountSession` records about sequence numbers, and the reason the
 * API's own balance responses hand back Horizon's string rather than a float.
 */
export interface StellarBalanceLine {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance: string;
  readonly limit?: string;
  readonly is_authorized?: boolean;
}

/**
 * The account as Horizon answers for it: enough to build a transaction *and* enough to
 * report what it holds.
 *
 * One type rather than two because it is one response. `Horizon.Server.loadAccount`
 * returns an `AccountResponse`, which is both a `TransactionSource` (Step 17's need) and
 * the account's balance sheet (Step 20's), so a port that promised only the former would
 * force Step 20 either to make a second round trip for data that arrived with the first
 * or to invent a shape this one already has.
 *
 * The SDK's offline `Account` - a `TransactionSource` with no balances - is deliberately
 * *not* accepted here: a value that did not come from Horizon cannot say what the account
 * holds, and the one thing Step 20 must not do is answer that question from a default.
 */
export type LoadedStellarAccount = TransactionSource & {
  readonly balances: readonly StellarBalanceLine[];
};

/**
 * Where a transaction's starting sequence number comes from, and what the account holds
 * (Steps 17 and 20).
 *
 * `StellarService` needs exactly one thing from Horizon: the source account as the SDK's
 * `TransactionSource` - an account id, its current sequence number, and the call the SDK
 * makes to advance that number for each transaction built from it. Horizon's own
 * `loadAccount` response *is* a `TransactionSource`, so the port is thin on purpose: there
 * is no reason to invent an intermediate shape, and no reason for the wrapper to depend on
 * the whole Horizon client. Step 20 made the response's `balances` part of the port for
 * the other half of the same reason - they arrive with the sequence number.
 *
 * The port is what makes the race in Step 17's audit test reachable: a real Horizon is a
 * round trip, and the test needs to hold that round trip open and count how many are in
 * flight for one account. It is also the seam a second Horizon host (the configured
 * fallback) or a cache would be added behind - and a cache is precisely what Step 20's
 * audit rules out for balances, so the seam has to keep the distinction visible rather
 * than hide it.
 */
export const STELLAR_ACCOUNT_SOURCE = Symbol('STELLAR_ACCOUNT_SOURCE');

export interface StellarAccountSource {
  /**
   * The account as of now: its current sequence number, a mutable copy that the
   * transaction builder increments as it builds, and the balance lines Horizon reported
   * alongside them.
   */
  loadAccount(accountId: string): Promise<LoadedStellarAccount>;
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
