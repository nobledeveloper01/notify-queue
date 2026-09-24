import { STATUS_CODES } from 'node:http';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ErrorResponseDto, FieldErrorDto } from '../dto/error-response.dto.js';
import { ensureRequestId } from '../middleware/request-id.middleware.js';
import { loggableError } from '../utils/error.util.js';

/**
 * Errors from Express middleware (body-parser's 413 and malformed-JSON 400)
 * follow the http-errors convention: a 4xx `status` and `expose: true` mean
 * the message was written for the client.
 */
interface ClientSafeError {
  status: number;
  expose: true;
  message: string;
}

const isClientSafeError = (error: unknown): error is ClientSafeError => {
  if (typeof error !== 'object' || error === null) return false;
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true;
};

interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
  details?: FieldErrorDto[];
}

/**
 * Turns every error into the same JSON shape. Expected errors (HttpException,
 * or client-safe middleware errors) keep their status and message; anything
 * else becomes a generic 500 and is logged server-side with its stack, which
 * never reaches the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = ensureRequestId(request, response);

    const expected = exception instanceof HttpException || isClientSafeError(exception);
    const body: ErrorResponseDto =
      exception instanceof HttpException
        ? this.fromHttpException(exception, request.path, requestId)
        : isClientSafeError(exception)
          ? {
              statusCode: exception.status,
              error: STATUS_CODES[exception.status] ?? 'Error',
              message: exception.message,
              path: request.path,
              requestId,
            }
          : {
              statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
              error: 'Internal Server Error',
              message: 'An unexpected error occurred',
              path: request.path,
              requestId,
            };

    if (!expected) {
      const { stack, ...error } = loggableError(exception);
      this.logger.error({ requestId, method: request.method, path: request.path, error }, stack);
    }

    response.status(body.statusCode).json(body);
  }

  private fromHttpException(
    exception: HttpException,
    path: string,
    requestId: string,
  ): ErrorResponseDto {
    const statusCode = exception.getStatus();
    const raw = exception.getResponse();
    const body: HttpExceptionBody = typeof raw === 'string' ? { message: raw } : raw;
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;

    return {
      statusCode,
      error: body.error ?? exception.name,
      message: message ?? exception.message,
      ...(body.details ? { details: body.details } : {}),
      path,
      requestId,
    };
  }
}
