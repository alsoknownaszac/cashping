import { type ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailDeliveryError, type EmailMessage } from './email-sender.js';
import { ResendEmailSender } from './resend-email.sender.js';

/**
 * The request `ResendEmailSender` puts on the wire, and how it turns Resend's answers into
 * `EmailDeliveryError` (Step 34c).
 *
 * `fetch` is the only thing replaced: the sender is handed a fake `ConfigService` and the global
 * `fetch` is swapped for one that records the call and answers with a canned `Response`. That keeps
 * the assertions about exactly what a real send would look like - the URL, the `Bearer` header and
 * the JSON body - and about which HTTP answers become a delivery failure, with no network and no
 * API key. The sender is the email twin of `AfricasTalkingSmsSender`; there is no spec for that one
 * yet, so this file follows `notifications.service.spec.ts`' hand-written-fake style rather than a
 * mocking framework's.
 */

/** A value shaped like a Resend key; never a real one. */
const API_KEY = 're_test_000000000000';
const SEND_URL = 'https://api.resend.com/emails';
/** The id Resend returns on acceptance, copied from its own documentation example. */
const PROVIDER_ID = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** The message the notification flow builds: one `email.from`, one subject, one plain-text body. */
function message(): EmailMessage {
  return {
    to: 'miriam@example.com',
    from: 'Cashping <onboarding@resend.dev>',
    subject: 'Your Cashping verification code',
    body: 'Your verification code is 123456. It expires in 10 minutes.',
  };
}

function createSender(): ResendEmailSender {
  const config = {
    getOrThrow: (key: string) => {
      // The exact key the factory defines, so a renamed config path fails here rather than in
      // production.
      expect(key).toBe('notifications.resend.apiKey');
      return API_KEY;
    },
  } as unknown as ConfigService;

  return new ResendEmailSender(config);
}

/** A JSON answer from Resend, accepted (`200`) or refused. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

/**
 * Replaces the global `fetch` for one test.
 *
 * Hand-written rather than a mock object, matching the rest of the suite: the recorded call *is*
 * the assertion (its URL, headers and body), so a small fake that keeps them is clearer than a mock
 * whose arguments have to be cast back out of `mock.calls`.
 */
function stubFetch(responder: () => Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder();
  }) as unknown as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ResendEmailSender.send', () => {
  it('POSTs the message to Resend with the key as a Bearer token', async () => {
    const calls = stubFetch(async () => jsonResponse({ id: PROVIDER_ID }));

    const result = await createSender().send(message());

    expect(calls).toHaveLength(1);

    const call = calls[0] as FetchCall;

    expect(call.url).toBe(SEND_URL);
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;

    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    // The body is the shape Resend documents: `to` is an array, and the plain text travels as
    // `text` rather than `html`.
    expect(JSON.parse(call.init.body as string)).toEqual({
      from: 'Cashping <onboarding@resend.dev>',
      to: ['miriam@example.com'],
      subject: 'Your Cashping verification code',
      text: 'Your verification code is 123456. It expires in 10 minutes.',
    });
    expect(result.providerMessageId).toBe(PROVIDER_ID);
  });

  it('reports no provider id when an accepted response carries none', async () => {
    stubFetch(async () => jsonResponse({}));

    await expect(createSender().send(message())).resolves.toEqual({ providerMessageId: undefined });
  });

  it('throws EmailDeliveryError naming the status and the provider message on a refusal', async () => {
    stubFetch(async () =>
      jsonResponse(
        { statusCode: 422, name: 'validation_error', message: 'Invalid `from` field' },
        422,
      ),
    );

    const error = await createSender()
      .send(message())
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error?.message).toContain('HTTP 422');
    expect(error?.message).toContain('Invalid `from` field');
    // The reason is logged, so the recipient is masked and cannot be read back out of it.
    expect(error?.message).toContain('m***@example.com');
    expect(error?.message).not.toContain('miriam@example.com');
  });

  it('still throws EmailDeliveryError when a refusal body is not JSON', async () => {
    stubFetch(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const error = await createSender()
      .send(message())
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error?.message).toContain('HTTP 502');
    expect(error?.message).toContain('no message in the response body');
  });

  it('translates a transport failure into EmailDeliveryError, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    stubFetch(async () => {
      throw cause;
    });

    const error = await createSender()
      .send(message())
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error?.message).toContain('Could not reach Resend');
    expect(error?.message).toContain('m***@example.com');
    expect(error?.cause).toBe(cause);
  });
});
