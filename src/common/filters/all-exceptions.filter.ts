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
 * Global exception filter (Step 6).
 *
 * It has two jobs, kept in one place on purpose so the API has a single error
 * path: answer the caller in a predictable shape, and report genuinely
 * unexpected failures to Sentry with a usable stack trace.
 *
 * `@sentry/nestjs` ships `SentryGlobalFilter`, but that one only reports - it
 * rethrows so Nest's default handler still owns the response, which would leave
 * the response shape defined somewhere else. Doing both here keeps the two in
 * step.
 *
 * Unlike Nest's default handler, an internal failure is never described to the
 * caller: the real message tends to carry ORM/driver internals. The detail goes
 * to the log and to Sentry instead.
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

    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const method = httpAdapter.getRequestMethod(request);
    const path = httpAdapter.getRequestUrl(request);

    // Only 5xx reaches Sentry: a 4xx is the caller's mistake and is already
    // described in the response, so reporting it would drown the real issues.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${method} ${path} failed with ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception);
    }

    httpAdapter.reply(
      context.getResponse(),
      this.toErrorBody(exception, statusCode, path),
      statusCode,
    );
  }

  /**
   * Maps an exception onto the response body, never exposing internals for a 5xx.
   */
  private toErrorBody(exception: unknown, statusCode: number, path: string): ErrorResponseBody {
    const timestamp = new Date().toISOString();

    // The second half of the condition is what narrows `exception` for TypeScript:
    // anything that is not an `HttpException` was floored to a 500 above.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR || !(exception instanceof HttpException)) {
      return {
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal server error',
        path,
        timestamp,
      };
    }

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
}
