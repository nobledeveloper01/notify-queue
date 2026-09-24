import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { REQUEST_ID_HEADER } from '../constants/app.constants.js';

declare module 'http' {
  interface IncomingMessage {
    requestId?: string;
  }
}

/** Accept a caller's ID only if it is short and log-safe; otherwise mint one. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the request's ID, assigning it (and echoing it in the response
 * header) on first call. Idempotent, so the exception filter can call it for
 * errors raised before the middleware ran, such as an oversized body.
 */
export const ensureRequestId = (req: IncomingMessage, res: ServerResponse): string => {
  if (req.requestId) {
    return req.requestId;
  }
  const incoming = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

  req.requestId = requestId;
  if (!res.headersSent) {
    res.setHeader(REQUEST_ID_HEADER, requestId);
  }
  return requestId;
};

@Injectable()
export class RequestIdMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    ensureRequestId(req, res);
    next();
  }
}
