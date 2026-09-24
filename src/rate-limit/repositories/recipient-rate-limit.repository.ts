import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { RATE_LIMIT_LOCK_NAMESPACE } from '../../common/constants/rate-limit.constants.js';

export interface RecentUsage {
  /** Reservations inside the window. */
  count: number;
  /** The oldest of them: when it leaves the window, a slot frees. */
  oldest: Date | null;
}

/** Operations available while a recipient's lock is held. */
export interface RecipientLockScope {
  hasActiveReservation(jobId: string, windowSeconds: number): Promise<boolean>;
  recentUsage(recipient: string, windowSeconds: number): Promise<RecentUsage>;
  reserve(recipient: string, jobId: string): Promise<void>;
}

/**
 * Persistence for sliding-window rate limits.
 *
 * Concurrency: every admission for a recipient runs inside one short
 * transaction holding `pg_advisory_xact_lock(namespace, hashtext(recipient))`.
 * Two workers checking the same recipient therefore run one after the other,
 * so "count, then reserve" cannot interleave into N+1 sends. A row lock would
 * not do: for a recipient's first notification there is no row to lock yet.
 * Hash collisions between recipients only serialise them a little more; they
 * never let a limit be exceeded. The lock is released at COMMIT.
 */
@Injectable()
export class RecipientRateLimitRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  withRecipientLock<T>(
    recipient: string,
    work: (scope: RecipientLockScope) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        RATE_LIMIT_LOCK_NAMESPACE,
        recipient,
      ]);
      return work(this.scope(manager));
    });
  }

  /** Deletes reservations that can no longer affect any decision. Returns how many. */
  async pruneExpired(windowSeconds: number): Promise<number> {
    const rows: { job_id: string }[] = await this.dataSource.query(
      `DELETE FROM rate_limit_reservations
        WHERE reserved_at <= now() - make_interval(secs => $1)
        RETURNING job_id`,
      [windowSeconds],
    );
    return rows.length;
  }

  private scope(manager: EntityManager): RecipientLockScope {
    return {
      hasActiveReservation: async (jobId, windowSeconds) => {
        const rows: unknown[] = await manager.query(
          `SELECT 1 FROM rate_limit_reservations
            WHERE job_id = $1 AND reserved_at > now() - make_interval(secs => $2)`,
          [jobId, windowSeconds],
        );
        return rows.length > 0;
      },

      recentUsage: async (recipient, windowSeconds) => {
        const [row]: { count: string; oldest: Date | null }[] = await manager.query(
          `SELECT count(*) AS count, min(reserved_at) AS oldest
             FROM rate_limit_reservations
            WHERE recipient = $1 AND reserved_at > now() - make_interval(secs => $2)`,
          [recipient, windowSeconds],
        );
        return { count: Number(row.count), oldest: row.oldest };
      },

      reserve: async (recipient, jobId) => {
        // A job whose old reservation has aged out takes a fresh one.
        await manager.query(
          `INSERT INTO rate_limit_reservations (job_id, recipient) VALUES ($1, $2)
           ON CONFLICT (job_id) DO UPDATE SET reserved_at = now()`,
          [jobId, recipient],
        );
      },
    };
  }
}
