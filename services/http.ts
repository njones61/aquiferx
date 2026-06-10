/**
 * fetch() with a hard timeout. A stalled connection never rejects on its own,
 * so every external request must carry an AbortSignal or it can hang the
 * calling flow forever.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

/** True for errors thrown by an aborted/timed-out fetch. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
