import { randomUUID } from 'node:crypto';
import { validateEnv } from './env.validation.js';
import type { AppRole, EnvironmentVariables, NodeEnvironment } from './env.validation.js';

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  poolMax: number;
}

export interface WorkerConfig {
  id: string;
  concurrency: number;
  batchSize: number;
  pollIntervalMs: number;
  visibilityTimeoutSeconds: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RateLimitConfig {
  maxNotifications: number;
  windowSeconds: number;
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  role: AppRole;
  port: number;
  database: DatabaseConfig;
  worker: WorkerConfig;
  retry: RetryConfig;
  rateLimit: RateLimitConfig;
  mockFailureRate: number;
  webhookUrl?: string;
}

/**
 * Maps validated flat environment variables onto the typed, grouped shape
 * the rest of the application consumes through `ConfigService<AppConfig>`.
 */
export const buildConfig = (env: EnvironmentVariables): AppConfig => ({
  nodeEnv: env.NODE_ENV,
  role: env.APP_ROLE,
  port: env.PORT,
  database: {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    name: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    poolMax: env.DATABASE_POOL_MAX,
  },
  worker: {
    id: env.WORKER_ID ?? randomUUID(),
    concurrency: env.WORKER_CONCURRENCY,
    batchSize: env.WORKER_BATCH_SIZE,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    visibilityTimeoutSeconds: env.JOB_VISIBILITY_TIMEOUT_SECONDS,
  },
  retry: {
    maxAttempts: env.MAX_RETRIES,
    baseDelayMs: env.BASE_RETRY_DELAY_MS,
    maxDelayMs: env.MAX_RETRY_DELAY_MS,
  },
  rateLimit: {
    maxNotifications: env.RATE_LIMIT_MAX_NOTIFICATIONS,
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
  },
  mockFailureRate: env.MOCK_FAILURE_RATE,
  webhookUrl: env.WEBHOOK_URL,
});

/** ConfigModule `load` factory: validate once at boot, then expose typed config. */
export const configuration = (): AppConfig => buildConfig(validateEnv(process.env));
