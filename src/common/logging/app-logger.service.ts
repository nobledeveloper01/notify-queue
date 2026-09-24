import { Inject, Injectable } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import type { Level, Logger } from 'pino';
import { PINO_LOGGER } from './logging.tokens.js';

/**
 * Nest's LoggerService on top of pino, so framework logs and every
 * `new Logger(Context).log(...)` in the app become structured JSON.
 *
 * Services log objects: `logger.log({ event: 'job.sent', workerId, jobId })`.
 * Those fields land at the top level of the JSON line, next to `context`.
 */
@Injectable()
export class AppLogger implements LoggerService {
  constructor(@Inject(PINO_LOGGER) private readonly pino: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /**
   * Nest calls `log(message, context)` and `error(message, stack, context)`:
   * the context, when present, is always the last string argument.
   */
  private write(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const context = typeof rest.at(-1) === 'string' ? (rest.pop() as string) : undefined;
    const stack = typeof rest[0] === 'string' && rest[0].includes('\n') ? rest[0] : undefined;
    const base = { ...(context ? { context } : {}), ...(stack ? { stack } : {}) };

    if (message instanceof Error) {
      this.pino[level]({ ...base, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.pino[level]({ ...base, ...(message as Record<string, unknown>) });
    } else {
      this.pino[level](base, String(message));
    }
  }
}
