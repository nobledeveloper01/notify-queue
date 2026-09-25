import { ConflictException } from '@nestjs/common';
import type { JobStatus } from '../enums/job-status.enum.js';

/** An operator action was asked of a job whose current status does not allow it. */
export class JobStateConflictException extends ConflictException {
  constructor(id: string, status: JobStatus, action: string, allowed: readonly JobStatus[]) {
    super(`Notification ${id} is ${status}; only ${allowed.join(' or ')} jobs can be ${action}`);
  }
}
