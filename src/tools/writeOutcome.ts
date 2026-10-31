// How a write that did not cleanly succeed is reported. calmcp never retries a write, and a write's
// result never invites the caller to retry it either: a POST or PATCH that timed out or met a server
// error may have been applied, and a second call would then create a duplicate or apply twice.

import { ApiError } from '../errors.js';

/**
 * Whether a failed write may still have been applied: no answer, a server-side failure, or a 408
 * from a gateway that stopped waiting while Cloud ALM may have gone on processing.
 */
export function outcomeUnknown(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 0 || error.status === 408 || error.status >= 500)
  );
}

/** Whether Cloud ALM accepted the write (2xx) but its answer could not be read. */
export function acceptedUnreadable(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 200 && error.status < 300;
}
