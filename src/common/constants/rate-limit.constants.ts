/**
 * First key of the two-key advisory lock taken per recipient, so rate-limit
 * locks can never collide with advisory locks taken for any other purpose.
 */
export const RATE_LIMIT_LOCK_NAMESPACE = 7_246_001;
