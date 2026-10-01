import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhoneNumber } from '../common/phone/phone-number.js';
import { SMS_SENDER, type SmsSender } from './sms/sms-sender.js';

/**
 * Outbound user-facing messages.
 *
 * The only thing the rest of the app knows about SMS. `AuthService` calls
 * `sendOtp` and gets either "the provider accepted it" or an error - it never
 * learns which provider, which host, or how the message is worded.
 *
 * This is a *delivery* service, not a template engine: the text of the one
 * message this API sends today lives here, next to the code that sends it, so
 * reading this file answers "what does our OTP SMS say".
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    // Injected by token, so the binding (not this class) decides which provider
    // sends the message. See `NotificationsModule`.
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends the verification code (Step 11).
   *
   * `expiresInMinutes` is not a parameter with a default buried in the template:
   * it is read from the same `otp.ttlMinutes` the row's expiry is computed from,
   * because a message that promises a different window to the one the database
   * enforces is a lie the user has no way to notice. The code itself is passed
   * through and never logged - the SMS is the only place it is allowed to exist.
   *
   * Resolves when the provider accepted the message; rejects when it did not, so
   * the caller can decide what an undeliverable code means (it is not a 2xx).
   */
  async sendOtp(phoneNumber: string, code: string): Promise<void> {
    const ttlMinutes = this.config.getOrThrow<number>('otp.ttlMinutes');

    // Plain ASCII and no line breaks: this is one GSM-7 segment (~90 characters
    // with the code), and a decorative character would silently bill two.
    const body = `Cashping: ${code} is your verification code. It expires in ${ttlMinutes} minutes. Never share it with anyone.`;

    const result = await this.smsSender.send({ to: phoneNumber, body });

    this.logger.log(
      `OTP SMS accepted by the provider (to=${maskPhoneNumber(phoneNumber)}${
        result.providerMessageId === undefined ? '' : `, messageId=${result.providerMessageId}`
      })`,
    );
  }

  /**
   * Tells the sender how a payment ended (Step 28).
   *
   * The two sentences, and nothing else: a payment has two endings a customer cares about, and
   * the *failure* wording says what a failure means for the money ("no USDC left your wallet")
   * rather than naming a code - the machine code belongs in the row (`failure_reason`), not in a
   * text to a customer.
   *
   * `amount` arrives as a decimal string from the money module, never a number, and is passed
   * through untouched: this is a template, and rounding or reformatting here would be a second
   * opinion about what the database holds.
   *
   * Rejects when the provider did not accept the message, like `sendOtp` - the caller decides
   * what an undeliverable notice means, and the confirmation sweep's answer is to log it and
   * keep the resolution, because the payment is already written.
   */
  async sendPaymentResult(phoneNumber: string, notice: PaymentResultNotice): Promise<void> {
    const to = notice.recipientHandle === null ? '' : ` to @${notice.recipientHandle}`;
    const body =
      notice.status === 'SUCCESSFUL'
        ? `Cashping: your payment of ${notice.amount} USDC${to} went through.`
        : `Cashping: your payment of ${notice.amount} USDC${to} did not go through. No USDC left your wallet.`;

    const result = await this.smsSender.send({ to: phoneNumber, body });

    this.logger.log(
      `Payment ${notice.status} SMS accepted by the provider (to=${maskPhoneNumber(phoneNumber)}${
        result.providerMessageId === undefined ? '' : `, messageId=${result.providerMessageId}`
      })`,
    );
  }
}

/**
 * What a settlement notice says, as the one shape both endings share.
 *
 * `status` is the `TransactionStatus` the row now holds, narrowed to the two that are answers -
 * a notice is only ever sent for an answer, which is Step 28's invariant: nothing notifies about
 * a payment that is still in flight.
 */
export interface PaymentResultNotice {
  readonly status: 'SUCCESSFUL' | 'FAILED';
  /** The amount as stored, as a decimal string (7 decimals at most). */
  readonly amount: string;
  /** The recipient's handle, or `null` - the message simply omits it rather than inventing one. */
  readonly recipientHandle: string | null;
}
