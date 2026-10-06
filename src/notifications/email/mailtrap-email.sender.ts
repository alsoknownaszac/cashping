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
 * Mailtrap's Email-Testing SMTP, behind `EmailSender` (Step 34c follow-up).
 *
 * Local development's answer to Resend. Resend's shared `onboarding@resend.dev` sender only
 * delivers to the address the account itself is registered under, which makes it useless for
 * reading a verification code in a dev inbox; Mailtrap's *Email Testing* sandbox accepts every
 * message, sends none of them, and shows them in a private inbox - no real address is emailed
 * and no domain has to be verified. It is selected by `EMAIL_SENDER=mailtrap` and is refused
 * when `NODE_ENV=production` by the validation schema, so a deployment cannot quietly route a
 * real verification code into a sandbox.
 *
 * Built on Nodemailer over SMTP rather than Mailtrap's HTTP API, and its own SMTP settings
 * rather than an SDK: the transport is five fields and one `sendMail`, and Nodemailer is the
 * dependency any second local provider (Gmail, a corporate relay) would need too, so the same
 * seam serves more than Mailtrap.
 *
 * `from` arrives on the message rather than being read here, exactly as in `ResendEmailSender`:
 * it is one `email.from` value chosen at the call site, so the sender stays a transport and the
 * wording stays in `NotificationsService`.
 */
@Injectable()
export class MailtrapEmailSender implements EmailSender {
  private readonly logger = new Logger(MailtrapEmailSender.name);

  /**
   * So a stuck SMTP handshake cannot hold a request open. No retry, for the reason
   * `ResendEmailSender` has none: this class cannot tell "Mailtrap never saw it" from "Mailtrap
   * accepted it and the reply was lost", and a retried verification email is a second code
   * delivered for one request.
   */
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.deliver(this.transporter(), message);
    const id = info.messageId;

    this.logger.log(
      `Mailtrap accepted a message for ${maskEmailAddress(message.to)}${
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
        `Could not send email via Mailtrap for ${maskEmailAddress(message.to)}`,
        { cause },
      );
    }
  }

  /**
   * Builds the transport from configuration, or fails with `EmailDeliveryError` when the
   * credentials are missing.
   *
   * A missing credential is *not* a boot error the way a missing `RESEND_API_KEY` is: Resend is
   * the binding every deployment uses, whereas Mailtrap is opt-in for local development, and
   * refusing to start a developer's app because a sandbox password is unset would be worse than
   * the send failing with a reason. In production the schema refuses this sender before it can
   * be reached, so the credential path below only ever runs in development.
   */
  private transporter(): Transporter {
    const host = this.config.get<string>('notifications.mailtrap.host');
    const port = this.config.get<number>('notifications.mailtrap.port');
    const username = this.config.get<string>('notifications.mailtrap.username');
    const password = this.config.get<string>('notifications.mailtrap.password');

    if (!host || !port || !username || !password) {
      throw new EmailDeliveryError(
        'Mailtrap SMTP is not configured: set MAILTRAP_USERNAME and MAILTRAP_PASSWORD ' +
          '(Mailtrap -> Email Testing -> Inbox -> SMTP settings) when EMAIL_SENDER=mailtrap.',
      );
    }

    return createTransport({
      host,
      port,
      // 465 is implicit TLS; 2525 (Mailtrap's default) and 587 upgrade with STARTTLS.
      secure: port === 465,
      auth: { user: username, pass: password },
      connectionTimeout: MailtrapEmailSender.TIMEOUT_MS,
      greetingTimeout: MailtrapEmailSender.TIMEOUT_MS,
      socketTimeout: MailtrapEmailSender.TIMEOUT_MS,
    });
  }
}
