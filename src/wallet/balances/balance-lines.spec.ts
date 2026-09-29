import { describe, expect, it } from 'vitest';
import type { UsdcAssetIdentity } from '../provisioning/usdc-trustline.js';
import type { StellarBalanceLine } from '../stellar/account-source.js';
import { readBalances } from './balance-lines.js';

/**
 * The mapping Step 20's audit compares against Horizon, so it is tested for the answers it
 * gives *and* for the shapes it refuses to fold together.
 *
 * Horizon's lines are written out here as literals rather than built by the SDK, because
 * these are wire values: the point of the module is what it does with what the network
 * says, and a helper that constructed them would be one more thing to trust.
 */

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER_ISSUER = 'GDHU7JBSJQXH7BRJQGVTLP3XAOJDZDWVOXFGVLTFJKQFXSHDDCTKVRP';

const USDC: UsdcAssetIdentity = { code: 'USDC', issuer: ISSUER };

function native(balance = '9999.9999900'): StellarBalanceLine {
  return { asset_type: 'native', balance };
}

function usdcLine(overrides: Partial<StellarBalanceLine> = {}): StellarBalanceLine {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: ISSUER,
    balance: '0.0000000',
    limit: '922337203685.4775807',
    is_authorized: true,
    ...overrides,
  };
}

describe('readBalances', () => {
  it('reports the native balance and the USDC line as Horizon wrote them', () => {
    const balances = readBalances([native(), usdcLine()], USDC);

    expect(balances).toEqual({
      native: '9999.9999900',
      usdc: { status: 'active', balance: '0.0000000', limit: '922337203685.4775807' },
    });
  });

  it('does not parse a balance: the largest legal one survives unchanged', () => {
    // The value is the reason the type is a string. Round-tripping it through a double
    // gives 922337203685.4775 - the last two decimal places are simply gone - and a money
    // endpoint that rounded every balance by a fraction of a unit is worse than one whose
    // field looks unusual.
    const balances = readBalances([native('922337203685.4775807')], USDC);

    expect(balances.native).toBe('922337203685.4775807');
    expect(String(Number(balances.native))).not.toBe(balances.native);
  });

  it('reports an unauthorised line as unauthorized, and still reports its balance', () => {
    // A line the issuer has not approved: payments to the account are rejected at the
    // sender, and the number here is 0.0000000 either way - which is exactly the state a
    // number alone cannot distinguish from an empty wallet.
    const balances = readBalances([native(), usdcLine({ is_authorized: false })], USDC);

    expect(balances.usdc.status).toBe('unauthorized');
    expect(balances.usdc.balance).toBe('0.0000000');
  });

  it('treats a line with no authorisation flag as active, not as unauthorised', () => {
    // Horizon reports `is_authorized` on credit lines; a response that omitted it must not
    // turn every healthy wallet into a support ticket. Absence of evidence is not evidence
    // of a missing authorisation.
    const balances = readBalances([usdcLine({ is_authorized: undefined })], USDC);

    expect(balances.usdc.status).toBe('active');
  });

  it('answers "nothing can be paid in" as missing, with no balance rather than a zero', () => {
    const balances = readBalances([native()], USDC);

    expect(balances.usdc).toEqual({ status: 'missing', balance: null, limit: null });
    // The XLM is still reported: an unfunded USDC side does not make the account's XLM
    // unknown.
    expect(balances.native).toBe('9999.9999900');
  });

  it('does not mistake a USDC line from another issuer for this asset', () => {
    // `USDC:GBBD…` and `USDC:GDHU…` are two different assets that share a code. The
    // endpoint's question is whether *our* USDC can arrive, and the answer for this wallet
    // is no - even though a line by that name exists.
    const balances = readBalances([usdcLine({ asset_issuer: OTHER_ISSUER })], USDC);

    expect(balances.usdc).toEqual({ status: 'missing', balance: null, limit: null });
  });

  it('ignores lines for other assets, and lines that are not assets at all', () => {
    const balances = readBalances(
      [
        native(),
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: ISSUER,
          balance: '5.0000000',
          limit: '100.0000000',
          is_authorized: true,
        },
        // A liquidity-pool share: no code, no issuer, and nothing here may treat it as a
        // balance of ours.
        {
          asset_type: 'liquidity_pool_shares',
          balance: '12.3456789',
          limit: '100.0000000',
        },
      ],
      USDC,
    );

    expect(balances.usdc.status).toBe('missing');
    expect(balances.native).toBe('9999.9999900');
  });

  it('answers the empty list as an account that is not on the ledger', () => {
    // The answer for a row whose funding never landed, produced by the same code path as
    // every other input - `null` and `missing`, never 0.
    const balances = readBalances([], USDC);

    expect(balances).toEqual({
      native: null,
      usdc: { status: 'missing', balance: null, limit: null },
    });
  });

  it('reports a trustline with no limit field as a null limit, not a zero', () => {
    const balances = readBalances([usdcLine({ limit: undefined })], USDC);

    expect(balances.usdc.limit).toBeNull();
    expect(balances.usdc.balance).toBe('0.0000000');
  });
});
