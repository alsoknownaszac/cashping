import { EmailDeliveryError, type EmailMessage, type EmailSendResult, type EmailSender } from './email-sender.js';

/**
 * The default `EMAIL_SENDER` binding (Step 34c), until a provider is chosen.
 *
 * ## Why this exists rather than a real provider
 *
 * `SmsSender` is bound to Africa's Talking because the SMS provider was chosen on Day 1 and
 * its credentials are required environment. Email is the channel this step *introduces*, and
 * the plan's own words for the seam are "SMTP today, a transactional API tomorrow" - which
 * is a decision that has not been made. Rather than guess a provider and add its dependency
 * and credentials, this binding refuses, so the seam is real and the refusal is honest.
 *
 * ## Why refusing is the right default, rather than logging
 *
 * A sender that logged the message and returned success would make `POST /v1/auth/email`
 * answer 200 while nothing was sent - a user told to check an inbox that will never receive
 * anything, with no error anywhere to explain it. Throwing `EmailDeliveryError` instead makes
 * that endpoint answer 503 ("we could not send the message right now"), which is exactly what
 * a missing provider *is*, and it matches what `NotificationsService.sendOtp` already does
 * when the SMS provider rejects: a delivery failure is not a success.
 *
 * ## What swapping in a real provider costs
 *
 * One line in `NotificationsModule` - `.useClass(SmtpEmailSender)` in place of this - and
 * possibly `EMAIL_FROM`. Nothing else in the app names a transport: the wording lives in
 * `NotificationsService`, and the tests replace this binding.
 */
export class UnconfiguredEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    throw new EmailDeliveryError(
      `No email provider is configured, so the message to ${message.to} was not sent. ` +
        'Bind EMAIL_SENDER to a provider in NotificationsModule (Step 34c).',
    );
  }
}
