import { JobStatus } from '../../src/common/enums/job-status.enum.js';
import {
  canOperatorApply,
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

  it('marks exactly SENT, FAILED, DEAD_LETTERED and CANCELLED as terminal', () => {
    const terminal = Object.values(JobStatus).filter(isTerminal);
    expect(terminal.sort()).toEqual(
      [JobStatus.Cancelled, JobStatus.DeadLettered, JobStatus.Failed, JobStatus.Sent].sort(),
    );
  });

  it('never lets an automatic transition leave a terminal state', () => {
    for (const from of Object.values(JobStatus).filter(isTerminal)) {
      for (const to of Object.values(JobStatus)) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('keeps operator actions out of the automatic table', () => {
    expect(sourceStatusesFor(JobStatus.Pending)).toEqual([JobStatus.Processing]);
    expect(sourceStatusesFor(JobStatus.Cancelled)).toEqual([]);
  });

  it.each([
    ['cancel', JobStatus.Pending, true],
    ['cancel', JobStatus.Processing, false],
    ['cancel', JobStatus.Sent, false],
    ['redrive', JobStatus.DeadLettered, true],
    ['redrive', JobStatus.Failed, true],
    ['redrive', JobStatus.Sent, false],
    ['redrive', JobStatus.Pending, false],
    ['redrive', JobStatus.Cancelled, false],
  ] as const)('operator %s from %s: %s', (action, from, allowed) => {
    expect(canOperatorApply(action, from)).toBe(allowed);
  });
});
