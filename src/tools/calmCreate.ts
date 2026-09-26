// `calm_create` — create a new SAP Cloud ALM document or library entry. Registered only when write
// access is enabled (`CALM_WRITE_ENABLED=true`); see `tools/index.ts`.
//
// Create is the whole write surface. The tool never updates or deletes: an existing document's
// HTML (with its embedded images) cannot be damaged by anything this file does.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import { CREATE_RESOURCES } from './create.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import type { calmCreateShape } from './schemas.js';

/** Arguments accepted by the `calm_create` tool. */
export type CalmCreateArgs = z.infer<z.ZodObject<typeof calmCreateShape>>;

/**
 * Handle a `calm_create` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The created entity as a JSON tool result, or an error result.
 */
export async function handleCalmCreate(
  clients: CalmClients,
  args: CalmCreateArgs,
): Promise<CallToolResult> {
  // Belt and braces: the tool is not registered without the switch, but the HTTP transport builds a
  // server per request and a stale client could still hold the tool name.
  if (!clients.writeEnabled) {
    return errorResult(
      'Write access is disabled: calmcp is read-only unless CALM_WRITE_ENABLED=true is set.',
    );
  }

  const def = CREATE_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list what calm_create accepts.`,
    );
  }

  const parsed = def.schema.safeParse(args.data);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'data'}: ${issue.message}`,
    );
    return errorResult(
      `Invalid data for resource '${args.resource}':\n- ${problems.join('\n- ')}\n` +
        `Call calm_resources({ topic: '${args.resource}' }) for the accepted fields.`,
    );
  }

  try {
    return jsonResult(await clients.createOData(def.service, def.entitySet, parsed.data));
  } catch (error) {
    return errorResultFrom(error);
  }
}
