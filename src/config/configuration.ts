import { randomUUID } from 'node:crypto';
import { validateEnv } from './env.validation.js';
import type { AppRole, EnvironmentVariables, LogLevel, NodeEnvironment } from './env.validation.js';

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
  recoveryIntervalMs: number;
  shutdownTimeoutMs: number;
  visibilityTimeoutSeconds: number;
}

export interface DeliveryConfig {
  providerTimeoutMs: number;
  mockFailureRate: number;
  mockLatencyMs: number;
}

export interface RetryConfig {
  /** Retries after the first attempt; a job gets `maxRetries + 1` attempts in total. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RateLimitConfig {
  maxNotifications: number;
  windowSeconds: number;
}

export interface WebhookConfig {
  /** Unset disables dispatch; events are still recorded in the outbox. */
  url?: string;
  timeoutMs: number;
  maxAttempts: number;
  pollIntervalMs: number;
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  role: AppRole;
  port: number;
  logLevel: LogLevel;
  database: DatabaseConfig;
  worker: WorkerConfig;
  retry: RetryConfig;
  rateLimit: RateLimitConfig;
  delivery: DeliveryConfig;
  webhook: WebhookConfig;
}

/**
 * Maps validated flat environment variables onto the typed, grouped shape
 * the rest of the application consumes through `ConfigService<AppConfig>`.
 */
export const buildConfig = (env: EnvironmentVariables): AppConfig => ({
  nodeEnv: env.NODE_ENV,
  role: env.APP_ROLE,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
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
    recoveryIntervalMs: env.WORKER_RECOVERY_INTERVAL_MS,
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
    visibilityTimeoutSeconds: env.JOB_VISIBILITY_TIMEOUT_SECONDS,
  },
  retry: {
    maxRetries: env.MAX_RETRIES,
    baseDelayMs: env.BASE_RETRY_DELAY_MS,
    maxDelayMs: env.MAX_RETRY_DELAY_MS,
  },
  rateLimit: {
    maxNotifications: env.RATE_LIMIT_MAX_NOTIFICATIONS,
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
  },
  delivery: {
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
    mockFailureRate: env.MOCK_FAILURE_RATE,
    mockLatencyMs: env.MOCK_LATENCY_MS,
  },
  webhook: {
    url: env.WEBHOOK_URL,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    pollIntervalMs: env.WEBHOOK_POLL_INTERVAL_MS,
  },
});

/** ConfigModule `load` factory: validate once at boot, then expose typed config. */
export const configuration = (): AppConfig => buildConfig(validateEnv(process.env));
