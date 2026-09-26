import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhoneNumber } from '../../common/phone/phone-number.js';
import {
  SmsDeliveryError,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from './sms-sender.js';

/**
 * Africa's Talking's SMS API, behind `SmsSender` (Step 11).
 *
 * `POST {baseUrl}/version1/messaging` with the app's `username`, `to` and
 * `message` form-encoded, and the API key in an `apiKey` *header* - not a
 * username/password pair, which is the other form this API accepts and the one
 * that shows up in most examples online. The key never goes in the URL.
 *
 * The host is resolved in `configuration.ts` rather than written here: the
 * sandbox app is served from `api.sandbox.africastalking.com` and a live account
 * from `api.africastalking.com`, and the key only works on the matching one
 * (verified: the sandbox key is a 401 on the live host).
 *
 * What this class does *not* have: a `from`. Africa's Talking falls back to the
 * account's default sender, which is what the sandbox uses, and a live account
 * needs one registered before launch - that is the one piece of configuration a
 * switch to live will want, and it does not belong in a Day-1 diff.
 */
@Injectable()
export class AfricasTalkingSmsSender implements SmsSender {
  private readonly logger = new Logger(AfricasTalkingSmsSender.name);

  /**
   * The timeout exists so a stuck provider cannot hold a request open, and the
   * absence of a retry is deliberate: this class cannot tell "the provider never
   * saw it" from "the provider sent it and the response was lost", and a retried
   * OTP is a second SMS charge. Retrying is a decision for the caller.
   */
  private static readonly SEND_TIMEOUT_MS = 10_000;
  private static readonly MESSAGING_PATH = '/version1/messaging';

  constructor(private readonly config: ConfigService) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const baseUrl = this.config.getOrThrow<string>('notifications.africasTalking.baseUrl');
    const apiKey = this.config.getOrThrow<string>('notifications.africasTalking.apiKey');
    const username = this.config.getOrThrow<string>('notifications.africasTalking.username');

    // Form-encoded, not JSON: the JSON form of this endpoint expects a different
    // body shape (`to` as an array of recipients) and rejects the simple one.
    const body = new URLSearchParams({
      username,
      to: message.to,
      message: message.body,
    });

    const response = await this.request(`${baseUrl}${AfricasTalkingSmsSender.MESSAGING_PATH}`, {
      apiKey,
      body,
      to: message.to,
    });

    const payload = await this.readPayload(response, message.to);
    const data = payload?.['SMSMessageData'] as
      { Message?: string; Recipients?: Array<Record<string, unknown>> } | undefined;

    if (!response.ok) {
      throw new SmsDeliveryError(
        `Africa's Talking rejected the message for ${maskPhoneNumber(message.to)} (HTTP ${
          response.status
        }): ${data?.Message ?? 'no message in the response body'}`,
      );
    }

    return { providerMessageId: this.recipient(data, message.to)?.messageId };
  }

  /**
   * The recipient block, or a thrown `SmsDeliveryError` if the provider accepted
   * the request but will not deliver the message.
   *
   * A 2xx from this endpoint means the *request* was accepted, not that the
   * message was queued: the per-recipient `status` is what says that, and it is
   * `Success` (statusCode 101) on the happy path. Anything else - an invalid
   * number, a blacklisted recipient - is a send that will never arrive, and
   * answering "we sent you a code" for it would leave the user waiting for an SMS
   * that is not coming, which is the one failure this flow cannot afford.
   */
  private recipient(
    data: { Recipients?: Array<Record<string, unknown>> } | undefined,
    to: string,
  ): { status?: string; statusCode?: number; messageId?: string } | undefined {
    const recipient = data?.Recipients?.[0] as
      { status?: string; statusCode?: number; messageId?: string } | undefined;

    if (recipient?.status !== undefined && recipient.status !== 'Success') {
      throw new SmsDeliveryError(
        `Africa's Talking did not queue the message for ${maskPhoneNumber(to)}: ${
          recipient.status
        } (statusCode ${recipient.statusCode ?? 'unknown'})`,
      );
    }

    return recipient;
  }

  /** Performs the call, translating transport-level failures into `SmsDeliveryError`. */
  private async request(
    url: string,
    options: { apiKey: string; body: URLSearchParams; to: string },
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          apiKey: options.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: options.body,
        signal: AbortSignal.timeout(AfricasTalkingSmsSender.SEND_TIMEOUT_MS),
      });
    } catch (cause) {
      // DNS, TLS, a dropped connection, or the timeout above. One wording for all
      // of them: the caller cannot act on the difference.
      throw new SmsDeliveryError(
        `Could not reach Africa's Talking for ${maskPhoneNumber(options.to)}`,
        { cause },
      );
    }
  }

  /**
   * Reads the body as JSON, tolerating one that is not (a gateway's HTML error
   * page is the usual reason) so the failure path can still report something
   * useful instead of throwing a parse error from inside error handling.
   */
  private async readPayload(
    response: Response,
    to: string,
  ): Promise<Record<string, unknown> | undefined> {
    const text = await response.text();

    if (text === '') {
      return undefined;
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Logged, not returned: this endpoint echoes the recipient number back, and
      // the thrown error is what the caller sees.
      this.logger.warn(
        `Non-JSON response from Africa's Talking for ${maskPhoneNumber(to)} (HTTP ${
          response.status
        }, ${text.length} bytes)`,
      );
      return undefined;
    }
  }
}
