export enum JobStatus {
  /** Waiting until `next_attempt_at`; claimable once due. */
  Pending = 'PENDING',
  /** Claimed by exactly one worker, which holds the claim token. */
  Processing = 'PROCESSING',
  /** Terminal: the provider accepted the notification. */
  Sent = 'SENT',
  /** Terminal: the provider rejected it permanently; retrying cannot help. */
  Failed = 'FAILED',
  /** Terminal: every allowed attempt failed with a retryable error. */
  DeadLettered = 'DEAD_LETTERED',
}
