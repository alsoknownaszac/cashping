import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter, type ErrorResponseBody } from './all-exceptions.filter.js';

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(() => 'sentry-event-id'),
}));

/**
 * Stands in for the Express response + HTTP adapter, recording what the filter
 * writes so assertions can be made on the payload rather than on a live server.
 *
 * `headers` stands in for the request headers the filter reads - so far only the
 * `Content-Encoding` it names in a decompression message.
 */
function createFixture(headers: Record<string, string> = {}) {
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
      getRequest: () => ({ headers }),
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  // The class of bug this filter used to have: a client-side error from Express's
  // body parser is not an `HttpException`, so it was floored to a 500. Each error
  // below is built the way `http-errors` builds it - the shape was captured from a
  // real request, not guessed.

  it('answers an over-limit body with 413 and the ceiling it broke', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
      limit: 102400,
      length: 200009,
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(413);
    expect(body.statusCode).toBe(413);
    expect(body.error).toBe('Payload Too Large');
    expect(body.message).toContain('too large');
    expect(body.message).toContain('limit 102400');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('answers a bad charset with 415 and names the charset', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('unsupported charset "KLINGON"'), {
      status: 415,
      statusCode: 415,
      type: 'charset.unsupported',
      charset: 'klingon',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(415);
    expect(body.error).toBe('Unsupported Media Type');
    expect(body.message).toContain('klingon');
  });

  it('answers an unsupported content encoding with 415 and names the encoding', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('unsupported content encoding "snappy"'), {
      status: 415,
      statusCode: 415,
      type: 'encoding.unsupported',
      encoding: 'snappy',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(415);
    expect(body.message).toContain('snappy');
  });

  it('answers a broken JSON body with 400', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      statusCode: 400,
      type: 'entity.parse.failed',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toBe('Request body is not valid JSON');
  });

  it('answers an aborted request with 400', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('request aborted'), {
      status: 400,
      statusCode: 400,
      type: 'request.aborted',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toContain('closed the connection');
  });

  // A decompression failure, shaped as body-parser actually produces it: zlib's
  // error re-wrapped with `createError(400, err)`, which keeps the `code` and
  // leaves `type` unset. The message is fixed, and never zlib's own wording.
  it('names the encoding when a body cannot be decompressed', () => {
    const { filter, host, reply } = createFixture({ 'content-encoding': 'gzip' });
    const error = Object.assign(new Error('incorrect header check'), {
      status: 400,
      statusCode: 400,
      code: 'Z_DATA_ERROR',
      errno: -3,
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('Request body could not be decompressed (Content-Encoding: gzip)');
    expect(JSON.stringify(body)).not.toContain('incorrect header check');
  });

  it('names the encoding the caller declared, not a hard-coded gzip', () => {
    const { filter, host, reply } = createFixture({ 'content-encoding': 'deflate' });
    const error = Object.assign(new Error('incorrect header check'), {
      status: 400,
      statusCode: 400,
      code: 'Z_DATA_ERROR',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toBe('Request body could not be decompressed (Content-Encoding: deflate)');
  });

  it('recognises brotli code as a decompression failure too', () => {
    const { filter, host, reply } = createFixture({ 'content-encoding': 'br' });
    const error = Object.assign(new Error('Decompression failed'), {
      status: 400,
      statusCode: 400,
      code: 'ERR__ERROR_FORMAT_PADDING_2',
      errno: -15,
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toBe('Request body could not be decompressed (Content-Encoding: br)');
    expect(JSON.stringify(body)).not.toContain('Decompression failed');
  });

  it('answers a Content-Length mismatch with 400', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('request size did not match content length'), {
      status: 400,
      statusCode: 400,
      type: 'request.size.invalid',
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.message).toContain('Content-Length');
  });

  it('uses the error message for a 4xx that marked itself safe to show', () => {
    // A 4xx that is none of the named types: http-errors marked it safe to show
    // (`expose: true`) and gave it no `type`, and it carries no decompression code,
    // so its own message is all we have.
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('incorrect header check'), {
      status: 400,
      expose: true,
    });

    filter.catch(error, host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('incorrect header check');
  });

  it('returns any other 4xx status instead of flooring it to 500', () => {
    const { filter, host, reply } = createFixture();

    filter.catch(Object.assign(new Error('teapot'), { status: 418 }), host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(418);
    expect(body.statusCode).toBe(418);
    expect(body.error).toBe("I'm a Teapot");
  });

  it('never leaks a client error message it was not told to expose', () => {
    const { filter, host, reply } = createFixture();
    const error = Object.assign(new Error('internal db name'), { status: 400, expose: false });

    filter.catch(error, host);

    const { body } = captured(reply);

    expect(JSON.stringify(body)).not.toContain('internal db name');
  });

  it('keeps a 403 behaving exactly as before', () => {
    const { filter, host, reply } = createFixture();

    filter.catch(new ForbiddenException('not allowed'), host);

    const { body, statusCode } = captured(reply);

    expect(statusCode).toBe(403);
    expect(body.error).toBe('Forbidden');
    expect(body.message).toBe('not allowed');
  });

  it('logs a 4xx at warn (short, naming the type) and never at error', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { filter, host } = createFixture();

    filter.catch(
      Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      }),
      host,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('413');
    expect(warn.mock.calls[0][0]).toContain('entity.too.large');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('logs a 5xx at error and reports it', () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { filter, host } = createFixture();

    filter.catch(new Error('boom'), host);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
