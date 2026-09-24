import { QueryFailedError } from 'typeorm';
import { loggableError } from '../../src/common/utils/error.util.js';
import { AppLogger } from '../../src/common/logging/app-logger.service.js';
import { createPinoLogger } from '../../src/common/logging/pino.factory.js';
import { AppRole, LogLevel, NodeEnvironment } from '../../src/config/env.validation.js';
import { LogCapture } from '../support/log-capture.js';

const failedInsert = () => {
  const driverError = Object.assign(
    new Error('invalid input syntax for type json: "SECRET-PAYLOAD"'),
    { code: '22P02' },
  );
  return new QueryFailedError(
    'INSERT INTO notification_jobs (recipient, payload) VALUES ($1, $2)',
    ['secret-recipient@example.com', '{"body":"SECRET-PAYLOAD"}'],
    driverError,
  );
};

describe('loggableError', () => {
  it('keeps only the class, SQLSTATE and constraint of a database error', () => {
    const logged = loggableError(failedInsert());

    expect(logged).toEqual({ name: 'QueryFailedError', code: '22P02' });
    expect(JSON.stringify(logged)).not.toMatch(/SECRET|secret-recipient|INSERT/);
  });

  it('keeps message and stack for ordinary errors', () => {
    expect(loggableError(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('describes thrown non-errors', () => {
    expect(loggableError('plain string')).toEqual({ name: 'string', message: 'plain string' });
  });
});

describe('log redaction backstop', () => {
  it('censors SQL parameters even if a database error is logged whole', () => {
    const capture = new LogCapture();
    const logger = new AppLogger(
      createPinoLogger(
        { nodeEnv: NodeEnvironment.Production, role: AppRole.Api, logLevel: LogLevel.Info },
        capture,
      ),
    );

    logger.error({ event: 'oops', err: failedInsert() });

    expect(capture.text).not.toMatch(/secret-recipient|SECRET-PAYLOAD/);
  });
});
