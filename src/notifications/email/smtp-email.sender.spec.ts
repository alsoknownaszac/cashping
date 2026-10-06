import { type ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDeliveryError, type EmailMessage } from './email-sender.js';
import { SmtpEmailSender } from './smtp-email.sender.js';

/**
 * `SmtpEmailSender`'s SMTP envelope and its error translation (Step 34c follow-up).
 *
 * `nodemailer` is the only thing replaced (`vi.mock`, held through `vi.hoisted` so the factory
 * can see it - the way `reconciliation.service.spec.ts` replaces `@sentry/nestjs`): `createTransport`
 * becomes a spy returning a fake transport, so the assertions are about the exact `sendMail`
 * envelope and about which failures become an `EmailDeliveryError`, with no SMTP connection and
 * no credentials. The twin of `mailtrap-email.sender.spec.ts`; the config group it reads is the
 * one thing that differs.
 */
const { createTransport } = vi.hoisted(() => ({ createTransport: vi.fn() }));

vi.mock('nodemailer', () => ({ createTransport }));

/** The message the notification flow builds: one `email.from`, one subject, one plain-text body. */
const MESSAGE: EmailMessage = {
  to: 'miriam@example.com',
  from: 'Cashping <no-reply@cashping.test>',
  subject: 'Your Cashping verification code',
  body: 'Your verification code is 123456. It expires in 10 minutes.',
};

/** The id an SMTP server returns on acceptance (a real one is a `<uuid@host>` message id). */
const PROVIDER_ID = '<a1b2c3d4-0000-0000-0000-abcdefabcdef@example.com>';

/** A `ConfigService` stub whose `get` reads the smtp group; overrides blank a key out. */
function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    // The exact keys the factory defines, so a renamed config path fails here rather than in
    // production.
    'notifications.smtp.host': 'smtp.gmail.com',
    'notifications.smtp.port': 465,
    'notifications.smtp.username': 'sender@gmail.com',
    'notifications.smtp.password': 'app-password',
    ...overrides,
  };

  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function createSender(overrides: Record<string, unknown> = {}): SmtpEmailSender {
  return new SmtpEmailSender(config(overrides));
}

/** Puts a fake transport behind `createTransport` and returns its `sendMail` spy. */
function stubTransport(sendMail: (message: unknown) => Promise<unknown>) {
  const spy = vi.fn(sendMail);

  createTransport.mockReturnValue({ sendMail: spy });

  return spy;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SmtpEmailSender.send', () => {
  it('builds the transport from config and sends the message as plain text', async () => {
    const sendMail = stubTransport(async () => ({ messageId: PROVIDER_ID }));

    const result = await createSender().send(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'sender@gmail.com', pass: 'app-password' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    // The envelope Nodemailer would put on the wire: the plain text travels as `text` rather
    // than `html`, matching `ResendEmailSender`.
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Cashping <no-reply@cashping.test>',
      to: 'miriam@example.com',
      subject: 'Your Cashping verification code',
      text: 'Your verification code is 123456. It expires in 10 minutes.',
    });
    expect(result.providerMessageId).toBe(PROVIDER_ID);
  });

  it('uses implicit TLS on port 465 and STARTTLS on any other port', async () => {
    stubTransport(async () => ({ messageId: PROVIDER_ID }));

    await createSender({ 'notifications.smtp.port': 465 }).send(MESSAGE);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );

    stubTransport(async () => ({ messageId: PROVIDER_ID }));

    await createSender({ 'notifications.smtp.port': 587 }).send(MESSAGE);

    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it('reports no provider id when the transport returns none', async () => {
    stubTransport(async () => ({}));

    await expect(createSender().send(MESSAGE)).resolves.toEqual({ providerMessageId: undefined });
  });

  it('translates an SMTP failure into EmailDeliveryError, keeping the cause and masking the recipient', async () => {
    const cause = new Error('Invalid login: 535 5.7.0 Authentication failed');
    stubTransport(async () => {
      throw cause;
    });

    const error = await createSender()
      .send(MESSAGE)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error?.message).toContain('Could not send email via SMTP');
    // The reason is logged, so the recipient is masked and cannot be read back out of it.
    expect(error?.message).toContain('m***@example.com');
    expect(error?.message).not.toContain('miriam@example.com');
    expect(error?.cause).toBe(cause);
  });

  it('fails with EmailDeliveryError, and builds no transport, when settings are missing', async () => {
    const error = await createSender({
      'notifications.smtp.host': undefined,
      'notifications.smtp.username': undefined,
      'notifications.smtp.password': undefined,
    })
      .send(MESSAGE)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error?.message).toContain('SMTP_HOST, SMTP_PORT, SMTP_USERNAME and SMTP_PASSWORD');
    expect(createTransport).not.toHaveBeenCalled();
  });
});
