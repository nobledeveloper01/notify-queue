import { pino, stdSerializers } from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { QueryFailedError } from 'typeorm';
import type { AppConfig } from '../../config/configuration.js';
import { NodeEnvironment } from '../../config/env.validation.js';
import { loggableError } from '../utils/error.util.js';

export type LoggerSettings = Pick<AppConfig, 'nodeEnv' | 'role' | 'logLevel'>;

/**
 * Paths that may hold notification content or credentials. Nothing in the
 * app logs them on purpose; this is the backstop if someone does.
 */
export const REDACTED_PATHS = [
  'payload',
  '*.payload',
  'body',
  '*.body',
  'req.headers',
  'headers',
  '*.password',
  // A TypeORM QueryFailedError logged whole carries its SQL and bound values.
  'parameters',
  '*.parameters',
  '*.query',
  '*.driverError',
];

/**
 * One pino instance per process, writing JSON lines. In development, a
 * readable single-line format instead (pino-pretty is a dev dependency and
 * is never loaded in production).
 */
export const createPinoLogger = (
  settings: LoggerSettings,
  destination?: DestinationStream,
): Logger => {
  const options = {
    level: settings.logLevel,
    base: { service: 'notify-queue', role: settings.role, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: {
      // A database error's message and stack can quote input values; log
      // only its class and codes, whoever logs it.
      err: (error: unknown) =>
        error instanceof QueryFailedError
          ? loggableError(error)
          : stdSerializers.err(error as Error),
    },
  };

  if (destination) {
    return pino(options, destination);
  }
  if (settings.nodeEnv === NodeEnvironment.Development) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { singleLine: true } },
    });
  }
  return pino(options);
};
