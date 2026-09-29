import { AssetType } from '@stellar/stellar-sdk';
import type { UsdcAssetIdentity } from '../provisioning/usdc-trustline.js';
import type { StellarBalanceLine } from '../stellar/account-source.js';

/**
 * The three states a USDC trustline can be in (Step 20).
 *
 * Three, not a boolean, because they are three different things to do about it:
 *
 * - `active` - the line is there and the issuer authorises it, so USDC can be received and
 *   whatever `balance` says is the truth about the money.
 * - `unauthorized` - the line exists but the issuer has not authorised it, which is what a
 *   trustline to an `AUTH_REQUIRED` issuer looks like before it is approved. Money sent to
 *   the account is rejected at the *sender*, and the balance stays 0.0000000 meanwhile, so
 *   this is exactly the state a number alone cannot distinguish from "empty".
 * - `missing` - there is no line for this asset, so no USDC can arrive at all. Step 19
 *   exists to make this impossible by the time a user can see a balance; it is still
 *   reported, because "provisioning stopped between funding and the trustline" is a real
 *   state and the honest answer is that there is nothing to report a balance *of*.
 *
 * The order is also the order of severity, which is why they are a tuple: it is the source
 * of the enum the API documents, so the two cannot drift.
 */
export const TRUSTLINE_STATUSES = ['active', 'unauthorized', 'missing'] as const;

export type TrustlineStatus = (typeof TRUSTLINE_STATUSES)[number];

/**
 * The USDC line of one account, from Horizon's own report of it.
 *
 * `balance` and `limit` are Horizon's strings, not numbers: Stellar amounts are 7-decimal
 * fixed point and the largest legal balance (`922337203685.4775807`) is not exactly
 * representable as a double. Parsing them would round every balance a user is shown, which
 * is the one thing a money endpoint must not do - and it would do it invisibly.
 *
 * Both are `null` only when `status` is `missing`, because there is no line to read them
 * from. `0.0000000` and `null` are therefore different answers, and the difference is the
 * whole reason this module exists: "you have no USDC" and "nothing can be paid to you in
 * USDC" are not the same sentence.
 */
export interface UsdcLine {
  readonly status: TrustlineStatus;
  /** The USDC the account holds, as Horizon's decimal string. */
  readonly balance: string | null;
  /** The trustline's ceiling, as Horizon's decimal string. */
  readonly limit: string | null;
}

/** What one wallet holds, from one Horizon answer. */
export interface WalletBalances {
  /**
   * XLM, as Horizon's decimal string.
   *
   * Reported for two reasons: it is what pays fees, so a wallet at zero cannot send
   * anything until it is topped up, and it is the number Step 19's funding step moves -
   * which is what makes a *cached* balance visible as wrong.
   *
   * `null` when the account is not on the ledger at all, which is the only honest value: an
   * unfunded account does not have a balance of zero, it has no balance.
   */
  readonly native: string | null;
  readonly usdc: UsdcLine;
}

/** The line that is not there, in the shape the line that is there would have taken. */
const NO_LINE: UsdcLine = { status: 'missing', balance: null, limit: null };

/**
 * Projects Horizon's balance lines onto the two numbers a wallet endpoint reports.
 *
 * Pure, total and offline: a list of lines goes in, a `WalletBalances` comes out, and the
 * only thing it can do with a well-formed input is answer - there is no branch that throws
 * and no lookup that can fail. That is deliberate, because this is the code that decides
 * *what a balance is*, and Step 20's audit compares its output against Horizon: the
 * comparison is only meaningful if the mapping between the two is small enough to read in
 * one screen and keeps no state of its own.
 *
 * An empty list is a valid input and produces the unfunded answer (`null`, `missing`),
 * which is how the service reports an account whose row exists but whose funding never
 * completed - one code path for both, rather than a special case.
 *
 * ## Matching, and what does not match
 *
 * The USDC line is the one whose `asset_code` *and* `asset_issuer` are this deployment's.
 * Both halves are compared because both halves are the asset's identity: a `USDC` line from
 * a different issuer is a different asset, and a trustline for it cannot receive the USDC
 * this app pays in. Such a line reads as `missing` here, which is the correct answer to the
 * question the endpoint asks ("can this wallet be paid in our USDC") even though a line by
 * that name exists.
 *
 * Liquidity-pool share lines carry neither a code nor an issuer, and native carries no
 * issuer, so neither can match by accident. The first matching line wins; Stellar allows
 * only one trustline per (account, asset), so a second match is not a state this has to
 * have an opinion about.
 */
export function readBalances(
  lines: readonly StellarBalanceLine[],
  asset: UsdcAssetIdentity,
): WalletBalances {
  const native = lines.find((line) => line.asset_type === AssetType.native);
  const usdc = lines.find((line) => isLineFor(line, asset));

  return {
    native: native?.balance ?? null,
    usdc:
      usdc === undefined
        ? NO_LINE
        : {
            /**
             * `=== false` rather than `!is_authorized`: Horizon only reports the flag for
             * credit lines, and a Horizon that omitted it altogether would otherwise turn
             * every healthy wallet into an "unauthorized" one. Absence of evidence is not
             * evidence of a missing authorisation, and the direction of that mistake
             * matters - one of the two sends a user to support for nothing.
             */
            status: usdc.is_authorized === false ? 'unauthorized' : 'active',
            balance: usdc.balance,
            limit: usdc.limit ?? null,
          },
  };
}

/** Whether one Horizon line is the asset `asset` names. */
function isLineFor(line: StellarBalanceLine, asset: UsdcAssetIdentity): boolean {
  return line.asset_code === asset.code && line.asset_issuer === asset.issuer;
}
