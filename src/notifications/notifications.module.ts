import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_SENDER, type EmailSender } from './email/email-sender.js';
import { MailtrapEmailSender } from './email/mailtrap-email.sender.js';
import { ResendEmailSender } from './email/resend-email.sender.js';
import { SmtpEmailSender } from './email/smtp-email.sender.js';
import { NotificationsService } from './notifications.service.js';
import { AfricasTalkingSmsSender } from './sms/africas-talking-sms.sender.js';
import { SMS_SENDER } from './sms/sms-sender.js';

/**
 * Chooses the `EmailSender` the app binds, from `email.sender` (`EMAIL_SENDER`) (Step 34c
 * follow-up).
 *
 * A function rather than a second `useClass`, because the choice is now data: `resend` - the
 * default, and the value a deployment uses - sends real mail, `mailtrap` hands it to a local
 * Email-Testing sandbox, and `smtp` sends it through a real relay (staging's Gmail, typically).
 * All three are constructed from the same injected `ConfigService`, so this is the one place the
 * providers are told apart and the one place a further one would be added. Exported so a spec can
 * assert the selection without booting the app.
 *
 * `email.sender` defaults to `'resend'` in `configuration()`, and the validation schema refuses
 * `mailtrap` when `NODE_ENV=production`, so a deployment is Resend or a real SMTP relay whether or
 * not the variable is set - never the sandbox.
 */
export function createEmailSender(config: ConfigService): EmailSender {
  switch (config.get<string>('email.sender')) {
    case 'mailtrap':
      return new MailtrapEmailSender(config);
    case 'smtp':
      return new SmtpEmailSender(config);
    default:
      return new ResendEmailSender(config);
  }
}

/**
 * Notifications bounded context (Step 11, extended with email in Step 34c).
 *
 * The bindings below are the swap points the steps ask for: `SMS_SENDER` is resolved to
 * Africa's Talking here and nowhere else, and `EMAIL_SENDER` through `createEmailSender` - so
 * replacing a provider is this one file. A test that wants to assert on a message provides its
 * own binding for the token instead.
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
    // Step 34c: the email seam. Bound here and nowhere else. `ResendEmailSender` speaks Resend's
    // HTTP API and reads `notifications.resend.apiKey`; `MailtrapEmailSender` speaks SMTP and
    // reads `notifications.mailtrap.*`; `SmtpEmailSender` speaks SMTP and reads
    // `notifications.smtp.*`. See `DEFAULT_EMAIL_FROM` for why the default from-address is
    // Resend's shared test one.
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService],
      useFactory: createEmailSender,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
