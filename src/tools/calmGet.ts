// `calm_get` — fetch a single Cloud ALM entity by id across domains. OData entities are fetched by
// key; features additionally accept a display id (e.g. "6-123"), resolved via a `displayId` filter.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { errorMessage } from '../errors.js';
import { GET_RESOURCES } from './registry.js';
import { errorResult, jsonResult } from './result.js';

/** Arguments accepted by the `calm_get` tool. */
export interface CalmGetArgs {
  resource: string;
  id: string;
  expand?: string;
}

/** RFC 4122 UUID matcher — distinguishes a key from a feature display id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handle a `calm_get` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The entity as a JSON tool result, or an error result.
 */
export async function handleCalmGet(
  clients: CalmClients,
  args: CalmGetArgs,
): Promise<CallToolResult> {
  const def = GET_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list valid ones.`,
    );
  }

  try {
    if (def.kind === 'rest') {
      return jsonResult(await clients.getRest(def.service, def.build(args.id)));
    }

    // OData entity: resolve a feature display id to its uuid when the id is not a UUID.
    if (def.allowDisplayId && !UUID_PATTERN.test(args.id)) {
      const collection = await clients.listOData(def.service, def.entitySet, {
        filter: `displayId eq '${args.id}'`,
        top: 1,
      });
      const first = collection.value[0] as { uuid?: string } | undefined;
      if (!first) {
        return errorResult(`No ${args.resource} found with display id '${args.id}'`);
      }
      // If an expand was requested, re-fetch by uuid to include the navigations.
      if (args.expand && first.uuid) {
        return jsonResult(
          await clients.getOData(def.service, def.entitySet, first.uuid, args.expand),
        );
      }
      return jsonResult(first);
    }

    return jsonResult(await clients.getOData(def.service, def.entitySet, args.id, args.expand));
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}
