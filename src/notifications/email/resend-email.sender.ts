import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEmailAddress } from '../../identity/email/email-address.js';
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSendResult,
  type EmailSender,
} from './email-sender.js';

/**
 * Resend's email API, behind `EmailSender` (Step 34c).
 *
 * `POST https://api.resend.com/emails` with a JSON body and the API key as a
 * `Bearer` token - Resend's own documented cURL, not the SDK. Hand-rolled for the
 * same reason the security headers are: the request is one call with four fields
 * (`from`, `to`, `subject`, `text`), and the `resend` package would add a
 * dependency - and its transitive tree - to send it. Nothing here needs the SDK's
 * types, its batching or its templates, so the transport is a `fetch` behind the
 * interface, exactly as `AfricasTalkingSmsSender` is.
 *
 * `from` arrives on the message rather than being read here: it is one `email.from`
 * value (`EMAIL_FROM`, defaulting to `DEFAULT_EMAIL_FROM`) chosen at the call site,
 * so the sender stays a transport and the wording stays in `NotificationsService`.
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger(ResendEmailSender.name);

  /**
   * So a stuck provider cannot hold a request open. No retry, for the reason
   * `AfricasTalkingSmsSender` has none: this class cannot tell "Resend never saw it"
   * from "Resend sent it and the response was lost", and a retried verification
   * email is a second code delivered for one request.
   */
  private static readonly SEND_TIMEOUT_MS = 10_000;
  private static readonly SEND_URL = 'https://api.resend.com/emails';

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const apiKey = this.config.getOrThrow<string>('notifications.resend.apiKey');

    const response = await this.request(ResendEmailSender.SEND_URL, {
      apiKey,
      to: message.to,
      body: JSON.stringify({
        from: message.from,
        // An array, as the API documents it: the single-recipient form of a send
        // still travels as a one-element list.
        to: [message.to],
        subject: message.subject,
        // `text`, not `html`: the body is the plain-text wording the SMS template
        // mirrors, and nothing here builds markup.
        text: message.body,
      }),
    });

    const payload = await this.readPayload(response, message.to);

    if (!response.ok) {
      throw new EmailDeliveryError(
        `Resend rejected the message for ${maskEmailAddress(message.to)} (HTTP ${
          response.status
        }): ${this.providerMessage(payload)}`,
      );
    }

    const id = payload?.['id'];

    return { providerMessageId: typeof id === 'string' ? id : undefined };
  }

  /**
   * Resend's error wording, or a stand-in when the body carried none. The failures
   * this endpoint returns are `{ statusCode, message, name }`, but a gateway in
   * front of it can answer with something else entirely - hence the guard rather
   * than a direct read.
   */
  private providerMessage(payload: Record<string, unknown> | undefined): string {
    const message = payload?.['message'];

    return typeof message === 'string' && message !== ''
      ? message
      : 'no message in the response body';
  }

  /** Performs the call, translating transport-level failures into `EmailDeliveryError`. */
  private async request(
    url: string,
    options: { apiKey: string; to: string; body: string },
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: options.body,
        signal: AbortSignal.timeout(ResendEmailSender.SEND_TIMEOUT_MS),
      });
    } catch (cause) {
      // DNS, TLS, a dropped connection, or the timeout above. One wording for all
      // of them: the caller cannot act on the difference.
      throw new EmailDeliveryError(
        `Could not reach Resend for ${maskEmailAddress(options.to)}`,
        { cause },
      );
    }
  }

  /**
   * Reads the body as JSON, tolerating one that is not (a gateway's HTML error page
   * is the usual reason) so the failure path can still report something useful
   * instead of throwing a parse error from inside error handling.
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
      // Logged, not returned: the thrown error is what the caller sees, and this
      // endpoint's success body carries an id rather than anything worth echoing.
      this.logger.warn(
        `Non-JSON response from Resend for ${maskEmailAddress(to)} (HTTP ${
          response.status
        }, ${text.length} bytes)`,
      );
      return undefined;
    }
  }
}
