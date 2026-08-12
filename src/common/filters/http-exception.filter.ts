import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  message: string;
  errors?: Record<string, string[]>;
}

/**
 * Normalises every error to `{ message, errors? }`.
 *
 * That is exactly the shape the legacy `err()` helper produced, and
 * `client/lib/api-client.js` reads `data.message` to build its ApiError. Nest's
 * default envelope (`{ statusCode, message, error }`, with `message` as a string
 * ARRAY for validation failures) would have broken that contract silently.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = this.toBody(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Log the cause server-side; never leak internals to the caller.
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private toBody(exception: unknown, status: number): ErrorBody {
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return { message: 'Internal server error' };
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'string') return { message: payload };

      const { message } = payload as { message?: string | string[] };

      // class-validator returns one string per failed constraint.
      if (Array.isArray(message)) {
        return { message: message[0] ?? 'Validation failed', errors: group(message) };
      }
      return { message: message ?? exception.message };
    }

    return { message: 'Internal server error' };
  }
}

/** Buckets "field must be ..." constraint strings under their field name. */
function group(messages: string[]): Record<string, string[]> {
  return messages.reduce<Record<string, string[]>>((acc, message) => {
    const field = message.split(' ')[0] ?? '_';
    (acc[field] ??= []).push(message);
    return acc;
  }, {});
}
