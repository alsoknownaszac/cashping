import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { STATUS_CODES } from 'node:http';

/**
 * The body every failed request is answered with.
 */
export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/**
 * The shape of an error raised by Express's body-parsing middleware.
 *
 * None of these is an `HttpException` - they are thrown before any guard or
 * controller runs - but each carries, via `http-errors`, the status the caller
 * should be answered with and a `type` naming what went wrong.
 */
interface RequestError extends Error {
  /** `entity.too.large`, `charset.unsupported`, `request.aborted`, ... */
  type?: string;
  status?: number;
  statusCode?: number;
  /** `http-errors` marks a 4xx it created itself as "safe to show the caller". */
  expose?: boolean;
  /** Byte ceiling that was exceeded (`entity.too.large`). */
  limit?: number;
  /** Declared body size, when the ceiling was known before reading the body. */
  length?: number;
  /** Bytes actually read before the ceiling was hit. */
  received?: number;
  /** The `Content-Encoding` that was refused (`encoding.unsupported`). */
  encoding?: string;
  /** The `charset` that was refused (`charset.unsupported`). */
  charset?: string;
  /**
   * zlib's own failure code when a declared `Content-Encoding` could not be
   * decompressed (`Z_DATA_ERROR`, `Z_BUF_ERROR`, or brotli's `ERR__ERROR_*`).
   * Present only on that one error, which carries no `type`.
   */
  code?: string;
}

/**
 * Global exception filter (Step 6).
 *
 * It has two jobs, kept in one place on purpose so the API has a single error
 * path: answer the caller in a predictable shape, and report genuinely
 * unexpected failures to Sentry with a usable stack trace.
 *
 * A distinction it never blurs: a *mistake by the sender* is not a server fault.
 * Anything the client got wrong - a body over the limit, a bad charset, a
 * truncated request - is answered with its own 4xx status and a message naming
 * the problem, and it is not sent to Sentry. Only an error with no client-side
 * meaning at all becomes a 500, and that one is never described to the caller:
 * the real message tends to carry ORM/driver internals, so it goes to the log
 * and to Sentry instead.
 *
 * `@sentry/nestjs` ships `SentryGlobalFilter`, but that one only reports - it
 * rethrows so Nest's default handler still owns the response, which would leave
 * the response shape defined somewhere else. Doing both here keeps the two in
 * step.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  // `HttpAdapterHost` rather than the raw Express `Response`, so the filter keeps
  // working if the HTTP adapter is swapped (Fastify is a drop-in swap).
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request = context.getRequest();

    const contentEncoding = requestContentEncoding(request);
    const statusCode = resolveStatus(exception, contentEncoding);

    const method = httpAdapter.getRequestMethod(request);
    const path = httpAdapter.getRequestUrl(request);

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Unexpected: the full stack goes to the log and to Sentry, and the caller
      // is told nothing beyond "it broke".
      this.logger.error(
        `${method} ${path} failed with ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception);
    } else {
      // The caller's mistake: one short line naming the status and what was wrong,
      // kept out of Sentry so real faults are not drowned out.
      this.logger.warn(`${method} ${path} failed with ${statusCode} (${describeType(exception)})`);
    }

    httpAdapter.reply(
      context.getResponse(),
      this.toErrorBody(exception, statusCode, path, contentEncoding),
      statusCode,
    );
  }

  /**
   * Maps an exception onto the response body.
   *
   * A 5xx - and anything unrecognised - is never described. A 4xx is: an
   * `HttpException` keeps the shape Nest gave it, and a client-side error that is
   * not one (body-parser and friends) is described from its own fields.
   */
  private toErrorBody(
    exception: unknown,
    statusCode: number,
    path: string,
    contentEncoding: string | undefined,
  ): ErrorResponseBody {
    const timestamp = new Date().toISOString();

    // Genuine server faults, and anything we cannot attribute to the caller, get
    // one generic body with no room for a leaked stack or driver message.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return {
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal server error',
        path,
        timestamp,
      };
    }

    if (exception instanceof HttpException) {
      const response: unknown = exception.getResponse();

      if (typeof response === 'string') {
        return { statusCode, error: exception.name, message: response, path, timestamp };
      }

      const { error, message } = response as {
        error?: string;
        message?: string | string[];
      };

      return {
        statusCode,
        // Nest puts the human-readable reason here ("Bad Request"), next to the
        // message the throwing code supplied.
        error: error ?? exception.name,
        message: message ?? exception.message,
        path,
        timestamp,
      };
    }

    // A client-side error that is not an `HttpException`. The specific message
    // comes from the error `type` when we know it, otherwise from the error's own
    // message (when it marked itself safe to show), otherwise from the status.
    const reason = STATUS_CODES[statusCode] ?? 'Error';

    return {
      statusCode,
      error: reason,
      message:
        mapClientError(exception, contentEncoding)?.message ?? exposedMessage(exception) ?? reason,
      path,
      timestamp,
    };
  }
}

/**
 * Resolves the status a failed request is answered with, in this order:
 *
 * 1. an `HttpException` carries its own status;
 * 2. a body-parser error `type` we recognise implies an exact status;
 * 3. any other error exposing a numeric `status`/`statusCode` in the 4xx range;
 * 4. otherwise 500.
 *
 * Step 3 is what keeps a 413/415 from body-parser - an error Nest's own adapter
 * leaves untouched because it is neither a `SyntaxError` nor an `HttpException` -
 * from being reported as a server fault.
 *
 * The request's `Content-Encoding` is carried through only so `mapClientError` can
 * name it in a decompression message; a decompression failure is a 400 either way.
 */
function resolveStatus(exception: unknown, contentEncoding: string | undefined): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }

  const mapped = mapClientError(exception, contentEncoding);
  if (mapped) {
    return mapped.statusCode;
  }

  const status = numericStatus(exception);
  if (status !== undefined && status >= 400 && status <= 499) {
    return status;
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Describes the body-parsing (and other `http-errors`) mistakes we can name, so
 * the caller is told exactly what was wrong instead of a bare status.
 *
 * A failed decompression is the one such mistake with no `type` of its own (see
 * `isDecompressionFailure`); it is named from the request's `Content-Encoding`.
 *
 * Returns `null` for anything else, leaving the caller to fall back to the
 * error's own message or its status reason phrase.
 */
function mapClientError(
  exception: unknown,
  contentEncoding: string | undefined,
): { statusCode: number; message: string } | null {
  const error = exception as RequestError;

  if (error === null || typeof error !== 'object') {
    return null;
  }

  // The one body-parser mistake with no `type` of its own: a body it could not
  // decompress. zlib's `code` survives the wrap, so that is what names it.
  if (isDecompressionFailure(error)) {
    return { statusCode: 400, message: decompressionMessage(contentEncoding) };
  }

  if (typeof error.type !== 'string') {
    return null;
  }

  switch (error.type) {
    case 'entity.too.large':
      return { statusCode: 413, message: tooLargeMessage(error) };
    case 'entity.parse.failed':
      return { statusCode: 400, message: 'Request body is not valid JSON' };
    case 'encoding.unsupported':
      return {
        statusCode: 415,
        message: `Unsupported Content-Encoding: ${error.encoding ?? 'unknown'}`,
      };
    case 'charset.unsupported':
      return { statusCode: 415, message: `Unsupported charset: ${error.charset ?? 'unknown'}` };
    case 'request.aborted':
      return { statusCode: 400, message: 'Client closed the connection before the body finished' };
    case 'request.size.invalid':
      return { statusCode: 400, message: 'Content-Length does not match the body size' };
    default:
      return null;
  }
}

/**
 * The message for `entity.too.large`, naming the ceiling and - when the parser
 * knows it - how much was received.
 */
function tooLargeMessage(error: RequestError): string {
  const details: string[] = [];

  if (typeof error.limit === 'number') {
    details.push(`limit ${error.limit} bytes`);
  }

  const size = typeof error.received === 'number' ? error.received : error.length;
  if (typeof size === 'number') {
    details.push(`received ${size} bytes`);
  }

  return details.length > 0
    ? `Request body too large: ${details.join(', ')}`
    : 'Request body too large';
}

/**
 * Whether an error is a body that could not be decompressed.
 *
 * body-parser inflates the body through zlib before parsing it, so a body it
 * cannot inflate surfaces zlib's own error; body-parser then re-wraps that with
 * `createError(400, err)`, which keeps the `code` but adds no `type`. The code is
 * therefore the only thing that identifies it: `Z_DATA_ERROR` / `Z_BUF_ERROR` for
 * gzip and deflate, and brotli's own `ERR__ERROR_*` for `br`. Every other
 * body-parser mistake carries a `type` instead, so none of them is caught here.
 */
function isDecompressionFailure(error: RequestError): boolean {
  return (
    typeof error.code === 'string' &&
    (/^Z_[A-Z_]*ERROR$/.test(error.code) || error.code.startsWith('ERR__ERROR_'))
  );
}

/**
 * The message for a body that could not be decompressed, naming the encoding the
 * caller declared.
 *
 * zlib's own wording - "incorrect header check", "invalid block type" - describes
 * nothing to the sender and is never echoed; the request's own `Content-Encoding`
 * is what does.
 */
function decompressionMessage(contentEncoding: string | undefined): string {
  return `Request body could not be decompressed (Content-Encoding: ${
    contentEncoding ?? 'unknown'
  })`;
}

/**
 * The `Content-Encoding` a request declared, lower-cased, when there is one.
 *
 * Read from the request rather than the error because the failure that needs it
 * carries no `encoding` of its own. Express lower-cases header names, so the key
 * is always `content-encoding`; the value is lower-cased here to match the token
 * body-parser itself switches on when it picks a decompression stream.
 */
function requestContentEncoding(request: unknown): string | undefined {
  if (request === null || typeof request !== 'object') {
    return undefined;
  }

  const value = (request as { headers?: Record<string, unknown> }).headers?.['content-encoding'];

  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : undefined;
}

/** The numeric `status`/`statusCode` an arbitrary error carries, if any. */
function numericStatus(exception: unknown): number | undefined {
  if (exception === null || typeof exception !== 'object') {
    return undefined;
  }

  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };

  if (typeof status === 'number') {
    return status;
  }

  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** The error's own message, but only when `http-errors` marked it safe to show. */
function exposedMessage(exception: unknown): string | undefined {
  const error = exception as RequestError;

  if (
    error !== null &&
    typeof error === 'object' &&
    error.expose === true &&
    typeof error.message === 'string' &&
    error.message.length > 0
  ) {
    return error.message;
  }

  return undefined;
}

/** A short label for the log line: the body-parser `type` when present, else the error name. */
function describeType(exception: unknown): string {
  const error = exception as RequestError;

  if (error !== null && typeof error === 'object' && typeof error.type === 'string') {
    return error.type;
  }

  return exception instanceof Error ? exception.name : 'unknown';
}
