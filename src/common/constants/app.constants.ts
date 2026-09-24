export const REQUEST_ID_HEADER = 'X-Request-ID';

/** Response header telling a client its POST replayed an existing job. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Upper bound on a JSON request body; notification payloads are small. */
export const JSON_BODY_LIMIT = '64kb';
