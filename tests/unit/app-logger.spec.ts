import { LogCapture } from '../support/log-capture.js';
import { AppLogger } from '../../src/common/logging/app-logger.service.js';
import { createPinoLogger } from '../../src/common/logging/pino.factory.js';
import { AppRole, LogLevel, NodeEnvironment } from '../../src/config/env.validation.js';

describe('AppLogger', () => {
  let capture: LogCapture;
  let logger: AppLogger;

  beforeEach(() => {
    capture = new LogCapture();
    logger = new AppLogger(
      createPinoLogger(
        { nodeEnv: NodeEnvironment.Production, role: AppRole.Worker, logLevel: LogLevel.Debug },
        capture,
      ),
    );
  });

  it('writes structured fields at the top level with the Nest context', () => {
    logger.log(
      { event: 'job.sent', workerId: 'w-1', jobId: 'j-1', attempt: 2 },
      'JobProcessorService',
    );

    expect(capture.lines[0]).toMatchObject({
      level: 30,
      service: 'notify-queue',
      role: 'worker',
      context: 'JobProcessorService',
      event: 'job.sent',
      workerId: 'w-1',
      jobId: 'j-1',
      attempt: 2,
    });
  });

  it('keeps a stack passed the way Nest passes it to error()', () => {
    logger.error({ event: 'boom' }, 'Error: x\n    at f (file.js:1:1)', 'Ctx');

    expect(capture.lines[0]).toMatchObject({
      level: 50,
      context: 'Ctx',
      event: 'boom',
      stack: expect.stringContaining('at f'),
    });
  });

  it('logs plain strings as the message', () => {
    logger.warn('careful', 'Ctx');

    expect(capture.lines[0]).toMatchObject({ level: 40, msg: 'careful', context: 'Ctx' });
  });

  it('redacts payloads even if someone logs one', () => {
    logger.log({ event: 'oops', payload: { body: 'SECRET' }, job: { payload: 'SECRET' } });

    expect(capture.text).not.toContain('SECRET');
  });

  it('redacts recipients and idempotency keys even if someone logs one', () => {
    logger.log({
      event: 'oops',
      recipient: 'ada@example.com',
      job: { recipient: '+2348012345678', idempotencyKey: 'order-ada-42' },
    });

    expect(capture.text).not.toContain('ada@example.com');
    expect(capture.text).not.toContain('+2348012345678');
    expect(capture.text).not.toContain('order-ada-42');
  });
});
