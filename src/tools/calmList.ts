// `calm_list` — list/query any Cloud ALM collection. The `resource` parameter selects the entity
// set or REST endpoint; OData resources accept $filter/$select/$expand/$orderby/$top/$skip, while
// REST resources accept the relevant contextual parameters (validated against the registry).

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { errorMessage } from '../errors.js';
import { LIST_RESOURCES, type ListParams } from './registry.js';
import { errorResult, jsonResult } from './result.js';

/** Arguments accepted by the `calm_list` tool (validated by `calmListShape`). */
export type CalmListArgs = ListParams & { resource: string };

/**
 * Handle a `calm_list` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The collection as a JSON tool result, or an error result.
 */
export async function handleCalmList(
  clients: CalmClients,
  args: CalmListArgs,
): Promise<CallToolResult> {
  const def = LIST_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list valid ones.`,
    );
  }

  try {
    if (def.kind === 'odata') {
      const data = await clients.listOData(def.service, def.entitySet, {
        filter: args.filter,
        select: args.select,
        expand: args.expand,
        orderby: args.orderby,
        top: args.top,
        skip: args.skip,
      });
      return jsonResult(data);
    }

    // REST resource: enforce required contextual parameters before issuing the request.
    const missing = def.required.filter((name) => !args[name as keyof ListParams]);
    if (missing.length > 0) {
      return errorResult(
        `Missing required parameter(s) for resource '${args.resource}': ${missing.join(', ')}`,
      );
    }
    const { path, query } = def.build(args);
    const data = await clients.getRest(def.service, path, query);
    return jsonResult(data);
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}
