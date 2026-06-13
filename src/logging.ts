// Centralized logging for calmcp: a single logger plus helpers for tracing MCP tool calls and
// (truncated) results. Built on `pino`.
//
// IMPORTANT: over the stdio transport, stdout carries the MCP JSON-RPC protocol, so all logs MUST
// go to stderr. We therefore pin the pino destination to file descriptor 2 (stderr).

import pino, { type Logger } from 'pino';

/** Maximum characters of a serialized tool result to log before truncating. */
const MAX_RESULT_LOG_CHARS = 1000;

/**
 * Create the application logger.
 *
 * @param debug - When true, sets the level to `debug` for verbose request/response tracing.
 * @returns A `pino` logger writing to stderr.
 */
export function createLogger(debug: boolean): Logger {
  return pino(
    {
      level: debug ? 'debug' : 'info',
      base: { service: 'calmcp' },
    },
    // Pin to stderr (fd 2) so stdout stays reserved for the MCP protocol on the stdio transport.
    pino.destination(2),
  );
}

/**
 * Log an incoming MCP tool call.
 *
 * @param logger - The application logger.
 * @param tool - The tool name (e.g. "calm_list").
 * @param params - The validated tool arguments.
 */
export function logToolCall(logger: Logger, tool: string, params: unknown): void {
  logger.debug({ tool, params }, 'tool call');
}

/**
 * Log the result of an MCP tool call, truncating large payloads.
 *
 * @param logger - The application logger.
 * @param tool - The tool name.
 * @param result - The result value; serialized and truncated for the log line.
 */
export function logToolResult(logger: Logger, tool: string, result: unknown): void {
  if (!logger.isLevelEnabled('debug')) {
    return;
  }
  let serialized = safeStringify(result);
  if (serialized.length > MAX_RESULT_LOG_CHARS) {
    serialized = `${serialized.slice(0, MAX_RESULT_LOG_CHARS)}...(truncated)`;
  }
  logger.debug({ tool, result: serialized }, 'tool result');
}

/** Serialize a value to JSON, falling back to `String()` on circular structures. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
