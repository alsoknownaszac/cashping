import { ApiProperty } from '@nestjs/swagger';
import { StellarNetwork } from '../../config/validation.schema.js';

/**
 * 200 body of `GET /v1/wallet/account` (Step 20): who this user is on Stellar.
 *
 * The endpoint answers "what is my wallet", which `GET /v1/wallet/balance` deliberately
 * does not: that one answers "what is in it". So what is here is the address to be paid at,
 * the network it is an address *on*, and the two facts that decide whether the balance
 * endpoint's numbers mean anything yet.
 *
 * `network` is part of the body rather than something the client knows, because the same
 * public key is a different account on Testnet and on the public network - a wallet screen
 * that showed a Testnet address without saying so would be showing a string that receives
 * nothing.
 *
 * `funded` is the honest version of a state a boolean business usually fudges: a row exists
 * (provisioning created the keypair and sealed it) while the network has never seen the key
 * (the funding transaction did not land). Every number below is then `null`, because an
 * account that does not exist does not have a balance of zero - and a client that showed
 * "0.00 XLM, 0.00 USDC" for it would be telling the user their wallet is empty rather than
 * mid-setup.
 *
 * `nativeBalance` is XLM, and it is here rather than in the balance endpoint because it is
 * not what the user came for: it is what pays fees, so it is a property of the account's
 * readiness. The balance endpoint reports the money - USDC - and nothing else.
 */
export class AccountResponseDto {
  @ApiProperty({
    description: "The `stellar_accounts` row id: this app's handle for the wallet.",
    example: '3f1c2a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f',
  })
  accountId!: string;

  @ApiProperty({
    description:
      'The public key, in `G...` form: the address this wallet is paid at, and the only value here that is safe to share.',
    example: 'GCEKPAYY2BODURJDT6V4YP2QPB27RQTPJMWB2T2EFXPGMHSFGX5Q7CUT',
  })
  publicKey!: string;

  @ApiProperty({
    description:
      'The network this key is an account on. `TESTNET` funds from a faucet; a `PUBLIC` key with the same characters is a different, unfunded account.',
    enum: StellarNetwork,
    example: StellarNetwork.Testnet,
  })
  network!: StellarNetwork;

  @ApiProperty({
    description: 'When the wallet was provisioned (the account row was written).',
    example: '2026-09-29T03:00:41.512Z',
  })
  createdAt!: string;

  @ApiProperty({
    description:
      'Whether the Stellar network knows this account. `false` means provisioning did not get past funding: the row is real and retryable, and both balances are `null`.',
    example: true,
  })
  funded!: boolean;

  @ApiProperty({
    description:
      'The XLM balance, as Horizon reports it (7 decimal places, exactly the string the ledger answered with). `null` when `funded` is false. XLM is what pays transaction fees.',
    example: '9999.9999900',
    nullable: true,
    type: String,
  })
  nativeBalance!: string | null;
}
