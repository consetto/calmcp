// `calm_analytics` — query an Analytics provider (entity set) with OData options. The service
// supports $filter and aggregates server-side, which makes this the tool for tenant-wide totals
// and breakdowns. It does NOT sort: $orderby is accepted and ignored (verified on a tenant), so it
// is not advertised on this tool and its output must never be presented as sorted.
//
// It is also the only tenant-wide counting path: `calm_list resource:'tasks'` requires a
// project_id, while every analytics provider spans the tenant. Pass `count_only` for a total or
// `group_by` for a breakdown; both return a few hundred bytes instead of every matching row.
//
// Analytics reports a daily snapshot, so its numbers will not match a live read of the same
// collection. Counting results say so, and `analyticsFilter.ts` explains why the time window is
// pinned rather than left to the service defaults.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import {
  COUNT_PERIOD,
  COUNT_RESOLUTION,
  controlValue,
  filtersDimensions,
  mergeAnalyticsFilter,
  PROVIDERS_WITHOUT_RESOLUTION,
} from './analyticsFilter.js';
import { ANALYTICS_PROVIDER_FIELDS } from './constants.js';
import { countAnalytics } from './counting.js';
import { withNextPage } from './paging.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import type { calmAnalyticsShape } from './schemas.js';

/** Caveat attached to every analytics count, so a snapshot is never quoted as a live number. */
const SNAPSHOT_NOTE =
  'Analytics is a daily snapshot, so it may differ from a live read of the same records.';

/** Arguments accepted by the `calm_analytics` tool. */
export type CalmAnalyticsArgs = z.infer<z.ZodObject<typeof calmAnalyticsShape>>;

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
  const countResolution = PROVIDERS_WITHOUT_RESOLUTION.has(args.provider)
    ? undefined
    : COUNT_RESOLUTION;

  // A count returns no rows, so a row window or a column list would be ignored without a word.
  const window = (['top', 'skip', 'select', 'with_count'] as const).filter(
    (name) => args[name] !== undefined,
  );
  if (counting && window.length > 0) {
    return errorResult(
      `${window.join(', ')} ${window.length > 1 ? 'apply' : 'applies'} to returned rows, but ` +
        'count_only/group_by return a total. Drop ' +
        `${window.length > 1 ? 'them' : 'it'}.`,
    );
  }

  try {
    // Counting pins the window so the row count equals the entity count; a plain query keeps the
    // service defaults unless the caller asked for a specific window.
    const filter = mergeAnalyticsFilter(args.filter, {
      period: args.period ?? (counting ? COUNT_PERIOD : undefined),
      resolution: args.resolution ?? (counting ? countResolution : undefined),
    });

    if (counting) {
      // The same window with the caller's dimension filter removed. Comparing against it is how a
      // filter the service dropped is caught; see `filterWarning` in `counting.ts`.
      // It must cover the caller's window: one the filter sets itself (`period eq 'L4W'`) included.
      const baseline = filtersDimensions(args.filter)
        ? mergeAnalyticsFilter(undefined, {
            period: args.period ?? controlValue(args.filter, 'period') ?? COUNT_PERIOD,
            resolution:
              args.resolution ?? controlValue(args.filter, 'resolution') ?? countResolution,
          })
        : undefined;

      const result = await countAnalytics(
        clients,
        args.provider,
        filter,
        ANALYTICS_PROVIDER_FIELDS[args.provider],
        {
          subject: { provider: args.provider },
          groupBy: args.group_by,
          groupLimit: args.group_limit,
          note: SNAPSHOT_NOTE,
          unfilteredBaseline: baseline,
        },
      );
      return jsonResult(result);
    }

    // Each provider is exposed as an entity set of the Analytics OData service.
    const data = await clients.listOData('analytics', args.provider, {
      filter,
      select: args.select,
      top: args.top,
      skip: args.skip,
      count: args.with_count,
    });
    return jsonResult(withNextPage(data, data, args));
  } catch (error) {
    return errorResultFrom(error);
  }
}
