// Helpers for building MCP tool results. A tool's payload is returned as a single JSON text block;
// failures are returned as an error result so the AI client sees the message rather than a crash.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Wrap a value as a successful tool result (pretty-printed JSON text).
 *
 * @param data - The data to return to the client.
 * @returns A successful {@link CallToolResult}.
 */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wrap a message as an error tool result.
 *
 * @param message - The human-readable error message.
 * @returns A {@link CallToolResult} flagged with `isError`.
 */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
