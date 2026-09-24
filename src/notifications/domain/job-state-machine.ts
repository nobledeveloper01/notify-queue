import { JobStatus } from '../../common/enums/job-status.enum.js';

/**
 * The single source of truth for which status changes are legal.
 *
 *   PENDING ──claim──▶ PROCESSING ──▶ SENT
 *                          │  ├──────▶ FAILED          (permanent provider error)
 *                          │  ├──────▶ DEAD_LETTERED   (retryable errors, attempts exhausted)
 *                          └──────────▶ PENDING         (retry, rate limited, or lease expired)
 *
 * Terminal states have no outgoing edges: nothing moves a SENT job back to
 * PROCESSING. The repository derives each UPDATE's `WHERE status IN (...)`
 * guard from this table, so the database enforces the same rules the code
 * documents.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [JobStatus.Pending]: [JobStatus.Processing],
  [JobStatus.Processing]: [
    JobStatus.Sent,
    JobStatus.Failed,
    JobStatus.DeadLettered,
    JobStatus.Pending,
  ],
  [JobStatus.Sent]: [],
  [JobStatus.Failed]: [],
  [JobStatus.DeadLettered]: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Every status a job may be in immediately before moving to `to`. */
export const sourceStatusesFor = (to: JobStatus): JobStatus[] =>
  (Object.keys(TRANSITIONS) as JobStatus[]).filter((from) => canTransition(from, to));

export const isTerminal = (status: JobStatus): boolean => TRANSITIONS[status].length === 0;
