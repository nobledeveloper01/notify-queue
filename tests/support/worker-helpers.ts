import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import type { WorkerService } from '../../src/workers/worker.service.js';

export const countByStatus = async (
  dataSource: DataSource,
): Promise<Partial<Record<string, number>>> => {
  const rows: { status: string; count: string }[] = await dataSource.query(
    'SELECT status, count(*) FROM notification_jobs GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
};

/**
 * Polls and waits, repeatedly, until no job is PENDING-and-due or PROCESSING.
 * Tests use tiny retry delays, so retries become due within a few ms.
 */
export const runUntilSettled = async (
  worker: WorkerService,
  dataSource: DataSource,
  maxRounds = 200,
): Promise<void> => {
  for (let round = 0; round < maxRounds; round++) {
    await worker.poll();
    await worker.whenIdle();
    const [{ open }]: { open: string }[] = await dataSource.query(
      `SELECT count(*) AS open FROM notification_jobs
        WHERE status = 'PROCESSING' OR (status = 'PENDING' AND next_attempt_at <= now() + interval '1 second')`,
    );
    if (Number(open) === 0) return;
    await sleep(5);
  }
  throw new Error(`Jobs still open after ${maxRounds} rounds`);
};

/** Waits until `check` passes or the deadline elapses (for scheduler-driven tests). */
export const eventually = async (
  check: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
};
