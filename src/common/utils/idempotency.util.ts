import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every depth, so key order never changes the hash. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

/** SHA-256 over the canonical JSON of a request: equal requests, equal fingerprints. */
export const fingerprintRequest = (request: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson(request)).digest('hex');
