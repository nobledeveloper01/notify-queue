import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import type { EntityManager, QueryResult, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { JOB_PRIORITY_RANK } from '../../common/enums/job-priority.enum.js';
import type { JobPriority } from '../../common/enums/job-priority.enum.js';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import type { NotificationChannel } from '../../common/enums/notification-channel.enum.js';
import { sourceStatusesFor } from '../domain/job-state-machine.js';
import { NotificationJob } from '../entities/notification-job.entity.js';

/** When a job first becomes due: an absolute time, or a delay from the database's now(). */
export type JobSchedule = { sendAt: Date } | { delaySeconds: number };

export interface NewNotificationJob {
  idempotencyKey: string;
  requestFingerprint: string;
  recipient: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  priority: JobPriority;
  schedule: JobSchedule;
  maxAttempts: number;
}

export interface InsertOutcome {
  job: NotificationJob;
  /** False when a job with this idempotency key already existed. */
  created: boolean;
}

export interface ClaimedBatch {
  /** Fencing token shared by every job in this claim; required to finish them. */
  claimToken: string;
  jobs: NotificationJob[];
}

export interface RecoveryOutcome {
  requeued: string[];
  deadLettered: string[];
}

/**
 * The only code that reads or writes `notification_jobs`.
 *
 * Every timestamp that orders or expires work (`now()`, lease cutoffs, retry
 * times) is computed by PostgreSQL, never by the worker's clock, so workers on
 * machines with skewed clocks still agree on what is due and what is stale.
 */
@Injectable()
export class NotificationJobRepository {
  private readonly jobs: Repository<NotificationJob>;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    this.jobs = dataSource.getRepository(NotificationJob);
  }

  findById(id: string): Promise<NotificationJob | null> {
    return this.jobs.findOneBy({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<NotificationJob | null> {
    return this.jobs.findOneBy({ idempotencyKey });
  }

  /**
   * Inserts the job unless its idempotency key is taken, in one statement.
   *
   * `ON CONFLICT DO NOTHING` makes the unique constraint the arbiter: when two
   * requests race, the loser's INSERT waits for the winner to commit and then
   * inserts nothing, so it never surfaces as a unique-violation error.
   *
   * A relative delay is resolved against the database clock, the same clock
   * the claim query compares `next_attempt_at` with.
   */
  async insertIfAbsent(input: NewNotificationJob): Promise<InsertOutcome> {
    const sendAt = 'sendAt' in input.schedule ? input.schedule.sendAt : null;
    const delaySeconds = 'delaySeconds' in input.schedule ? input.schedule.delaySeconds : null;

    const { records } = await this.run<{ id: string }>(
      `INSERT INTO notification_jobs
         (idempotency_key, request_fingerprint, recipient, channel, payload, priority,
          scheduled_at, next_attempt_at, max_attempts)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, due.at, due.at, $9
         FROM (SELECT COALESCE($7::timestamptz,
                               now() + make_interval(secs => $8::double precision)) AS at) AS due
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.idempotencyKey,
        input.requestFingerprint,
        input.recipient,
        input.channel,
        JSON.stringify(input.payload),
        JOB_PRIORITY_RANK[input.priority],
        sendAt,
        delaySeconds,
        input.maxAttempts,
      ],
    );

    const inserted = records.at(0);
    const job = inserted
      ? await this.findById(inserted.id)
      : await this.findByIdempotencyKey(input.idempotencyKey);

    if (!job) {
      // Only reachable if the row was deleted between the two statements.
      throw new Error(`Job for idempotency key "${input.idempotencyKey}" vanished after insert`);
    }
    return { job, created: inserted !== undefined };
  }

  /**
   * Atomically claims up to `batchSize` due jobs for one worker.
   *
   *   BEGIN
   *     SELECT ... FOR UPDATE SKIP LOCKED   -- lock due rows nobody else holds
   *     UPDATE ... SET status = PROCESSING  -- stamp owner, lease and token
   *   COMMIT                                -- locks released; claim is durable
   *
   * SKIP LOCKED makes concurrent workers pass over rows another transaction
   * has locked instead of queueing behind it, so N workers polling at once
   * take N disjoint batches. The transaction ends before any delivery starts:
   * no lock is ever held across a network call.
   *
   * The attempt is counted at claim time, so a job that crashes every worker
   * that touches it still exhausts its attempts and gets dead-lettered.
   */
  async claimDueJobs(workerId: string, batchSize: number): Promise<ClaimedBatch> {
    const claimToken = randomUUID();

    const jobs = await this.dataSource.transaction(async (manager) => {
      const { records: due } = await this.run<{ id: string }>(
        `SELECT id
           FROM notification_jobs
          WHERE status = $1
            AND next_attempt_at <= now()
            AND attempt_count < max_attempts
          ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [JobStatus.Pending, batchSize],
        manager,
      );
      if (due.length === 0) {
        return [];
      }

      const ids = due.map(({ id }) => id);
      await this.run(
        `UPDATE notification_jobs
            SET status        = $1,
                locked_by     = $2,
                locked_at     = now(),
                claim_token   = $3,
                attempt_count = attempt_count + 1,
                updated_at    = now()
          WHERE id = ANY($4::uuid[])`,
        [JobStatus.Processing, workerId, claimToken, ids],
        manager,
      );

      return manager.find(NotificationJob, {
        where: { id: In(ids) },
        order: { priority: 'DESC', nextAttemptAt: 'ASC', createdAt: 'ASC' },
      });
    });

    return { claimToken, jobs };
  }

  /** PROCESSING → SENT. False if this claim no longer owns the job. */
  markSent(id: string, claimToken: string): Promise<boolean> {
    return this.completeClaim(id, claimToken, JobStatus.Sent, {
      sentAt: () => 'now()',
      lastError: null,
    });
  }

  /** PROCESSING → FAILED, for errors that retrying cannot fix. */
  markFailed(id: string, claimToken: string, error: string): Promise<boolean> {
    return this.completeClaim(id, claimToken, JobStatus.Failed, {
      failedAt: () => 'now()',
      lastError: error,
    });
  }

  /** PROCESSING → DEAD_LETTERED, once retryable failures exhaust the attempts. */
  markDeadLettered(id: string, claimToken: string, error: string): Promise<boolean> {
    return this.completeClaim(id, claimToken, JobStatus.DeadLettered, {
      deadLetteredAt: () => 'now()',
      lastError: error,
    });
  }

  /** PROCESSING → PENDING, due again `delayMs` from now (database clock). */
  scheduleRetry(id: string, claimToken: string, delayMs: number, error: string): Promise<boolean> {
    return this.completeClaim(
      id,
      claimToken,
      JobStatus.Pending,
      {
        nextAttemptAt: () => 'now() + make_interval(secs => :delaySeconds)',
        lastError: error,
      },
      { delaySeconds: delayMs / 1000 },
    );
  }

  /**
   * Returns jobs whose lease expired (the owning worker crashed or hung) to
   * PENDING, or dead-letters them if the expired claim was their last attempt.
   *
   * The owner may still be alive and merely slow. Its claim token is cleared
   * here, so when it finishes, its `markSent` matches no row and is rejected;
   * the job is delivered again by the next claimant, with the same delivery
   * key, which is why the provider call must be idempotent.
   */
  async recoverStaleClaims(
    visibilityTimeoutSeconds: number,
    limit: number,
  ): Promise<RecoveryOutcome> {
    const { records } = await this.run<{ id: string; status: JobStatus }>(
      `UPDATE notification_jobs
          SET status = CASE WHEN attempt_count >= max_attempts
                            THEN $2 ELSE $3 END,
              dead_lettered_at = CASE WHEN attempt_count >= max_attempts
                                      THEN now() ELSE NULL END,
              next_attempt_at = now(),
              last_error = $6,
              locked_by = NULL,
              locked_at = NULL,
              claim_token = NULL,
              updated_at = now()
        WHERE id IN (
          SELECT id
            FROM notification_jobs
           WHERE status = $1
             AND locked_at < now() - make_interval(secs => $4)
           ORDER BY locked_at
           LIMIT $5
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, status`,
      [
        JobStatus.Processing,
        JobStatus.DeadLettered,
        JobStatus.Pending,
        visibilityTimeoutSeconds,
        limit,
        `Claim expired after ${visibilityTimeoutSeconds}s without completion`,
      ],
    );

    return {
      requeued: records.filter((r) => r.status === JobStatus.Pending).map((r) => r.id),
      deadLettered: records.filter((r) => r.status === JobStatus.DeadLettered).map((r) => r.id),
    };
  }

  /**
   * The one place a claimed job leaves PROCESSING. The WHERE clause is the
   * fence: the row must still carry this claim's token and be in a status the
   * state machine allows to move to `to`. Zero rows updated means the claim
   * was lost (lease expired and reclaimed), and the caller must not assume
   * its outcome was recorded.
   */
  private async completeClaim(
    id: string,
    claimToken: string,
    to: JobStatus,
    changes: QueryDeepPartialEntity<NotificationJob>,
    parameters: Record<string, unknown> = {},
  ): Promise<boolean> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(NotificationJob)
      .set({ ...changes, status: to, lockedBy: null, lockedAt: null, claimToken: null })
      .where('id = :id', { id })
      .andWhere('claim_token = :claimToken', { claimToken })
      .andWhere('status IN (:...from)', { from: sourceStatusesFor(to) })
      .setParameters(parameters)
      .execute();

    return result.affected === 1;
  }

  /** Runs raw SQL and returns rows plus affected count, inside `manager`'s transaction if given. */
  private async run<T = unknown>(
    sql: string,
    parameters: unknown[],
    manager?: EntityManager,
  ): Promise<QueryResult<T>> {
    if (manager?.queryRunner) {
      return manager.queryRunner.query(sql, parameters, true) as Promise<QueryResult<T>>;
    }
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      return (await queryRunner.query(sql, parameters, true)) as QueryResult<T>;
    } finally {
      await queryRunner.release();
    }
  }
}
