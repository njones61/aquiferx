/**
 * Cooperative cancellation for the long-running analysis pipelines.
 * Pipelines check an isCancelled callback at every yield point and throw
 * PipelineCancelledError, which callers treat as a quiet abort (no error
 * UI, no result file written).
 */
export class PipelineCancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'PipelineCancelledError';
  }
}

export function isPipelineCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'PipelineCancelledError';
}
