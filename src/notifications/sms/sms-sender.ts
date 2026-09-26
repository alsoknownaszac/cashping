/**
 * The SMS boundary (Step 11).
 *
 * Everything that wants to send a text depends on this interface, never on
 * Africa's Talking: `NotificationsService` injects the `SMS_SENDER` token and
 * knows nothing about hosts, `apiKey` headers or `SMSMessageData`. Swapping
 * providers is then one `useClass` in `NotificationsModule` and no change at any
 * call site - which is the whole point of drawing the line here rather than
 * calling `fetch` from the notification service.
 *
 * The interface is deliberately one method. A sender that also does delivery
 * reports, templates or sender IDs would be a provider API leaking into the
 * contract, and every future swap would have to satisfy all of it.
 */

/**
 * DI token for the binding.
 *
 * A `Symbol` rather than a string, so a provider registered under a similar name
 * elsewhere in the app cannot collide with it.
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsMessage {
  /**
   * Recipient in strict E.164 (`+233241234567`).
   *
   * E.164 is the only format every provider accepts, and the one the database
   * stores, so the sender never has to guess what it was handed - normalization
   * happened at the edge (Step 9).
   */
  to: string;

  /**
   * Message text. Kept to a single GSM-7 segment where possible: each extra
   * segment is a separate charge, and an em-dash or a curly quote silently turns
   * one segment into two (UCS-2) - which is why the OTP template is plain ASCII.
   */
  body: string;
}

export interface SmsSendResult {
  /**
   * The provider's own id for the message, when it returns one. Kept for logs
   * and for a support conversation with the provider - not persisted on Day 1.
   */
  providerMessageId?: string;
}

export interface SmsSender {
  /**
   * Hands the message to the provider.
   *
   * Resolves when the provider has *accepted* the message, which is not the same
   * as delivered - no SMS provider promises delivery on the request. Rejects with
   * `SmsDeliveryError` when it is known not to have been accepted, so the caller
   * can tell "we sent it" from "nobody is going to receive this".
   */
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/**
 * The provider did not accept the message. Thrown by every `SmsSender`
 * implementation, whatever the underlying failure, so calling code never has to
 * interpret a provider's error body - and never accidentally treats a rejected
 * send as a delivered one.
 *
 * `reason` is safe to log but is *not* forwarded to the API caller verbatim: it
 * can name the recipient and quote the provider, and the global exception filter
 * answers a 5xx with a generic message for exactly that reason.
 */
export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SmsDeliveryError';
  }
}
