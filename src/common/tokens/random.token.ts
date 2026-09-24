/** Injectable source of randomness, so jitter and simulated failures are deterministic in tests. */
export const RANDOM = Symbol('RANDOM');

/** Returns a number in [0, 1), like Math.random. */
export type RandomSource = () => number;
