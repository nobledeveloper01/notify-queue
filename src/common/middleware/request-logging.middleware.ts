import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { HttpLogger } from 'pino-http';
import { PINO_LOGGER } from '../logging/logging.tokens.js';
import { ensureRequestId } from './request-id.middleware.js';

const pathOf = (req: IncomingMessage): string => (req.url ?? '').split('?')[0];

/**
 * One JSON line per request, written when the response finishes:
 * requestId, method, path, statusCode and responseTime (ms).
 *
 * The serializers whitelist those fields, so request bodies (notification
 * payloads), headers and query strings are never written.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  private readonly httpLogger: HttpLogger;

  constructor(@Inject(PINO_LOGGER) logger: Logger) {
    this.httpLogger = pinoHttp({
      logger,
      genReqId: (req, res) => ensureRequestId(req, res),
      customProps: (req) => ({ requestId: req.requestId }),
      serializers: {
        req: (req: IncomingMessage) => ({ method: req.method, path: pathOf(req) }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      customSuccessMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
      customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Orchestrator health probes would otherwise drown the log.
      autoLogging: { ignore: (req) => pathOf(req) === '/health' },
    });
  }

  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    this.httpLogger(req, res, next);
  }
}
