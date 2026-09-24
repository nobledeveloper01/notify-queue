import { buildConfig } from '../../src/config/configuration.js';
import { AppRole, validateEnv } from '../../src/config/env.validation.js';

const minimalEnv = { DATABASE_PASSWORD: 'secret' };

describe('validateEnv', () => {
  it('applies documented defaults when only required values are set', () => {
    const env = validateEnv(minimalEnv);

    expect(env.APP_ROLE).toBe(AppRole.All);
    expect(env.WORKER_CONCURRENCY).toBe(10);
    expect(env.WORKER_BATCH_SIZE).toBe(100);
    expect(env.MAX_RETRIES).toBe(5);
    expect(env.MOCK_FAILURE_RATE).toBe(0.2);
  });

  it('coerces numeric strings from the environment', () => {
    const env = validateEnv({ ...minimalEnv, WORKER_CONCURRENCY: '3', MOCK_FAILURE_RATE: '0' });

    expect(env.WORKER_CONCURRENCY).toBe(3);
    expect(env.MOCK_FAILURE_RATE).toBe(0);
  });

  it('rejects a missing database password', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_PASSWORD/);
  });

  it('lists every invalid value in one error', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, MOCK_FAILURE_RATE: '1.5', WORKER_CONCURRENCY: '0' }),
    ).toThrow(
      /MOCK_FAILURE_RATE[\s\S]*WORKER_CONCURRENCY|WORKER_CONCURRENCY[\s\S]*MOCK_FAILURE_RATE/,
    );
  });

  it('rejects a base retry delay larger than the maximum', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, BASE_RETRY_DELAY_MS: '5000', MAX_RETRY_DELAY_MS: '1000' }),
    ).toThrow(/BASE_RETRY_DELAY_MS/);
  });

  it('accepts a compose-internal webhook host without a TLD', () => {
    const env = validateEnv({ ...minimalEnv, WEBHOOK_URL: 'http://api:3000/webhooks/mock' });

    expect(env.WEBHOOK_URL).toBe('http://api:3000/webhooks/mock');
  });
});

describe('buildConfig', () => {
  it('generates a worker ID when WORKER_ID is empty', () => {
    const config = buildConfig(validateEnv({ ...minimalEnv, WORKER_ID: '' }));

    expect(config.worker.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an explicit worker ID', () => {
    const config = buildConfig(validateEnv({ ...minimalEnv, WORKER_ID: 'worker-a' }));

    expect(config.worker.id).toBe('worker-a');
  });
});
