/**
 * The email boundary (Step 34c).
 *
 * Everything that wants to send an email depends on this interface, never on a provider,
 * exactly as everything that sends a text depends on `SmsSender`: `NotificationsService`
 * injects the `EMAIL_SENDER` token and knows nothing about SMTP hosts, API keys or
 * `Message-ID`s. Swapping providers is then one `useClass` in `NotificationsModule` and no
 * change at a call site - which is why the e2e tests replace *this binding* rather than
 * reaching into a network.
 *
 * The interface is deliberately one method, for the reason `SmsSender`'s is: a sender that
 * also did templates, bounce handling or delivery reports would be one provider's API
 * leaking into the contract, and every future swap would have to satisfy all of it.
 */

/**
 * DI token for the binding.
 *
 * A `Symbol` rather than a string, so a provider registered under a similar name elsewhere
 * cannot collide with it.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  /**
   * Recipient address, normalized (trimmed, lower-cased) before it reaches here.
   *
   * Normalization happened at the edge (`normalizeEmailAddress`, Step 34c), so the sender
   * never has to guess which spelling it was handed.
   */
  to: string;

  /** The address the message is sent from. One `email.from` value, read at the call site. */
  from: string;

  /** Subject line. Short, and never carrying a secret. */
  subject: string;

  /** Plain-text body. The code or the receipt wording is inline, as the SMS template is. */
  body: string;
}

export interface EmailSendResult {
  /**
   * The provider's own id for the message, when it returns one. Kept for logs and for a
   * support conversation with the provider - neither persisted nor required.
   */
  providerMessageId?: string;
}

export interface EmailSender {
  /**
   * Hands the message to the provider.
   *
   * Resolves when the provider has *accepted* the message, which is not the same as
   * delivered - no email provider promises delivery on the request. Rejects with
   * `EmailDeliveryError` when it is known not to have been accepted, so the caller can tell
   * "we sent it" from "nobody is going to receive this".
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * The provider did not accept the message. Thrown by every `EmailSender` implementation,
 * whatever the underlying failure, so calling code never has to interpret a provider's
 * error body - and never accidentally treats a rejected send as a delivered one.
 *
 * `reason` is safe to log but is *not* forwarded to the API caller verbatim: it can name the
 * recipient and quote the provider, and the global exception filter answers a 5xx with a
 * generic message for exactly that reason.
 */
export class EmailDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailDeliveryError';
  }
}
