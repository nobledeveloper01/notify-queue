import { registerDecorator } from 'class-validator';
import type { ValidationArguments } from 'class-validator';

const containsNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (typeof value === 'object' && value !== null) {
    // JSON.stringify escapes NUL as \u0000 wherever it appears, keys included.
    return JSON.stringify(value).includes('\\u0000');
  }
  return false;
};

/**
 * Rejects strings, or objects at any depth, containing a NUL character.
 * PostgreSQL cannot store NUL in text or jsonb, so without this such input
 * would pass validation and fail at INSERT with a 500 instead of a 400.
 */
export const NoNullCharacters = (): PropertyDecorator => (target, propertyName) => {
  registerDecorator({
    name: 'noNullCharacters',
    target: target.constructor,
    propertyName: String(propertyName),
    validator: {
      validate: (value: unknown): boolean => !containsNul(value),
      defaultMessage: (args?: ValidationArguments): string =>
        `${args?.property ?? 'value'} must not contain NUL (\\u0000) characters`,
    },
  });
};
