import { JobStatus } from '../../common/enums/job-status.enum.js';

/**
 * The single source of truth for which status changes are legal.
 *
 *   PENDING ──claim──▶ PROCESSING ──▶ SENT
 *                          │  ├──────▶ FAILED          (permanent provider error)
 *                          │  ├──────▶ DEAD_LETTERED   (retryable errors, attempts exhausted)
 *                          └──────────▶ PENDING         (retry, rate limited, or lease expired)
 *
 * These are the transitions the system makes on its own (workers, recovery).
 * Terminal states have no outgoing edges here: nothing automatic ever moves a
 * SENT job back to PROCESSING. The repository derives each UPDATE's
 * `WHERE status IN (...)` guard from this table, so the database enforces the
 * same rules the code documents.
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
  [JobStatus.Cancelled]: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Every status a job may be in immediately before moving to `to`. */
export const sourceStatusesFor = (to: JobStatus): JobStatus[] =>
  (Object.keys(TRANSITIONS) as JobStatus[]).filter((from) => canTransition(from, to));

export const isTerminal = (status: JobStatus): boolean => TRANSITIONS[status].length === 0;

/**
 * Transitions only an operator (an API call) may make. Kept apart from the
 * automatic table on purpose: widening that table would widen the guards on
 * every worker update. Each action names the statuses it may start from.
 *
 *   cancel:   PENDING                → CANCELLED
 *   redrive:  DEAD_LETTERED, FAILED  → PENDING   (fresh attempt budget, audited)
 */
export const OPERATOR_TRANSITIONS = {
  cancel: { from: [JobStatus.Pending], to: JobStatus.Cancelled },
  redrive: { from: [JobStatus.DeadLettered, JobStatus.Failed], to: JobStatus.Pending },
} as const satisfies Record<string, { from: readonly JobStatus[]; to: JobStatus }>;

export type OperatorAction = keyof typeof OPERATOR_TRANSITIONS;

export const canOperatorApply = (action: OperatorAction, from: JobStatus): boolean =>
  (OPERATOR_TRANSITIONS[action].from as readonly JobStatus[]).includes(from);
