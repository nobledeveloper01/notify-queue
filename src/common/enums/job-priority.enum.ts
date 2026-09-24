/**
 * Priority as the API speaks it. Stored as a smallint (see
 * `JOB_PRIORITY_RANK`) so `ORDER BY priority DESC` sorts by urgency rather
 * than alphabetically.
 */
export enum JobPriority {
  High = 'HIGH',
  Normal = 'NORMAL',
  Low = 'LOW',
}

export const JOB_PRIORITY_RANK: Readonly<Record<JobPriority, number>> = {
  [JobPriority.High]: 3,
  [JobPriority.Normal]: 2,
  [JobPriority.Low]: 1,
};

const PRIORITY_BY_RANK = new Map(
  Object.entries(JOB_PRIORITY_RANK).map(([priority, rank]) => [rank, priority as JobPriority]),
);

export const priorityFromRank = (rank: number): JobPriority => {
  const priority = PRIORITY_BY_RANK.get(rank);
  if (!priority) {
    throw new Error(`Unknown priority rank: ${rank}`);
  }
  return priority;
};
