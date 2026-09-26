import { BadRequestException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { InternalServerErrorException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter, type ErrorResponseBody } from './all-exceptions.filter.js';

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(() => 'sentry-event-id'),
}));

/**
 * Stands in for the Express response + HTTP adapter, recording what the filter
 * writes so assertions can be made on the payload rather than on a live server.
 */
function createFixture() {
  const response = { marker: 'response' };
  const reply = vi.fn();
  const httpAdapterHost = {
    httpAdapter: {
      getRequestMethod: () => 'GET',
      getRequestUrl: () => '/v1/throwaway',
      reply,
    },
  } as unknown as HttpAdapterHost;

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({}),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { filter: new AllExceptionsFilter(httpAdapterHost), host, reply, response };
}

/** The body the filter handed to the adapter, and the status code alongside it. */
function captured(reply: ReturnType<typeof vi.fn>): {
  body: ErrorResponseBody;
  statusCode: number;
} {
  const [, body, statusCode] = reply.mock.calls[0] as [unknown, ErrorResponseBody, number];

  return { body, statusCode };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes an HttpException message through with its status code', () => {
    const { filter, host, reply } = createFixture();

    filter.catch(new NotFoundException('User not found'), host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(404);
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toBe('User not found');
    expect(body.path).toBe('/v1/throwaway');
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('keeps the message array a validation failure carries', () => {
    const { filter, host, reply } = createFixture();
    const messages = ['phoneNumber must be a valid phone number'];

    filter.catch(new BadRequestException(messages), host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toEqual(messages);
  });

  // Audit checklist Step 6: unexpected errors are reported to Sentry with a
  // usable stack trace.
  it('reports an unexpected error to Sentry, with the error itself', () => {
    const { filter, host, reply } = createFixture();
    const boom = new Error('pg: connection string leaked');

    filter.catch(boom, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(boom);

    const { statusCode } = captured(reply);

    expect(statusCode).toBe(500);
  });

  it('never echoes an internal error message back to the caller', () => {
    const { filter, host, reply } = createFixture();

    filter.catch(new Error('pg: connection string leaked'), host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('leaked');
  });

  it('treats a 5xx HttpException as unexpected: reported, but not described', () => {
    const { filter, host, reply } = createFixture();

    filter.catch(new InternalServerErrorException('ledger write failed'), host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
  });

  it('does not report a 4xx: the caller was told what was wrong', () => {
    const { filter, host } = createFixture();

    filter.catch(new NotFoundException('User not found'), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
