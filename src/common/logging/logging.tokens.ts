/** The shared pino instance. */
export const PINO_LOGGER = Symbol('PINO_LOGGER');

/** Where log lines go; stdout by default, a capturing stream in tests. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
