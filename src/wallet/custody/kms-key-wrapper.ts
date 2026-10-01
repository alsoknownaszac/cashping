import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DescribeKeyCommand,
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { describeError, markBootStage } from '../../common/boot/boot-log.js';
import { NodeEnvironment } from '../../config/validation.schema.js';
import {
  KmsKeyNotFoundError,
  KeyCustodyUnavailableError,
  type KeyDescription,
  type KeyWrapper,
  type UnwrapDataKeyRequest,
  type WrapDataKeyRequest,
  type WrappedDataKey,
} from './key-wrapper.js';
import { SecretEnvelopeError } from './secret-envelope.js';

/**
 * Everything the client needs, read from validated config.
 *
 * Credentials are passed explicitly rather than left to the SDK's environment
 * lookup: the schema already requires `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
 * and passing them means the client the app builds uses the same values the rest of
 * the app validated - not whatever else happens to be in the ambient environment.
 */
export interface KmsClientOptions {
  readonly region: string;
  /** Set only for a non-AWS endpoint. Production refuses a value (see the schema). */
  readonly endpointUrl?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type KmsClientFactory = (options: KmsClientOptions) => KMSClient;

/**
 * The seam `KmsKeyWrapper`'s spec substitutes for a client whose `send` it controls,
 * so every branch of the error mapping is testable with no network. Production binds
 * the real constructor below, in `WalletModule`.
 */
export const KMS_CLIENT_FACTORY = Symbol('KMS_CLIENT_FACTORY');

/**
 * Builds the real client.
 *
 * `endpoint` is only set when an endpoint is configured. That one option is the
 * whole of the local-emulator story: the SDK honours `endpoint` for every call, and
 * with it unset the client talks to the regional AWS endpoint it derives from
 * `region` - which is also why a *region* mistake is invisible until a call fails.
 */
export const createKmsClient: KmsClientFactory = (options) =>
  new KMSClient({
    region: options.region,
    ...(options.endpointUrl ? { endpoint: options.endpointUrl } : {}),
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

/**
 * How long the boot probe waits for `DescribeKey` before it calls the endpoint dead.
 *
 * A hard cap rather than a nicety. Without one, an endpoint that accepts the socket and
 * then never answers leaves `onModuleInit` pending forever, which stalls `app.init()`,
 * which means the port never binds, which ends the deploy as "no open HTTP ports detected"
 * with nothing in the log - a hang wearing the costume of a network problem.
 *
 * Ten seconds is chosen from both ends: comfortably above the SDK's own connect timeout, so
 * a merely slow answer still arrives and is reported as itself rather than as a timeout, and
 * far below the point where a health check has already given up, so the failure lands in the
 * log as a named line instead of as silence.
 */
const KMS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Fails `operation` with a named error once `timeoutMs` passes without an answer.
 *
 * The timer is unref'd and cleared, so a prompt answer never leaves a stray callback keeping
 * the event loop open - which would surface as a slow shutdown rather than a slow boot, and
 * be blamed on something else entirely. The operation is abandoned rather than cancelled
 * (a promise cannot be cancelled), which is safe for the one caller: `Promise.race` has
 * already attached a rejection handler to the loser, so a late failure is observed by
 * nobody and crashes nothing, and the call being abandoned is a read that leaves no
 * half-applied state behind.
 */
async function withBootTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}


/**
 * The AWS KMS implementation of `KeyWrapper` (Step 18) - the only file in the app
 * that imports `@aws-sdk/client-kms`.
 *
 * It does two things beyond calling KMS: it classifies failures into the three
 * reactions `key-wrapper.ts` documents, and it probes the configured key once at
 * boot. Both are here because this is the only place that can see what KMS actually
 * said.
 *
 * The client is built on first use rather than in the constructor, so that merely
 * instantiating the module graph (which the module spec does) opens no socket. That
 * matters more than it looks: `WalletModule` is imported by `AppModule`, so a
 * constructor that connected would make every unit test depend on KMS.
 */
@Injectable()
export class KmsKeyWrapper implements KeyWrapper, OnModuleInit {
  private readonly logger = new Logger(KmsKeyWrapper.name);
  private kmsClient: KMSClient | undefined;

  private readonly region: string;
  private readonly endpointUrl: string | undefined;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly masterKeyId: string;
  private readonly isProduction: boolean;

  constructor(
    config: ConfigService,
    @Inject(KMS_CLIENT_FACTORY) private readonly createClient: KmsClientFactory,
  ) {
    this.region = config.getOrThrow<string>('aws.region');
    this.endpointUrl = config.get<string>('aws.endpointUrl');
    this.accessKeyId = config.getOrThrow<string>('aws.accessKeyId');
    this.secretAccessKey = config.getOrThrow<string>('aws.secretAccessKey');
    this.masterKeyId = config.getOrThrow<string>('aws.kmsKeyId');
    this.isProduction = config.get<string>('nodeEnv') === NodeEnvironment.Production;
  }

  async wrapDataKey({ accountId }: WrapDataKeyRequest): Promise<WrappedDataKey> {
    try {
      const response = await this.client().send(
        new GenerateDataKeyCommand({
          KeyId: this.masterKeyId,
          KeySpec: 'AES_256',
          EncryptionContext: encryptionContext(accountId),
        }),
      );

      const { Plaintext, CiphertextBlob, KeyId } = response;

      if (!Plaintext || !CiphertextBlob || !KeyId) {
        // KMS is contractually required to return all three. An endpoint that does not
        // is not KMS, and a seed must not be sealed under a key whose reference cannot
        // be recorded - the row would be unopenable later, silently.
        throw new KeyCustodyUnavailableError(
          'wrap',
          'GenerateDataKey returned an incomplete response',
        );
      }

      return {
        dataKey: Buffer.from(Plaintext),
        wrappedDataKey: Buffer.from(CiphertextBlob),
        // The *resolved* key, not the configured name: `KeyId` comes back as a full ARN
        // even when the config named an alias or a bare uuid, which is what makes the
        // per-row reference canonical and comparable.
        keyArn: KeyId,
      };
    } catch (cause) {
      throw this.failure(cause, { operation: 'wrap', accountId, keyId: this.masterKeyId });
    }
  }

  async unwrapDataKey({
    accountId,
    keyArn,
    wrappedDataKey,
  }: UnwrapDataKeyRequest): Promise<Buffer> {
    try {
      const response = await this.client().send(
        new DecryptCommand({
          CiphertextBlob: wrappedDataKey,
          /**
           * Passed even though the blob carries its own key reference: it asserts that
           * this row's recorded key is the key that wrapped it, and KMS answers
           * `IncorrectKeyException` when it is not. That turns "the row and the blob
           * disagree" - which is exactly the rotation mistake worth catching - into an
           * error, instead of quietly decrypting under whatever key the blob names.
           */
          KeyId: keyArn,
          EncryptionContext: encryptionContext(accountId),
        }),
      );

      if (!response.Plaintext) {
        throw new KeyCustodyUnavailableError('unwrap', 'Decrypt returned no plaintext');
      }

      return Buffer.from(response.Plaintext);
    } catch (cause) {
      throw this.failure(cause, { operation: 'unwrap', accountId, keyId: keyArn });
    }
  }

  async describeMasterKey(): Promise<KeyDescription> {
    try {
      const response = await this.client().send(
        new DescribeKeyCommand({ KeyId: this.masterKeyId }),
      );
      const metadata = response.KeyMetadata;

      if (!metadata?.Arn) {
        throw new KeyCustodyUnavailableError('describe', 'DescribeKey returned no key metadata');
      }

      return {
        arn: metadata.Arn,
        region: regionOf(metadata.Arn),
        keyState: metadata.KeyState ?? 'Unknown',
      };
    } catch (cause) {
      throw this.failure(cause, { operation: 'describe', keyId: this.masterKeyId });
    }
  }

  /**
   * The client, built once on first use.
   *
   * Not in the constructor for the reason the class comment gives: instantiating the
   * module graph must not open a socket, or every spec that compiles `WalletModule`
   * would depend on KMS.
   */
  private client(): KMSClient {
    this.kmsClient ??= this.createClient({
      region: this.region,
      endpointUrl: this.endpointUrl,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    });

    return this.kmsClient;
  }

  /**
   * Turns whatever the SDK threw into one of the three reactions, without ever
   * guessing "corruption" from an unfamiliar failure.
   *
   * An error that is already one of ours is returned untouched, so the deliberate
   * throws above (`returned no plaintext`) keep their own message instead of being
   * re-classified into a vaguer one.
   */
  private failure(cause: unknown, context: FailureContext): Error {
    if (
      cause instanceof KeyCustodyUnavailableError ||
      cause instanceof KmsKeyNotFoundError ||
      cause instanceof SecretEnvelopeError
    ) {
      return cause;
    }

    if (classifyKmsFailure(cause) === 'key-not-found') {
      return new KmsKeyNotFoundError(context.keyId, describeFailure(cause), { cause });
    }

    if (classifyKmsFailure(cause) === 'envelope' && context.operation === 'unwrap') {
      // Only the one operation that *had* a stored blob can be about that blob. The reason is
      // `key-mismatch` rather than an authentication failure: nothing was tampered with
      // locally, the key or the context the blob was presented with is not the one that
      // wrapped it.
      return new SecretEnvelopeError('key-mismatch', context.accountId, { cause });
    }

    // Includes blob-class KMS errors on calls that had no blob (`GenerateDataKey` and
    // `DescribeKey`, which cannot fail because of stored data), and every unrecognised
    // failure. Reporting either as corruption is the mis-classification worth designing
    // against: it sends whoever is on call to the rows instead of to AWS.
    return new KeyCustodyUnavailableError(context.operation, describeFailure(cause), { cause });
  }

  /**
   * The boot probe (Step 18).
   *
   * Why it exists: KMS keys are regional and a key is named by an ARN, so the ways to
   * get custody wrong - a key from another region, a key that is disabled or pending
   * deletion, an ARN that does not exist - are invisible until the first account is
   * provisioned. `DescribeKey` plus a comparison against the configured region turns
   * all of them into one boot-time line naming the ARN that actually resolved.
   *
   * What happens on failure is deliberately not one rule:
   *
   * - a **key reference that cannot work** (does not resolve, resolves into another
   *   region, or is in a dead state) aborts startup in production. Every account would
   *   otherwise fail one at a time, later, with nobody watching.
   * - an **unreachable or throttled KMS** is logged and never thrown, in every
   *   environment. This is the rule `main.ts` already applies to Postgres and Redis
   *   (Step 3): a missing dependency must not put the container into a restart loop.
   *   It is safe here for a reason specific to this feature - custody fails closed. A
   *   failed call creates no account, stores no seed, and overwrites nothing.
   *
   * Anything unrecognised is treated as the second case: an unfamiliar failure is not
   * evidence that the key reference is wrong, and guessing wrong sends someone to the
   * wrong place at the worst time.
   */
  async onModuleInit(): Promise<void> {
    let described: KeyDescription;

    try {
      described = await this.probeMasterKey();
    } catch (cause) {
      this.reportUnusableKey(
        cause instanceof Error ? cause.message : String(cause),
        cause instanceof KmsKeyNotFoundError,
      );
      return;
    }

    const resolvedElsewhere = described.region !== undefined && described.region !== this.region;
    const stateIsDead = described.keyState === 'Disabled' || described.keyState === 'PendingDeletion';

    if (resolvedElsewhere || stateIsDead) {
      this.reportUnusableKey(
        resolvedElsewhere
          ? `it resolves to ${described.arn}, in region ${described.region}, but AWS_REGION is ${this.region}`
          : `its state is ${described.keyState}`,
        true,
      );
      return;
    }

    this.logger.log(`KMS master key ready: ${described.arn} (${described.keyState})`);
  }

  /**
   * `describeMasterKey`, narrated and bounded - the probe's own body.
   *
   * Three lines, and the one *before* the call is the point: it is what separates "KMS
   * never answered" from "KMS answered and the answer was wrong", and it is the last marker
   * that will print at all if everything downstream of it stops printing. The timeout turns
   * an endpoint that accepts a connection and then goes quiet into a named failure instead
   * of a boot that never finishes.
   *
   * The elapsed time is included because it is free and it is the one number that says which
   * of the two happened: ~10 000ms is the cap being hit (unreachable), tens of milliseconds
   * is a real answer (wrong key, wrong region, dead key state).
   */
  private async probeMasterKey(): Promise<KeyDescription> {
    markBootStage('calling KMS DescribeKey...');
    const startedAt = Date.now();

    try {
      const described = await withBootTimeout(
        this.describeMasterKey(),
        KMS_PROBE_TIMEOUT_MS,
        'KMS DescribeKey',
      );

      markBootStage(
        `KMS DescribeKey answered in ${Date.now() - startedAt}ms: ${described.arn} (${described.keyState})`,
      );

      return described;
    } catch (cause) {
      markBootStage(
        `KMS DescribeKey failed after ${Date.now() - startedAt}ms - ${describeError(cause)}`,
      );

      throw cause;
    }
  }

  /**
   * The one place the abort-or-log decision is made, so its two callers cannot drift.
   *
   * `misconfigured` is the only thing that can abort, and only in production: it means
   * "this key reference cannot work", as opposed to "KMS did not answer".
   */
  private reportUnusableKey(detail: string, misconfigured: boolean): void {
    const endpoint = this.endpointUrl ?? `the AWS endpoint for ${this.region}`;
    const message = `KMS master key ${this.masterKeyId} cannot be used for custody: ${detail} (endpoint: ${endpoint})`;

    if (misconfigured && this.isProduction) {
      throw new Error(
        `${message}. Refusing to start in production: key custody that cannot work would fail per account, later, silently.`,
      );
    }

    this.logger.error(
      this.isProduction
        ? `${message}. Continuing: an unreachable or throttled KMS is transient, a restart loop would be worse (Step 3), and custody calls fail closed until it answers.`
        : `${message}. Continuing: outside production this is not fatal, and the first custody call fails closed regardless.`,
    );
  }
}

/** The reactions this mapping recognises. */
export type CustodyFailureKind = 'key-not-found' | 'unavailable' | 'envelope';

/**
 * What a classified failure needs in order to build the right error.
 *
 * A discriminated union rather than one shape with optional fields, because the two
 * callers genuinely have different facts: `describe` has no account at all, and a
 * blob-class failure can only ever come from the one operation that had a blob. Weaving
 * a placeholder account id through the describe path to satisfy a single type would be
 * exactly the kind of pretend-correctness this file is supposed to avoid.
 */
type FailureContext =
  | { readonly operation: 'wrap' | 'unwrap'; readonly accountId: string; readonly keyId: string }
  | { readonly operation: 'describe'; readonly keyId: string };

/**
 * Connection-level failures.
 *
 * These are not KMS errors and carry no `$metadata`: the SDK reports a refused socket
 * as a Node error code, and the surrounding `AggregateError` has an *empty* message, so
 * matching on the message is not an option.
 */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Transport failures that arrive as an error *type* rather than a code. */
const TRANSPORT_NAMES = new Set(['AggregateError', 'TimeoutError']);

/**
 * The key reference does not resolve. `NotFoundException` is what a wrong region, a
 * deleted key and a bad ARN all look like; `InvalidArnException` is a malformed one.
 */
const KEY_REFERENCE_NAMES = new Set(['NotFoundException', 'InvalidArnException']);

/**
 * The blob and the key/context it was presented with do not belong together.
 *
 * `IncorrectKeyException` is the row-versus-blob disagreement - what a botched rotation
 * looks like. `InvalidCiphertextException` covers the rest, including a *wrong encryption
 * context*: KMS has no separate error for that (the SDK exports no
 * `InvalidEncryptionContextException`), so context tampering and a mangled blob arrive
 * under the same name - which is fine here, because both mean the same thing to the app.
 */
const BLOB_NAMES = new Set(['IncorrectKeyException', 'InvalidCiphertextException']);

/**
 * Which reaction a KMS failure demands.
 *
 * Exported because it is the part of this file worth testing on its own: the spec feeds
 * it real SDK exceptions and thrown `AggregateError`s and asserts the mapping with no
 * client and no network in the picture.
 *
 * The last line is the deliberate part. Everything unrecognised - throttling, a policy
 * denial, an expired token, a KMS internal error, something new AWS added last week -
 * is `unavailable`, never `envelope`. The cost of that choice is one extra log line in
 * an incident; the cost of the other choice is paging somebody to inspect key material
 * that was never touched.
 */
export function classifyKmsFailure(error: unknown): CustodyFailureKind {
  const name = nameOf(error);
  const code = codeOf(error);

  if ((code !== undefined && TRANSPORT_CODES.has(code)) || TRANSPORT_NAMES.has(name)) {
    return 'unavailable';
  }

  if (KEY_REFERENCE_NAMES.has(name)) {
    return 'key-not-found';
  }

  if (BLOB_NAMES.has(name)) {
    return 'envelope';
  }

  return 'unavailable';
}

/**
 * A short, non-sensitive description of a failure, for an error message that has to be
 * actionable in a log.
 *
 * Name plus code, not the SDK's message: a refused connection has no message to speak
 * of, and an unfamiliar error's text can carry endpoint internals into a log line.
 * `AggregateError (ECONNREFUSED)` tells an operator the endpoint is down;
 * `NotFoundException` tells them the key reference is wrong.
 */
export function describeFailure(error: unknown): string {
  const name = nameOf(error) || 'unknown error';
  const code = codeOf(error);

  return code !== undefined && code !== name ? `${name} (${code})` : name;
}

/**
 * The region from a KMS key ARN - `arn:<partition>:kms:<region>:<account>:key/<id>` -
 * or `undefined` when the string is not one.
 *
 * `undefined` rather than a throw: this runs on whatever an endpoint answered, and a
 * probe that crashed on an unexpected ARN shape would be its own outage.
 */
export function regionOf(arn: string): string | undefined {
  const [prefix, , service, region] = arn.split(':');

  return prefix === 'arn' && service === 'kms' && region ? region : undefined;
}

/**
 * The KMS encryption context for one account's data key.
 *
 * One key, and it is the account id. Encryption context is *authenticated* but not
 * secret, which is the point: it travels into CloudTrail, so "which account's data key
 * was unwrapped" is answerable later from the audit trail alone.
 */
function encryptionContext(accountId: string): Record<string, string> {
  return { accountId };
}

function nameOf(error: unknown): string {
  return error instanceof Error && typeof error.name === 'string' ? error.name : '';
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;

  return typeof code === 'string' ? code : undefined;
}
