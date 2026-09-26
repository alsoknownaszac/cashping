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
}
