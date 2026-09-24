import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { FieldErrorDto } from '../dto/error-response.dto.js';

/** Flattens nested class-validator errors into `field.path: [messages]`. */
const toFieldErrors = (errors: ValidationError[], parent = ''): FieldErrorDto[] =>
  errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, errors: Object.values(error.constraints) }] : [];
    return [...own, ...toFieldErrors(error.children ?? [], field)];
  });

/**
 * Global request validation: strip nothing silently (unknown properties are
 * rejected), coerce path/query primitives, and report every field problem in
 * one 400 response.
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new BadRequestException({
        error: 'Bad Request',
        message: 'Validation failed',
        details: toFieldErrors(errors),
      }),
  });
