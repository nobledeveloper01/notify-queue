import { QueryFailedError } from 'typeorm';

/** The message of an unknown thrown value, for logs and stored `last_error` values. */
export const errorMessage = (error: unknown, fallback = 'Unknown error'): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

export interface LoggableError {
  name: string;
  message?: string;
  /** PostgreSQL SQLSTATE, e.g. 23505 for a unique violation. */
  code?: string;
  constraint?: string;
  stack?: string;
}

/**
 * What is safe to write to a log about an unexpected error.
 *
 * A TypeORM QueryFailedError carries the SQL and its bound parameters, which
 * here include recipients and notification payloads, and PostgreSQL's
 * messages can quote input values. So for database errors only the class,
 * the SQLSTATE code and the constraint name are kept; the message and the
 * stack (whose first line repeats the message) are dropped.
 */
export const loggableError = (error: unknown): LoggableError => {
  if (error instanceof QueryFailedError) {
    const driverError = error.driverError as { code?: unknown; constraint?: unknown };
    return {
      name: 'QueryFailedError',
      ...(typeof driverError.code === 'string' ? { code: driverError.code } : {}),
      ...(typeof driverError.constraint === 'string' ? { constraint: driverError.constraint } : {}),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: typeof error, message: errorMessage(error) };
};
