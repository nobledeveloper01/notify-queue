/** How far ahead a notification may be scheduled (sendAt or delaySeconds). */
export const MAX_SCHEDULE_AHEAD_SECONDS = 365 * 24 * 60 * 60;

export const SCHEDULE_EXACTLY_ONE_MESSAGE = 'Provide exactly one of sendAt or delaySeconds';
