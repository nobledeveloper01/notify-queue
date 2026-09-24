import { ConflictException } from '@nestjs/common';

/** The idempotency key is already bound to a different request. */
export class IdempotencyKeyReuseException extends ConflictException {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key "${idempotencyKey}" was already used for a different notification request`,
    );
  }
}
