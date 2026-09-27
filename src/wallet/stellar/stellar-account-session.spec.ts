import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  type xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { StellarAccountSession, TRANSACTION_TIMEOUT_SECONDS } from './stellar-account-session.js';

/**
 * The session is where the sequence number actually lives, so these specs pin the
 * three properties the rest of Step 17 leans on: a session starts from the loaded
 * number and builds with the *next* one, every build advances it (so two builds
 * inside one locked section are consecutive, not identical), and everything a
 * caller may leave out - fee, validity window, memo - is defaulted here rather
 * than at each call site.
 *
 * `Account` and `Keypair` are the real SDK objects: the session's contract is the
 * SDK's `TransactionSource`, so a fake one would test the fake.
 */

const ACCOUNT = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();

function sessionAt(sequence = '100'): StellarAccountSession {
  return new StellarAccountSession(new Account(ACCOUNT, sequence), Networks.TESTNET);
}

function payment(amount = '1'): xdr.Operation {
  return Operation.payment({ destination: DESTINATION, asset: Asset.native(), amount });
}

describe('StellarAccountSession', () => {
  it('reports the account it was loaded for', () => {
    expect(sessionAt().accountId).toBe(ACCOUNT);
    expect(sessionAt().sequenceNumber).toBe('100');
  });

  it('builds with the sequence number after the one the account is on', () => {
    expect(sessionAt().build([payment()]).sequence).toBe('101');
  });

  it("handles sequence numbers beyond JavaScript's safe integer range", () => {
    // Real accounts are already past 2^53, which is why this is a string
    // everywhere and never a `number`.
    expect(sessionAt('45000982222299394').build([payment()]).sequence).toBe('45000982222299395');
  });

  it('advances the sequence for each build in the same session', () => {
    const session = sessionAt('100');

    // Consecutive, not identical: this is the whole reason a build happens inside
    // the per-account lock and the session is thrown away afterwards.
    expect(session.build([payment()]).sequence).toBe('101');
    expect(session.sequenceNumber).toBe('101');
    expect(session.build([payment()]).sequence).toBe('102');
    expect(session.sequenceNumber).toBe('102');
  });

  it('carries every operation it is given', () => {
    const transaction = sessionAt().build([payment('1'), payment(), payment()]);

    expect(transaction.operations).toHaveLength(3);
    expect(transaction.source).toBe(ACCOUNT);
  });

  it('defaults the fee to the base fee per operation', () => {
    expect(sessionAt().build([payment()]).fee).toBe(BASE_FEE);
    expect(sessionAt().build([payment(), payment()]).fee).toBe(String(Number(BASE_FEE) * 2));
  });

  it('lets a caller pay more than the base fee', () => {
    // Surge pricing is real on Stellar: a transaction that pays only the base fee
    // can sit unsubmitted during a spike.
    expect(sessionAt().build([payment()], { fee: '1000' }).fee).toBe('1000');
  });

  it('gives the transaction a finite validity window by default', () => {
    const now = Math.floor(Date.now() / 1000);
    const { minTime, maxTime } = sessionAt().build([payment()]).timeBounds ?? {};

    // Valid the moment it is submitted (`minTime` stays 0 - the SDK's `setTimeout`
    // sets the deadline and nothing else), and dead 180 seconds later. Both halves
    // matter: an infinite window makes a transaction replayable forever, and a
    // window that starts in the future would sit pending against a sequence number.
    expect(Number(minTime)).toBe(0);
    expect(Number(maxTime) - now).toBeGreaterThanOrEqual(TRANSACTION_TIMEOUT_SECONDS);
    expect(Number(maxTime) - now).toBeLessThan(TRANSACTION_TIMEOUT_SECONDS + 5);
  });

  it('lets a caller shorten or lengthen the window', () => {
    const now = Math.floor(Date.now() / 1000);
    const { maxTime } = sessionAt().build([payment()], { timeoutSeconds: 30 }).timeBounds ?? {};

    // A shorter window is how a flow that must not be replayed much later (an OTP
    // redemption, say) narrows its exposure.
    expect(Number(maxTime) - now).toBeGreaterThanOrEqual(30);
    expect(Number(maxTime) - now).toBeLessThan(35);
  });

  it('signs for the network it was constructed with', () => {
    const transaction = sessionAt().build([payment()]);

    expect(transaction.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('attaches a memo only when one is given', () => {
    expect(sessionAt().build([payment()]).memo.type).toBe('none');

    const memo = sessionAt().build([payment()], { memo: Memo.text('cashping') }).memo;

    expect(memo.type).toBe('text');
    // A text memo comes back as its UTF-8 bytes once it has been through XDR - the
    // SDK documents `MemoText` values as a `Uint8Array` after `Memo.fromXdrObject` -
    // so the bytes are decoded here rather than the value compared as a string.
    expect(Buffer.from(memo.value as Uint8Array).toString('utf8')).toBe('cashping');
  });

  it('produces a transaction a keypair can sign', () => {
    const keypair = Keypair.random();
    const transaction = sessionAt().build([payment()]);

    transaction.sign(keypair);

    expect(transaction.signatures).toHaveLength(1);
  });

  it('refuses to build a transaction with no operations', () => {
    // Stellar rejects these anyway (`tx_missing_operations`); failing here means
    // the bug is named at the call site that made it.
    expect(() => sessionAt().build([])).toThrowError(/at least one operation/);
  });
});
