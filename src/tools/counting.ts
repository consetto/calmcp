// The `count_only` / `group_by` path shared by `calm_list` and `calm_analytics`.
//
// Counting exists as its own path because listing records to count them is the failure mode this
// server keeps hitting: a few hundred tasks serialize to hundreds of KB, the AI client truncates
// the JSON, and the model answers "several hundred" from a fragment. Every result built here is a
// few hundred bytes whatever the collection size.
//
// Two strategies, chosen per target:
//   - OData and Analytics, no group_by -> `$count=true&$top=0`, one request, no records moved.
//   - everything else                  -> calmcp pages and tallies, discarding each page.
//
// The chosen strategy, the effective `$filter` and the completeness of the walk are all reported,
// because a bare number carries no way to tell a snapshot from a live read or a full count from a
// capped one. See `analyticsFilter.ts` for why the analytics time window is pinned.

import type { CalmClients } from '../calm/index.js';
import { readODataCount } from '../calm/odata.js';
import type { ServiceName } from '../config.js';
import { createGroupTally, type Group } from './aggregate.js';
import { fetchAllOData, fetchAllRest, MAX_PAGES_COUNT, type PagingOptions } from './paging.js';
import type { ListParams, RestListResource } from './registry.js';
import { parseFields, type Record_ } from './shape.js';

/** How a total was arrived at. */
export type CountMethod = 'odata-count' | 'client-paging';

/** The result of a counting call: small, and explicit about where the number came from. */
export interface CountResult {
  /** What was counted (provider, or resource plus its scoping parameters). */
  subject: Record<string, string>;
  /** The `$filter` actually sent, when there was one. Quotable, and reproducible by hand. */
  filter?: string;
  total: number;
  /** False when a page cap stopped the walk, so `total` is a floor rather than the total. */
  complete: boolean;
  method: CountMethod;
  pagesFetched?: number;
  groupBy?: string[];
  groups?: Group[];
  groupsOmitted?: number;
  otherCount?: number;
  note?: string;
}

/** What to count and how. */
export interface CountRequest {
  /** Identifies the counted collection in the result. */
  subject: Record<string, string>;
  /** Comma-separated field name(s) to break the count down by. */
  groupBy?: string;
  /** Maximum groups returned. */
  groupLimit?: number;
  /** Appended to `note`, e.g. the analytics snapshot caveat. */
  note?: string;
}

/**
 * Count an OData entity set, including any Analytics provider.
 *
 * Without `group_by` this is a single request that transfers no records. With it, calmcp pages and
 * tallies, because no Cloud ALM service offers a grouped count calmcp can depend on.
 *
 * @param clients - The Cloud ALM client container.
 * @param service - The owning service.
 * @param entitySet - The entity set or analytics provider name.
 * @param query - `$filter`/`$orderby` to apply.
 * @param request - What to count and how to label it.
 * @returns The count result.
 * @throws {ShapeError} When a `group_by` field exists on none of the records.
 */
export async function countOData(
  clients: CalmClients,
  service: ServiceName,
  entitySet: string,
  query: { filter?: string; orderby?: string },
  request: CountRequest,
): Promise<CountResult> {
  const keys = request.groupBy ? parseFields(request.groupBy) : [];

  if (keys.length === 0) {
    const total = await serverSideCount(clients, service, entitySet, query);
    if (total !== undefined) {
      return {
        subject: request.subject,
        filter: query.filter,
        total,
        complete: true,
        method: 'odata-count',
        ...(request.note ? { note: request.note } : {}),
      };
    }
    // The service answered without a count annotation. Fall through rather than report nothing.
  }

  const tally = await pagedTally(keys, request.groupLimit, (options) =>
    fetchAllOData(clients, service, entitySet, query, options),
  );
  return { subject: request.subject, filter: query.filter, ...tally, ...noteFor(tally, request) };
}

/**
 * Count a REST resource by paging through it.
 *
 * The Cloud ALM REST endpoints expose no count of any kind, so this is the only way. Records are
 * discarded page by page, so only the tally is ever held.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The REST resource definition.
 * @param params - The caller's scoping and filter parameters.
 * @param request - What to count and how to label it.
 * @returns The count result.
 * @throws {ShapeError} When a `group_by` field exists on none of the records.
 */
export async function countRest(
  clients: CalmClients,
  def: RestListResource,
  params: ListParams,
  request: CountRequest,
): Promise<CountResult> {
  const keys = request.groupBy ? parseFields(request.groupBy) : [];
  const tally = await pagedTally(keys, request.groupLimit, (options) =>
    fetchAllRest(clients, def, params, options),
  );
  return { subject: request.subject, ...tally, ...noteFor(tally, request) };
}

/**
 * Ask the service for the count alone.
 *
 * `$top=0` is the ideal form, since it transfers no records at all. Not every OData gateway
 * accepts it, so a service that answers without a count annotation is retried at `$top=1` before
 * giving up and letting the caller page instead.
 *
 * @returns The total, or `undefined` when the service returned no count annotation.
 */
async function serverSideCount(
  clients: CalmClients,
  service: ServiceName,
  entitySet: string,
  query: { filter?: string; orderby?: string },
): Promise<number | undefined> {
  for (const top of [0, 1]) {
    const body = await clients.listOData(service, entitySet, { ...query, count: true, top });
    const total = readODataCount(body);
    if (total !== undefined) return total;
  }
  return undefined;
}

/** The part of a {@link CountResult} that paging produces. */
type PagedTally = Pick<
  CountResult,
  | 'total'
  | 'complete'
  | 'method'
  | 'pagesFetched'
  | 'groupBy'
  | 'groups'
  | 'groupsOmitted'
  | 'otherCount'
>;

/**
 * Page through a collection, keeping only a running total or group tally.
 *
 * @param keys - Group-by field names; empty for a plain total.
 * @param groupLimit - Maximum groups to return.
 * @param walk - The paged fetch to drive.
 * @returns The tally portion of the result.
 */
async function pagedTally(
  keys: string[],
  groupLimit: number | undefined,
  walk: (options: PagingOptions) => Promise<{ complete: boolean; pages: number }>,
): Promise<PagedTally> {
  const grouping = keys.length > 0 ? createGroupTally(keys, groupLimit) : undefined;
  let counted = 0;

  const onPage = (rows: Record_[]): void => {
    counted += rows.length;
    grouping?.add(rows);
  };

  const { complete, pages } = await walk({ maxPages: MAX_PAGES_COUNT, onPage });

  const base: PagedTally = {
    total: counted,
    complete,
    method: 'client-paging',
    pagesFetched: pages,
  };
  if (!grouping) return base;

  const tally = grouping.result();
  return {
    ...base,
    groupBy: tally.groupBy,
    groups: tally.groups,
    ...(tally.groupsOmitted !== undefined ? { groupsOmitted: tally.groupsOmitted } : {}),
    ...(tally.otherCount !== undefined ? { otherCount: tally.otherCount } : {}),
  };
}

/**
 * Build the `note` for a result, combining the caller's caveat with a cap warning.
 *
 * A capped walk must say so in words, not only in `complete: false`: a model reading a plain total
 * will otherwise quote a floor as if it were the answer.
 */
function noteFor(tally: PagedTally, request: CountRequest): { note?: string } {
  const parts: string[] = [];
  if (request.note) parts.push(request.note);
  if (!tally.complete) {
    parts.push(
      `Stopped at the ${tally.total}-record page cap, so the real total is higher. ` +
        'Narrow the query (for tasks: project_id, task_type, status) and count again.',
    );
  }
  return parts.length > 0 ? { note: parts.join(' ') } : {};
}
