import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../../src/common/utils/cursor.util.js';

describe('pagination cursors', () => {
  const position = {
    createdAt: '2026-09-24 21:36:45.123456+01',
    id: '3f6c2b0e-8a5d-4c1e-9b7a-2d4e6f8a0b1c',
  };

  it('round-trips a position exactly, microseconds included', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is URL-safe', () => {
    expect(encodeCursor(position)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 JSON', 'nope'],
    ['wrong shape', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['bad date', Buffer.from(JSON.stringify(['yesterday', position.id])).toString('base64url')],
    ['bad id', Buffer.from(JSON.stringify([position.createdAt, 'x'])).toString('base64url')],
  ])('rejects %s with 400', (_, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });
});
