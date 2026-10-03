import { Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email/email-sender.js';
import { UnconfiguredEmailSender } from './email/unconfigured-email.sender.js';
import { NotificationsService } from './notifications.service.js';
import { AfricasTalkingSmsSender } from './sms/africas-talking-sms.sender.js';
import { SMS_SENDER } from './sms/sms-sender.js';

/**
 * Notifications bounded context (Step 11, extended with email in Step 34c).
 *
 * The bindings below are the swap points the steps ask for: `SMS_SENDER` is resolved to
 * Africa's Talking here and nowhere else, and `EMAIL_SENDER` to `UnconfiguredEmailSender`
 * until an email provider is chosen - so replacing either provider is this one line. A test
 * that wants to assert on a message provides its own binding for the token instead.
 *
 * `NotificationsService` is exported rather than the senders: callers ask for "send the user
 * a code", not for "an SMS client" or "an SMTP client". That is what let email arrive in
 * Step 34c without a single caller changing - the second channel was added to the service,
 * exactly as this docstring predicted, and every caller kept working.
 */
@Module({
  providers: [
    NotificationsService,
    { provide: SMS_SENDER, useClass: AfricasTalkingSmsSender },
    // Step 34c: the email seam. Bound here and nowhere else, so choosing a provider later is
    // one `useClass`. See `UnconfiguredEmailSender` for why the default refuses rather than
    // pretending to send.
    { provide: EMAIL_SENDER, useClass: UnconfiguredEmailSender },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
