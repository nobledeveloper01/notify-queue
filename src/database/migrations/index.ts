import { CreateNotificationJobs1790208000000 } from './1790208000000-create-notification-jobs.js';
import { AddRequestFingerprint1790294400000 } from './1790294400000-add-request-fingerprint.js';
import { CreateMockProviderDeliveries1790380800000 } from './1790380800000-create-mock-provider-deliveries.js';

/**
 * Registered explicitly rather than by file glob: the same list works from
 * compiled `dist/` (the CLI, the app) and from TypeScript sources (Jest), and
 * ESM has no `require`-style directory scan to lean on.
 */
export const migrations = [
  CreateNotificationJobs1790208000000,
  AddRequestFingerprint1790294400000,
  CreateMockProviderDeliveries1790380800000,
];
