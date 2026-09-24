import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Which half of the system this process runs. One image, one entrypoint:
 * `api` serves the HTTP API and never delivers; `worker` polls and delivers,
 * and answers only /health and /metrics over HTTP; `all` does both
 * (convenient for local development).
 */
export enum AppRole {
  Api = 'api',
  Worker = 'worker',
  All = 'all',
}

/**
 * Every environment variable the application reads. Defaults live here so the
 * rest of the code never has to guess at a fallback.
 *
 * Keep the explicit type annotations even where TypeScript could infer them:
 * decorator metadata records an unannotated property as `Object`, and
 * class-transformer then leaves `"3"` as a string instead of coercing it.
 */
export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @IsEnum(AppRole)
  APP_ROLE: AppRole = AppRole.All;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @IsString()
  @IsNotEmpty()
  DATABASE_HOST: string = 'localhost';

  @IsInt()
  @Min(1)
  @Max(65535)
  DATABASE_PORT: number = 5432;

  @IsString()
  @IsNotEmpty()
  DATABASE_NAME: string = 'notify_queue';

  @IsString()
  @IsNotEmpty()
  DATABASE_USER: string = 'postgres';

  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD: string;

  @IsInt()
  @Min(1)
  DATABASE_POOL_MAX: number = 10;

  @IsOptional()
  @IsString()
  WORKER_ID?: string;

  @IsInt()
  @Min(1)
  WORKER_CONCURRENCY: number = 10;

  @IsInt()
  @Min(1)
  WORKER_BATCH_SIZE: number = 100;

  @IsInt()
  @Min(10)
  WORKER_POLL_INTERVAL_MS: number = 1000;

  @IsInt()
  @Min(1000)
  WORKER_RECOVERY_INTERVAL_MS: number = 30000;

  @IsInt()
  @Min(0)
  WORKER_SHUTDOWN_TIMEOUT_MS: number = 30000;

  @IsInt()
  @Min(1)
  JOB_VISIBILITY_TIMEOUT_SECONDS: number = 300;

  @IsInt()
  @Min(1)
  PROVIDER_TIMEOUT_MS: number = 10000;

  @IsInt()
  @Min(1)
  MAX_RETRIES: number = 5;

  @IsInt()
  @Min(1)
  BASE_RETRY_DELAY_MS: number = 1000;

  @IsInt()
  @Min(1)
  MAX_RETRY_DELAY_MS: number = 60000;

  @IsNumber()
  @Min(0)
  @Max(1)
  MOCK_FAILURE_RATE: number = 0.2;

  @IsInt()
  @Min(0)
  MOCK_LATENCY_MS: number = 50;

  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX_NOTIFICATIONS: number = 10;

  @IsInt()
  @Min(1)
  RATE_LIMIT_WINDOW_SECONDS: number = 3600;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  WEBHOOK_URL?: string;

  @IsInt()
  @Min(1)
  WEBHOOK_TIMEOUT_MS: number = 5000;

  @IsInt()
  @Min(1)
  WEBHOOK_MAX_ATTEMPTS: number = 10;

  @IsInt()
  @Min(10)
  WEBHOOK_POLL_INTERVAL_MS: number = 1000;
}

/**
 * Validates and coerces raw environment variables. Empty strings count as
 * unset, so `WORKER_ID=` in a .env file falls through to a generated ID.
 * Throws with every problem listed at once, so a misconfigured deploy fails
 * at boot rather than on the first job.
 */
export const validateEnv = (raw: Record<string, string | undefined>): EnvironmentVariables => {
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ''),
  );

  const env = plainToInstance(EnvironmentVariables, present, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .flatMap(({ property, constraints }) =>
        Object.values(constraints ?? {}).map((message) => `  - ${property}: ${message}`),
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (env.BASE_RETRY_DELAY_MS > env.MAX_RETRY_DELAY_MS) {
    throw new Error(
      'Invalid environment configuration:\n  - BASE_RETRY_DELAY_MS must not exceed MAX_RETRY_DELAY_MS',
    );
  }

  // A provider call that outlives the lease would let recovery hand the job
  // to a second worker while the first is still sending it.
  if (env.PROVIDER_TIMEOUT_MS >= env.JOB_VISIBILITY_TIMEOUT_SECONDS * 1000) {
    throw new Error(
      'Invalid environment configuration:\n  - PROVIDER_TIMEOUT_MS must be shorter than JOB_VISIBILITY_TIMEOUT_SECONDS',
    );
  }

  return env;
};
