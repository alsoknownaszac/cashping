import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { MailtrapEmailSender } from './email/mailtrap-email.sender.js';
import { ResendEmailSender } from './email/resend-email.sender.js';
import { createEmailSender } from './notifications.module.js';

/**
 * The `EMAIL_SENDER` selection (Step 34c follow-up).
 *
 * `createEmailSender` is the one place the two senders are told apart, so this pins the rule that
 * matters most to production: an unset `EMAIL_SENDER` - and any value other than the literal
 * `mailtrap` - binds Resend, and only `mailtrap` binds the sandbox. Constructing a sender reads
 * no credentials and opens no connection, so nothing here touches the network.
 */
function config(sender: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === 'email.sender' ? sender : undefined),
  } as unknown as ConfigService;
}

describe('createEmailSender', () => {
  it('binds Resend when EMAIL_SENDER is unset', () => {
    expect(createEmailSender(config(undefined))).toBeInstanceOf(ResendEmailSender);
  });

  it("binds Resend when EMAIL_SENDER='resend'", () => {
    expect(createEmailSender(config('resend'))).toBeInstanceOf(ResendEmailSender);
  });

  it("binds Mailtrap when EMAIL_SENDER='mailtrap'", () => {
    expect(createEmailSender(config('mailtrap'))).toBeInstanceOf(MailtrapEmailSender);
  });

  it('binds Resend for any other value, so an unexpected string cannot select the sandbox', () => {
    expect(createEmailSender(config('mailgun'))).toBeInstanceOf(ResendEmailSender);
  });
});
