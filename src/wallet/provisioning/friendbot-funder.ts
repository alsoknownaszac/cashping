import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountFundingMisconfiguredError,
  AccountFundingUnavailableError,
  type AccountFunder,
  type FundingResult,
} from './account-funder.js';

/**
 * The Testnet faucet, bound as `ACCOUNT_FUNDER` (Step 19).
 *
 * `friendbot` is Stellar's Testnet faucet: a plain HTTP endpoint that pays a new
 * account its starting balance. It is what makes Step 19 possible without an
 * operator in the loop on Testnet, and it is emphatically not a production funder -
 * there is no friendbot on the public network, which is why the URL is config
 * (`STELLAR_FRIENDBOT_URL`) and why a production deployment binds a treasury funder
 * here instead.
 *
 * ## The two endpoint shapes, verified against Testnet
 *
 * The configured URL is used as a base with `?addr=<public key>` appended, so it
 * works for the shapes that actually exist:
 *
 * - `https://friendbot.stellar.org` - the canonical one. A first request answers
 *   `200 {"successful":true,"hash":...,"ledger":...}`; a second one for the same
 *   account answers `400` with a problem document whose `detail` is
 *   `account already funded to starting balance`.
 * - `https://horizon-testnet.stellar.org/friendbot` - Horizon serves the same
 *   faucet on a path. It has no such guard: asked for an already-funded account it
 *   answers `200` and pays the starting balance *again* (measured: a balance of
 *   9,999.99998 XLM came back as 19,999.99998).
 *
 * That second behaviour is the reason `fund` reports an *outcome* rather than a
 * boolean, and why provisioning calls it once per account. It is also why an
 * `already-funded` answer is a success: the caller asked for an account with XLM on
 * it, and both endpoints leave it that way.
 *
 * ## Failures
 *
 * Classification is by status and by what the funder said, in the same two groups
 * `AccountFunder` documents:
 *
 * - transport failure, timeout, `429`, `5xx`, or a `200` that reports an
 *   unsuccessful funding → `AccountFundingUnavailableError` (retry later; nothing
 *   happened).
 * - any other non-2xx, or a `200` whose body is not a funding response at all →
 *   `AccountFundingMisconfiguredError` (a human has to change something).
 *
 * The distinction is not cosmetic. A `400` here is usually `extras.invalid_field:
 * addr`, which can only happen if the app handed over an address it generated
 * itself - a bug, and one that a retry loop would turn into an infinite one - while
 * a `5xx` from a faucet that is briefly down is a retry.
 */
@Injectable()
export class FriendbotFunder implements AccountFunder {
  readonly kind = 'friendbot';

  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.endpoint = config.getOrThrow<string>('stellar.friendbotUrl');
  }

  async fund(publicKey: string): Promise<FundingResult> {
    const response = await this.request(publicKey);
    // The body is read exactly once, before any branch, because a `Response` is a
    // stream: a second `json()` call on the same body throws.
    const body = await readJsonObject(response);

    if (response.ok) {
      if (body !== undefined && body.successful === false) {
        throw new AccountFundingUnavailableError(
          publicKey,
          `friendbot answered HTTP ${response.status} but reported an unsuccessful funding`,
        );
      }

      if (body === undefined) {
        // A 2xx whose body is not a funding response: an HTML page from a proxy, a
        // URL pointing at the wrong service. Claiming success here would hand the
        // caller an account that may not exist, so it is not claimed.
        throw new AccountFundingMisconfiguredError(
          `friendbot answered HTTP ${response.status} with a body that is not a funding response`,
        );
      }

      return { outcome: 'funded', transactionHash: asString(body.hash) };
    }

    if (response.status === 400 && isAlreadyFunded(body)) {
      return { outcome: 'already-funded', transactionHash: asString(body?.hash) };
    }

    const detail = `friendbot answered HTTP ${response.status}${describeProblem(body)}`;

    if (response.status >= 500 || response.status === 429) {
      throw new AccountFundingUnavailableError(publicKey, detail);
    }

    throw new AccountFundingMisconfiguredError(detail);
  }

  /**
   * One request, bounded in time, with transport failures classified.
   *
   * The bound is explicit because Node's `fetch` has none worth relying on: undici's
   * default is a 300-second body timeout, which is indistinguishable from a hang for
   * anything user-facing. There is no retry here either - retrying belongs to the
   * provisioning flow, which knows the account and the deadline, and a funder that
   * retries on its own makes the flow's deadline meaningless.
   */
  private async request(publicKey: string): Promise<Response> {
    try {
      return await fetch(friendbotEndpoint(this.endpoint, publicKey), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FRIENDBOT_REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new AccountFundingUnavailableError(publicKey, describeRequestFailure(cause), { cause });
    }
  }
}

/**
 * How long a single funder request may take.
 *
 * A constant rather than a config key: it describes what an HTTP request to a faucet
 * is allowed to cost, not something a deployment tunes. The *flow* bound is the
 * configurable one (`STELLAR_PROVISIONING_TIMEOUT_MS`), and it is deliberately
 * larger than this, so the per-request bound normally fires first and the flow bound
 * is the backstop for a funder that never answers at all.
 */
export const FRIENDBOT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The funder's URL for one account.
 *
 * `URL` rather than string concatenation so the account id is escaped, and
 * `searchParams.set` rather than appending so a configured URL that already carries
 * a query string (an API key, say) keeps it instead of producing a second `?`.
 */
export function friendbotEndpoint(friendbotUrl: string, publicKey: string): string {
  const url = new URL(friendbotUrl);
  url.searchParams.set('addr', publicKey);

  return url.toString();
}

/**
 * Whether a `400` means "this account already has its starting balance".
 *
 * Two spellings, because two endpoints answer here. Friendbot proper says so in
 * prose (`account already funded to starting balance`); a Horizon body - reachable by
 * configuring the `/friendbot` path while something upstream still refuses the
 * transaction - says it with `op_already_exists` in `extras.result_codes.operations`.
 * Matching prose is normally a bad idea; it is acceptable here because the fallback
 * is "treat it as a misconfiguration and stop", which is the safe direction if the
 * wording ever changes.
 */
function isAlreadyFunded(body: JsonObject | undefined): boolean {
  const detail = asString(body?.detail);

  if (detail !== undefined && /already funded|already exists/i.test(detail)) {
    return true;
  }

  const extras = body?.extras;

  if (!isJsonObject(extras)) {
    return false;
  }

  const resultCodes = extras.result_codes;

  if (!isJsonObject(resultCodes)) {
    return false;
  }

  const operations = resultCodes.operations;

  return Array.isArray(operations) && operations.includes('op_already_exists');
}

/**
 * The part of an error document worth putting in a log line.
 *
 * `extras.reason` first because it is the specific one (`invalid address: must be a
 * valid G or C address`), then `detail`, which is often generic ("The request you
 * sent was invalid in some way."). Trimmed and length-bounded: this string comes
 * from a remote service and ends up in logs, so it is summarised rather than
 * embedded whole.
 */
function describeProblem(body: JsonObject | undefined): string {
  const extras = body?.extras;
  const reason = isJsonObject(extras) ? asString(extras.reason) : undefined;
  const summary = reason ?? asString(body?.detail);

  return summary === undefined ? '' : ` (${bound(summary)})`;
}

/** A transport-level failure of the funder request, in a few safe words. */
function describeRequestFailure(cause: unknown): string {
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return `did not answer within ${FRIENDBOT_REQUEST_TIMEOUT_MS} ms`;
  }

  if (cause instanceof Error && cause.message !== '') {
    return `could not be reached (${cause.constructor.name}: ${bound(cause.message)})`;
  }

  return 'could not be reached';
}

async function readJsonObject(response: Response): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = await response.json();

    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    // A non-JSON body is not an error in itself: it is the signal that this URL is
    // not answering funding requests, which the caller classifies by status.
    return undefined;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Collapses whitespace and caps the length, for remote text headed to a log. */
function bound(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();

  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}
