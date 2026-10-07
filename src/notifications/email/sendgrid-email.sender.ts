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
 * SendGrid's SMTP relay, behind `EmailSender` (Step 34c follow-up).
 *
 * The sender a staging or development environment uses to reach arbitrary external inboxes from
 * a *single-sender-verified* address: SendGrid confirms one from-address by an email link - not a
 * domain and not DNS - so mail can leave for any inbox without the SPF/DKIM records a verified
 * sending domain would need. It is selected by `EMAIL_SENDER=sendgrid` and, like
 * `SmtpEmailSender` and unlike `MailtrapEmailSender`, it is *not* refused in production, because
 * it delivers real mail; the validation schema refuses only the Mailtrap sandbox.
 *
 * SendGrid's relay is a fixed service, so its host, port and username are constants here rather
 * than configuration: `smtp.sendgrid.net` on 587 (STARTTLS), authenticated as the literal user
 * `apikey` with an API key as the password. That leaves exactly one thing to set -
 * `SENDGRID_API_KEY` - and no host to mistype or repoint. It is a near-twin of `SmtpEmailSender`:
 * the two share the Nodemailer transport and differ only in where the connection comes from and
 * in the wording of their errors. They are separate classes rather than one parameterised by a
 * host because the endpoint is a fixed fact about the provider, not a value an operator chooses.
 *
 * `from` arrives on the message rather than being read here, exactly as in the other senders: it
 * is one `email.from` value chosen at the call site, so the sender stays a transport and the
 * wording stays in `NotificationsService`. For SendGrid that address must be the one verified as
 * the account's single sender, or the relay refuses the message.
 */
@Injectable()
export class SendgridEmailSender implements EmailSender {
  private readonly logger = new Logger(SendgridEmailSender.name);

  /**
   * SendGrid's SMTP relay endpoint. Constants rather than config, because they are the same for
   * every SendGrid account - there is nothing here an operator could need to change.
   */
  private static readonly HOST = 'smtp.sendgrid.net';
  /** 587 speaks STARTTLS; SendGrid also offers 465 (implicit TLS) and 25 (unencrypted). */
  private static readonly PORT = 587;
  /** SendGrid authenticates SMTP with the literal username `apikey`, whatever the account is. */
  private static readonly USERNAME = 'apikey';

  /**
   * So a stuck SMTP handshake cannot hold a request open. No retry, for the reason
   * `SmtpEmailSender` has none: this class cannot tell "the relay never saw it" from "the relay
   * accepted it and the reply was lost", and a retried verification email is a second code
   * delivered for one request.
   */
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.deliver(this.transporter(), message);
    const id = info.messageId;

    this.logger.log(
      `SendGrid relay accepted a message for ${maskEmailAddress(message.to)}${
        typeof id === 'string' ? `, messageId=${id}` : ''
      }`,
    );

    return { providerMessageId: typeof id === 'string' ? id : undefined };
  }

  /**
   * Performs the send, translating every Nodemailer failure - a refused connection, a bad API
   * key, a rejected recipient - into the one `EmailDeliveryError`, so the caller never reads an
   * SMTP reply code (exactly as `SmtpEmailSender` and `ResendEmailSender` do not).
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
        `Could not send email via SendGrid for ${maskEmailAddress(message.to)}`,
        { cause },
      );
    }
  }

  /**
   * Builds the transport from the fixed SendGrid endpoint and the configured API key, or fails
   * with `EmailDeliveryError` when the key is missing.
   *
   * A missing key is *not* a boot error the way a missing `RESEND_API_KEY` is: `sendgrid` is
   * opt-in (production defaults to Resend), and refusing to start an environment because a
   * staging key is unset would be worse than the send failing with a reason naming it.
   */
  private transporter(): Transporter {
    const apiKey = this.config.get<string>('notifications.sendgrid.apiKey');

    if (!apiKey) {
      throw new EmailDeliveryError(
        'SendGrid is not configured: set SENDGRID_API_KEY when EMAIL_SENDER=sendgrid.',
      );
    }

    return createTransport({
      host: SendgridEmailSender.HOST,
      port: SendgridEmailSender.PORT,
      // 587 upgrades with STARTTLS; the port is not 465, so TLS is not implicit here.
      secure: false,
      auth: { user: SendgridEmailSender.USERNAME, pass: apiKey },
      connectionTimeout: SendgridEmailSender.TIMEOUT_MS,
      greetingTimeout: SendgridEmailSender.TIMEOUT_MS,
      socketTimeout: SendgridEmailSender.TIMEOUT_MS,
    });
  }
}
