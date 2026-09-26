// Per-tool-call context, carried through async calls without threading a parameter through every
// handler, pager and client. Today it holds the MCP request's abort signal, so a call the client
// cancelled (or gave up on) stops issuing Cloud ALM requests instead of finishing a 40-page walk.

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a tool call makes available to the code it runs. */
export interface CallContext {
  /** Aborted when the MCP client cancels the call or the connection closes. */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<CallContext>();

/**
 * Run `fn` with `context` visible to everything it awaits.
 *
 * @param context - The call's context.
 * @param fn - The work to run.
 * @returns What `fn` returns.
 */
export function runWithContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The abort signal of the tool call currently running, if any.
 *
 * @returns The signal, or undefined outside a tool call.
 */
export function currentSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}
