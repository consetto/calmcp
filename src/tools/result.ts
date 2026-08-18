// Helpers for building MCP tool results. A tool's payload is returned as a single JSON text block;
// failures are returned as an error result so the AI client sees the message rather than a crash.
//
// `jsonResult` also enforces the response-size budget. That guard lives here, not at the call
// sites, so no tool can forget it: an oversized payload is withheld and replaced by an explicit
// summary naming how to ask again. Letting it through instead means the AI client truncates the
// JSON mid-string and answers from a fragment, which is the same failure `shape.ts` warns about --
// the answer looks authoritative and is wrong.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { collectFieldNames, locateRecords } from './shape.js';

/** Fallback budget used until {@link configureResults} runs (matches the `Config` default). */
const FALLBACK_MAX_RESPONSE_BYTES = 100_000;

/** Current response budget in bytes. Module-level so every `jsonResult` call is covered. */
let maxResponseBytes = FALLBACK_MAX_RESPONSE_BYTES;

/**
 * Set the response-size budget from configuration.
 *
 * Called once per server construction. Idempotent, which matters because the HTTP transport builds
 * a fresh `McpServer` per request from the same `Config`.
 *
 * @param options - The budget in bytes; non-positive values are ignored.
 */
export function configureResults(options: { maxBytes: number }): void {
  if (Number.isFinite(options.maxBytes) && options.maxBytes > 0) {
    maxResponseBytes = options.maxBytes;
  }
}

/**
 * The active response budget in bytes.
 *
 * @returns The maximum serialized size a tool result may reach.
 */
export function responseBudget(): number {
  return maxResponseBytes;
}

/**
 * Wrap a value as a successful tool result (pretty-printed JSON text).
 *
 * Payloads over the configured budget are replaced by a summary describing what was withheld and
 * how to narrow the query. The summary is *not* flagged `isError`: the call succeeded, and several
 * agent hosts respond to an error by retrying the identical request, which burns the same tokens
 * again for the same outcome.
 *
 * @param data - The data to return to the client.
 * @returns A successful {@link CallToolResult}.
 */
export function jsonResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxResponseBytes) {
    return { content: [{ type: 'text', text }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(oversizeSummary(data, bytes), null, 2) }],
  };
}

/** The summary returned in place of a payload that exceeds the budget. */
interface OversizeSummary {
  complete: false;
  reason: 'RESPONSE_TOO_LARGE';
  message: string;
  bytes: number;
  budgetBytes: number;
  /**
   * How many records this one response carried. Deliberately *not* named like a total: the
   * endpoint may have applied its own page limit, so this is a floor, never an answer to
   * "how many are there?".
   */
  recordsInResponse?: number;
  recordsAreATotal: false;
  availableFields?: string[];
  hint: string;
}

/** Maximum field names listed back to the caller, so the summary itself cannot grow unbounded. */
const MAX_LISTED_FIELDS = 80;

/**
 * Describe an over-budget payload without including any of it.
 *
 * Deliberately carries no sample records: a preview invites the model to answer from partial data,
 * which is the failure being prevented. The field list is far more useful, because it is what the
 * caller needs to build the narrower follow-up query.
 *
 * @param data - The payload that was withheld.
 * @param bytes - Its serialized size.
 * @returns The summary object.
 */
function oversizeSummary(data: unknown, bytes: number): OversizeSummary {
  const located = locateRecords(data);
  const records = located?.records ?? [];
  const fields = collectFieldNames(records);

  const summary: OversizeSummary = {
    complete: false,
    reason: 'RESPONSE_TOO_LARGE',
    message:
      `The result is ${bytes} bytes, over the ${maxResponseBytes}-byte response budget, so ` +
      'calmcp withheld it rather than letting your client truncate the JSON mid-record. ' +
      'No data is lost: re-run the call in one of the narrower forms below. Do NOT report ' +
      'recordsInResponse as a count — the endpoint may have paged the result, so it is a floor, ' +
      'not a total. Use count_only:true to get the real total.',
    bytes,
    budgetBytes: maxResponseBytes,
    recordsAreATotal: false,
    hint:
      'For a total, re-run the SAME query with count_only:true. For a breakdown, add ' +
      'group_by:"status" (or any other field). To keep the records, add ' +
      'fields:"displayId,title,status" and a smaller top/limit. Never count by listing: that is ' +
      'what produced this response.',
  };

  if (records.length > 0) {
    summary.recordsInResponse = records.length;
    summary.availableFields =
      fields.length > MAX_LISTED_FIELDS ? fields.slice(0, MAX_LISTED_FIELDS) : fields;
  }
  return summary;
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
