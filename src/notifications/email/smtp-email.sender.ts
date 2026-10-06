import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { maskEmailAddress } from '../../identity/email/email-address.js';
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSendResult,
  type EmailSender,
} from './email-sender.js';

/**
 * A real SMTP relay, behind `EmailSender` (Step 34c follow-up).
 *
 * The sender staging uses to reach arbitrary external inboxes without verifying a domain in
 * Resend: Gmail over an app password is the usual answer, but any SMTP server works - a corporate
 * relay, a transactional provider that still speaks SMTP. It is selected by `EMAIL_SENDER=smtp`
 * and, unlike `MailtrapEmailSender`, it is *not* refused in production, because it delivers real
 * mail; the validation schema refuses only the Mailtrap sandbox.
 *
 * A near-twin of `MailtrapEmailSender`: the two share the Nodemailer transport and differ only in
 * which config group they read (`notifications.smtp.*` here, `notifications.mailtrap.*` there) and
 * in the wording of their errors. They are separate classes rather than one parameterised by a key
 * prefix because the *guard* has to tell them apart - the sandbox is refused in production and a
 * real relay is not - and a distinction the validator makes is worth keeping visible in the types.
 *
 * `from` arrives on the message rather than being read here, exactly as in the other two senders:
 * it is one `email.from` value chosen at the call site, so the sender stays a transport and the
 * wording stays in `NotificationsService`.
 */
@Injectable()
export class SmtpEmailSender implements EmailSender {
  private readonly logger = new Logger(SmtpEmailSender.name);

  /**
   * So a stuck SMTP handshake cannot hold a request open. No retry, for the reason
   * `ResendEmailSender` has none: this class cannot tell "the relay never saw it" from "the relay
   * accepted it and the reply was lost", and a retried verification email is a second code
   * delivered for one request.
   */
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.deliver(this.transporter(), message);
    const id = info.messageId;

    this.logger.log(
      `SMTP relay accepted a message for ${maskEmailAddress(message.to)}${
        typeof id === 'string' ? `, messageId=${id}` : ''
      }`,
    );

    return { providerMessageId: typeof id === 'string' ? id : undefined };
  }

  /**
   * Performs the send, translating every Nodemailer failure - a refused connection, bad
   * credentials, a rejected recipient - into the one `EmailDeliveryError`, so the caller never
   * reads an SMTP reply code (exactly as `ResendEmailSender` never reads an HTTP status).
   */
  private async deliver(
    transporter: Transporter,
    message: EmailMessage,
  ): Promise<{ messageId?: unknown }> {
    try {
      return await transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        // `text`, not `html`: the body is the plain-text wording the SMS template mirrors.
        text: message.body,
      });
    } catch (cause) {
      throw new EmailDeliveryError(
        `Could not send email via SMTP for ${maskEmailAddress(message.to)}`,
        { cause },
      );
    }
  }

  /**
   * Builds the transport from configuration, or fails with `EmailDeliveryError` when any of the
   * four settings is missing.
   *
   * A missing setting is *not* a boot error the way a missing `RESEND_API_KEY` is: `smtp` is
   * opt-in, and refusing to start an environment because a relay password is unset would be worse
   * than the send failing with a reason naming what is missing. There is no default host or port
   * either - see `configuration()` - because "the" SMTP server does not exist.
   */
  private transporter(): Transporter {
    const host = this.config.get<string>('notifications.smtp.host');
    const port = this.config.get<number>('notifications.smtp.port');
    const username = this.config.get<string>('notifications.smtp.username');
    const password = this.config.get<string>('notifications.smtp.password');

    if (!host || !port || !username || !password) {
      throw new EmailDeliveryError(
        'SMTP is not configured: set SMTP_HOST, SMTP_PORT, SMTP_USERNAME and SMTP_PASSWORD ' +
          'when EMAIL_SENDER=smtp.',
      );
    }

    return createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 (and 2525) upgrade with STARTTLS.
      secure: port === 465,
      auth: { user: username, pass: password },
      connectionTimeout: SmtpEmailSender.TIMEOUT_MS,
      greetingTimeout: SmtpEmailSender.TIMEOUT_MS,
      socketTimeout: SmtpEmailSender.TIMEOUT_MS,
    });
  }
}
