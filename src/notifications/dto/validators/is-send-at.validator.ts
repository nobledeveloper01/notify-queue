import { isISO8601, registerDecorator } from 'class-validator';
import type { ValidationArguments } from 'class-validator';
import { SCHEDULE_EXACTLY_ONE_MESSAGE } from '../../../common/constants/job.constants.js';

const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** Why a sendAt value is unacceptable, or null if it is fine. Checked in order, first failure wins. */
const sendAtProblem = (value: unknown, dto: { delaySeconds?: unknown }): string | null => {
  const hasSendAt = value !== undefined;
  const hasDelay = dto.delaySeconds !== undefined;

  if (hasSendAt === hasDelay) return SCHEDULE_EXACTLY_ONE_MESSAGE;
  if (!hasSendAt) return null;
  if (typeof value !== 'string' || !isISO8601(value, { strict: true, strictSeparator: true })) {
    return 'sendAt must be a valid ISO 8601 date-time';
  }
  if (!HAS_OFFSET.test(value)) return 'sendAt must include a timezone offset (Z or ±HH:MM)';
  return null;
};

/**
 * Validates the scheduling pair from the sendAt side: exactly one of sendAt
 * or delaySeconds, and a sendAt that is an unambiguous instant. One validator
 * rather than a stack of decorators, so a client sees the one real problem
 * instead of format errors about a field they deliberately left out.
 */
export const IsSendAt = (): PropertyDecorator => (target, propertyName) => {
  registerDecorator({
    name: 'isSendAt',
    target: target.constructor,
    propertyName: String(propertyName),
    validator: {
      validate: (value: unknown, args: ValidationArguments): boolean =>
        sendAtProblem(value, args.object) === null,
      defaultMessage: (args?: ValidationArguments): string =>
        (args && sendAtProblem(args.value, args.object)) ?? SCHEDULE_EXACTLY_ONE_MESSAGE,
    },
  });
};
