import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { AppRole } from '../../config/env.validation.js';

/** What a worker instance answers over HTTP: probes and metrics, nothing else. */
const WORKER_PATHS = new Set(['/health', '/metrics']);

/**
 * Keeps the roles honest. One image serves both, but a worker is not an API
 * server: it listens only so orchestrators can probe it and scrape it. Any
 * other request to a worker gets the standard 404 error body.
 */
@Injectable()
export class RoleRoutesMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  private readonly workerOnly: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.workerOnly = config.get('role', { infer: true }) === AppRole.Worker;
  }

  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    const path = (req.url ?? '').split('?')[0];
    if (this.workerOnly && !WORKER_PATHS.has(path)) {
      throw new NotFoundException(
        `${path} is not served by a worker instance (APP_ROLE=worker); send API requests to an API instance`,
      );
    }
    next();
  }
}
