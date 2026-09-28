import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service.js';
import { KEY_WRAPPER, type KeyWrapper } from './key-wrapper.js';
import { SecretEnvelopeError, openEnvelope, parseEnvelope, sealEnvelope } from './secret-envelope.js';

/**
 * A brand-new account with its seed already sealed, ready to be inserted (Step 18).
 *
 * This is the only shape in which a new account leaves this service, and the seed
 * is not in it - by the time a caller can see anything, the plaintext exists only as
 * local variables that have gone out of scope. Step 19 inserts exactly these four
 * columns.
 */
export interface SealedAccount {
  /**
   * The account's primary key, generated *here* rather than left to the database
   * default. The seed is bound to this value as its encryption context and AAD, so
   * the id has to exist before the seed is sealed - a row inserted under an id the
   * envelope was not bound to would be unopenable by construction.
   */
  readonly accountId: string;
  /** The public key: what Horizon and every payment reference. */
  readonly publicKey: string;
  /** The `cp-kms-1` envelope. Never a secret key. */
  readonly encryptedSecretKey: string;
  /** The KMS key that wrapped this account's data key. */
  readonly dataKeyArn: string;
}

/**
 * The columns `openSeed` needs - the shape a `StellarAccount` row has.
 *
 * Declared as exactly what is used rather than taking the generated Prisma type, so
 * a caller holding a projection of the row (or a spec holding a literal) can pass
 * one, and so the function cannot quietly start reading a column it was not given.
 */
export interface SealedAccountRow {
  readonly id: string;
  readonly encryptedSecretKey: string;
  readonly dataKeyArn: string;
}

/**
 * Key custody for Stellar accounts (Step 18): the only code that turns a secret seed
 * into something storable, and the only code that turns it back.
 *
 * Nothing here logs. There is no log line in this file because there is nothing
 * here that is safe to want in a log: the seed is the asset, the data key is the
 * thing that decrypts it, and the envelope is the ciphertext. Every failure travels
 * as an exception to whoever called - Step 19 decides what an operator should see,
 * exactly as `HorizonAccountSource` records for its own errors.
 *
 * Nothing here holds state either. A data key is fetched, used, and zeroed in the
 * same call, and no cache exists: a plaintext data key living in a long-lived field
 * would be the one thing in this process worth stealing. (Cache the *sealed* row if
 * a read ever needs speeding up. Caching a data key is a Step 23 decision, when
 * signature latency is a real number rather than a guess.)
 */
@Injectable()
export class SeedCustodyService {
  constructor(
    @Inject(KEY_WRAPPER) private readonly keys: KeyWrapper,
    /**
     * Only for `generateKeypair`: `StellarService` is the app's single door to the
     * SDK, and key generation is part of that contract rather than something this
     * service should reach around it for.
     */
    private readonly stellar: StellarService,
  ) {}

  /**
   * A new account, sealed and ready to store.
   *
   * The order is deliberate: id, then keypair, then data key, then envelope. The
   * data key is asked for *after* the id exists (it is the encryption context), and
   * the seed is sealed only once both keys are in hand. If any step fails, nothing
   * has been persisted, so there is no half-provisioned account to clean up - which
   * is why this returns the whole row rather than writing anything itself.
   */
  async createSealedAccount(): Promise<SealedAccount> {
    const accountId = randomUUID();
    const keypair = this.stellar.generateKeypair();
    const { dataKey, wrappedDataKey, keyArn } = await this.keys.wrapDataKey({ accountId });

    try {
      return {
        accountId,
        publicKey: keypair.publicKey(),
        encryptedSecretKey: sealEnvelope({
          accountId,
          secretSeed: keypair.secret(),
          dataKey,
          wrappedDataKey,
        }),
        dataKeyArn: keyArn,
      };
    } finally {
      // Every copy of the data key in this process is dead at this point. The
      // `Keypair` object holds the seed for as long as the caller keeps it, which is
      // why it never leaves this method.
      dataKey.fill(0);
    }
  }

  /**
   * The account's keypair, for as long as the caller needs it to sign.
   *
   * The checks are ordered by cost. The envelope is parsed first, so a malformed or
   * unknown-version blob fails without a network call. Then the data key is unwrapped
   * using the ARN *this row* records, which is what makes the reference column worth
   * having. Only then is the ciphertext opened - and because the account id is
   * recomputed into both bindings, a blob copied from another row of the same table
   * cannot be opened here even by someone with write access to Postgres.
   *
   * The caller owns the returned keypair. One hazard is worth having in the code
   * rather than only in a runbook: `JSON.stringify(keypair)` **includes the secret
   * seed** (`String(keypair)` does not), so the result must never be serialised into
   * a log, an error message or a response body.
   */
  async openSeed(row: SealedAccountRow): Promise<Keypair> {
    const parts = parseEnvelope(row.encryptedSecretKey, row.id);

    const dataKey = await this.keys.unwrapDataKey({
      accountId: row.id,
      keyArn: row.dataKeyArn,
      wrappedDataKey: parts.wrappedDataKey,
    });

    try {
      const secretSeed = openEnvelope({ accountId: row.id, parts, dataKey });

      try {
        return Keypair.fromSecret(secretSeed);
      } catch (cause) {
        // The GCM tag verified, so those bytes are ours - but they are not a Stellar
        // seed. That means an envelope written by something other than
        // `sealEnvelope`, i.e. a bug or a hand-edited row, and it must not be reported
        // as if the key material itself had been corrupted.
        throw new SecretEnvelopeError('not-a-seed', row.id, { cause });
      }
    } finally {
      /**
       * The seed itself exists as a JavaScript string from here on, which cannot be
       * zeroed - the language has no way to overwrite one. The mitigations are that
       * nothing in this class logs, stores or returns a string form of it, and the
       * `Keypair` handed back is the only object that holds it.
       */
      dataKey.fill(0);
    }
  }
}
