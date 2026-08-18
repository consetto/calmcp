// `calm_analytics` — query an Analytics provider (entity set) with OData options. Because the
// Analytics service supports $orderby and $filter, this is the right tool for sorted/aggregated
// questions such as "open defects ordered by priority".
//
// It is also the only tenant-wide counting path: `calm_list resource:'tasks'` requires a
// project_id, while every analytics provider spans the tenant. Pass `count_only` for a total or
// `group_by` for a breakdown; both return a few hundred bytes instead of every matching row.
//
// Analytics reports a daily snapshot, so its numbers will not match a live read of the same
// collection. Counting results say so, and `analyticsFilter.ts` explains why the time window is
// pinned rather than left to the service defaults.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { errorMessage } from '../errors.js';
import { COUNT_PERIOD, COUNT_RESOLUTION, mergeAnalyticsFilter } from './analyticsFilter.js';
import { countOData } from './counting.js';
import { errorResult, jsonResult } from './result.js';
import { ShapeError } from './shape.js';

/** Caveat attached to every analytics count, so a snapshot is never quoted as a live number. */
const SNAPSHOT_NOTE =
  'Analytics is a daily snapshot counted over a single time bucket, so it may differ from a live ' +
  'read of the same records.';

/** Arguments accepted by the `calm_analytics` tool. */
export interface CalmAnalyticsArgs {
  provider: string;
  filter?: string;
  select?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  count_only?: boolean;
  group_by?: string;
  group_limit?: number;
  period?: string;
  resolution?: string;
}

/**
 * Handle a `calm_analytics` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments (provider is constrained by the schema).
 * @returns The analytics dataset, or a count/breakdown, as a JSON tool result.
 */
export async function handleCalmAnalytics(
  clients: CalmClients,
  args: CalmAnalyticsArgs,
): Promise<CallToolResult> {
  const counting = args.count_only === true || args.group_by !== undefined;

  try {
    // Counting pins the window so the row count equals the entity count; a plain query keeps the
    // service defaults unless the caller asked for a specific window.
    const filter = mergeAnalyticsFilter(args.filter, {
      period: args.period ?? (counting ? COUNT_PERIOD : undefined),
      resolution: args.resolution ?? (counting ? COUNT_RESOLUTION : undefined),
    });

    if (counting) {
      const result = await countOData(
        clients,
        'analytics',
        args.provider,
        { filter },
        {
          subject: { provider: args.provider },
          groupBy: args.group_by,
          groupLimit: args.group_limit,
          note: SNAPSHOT_NOTE,
        },
      );
      return jsonResult(result);
    }

    // Each provider is exposed as an entity set of the Analytics OData service.
    const data = await clients.listOData('analytics', args.provider, {
      filter,
      select: args.select,
      orderby: args.orderby,
      top: args.top,
      skip: args.skip,
      count: args.count,
    });
    return jsonResult(data);
  } catch (error) {
    if (error instanceof ShapeError) return errorResult(error.message);
    return errorResult(errorMessage(error));
  }
}
