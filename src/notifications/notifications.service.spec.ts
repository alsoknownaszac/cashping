import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { EmailDeliveryError, type EmailMessage, type EmailSender } from './email/email-sender.js';
import { NotificationsService } from './notifications.service.js';
import { SmsDeliveryError, type SmsMessage, type SmsSender } from './sms/sms-sender.js';

/**
 * The wording of each message (Step 34c), and which channel a receipt goes out on.
 *
 * The text lives beside the sender on purpose, so this is the file that answers "what does our
 * receipt email say" - and it is where the two-channel decision (SMS always, email only for a
 * *verified* address) is asserted without a provider or a phone.
 */

class FakeSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  error: Error | null = null;

  async send(message: SmsMessage): Promise<{ providerMessageId: string }> {
    if (this.error !== null) {
      throw this.error;
    }

    this.sent.push({ ...message });

    return { providerMessageId: `sms-${this.sent.length}` };
  }
}

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  error: Error | null = null;

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    if (this.error !== null) {
      throw this.error;
    }

    this.sent.push({ ...message });

    return { providerMessageId: `email-${this.sent.length}` };
  }
}

/** The two config keys these methods read, matching `configuration()`. */
const CONFIG: Readonly<Record<string, number | string>> = {
  'otp.ttlMinutes': 10,
  'email.from': 'Cashping <no-reply@cashping.app>',
};

function createService(): {
  sms: FakeSmsSender;
  email: FakeEmailSender;
  service: NotificationsService;
} {
  const sms = new FakeSmsSender();
  const email = new FakeEmailSender();
  const config = { getOrThrow: (key: string) => CONFIG[key] } as unknown as ConfigService;

  return { sms, email, service: new NotificationsService(sms, email, config) };
}

describe('NotificationsService.sendEmailVerification', () => {
  it('sends the code, the TTL the row was given, and the configured from-address', async () => {
    const { email, service } = createService();

    await service.sendEmailVerification('miriam@example.com', '123456');

    expect(email.sent).toHaveLength(1);

    const message = email.sent[0] as EmailMessage;

    expect(message.to).toBe('miriam@example.com');
    expect(message.from).toBe('Cashping <no-reply@cashping.app>');
    expect(message.subject).toMatch(/verification code/i);
    expect(message.body).toContain('123456');
    // The window in the text is `otp.ttlMinutes` - the same key the row's expiry comes from, so
    // the sentence and the database cannot disagree.
    expect(message.body).toContain('10 minutes');
  });

  it('rejects when the provider did not accept the message', async () => {
    const { email, service } = createService();

    email.error = new EmailDeliveryError('no provider configured');

    await expect(service.sendEmailVerification('miriam@example.com', '123456')).rejects.toThrow(
      /no provider configured/,
    );
  });
});

describe('NotificationsService.sendPaymentResult', () => {
  it('texts the sender and sends no email when there is no verified address', async () => {
    const { sms, email, service } = createService();

    await service.sendPaymentResult('+233241234567', {
      status: 'SUCCESSFUL',
      amount: '1.25',
      recipientHandle: 'ama',
    });

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.body).toContain('1.25 USDC to @ama went through');
    expect(email.sent).toEqual([]);
  });

  it('sends the same body on both channels when a verified address is given', async () => {
    const { sms, email, service } = createService();

    await service.sendPaymentResult(
      '+233241234567',
      { status: 'FAILED', amount: '3.00', recipientHandle: null },
      'miriam@example.com',
    );

    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    // One body, two channels: the two cannot drift into saying different things about one payment.
    expect(email.sent[0]?.body).toBe(sms.sent[0]?.body);
    expect(email.sent[0]?.subject).toMatch(/did not go through/i);
  });

  it('propagates an SMS failure - the channel every account has - and does not email', async () => {
    const { sms, email, service } = createService();

    sms.error = new SmsDeliveryError('provider refused');

    await expect(
      service.sendPaymentResult(
        '+233241234567',
        { status: 'SUCCESSFUL', amount: '1.25', recipientHandle: null },
        'miriam@example.com',
      ),
    ).rejects.toThrow(/provider refused/);

    expect(email.sent).toEqual([]);
  });

  it('swallows an email failure, so a delivered text is not turned into a rejected call', async () => {
    const { sms, email, service } = createService();

    email.error = new EmailDeliveryError('email provider refused');

    await expect(
      service.sendPaymentResult(
        '+233241234567',
        { status: 'SUCCESSFUL', amount: '1.25', recipientHandle: null },
        'miriam@example.com',
      ),
    ).resolves.toBeUndefined();

    // The text still went out, which is the fact the caller acts on.
    expect(sms.sent).toHaveLength(1);
  });
});
