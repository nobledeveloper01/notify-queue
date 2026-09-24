import { BadRequestException } from '@nestjs/common';
import type { JobListPosition } from '../../notifications/repositories/notification-job.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opaque pagination cursors: base64url JSON of a job's list position.
 * Clients pass them back unchanged; the format is free to change.
 */
export const encodeCursor = (position: JobListPosition): string =>
  Buffer.from(JSON.stringify([position.createdAt, position.id])).toString('base64url');

export const decodeCursor = (cursor: string): JobListPosition => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === 'string' &&
      !Number.isNaN(Date.parse(decoded[0])) &&
      typeof decoded[1] === 'string' &&
      UUID.test(decoded[1])
    ) {
      return { createdAt: decoded[0], id: decoded[1] };
    }
  } catch {
    // fall through
  }
  throw new BadRequestException('cursor is not valid; use the nextCursor from a previous page');
};
