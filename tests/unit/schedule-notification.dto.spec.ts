import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SCHEDULE_EXACTLY_ONE_MESSAGE } from '../../src/common/constants/job.constants.js';
import { ScheduleNotificationDto } from '../../src/notifications/dto/schedule-notification.dto.js';

const valid = {
  recipient: 'user@example.com',
  channel: 'EMAIL',
  payload: { subject: 'Hi' },
  priority: 'HIGH',
  idempotencyKey: 'key-1',
};

const errorsFor = (body: Record<string, unknown>): Record<string, string[]> =>
  Object.fromEntries(
    validateSync(plainToInstance(ScheduleNotificationDto, body)).map((e) => [
      e.property,
      Object.values(e.constraints ?? {}),
    ]),
  );

describe('ScheduleNotificationDto', () => {
  it('accepts delaySeconds alone', () => {
    expect(errorsFor({ ...valid, delaySeconds: 60 })).toEqual({});
  });

  it('accepts sendAt alone', () => {
    expect(errorsFor({ ...valid, sendAt: '2026-09-27T12:00:00.000Z' })).toEqual({});
  });

  it('rejects neither', () => {
    expect(errorsFor(valid).sendAt).toEqual([SCHEDULE_EXACTLY_ONE_MESSAGE]);
  });

  it('rejects both', () => {
    expect(
      errorsFor({ ...valid, delaySeconds: 60, sendAt: '2026-09-27T12:00:00Z' }).sendAt,
    ).toEqual([SCHEDULE_EXACTLY_ONE_MESSAGE]);
  });

  it('rejects a sendAt without a timezone offset', () => {
    expect(errorsFor({ ...valid, sendAt: '2026-09-27T12:00:00' }).sendAt).toEqual([
      'sendAt must include a timezone offset (Z or ±HH:MM)',
    ]);
  });

  it.each(['tomorrow', '2026-13-01T00:00:00Z', 1_700_000_000])(
    'rejects sendAt %p as not a date-time',
    (sendAt) => {
      expect(errorsFor({ ...valid, sendAt }).sendAt).toEqual([
        'sendAt must be a valid ISO 8601 date-time',
      ]);
    },
  );

  it.each([0, -5, 1.5])('rejects delaySeconds %p', (delaySeconds) => {
    expect(errorsFor({ ...valid, delaySeconds }).delaySeconds).toBeDefined();
  });

  it('rejects an array payload and unknown enums', () => {
    const errors = errorsFor({ ...valid, delaySeconds: 1, payload: [], channel: 'FAX' });
    expect(Object.keys(errors).sort()).toEqual(['channel', 'payload']);
  });
});
