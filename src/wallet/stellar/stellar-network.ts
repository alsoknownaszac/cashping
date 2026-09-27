import { Networks } from '@stellar/stellar-sdk';
import { StellarNetwork } from '../../config/validation.schema.js';

/**
 * The network side of the wrapper: which Stellar network this process talks to,
 * and the client options that go with the configured Horizon host.
 *
 * `StellarNetwork` is the *deployment* vocabulary - the enum `STELLAR_NETWORK`
 * is validated against at boot (Step 4). The SDK's vocabulary is a network
 * passphrase, and the passphrase is what gets hashed into every signature: a
 * transaction signed for the wrong one is a perfectly valid transaction on the
 * other network. The two are mapped here, once, explicitly, rather than by
 * matching enum key names - `StellarNetwork.Testnet` and `Networks.TESTNET`
 * happen to line up today, and a renamed member in either package would silently
 * turn that coincidence into a mainnet payment.
 */
export const NETWORK_PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  [StellarNetwork.Testnet]: Networks.TESTNET,
  [StellarNetwork.Public]: Networks.PUBLIC,
};

/**
 * Turns the validated `stellar.network` string back into the enum.
 *
 * The config value is typed as `string`, because `ConfigService` cannot know
 * what the schema enforced, so the narrowing happens here instead of with a cast.
 * It can only fail if the schema and this enum have drifted apart, which is why
 * it throws rather than defaulting: an unknown network has no safe default, and
 * both candidates are real Stellar networks holding real money.
 */
export function parseStellarNetwork(raw: string): StellarNetwork {
  switch (raw) {
    case StellarNetwork.Testnet:
      return StellarNetwork.Testnet;
    case StellarNetwork.Public:
      return StellarNetwork.Public;
    default:
      throw new Error(
        `Unknown STELLAR_NETWORK "${raw}"; expected one of ${Object.values(StellarNetwork).join(', ')}`,
      );
  }
}

/** Passphrase for an already-validated network. */
export function networkPassphraseFor(network: StellarNetwork): string {
  return NETWORK_PASSPHRASES[network];
}

/**
 * Client options for a configured Horizon URL.
 *
 * Horizon is queried with a public key and no credentials, but its *response* is
 * the only thing that says whether a payment landed, so a plain-http endpoint
 * outside this machine is one man-in-the-middle away from a lie about money. The
 * SDK refuses `http:` by default and this keeps that default everywhere except
 * loopback, which is where the fallback slot points (a Stellar node or the
 * `stellar/quickstart` container) and where there is no network to be in the
 * middle of.
 */
export function horizonServerOptions(url: string): { allowHttp: boolean } {
  return { allowHttp: isLoopbackHost(url) };
}

function isLoopbackHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);

    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    // The schema rejects a non-URL at boot; if one reached this far it is not
    // loopback, and the safe answer for an unparseable host is "no plain http".
    return false;
  }
}
