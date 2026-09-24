import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import {
  canTransition,
  isTerminal,
  sourceStatusesFor,
} from '../../src/notifications/domain/job-state-machine.js';

describe('job state machine', () => {
  it.each([
    [JobStatus.Pending, JobStatus.Processing],
    [JobStatus.Processing, JobStatus.Sent],
    [JobStatus.Processing, JobStatus.Failed],
    [JobStatus.Processing, JobStatus.DeadLettered],
    [JobStatus.Processing, JobStatus.Pending],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    [JobStatus.Sent, JobStatus.Processing],
    [JobStatus.Sent, JobStatus.Pending],
    [JobStatus.DeadLettered, JobStatus.Processing],
    [JobStatus.Failed, JobStatus.Pending],
    [JobStatus.Pending, JobStatus.Sent],
    [JobStatus.Pending, JobStatus.DeadLettered],
  ])('forbids %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('only lets a claimed job reach a terminal state', () => {
    expect(sourceStatusesFor(JobStatus.Sent)).toEqual([JobStatus.Processing]);
    expect(sourceStatusesFor(JobStatus.Failed)).toEqual([JobStatus.Processing]);
    expect(sourceStatusesFor(JobStatus.DeadLettered)).toEqual([JobStatus.Processing]);
  });

  it('marks exactly SENT, FAILED and DEAD_LETTERED as terminal', () => {
    const terminal = Object.values(JobStatus).filter(isTerminal);
    expect(terminal.sort()).toEqual(
      [JobStatus.DeadLettered, JobStatus.Failed, JobStatus.Sent].sort(),
    );
  });
});
