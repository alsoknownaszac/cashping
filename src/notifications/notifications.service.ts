import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhoneNumber } from '../common/phone/phone-number.js';
// The address rule and its mask are stated once, in the value module that owns "what an address
// is" - which imports nothing, so this is a value import rather than a module cycle.
import { maskEmailAddress } from '../identity/email/email-address.js';
import { EMAIL_SENDER, type EmailSender } from './email/email-sender.js';
import { SMS_SENDER, type SmsSender } from './sms/sms-sender.js';

/**
 * Outbound user-facing messages.
 *
 * The only thing the rest of the app knows about SMS *and email*. `AuthService` calls
 * `sendOtp` or `sendEmailVerification` and gets either "the provider accepted it" or an
 * error - it never learns which provider, which host, or how the message is worded.
 *
 * This is a *delivery* service, not a template engine: the text of each message lives here,
 * next to the code that sends it, so reading this file answers "what does our verification
 * SMS say" and "what does our receipt email say".
 *
 * Step 34c added the email channel, and the way it was added is the point of the seam: a
 * second injected sender and two new methods, with no caller of `sendOtp` or
 * `sendPaymentResult` changed. The receipt is the one message that goes out on *both*
 * channels, and it says the same thing on each.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    // Injected by token, so the binding (not this class) decides which provider
    // sends the message. See `NotificationsModule`.
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
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
   * Sends the email verification code (Step 34c).
   *
   * The same shape as `sendOtp` and for the same reasons: the TTL in the body is read from
   * the same `otp.ttlMinutes` the row's expiry is computed from, so the sentence and the
   * database cannot disagree; the code is passed through and never logged; and a rejection
   * means the provider did not accept the message, so the caller decides what an
   * undeliverable code means (it is not a 2xx).
   *
   * The wording lives here, beside the sender, exactly as the SMS wording does - and it is
   * plain text, because the seam is a plain-text sender and markup is a feature of whichever
   * provider is eventually chosen.
   */
  async sendEmailVerification(to: string, code: string): Promise<void> {
    const ttlMinutes = this.config.getOrThrow<number>('otp.ttlMinutes');

    const result = await this.emailSender.send({
      to,
      from: this.from(),
      subject: 'Your Cashping verification code',
      body: `Cashping: ${code} is your email verification code. It expires in ${ttlMinutes} minutes. Never share it with anyone.`,
    });

    this.logger.log(
      `Verification email accepted by the provider (to=${maskEmailAddress(to)}${
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
   *
   * Step 34c adds the second channel: when `email` is non-null (a *verified* address - the
   * caller passes `null` for an address nobody has proved) the same body is emailed as well.
   * The SMS is attempted first and its failure propagates, because a phone number is the
   * channel every account has; the email is secondary, so its failure is logged and swallowed
   * here rather than turning a delivered SMS into a rejected call.
   */
  async sendPaymentResult(
    phoneNumber: string,
    notice: PaymentResultNotice,
    email: string | null = null,
  ): Promise<void> {
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

    if (email !== null) {
      await this.sendReceiptEmail(email, notice, body);
    }
  }

  /**
   * The email arm of a payment receipt (Step 34c).
   *
   * Swallows its own failure on purpose - see `sendPaymentResult`. The subject carries the
   * outcome so the inbox line is informative without opening it, and the body is the *same
   * string* the SMS used, so the two channels cannot say different things about one payment.
   */
  private async sendReceiptEmail(
    to: string,
    notice: PaymentResultNotice,
    body: string,
  ): Promise<void> {
    try {
      const result = await this.emailSender.send({
        to,
        from: this.from(),
        subject:
          notice.status === 'SUCCESSFUL'
            ? 'Your Cashping payment went through'
            : 'Your Cashping payment did not go through',
        body,
      });

      this.logger.log(
        `Payment ${notice.status} email accepted by the provider (to=${maskEmailAddress(to)}${
          result.providerMessageId === undefined ? '' : `, messageId=${result.providerMessageId}`
        })`,
      );
    } catch (error) {
      this.logger.error(
        `Payment ${notice.status} email to ${maskEmailAddress(to)} could not be sent - ${
          error instanceof Error ? error.message : 'unknown failure'
        }`,
      );
    }
  }

  /** The one from-address, read from configuration so the template and the binding agree. */
  private from(): string {
    return this.config.getOrThrow<string>('email.from');
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
