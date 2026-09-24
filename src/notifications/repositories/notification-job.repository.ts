import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import type { EntityManager, QueryResult, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { JOB_PRIORITY_RANK } from '../../common/enums/job-priority.enum.js';
import { runQuery } from '../../database/query.util.js';
import type { JobPriority } from '../../common/enums/job-priority.enum.js';
import { JobStatus } from '../../common/enums/job-status.enum.js';
import type { NotificationChannel } from '../../common/enums/notification-channel.enum.js';
import {
  isTerminal,
  OPERATOR_TRANSITIONS,
  sourceStatusesFor,
} from '../domain/job-state-machine.js';
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

export interface JobListFilter {
  status?: JobStatus;
  recipient?: string;
  /** Keyset position: return jobs strictly older than this (created_at, id). */
  after?: JobListPosition;
  limit: number;
}

/** A job's place in newest-first order. `createdAt` is PostgreSQL's exact text form. */
export interface JobListPosition {
  createdAt: string;
  id: string;
}

export interface JobPage {
  jobs: NotificationJob[];
  /** Position of the last job returned, when more jobs follow it. */
  next: JobListPosition | null;
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
   * PENDING → CANCELLED, in one conditional UPDATE. If a worker's claim
   * transaction holds the row, this waits for it, then re-checks the status
   * and finds PROCESSING: the claim wins, the cancel reports false. So a job
   * is either cancelled and never sent, or sent and not cancelled.
   */
  async cancelPending(id: string): Promise<boolean> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(NotificationJob)
      .set({ status: OPERATOR_TRANSITIONS.cancel.to, cancelledAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', { from: OPERATOR_TRANSITIONS.cancel.from })
      .execute();
    return result.affected === 1;
  }

  /**
   * DEAD_LETTERED or FAILED → PENDING with a fresh attempt budget, due now.
   * The redrive is counted and timestamped for audit, and the redrive count
   * is also the webhook generation, so this job's next terminal event does
   * not collide with its previous one. `last_error` is kept as context until
   * the next attempt overwrites it.
   */
  async redrive(id: string, maxAttempts: number): Promise<boolean> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(NotificationJob)
      .set({
        status: OPERATOR_TRANSITIONS.redrive.to,
        attemptCount: 0,
        maxAttempts,
        reconciliationGranted: false,
        nextAttemptAt: () => 'now()',
        failedAt: null,
        deadLetteredAt: null,
        redriveCount: () => 'redrive_count + 1',
        lastRedrivenAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', { from: OPERATOR_TRANSITIONS.redrive.from })
      .execute();
    return result.affected === 1;
  }

  /**
   * Newest first, keyset-paginated on (created_at, id): each page is an index
   * range scan from the previous position, however deep the listing goes,
   * unlike OFFSET. Backed by (status, created_at, id), (recipient,
   * created_at) and (created_at, id).
   */
  async list(filter: JobListFilter): Promise<JobPage> {
    const query = this.jobs
      .createQueryBuilder('job')
      // Exact timestamp for the cursor: a JS Date would drop microseconds and
      // skip or repeat jobs created within the same millisecond.
      .addSelect('job.created_at::text', 'position_created_at')
      .orderBy('job.created_at', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .limit(filter.limit + 1);

    if (filter.status) {
      query.andWhere('job.status = :status', { status: filter.status });
    }
    if (filter.recipient) {
      query.andWhere('job.recipient = :recipient', { recipient: filter.recipient });
    }
    if (filter.after) {
      query.andWhere(
        '(job.created_at, job.id) < (CAST(:afterCreatedAt AS timestamptz), CAST(:afterId AS uuid))',
        { afterCreatedAt: filter.after.createdAt, afterId: filter.after.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      job_id: string;
      position_created_at: string;
    }>();
    const jobs = entities.slice(0, filter.limit);
    const last = jobs.at(-1);
    const lastRaw = last ? raw.find((row) => row.job_id === last.id) : undefined;

    return {
      jobs,
      next:
        entities.length > filter.limit && last && lastRaw
          ? { createdAt: lastRaw.position_created_at, id: last.id }
          : null,
    };
  }

  /**
   * Marks the moment a worker actually starts a claimed job, renewing the
   * lease. Jobs wait in a worker's local queue after being claimed; without
   * this, that wait would eat into the lease, and a job reclaimed while
   * waiting would still be sent by the original worker. False means the claim
   * is gone and the job must not be started.
   */
  async startAttempt(id: string, claimToken: string): Promise<boolean> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(NotificationJob)
      .set({ lockedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('claim_token = :claimToken', { claimToken })
      .andWhere('status = :status', { status: JobStatus.Processing })
      .execute();
    return result.affected === 1;
  }

  /**
   * PROCESSING → PENDING without counting an attempt, due now: for a job whose
   * attempt never reached the provider (the worker is shutting down, or failed
   * before sending).
   */
  releaseClaim(id: string, claimToken: string): Promise<boolean> {
    return this.completeClaim(id, claimToken, JobStatus.Pending, {
      attemptCount: () => 'attempt_count - 1',
      nextAttemptAt: () => 'now()',
    });
  }

  /**
   * PROCESSING → PENDING until `until`, without counting an attempt: the
   * recipient is over its rate limit, so nothing was tried.
   */
  deferRateLimited(id: string, claimToken: string, until: Date): Promise<boolean> {
    return this.completeClaim(
      id,
      claimToken,
      JobStatus.Pending,
      {
        attemptCount: () => 'attempt_count - 1',
        nextAttemptAt: () => ':until',
      },
      { until },
    );
  }

  /**
   * Returns jobs whose lease expired (the owning worker crashed or hung) to
   * PENDING. This and `completeClaim` are the only ways out of PROCESSING;
   * both move only along edges the state machine allows (PROCESSING → PENDING
   * or DEAD_LETTERED).
   *
   * An expired *final* attempt is ambiguous: the worker may have died after
   * the provider accepted the notification. So the first time, the job gets
   * one extra attempt (`reconciliation_granted`); resending with the same
   * delivery key settles it. Only an expired attempt after that grant is
   * dead-lettered, which still bounds a job that crashes every worker.
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
    // One statement: requeue, grant a reconciliation attempt, or dead-letter
    // each expired claim, and write the outbox event for every dead-lettered
    // one, atomically. Every SET expression reads the row's values from
    // before the update.
    const { records } = await this.run<{ id: string; status: JobStatus }>(
      `WITH recovered AS (
       UPDATE notification_jobs
          SET status = CASE WHEN attempt_count >= max_attempts AND reconciliation_granted
                            THEN $2 ELSE $3 END,
              dead_lettered_at = CASE WHEN attempt_count >= max_attempts AND reconciliation_granted
                                      THEN now() ELSE NULL END,
              max_attempts = CASE WHEN attempt_count >= max_attempts AND NOT reconciliation_granted
                                  THEN max_attempts + 1 ELSE max_attempts END,
              reconciliation_granted = reconciliation_granted OR attempt_count >= max_attempts,
              next_attempt_at = now(),
              last_error = CASE WHEN attempt_count >= max_attempts AND NOT reconciliation_granted
                                THEN $7 ELSE $6 END,
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
        RETURNING id, status, attempt_count, updated_at, redrive_count
       ), events AS (
         INSERT INTO webhook_events (job_id, status, attempt_count, occurred_at, redrive_count)
         SELECT id, status, attempt_count, updated_at, redrive_count
           FROM recovered WHERE status = $2
       )
       SELECT id, status FROM recovered`,
      [
        JobStatus.Processing,
        JobStatus.DeadLettered,
        JobStatus.Pending,
        visibilityTimeoutSeconds,
        limit,
        `Claim expired after ${visibilityTimeoutSeconds}s without completion`,
        `Final attempt's claim expired after ${visibilityTimeoutSeconds}s; outcome unknown, one reconciliation attempt granted`,
      ],
    );

    return {
      requeued: records.filter((r) => r.status === JobStatus.Pending).map((r) => r.id),
      deadLettered: records.filter((r) => r.status === JobStatus.DeadLettered).map((r) => r.id),
    };
  }

  /**
   * How a claimed job leaves PROCESSING on its worker's own report (lease
   * expiry is the other way; see `recoverStaleClaims`). The WHERE clause is the
   * fence: the row must still carry this claim's token and be in a status the
   * state machine allows to move to `to`. Zero rows updated means the claim
   * was lost (lease expired and reclaimed), and the caller must not assume
   * its outcome was recorded.
   *
   * A move to a terminal status writes its webhook event in the same
   * transaction (the outbox), so the event exists exactly when the status
   * change does.
   */
  private async completeClaim(
    id: string,
    claimToken: string,
    to: JobStatus,
    changes: QueryDeepPartialEntity<NotificationJob>,
    parameters: Record<string, unknown> = {},
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(NotificationJob)
        .set({ ...changes, status: to, lockedBy: null, lockedAt: null, claimToken: null })
        .where('id = :id', { id })
        .andWhere('claim_token = :claimToken', { claimToken })
        .andWhere('status IN (:...from)', { from: sourceStatusesFor(to) })
        .setParameters(parameters)
        .execute();

      if (result.affected !== 1) {
        return false;
      }
      if (isTerminal(to)) {
        await this.run(
          `INSERT INTO webhook_events (job_id, status, attempt_count, occurred_at, redrive_count)
           SELECT id, status, attempt_count, updated_at, redrive_count
             FROM notification_jobs WHERE id = $1`,
          [id],
          manager,
        );
      }
      return true;
    });
  }

  private run<T = unknown>(
    sql: string,
    parameters: unknown[],
    manager?: EntityManager,
  ): Promise<QueryResult<T>> {
    return runQuery<T>(this.dataSource, sql, parameters, manager);
  }
}
