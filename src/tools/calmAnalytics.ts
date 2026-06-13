// `calm_analytics` — query an Analytics provider (entity set) with OData options. Because the
// Analytics service supports $orderby and $filter, this is the right tool for sorted/aggregated
// questions such as "open defects ordered by priority".

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { errorMessage } from '../errors.js';
import { errorResult, jsonResult } from './result.js';

/** Arguments accepted by the `calm_analytics` tool. */
export interface CalmAnalyticsArgs {
  provider: string;
  filter?: string;
  select?: string;
  orderby?: string;
  top?: number;
  skip?: number;
}

/**
 * Handle a `calm_analytics` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments (provider is constrained by the schema).
 * @returns The analytics dataset as a JSON tool result, or an error result.
 */
export async function handleCalmAnalytics(
  clients: CalmClients,
  args: CalmAnalyticsArgs,
): Promise<CallToolResult> {
  try {
    // Each provider is exposed as an entity set of the Analytics OData service.
    const data = await clients.listOData('analytics', args.provider, {
      filter: args.filter,
      select: args.select,
      orderby: args.orderby,
      top: args.top,
      skip: args.skip,
    });
    return jsonResult(data);
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}
