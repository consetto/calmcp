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

/** One record of the audit trail, written for every entity Cloud ALM created. */
export interface CreateAuditEntry {
  resource: string;
  /** The new entity's key and display id, as Cloud ALM returned them. */
  id: unknown;
  displayId: unknown;
  /** The payload fields the caller set (names only; values may be long or personal). */
  fields: string[];
}

/**
 * Handle a `calm_create` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @param audit - Receives one entry per entity created, for the operator's log.
 * @returns The created entity as a JSON tool result, or an error result.
 */
export async function handleCalmCreate(
  clients: CalmClients,
  args: CalmCreateArgs,
  audit: (entry: CreateAuditEntry) => void = () => {},
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
    const created = await clients.createOData(def.service, def.entitySet, parsed.data);
    const { uuid, displayId } = (created ?? {}) as { uuid?: unknown; displayId?: unknown };
    audit({ resource: args.resource, id: uuid, displayId, fields: Object.keys(parsed.data) });
    return jsonResult(created);
  } catch (error) {
    return errorResultFrom(error);
  }
}
