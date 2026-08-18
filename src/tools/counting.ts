// The `count_only` / `group_by` path shared by `calm_list` and `calm_analytics`.
//
// Counting exists as its own path because listing records to count them is the failure mode this
// server keeps hitting: a few hundred tasks serialize to hundreds of KB, the AI client truncates
// the JSON, and the model answers "several hundred" from a fragment. Every result built here is a
// few hundred bytes whatever the collection size.
//
// Three strategies, chosen per target:
//   - Analytics          -> `$select` the dimensions plus the count measure, and let the service
//                           aggregate. See `countAnalytics` for why counting its rows is wrong.
//   - OData, no group_by -> `$count=true&$top=0`, one request, no records moved.
//   - everything else    -> calmcp pages and tallies, discarding each page.
//
// The chosen strategy, the effective `$filter` and the completeness of the walk are all reported,
// because a bare number carries no way to tell a snapshot from a live read or a full count from a
// capped one. See `analyticsFilter.ts` for why the analytics time window is pinned.

import type { CalmClients } from '../calm/index.js';
import { readODataCount } from '../calm/odata.js';
import type { ServiceName } from '../config.js';
import { createGroupTally, DEFAULT_GROUP_LIMIT, type Group, NO_VALUE } from './aggregate.js';
import { fetchAllOData, fetchAllRest, MAX_PAGES_COUNT, type PagingOptions } from './paging.js';
import type { ListParams, RestListResource } from './registry.js';
import { parseFields, type Record_ } from './shape.js';

/** How a total was arrived at. */
export type CountMethod =
  | 'odata-count'
  | 'client-paging'
  | 'analytics-measure'
  | 'analytics-distinct';

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
  /**
   * What the number counts. `entities` is the real answer to "how many are there?"; `rows` means
   * the provider had no identity or measure catalogued, so this is a count of analytics data
   * points, which can be many times the entity count.
   */
  unit?: 'entities' | 'rows';
  /**
   * Present and `false` when the count could not be distinguished from an unfiltered one, so the
   * filter may have been ignored. Absent means no such doubt, not that the filter was verified.
   */
  filterVerified?: false;
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
  /**
   * A `$filter` selecting everything the caller's filter was narrowing, used to detect a filter
   * the service dropped. Set it only when the caller actually supplied a filter, and only for a
   * service known to ignore unsupported filter fields rather than rejecting them.
   */
  unfilteredBaseline?: string;
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
      const warning = await filterWarning(clients, service, entitySet, request, total);
      const note = [request.note, warning].filter(Boolean).join(' ');
      return {
        subject: request.subject,
        filter: query.filter,
        total,
        complete: true,
        method: 'odata-count',
        ...(warning ? { filterVerified: false } : {}),
        ...(note ? { note } : {}),
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
  query: { filter?: string; orderby?: string; select?: string },
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
 * Count entities in an Analytics provider.
 *
 * An analytics row is **not** an entity. The service emits one row per combination of a record's
 * dimension values, so a task carrying several tags, workstreams and scope assignments produces
 * many rows: 192, for one record in a real tenant. Counting rows therefore overstates the entity
 * count by a large and wildly uneven factor (2749 rows for 428 user stories), and `$count` over
 * the unrestricted row set is wrong for the same reason.
 *
 * What the service does offer is server-side aggregation: `$select` a set of dimensions plus a
 * measure and it returns one pre-aggregated row per distinct combination, with the measure already
 * counted. `$select=typeID,counter` answers "how many of each task type" in a single request and a
 * few hundred bytes. A measure selected alone does not collapse, so a grand total instead comes
 * from `$count` over `$select=<identity>`, which counts distinct entities.
 *
 * When the provider has neither an identity nor a count measure catalogued, the result is labelled
 * `unit: 'rows'` rather than quietly passing off data points as entities.
 *
 * @param clients - The Cloud ALM client container.
 * @param provider - The analytics provider (entity set) name.
 * @param filter - The effective `$filter`, time window already merged in.
 * @param fields - The provider's catalogued identity, measure and dimensions, if known.
 * @param request - What to count and how to label it.
 * @returns The count result.
 */
export async function countAnalytics(
  clients: CalmClients,
  provider: string,
  filter: string | undefined,
  fields: { identity?: string; countMeasure?: string } | undefined,
  request: CountRequest,
): Promise<CountResult> {
  const keys = request.groupBy ? parseFields(request.groupBy) : [];
  const identity = fields?.identity;
  const measure = fields?.countMeasure;

  const base = { subject: request.subject, filter };

  // Breakdown: let the service aggregate, one request, one row per group.
  if (keys.length > 0 && measure) {
    const { records, complete, pages } = await fetchAllOData(
      clients,
      'analytics',
      provider,
      { filter, select: [...keys, measure].join(',') },
      { maxPages: MAX_PAGES_COUNT },
    );
    const groups = toMeasuredGroups(records, keys, measure);
    return {
      ...base,
      total: groups.reduce((sum, group) => sum + group.count, 0),
      complete,
      method: 'analytics-measure',
      unit: 'entities',
      pagesFetched: pages,
      groupBy: keys,
      groups: groups.slice(0, request.groupLimit ?? DEFAULT_GROUP_LIMIT),
      ...foldedGroups(groups, request.groupLimit ?? DEFAULT_GROUP_LIMIT),
      ...noteFor({ total: 0, complete, method: 'analytics-measure' }, request),
    };
  }

  // Grand total: distinct entities, via $count over the identity alone.
  if (keys.length === 0 && identity) {
    const total = await serverSideCount(clients, 'analytics', provider, {
      filter,
      select: identity,
    });
    if (total !== undefined) {
      const warning = await filterWarning(clients, 'analytics', provider, request, total, identity);
      const note = [request.note, warning].filter(Boolean).join(' ');
      return {
        ...base,
        total,
        complete: true,
        method: 'analytics-distinct',
        unit: 'entities',
        ...(warning ? { filterVerified: false as const } : {}),
        ...(note ? { note } : {}),
      };
    }
  }

  // Nothing catalogued for this provider: count rows, and say that is what they are.
  const tally = await pagedTally(keys, request.groupLimit, (options) =>
    fetchAllOData(clients, 'analytics', provider, { filter }, options),
  );
  const rowNote =
    `This provider has no identity field or count measure catalogued in calmcp, so this counts ` +
    'analytics data points, not records. One record produces one row per combination of its ' +
    'dimension values, so the true number of records is lower, possibly by a large factor. Use ' +
    'calm_list for an exact count.';
  return {
    ...base,
    ...tally,
    unit: 'rows',
    note: [request.note, rowNote].filter(Boolean).join(' '),
  };
}

/** Build groups from pre-aggregated rows, ordered like every other tally. */
function toMeasuredGroups(records: Record_[], keys: string[], measure: string): Group[] {
  const groups = records.map((record) => {
    const count = Number(record[measure] ?? 0);
    const labels = keys.map((key) => labelOf(record[key]));
    const group: Group =
      keys.length === 1
        ? { value: labels[0] ?? NO_VALUE, count: Number.isFinite(count) ? count : 0 }
        : {
            values: Object.fromEntries(keys.map((key, i) => [key, labels[i] ?? NO_VALUE])),
            count: Number.isFinite(count) ? count : 0,
          };
    return group;
  });
  return groups.sort((a, b) => b.count - a.count || labelKey(a).localeCompare(labelKey(b)));
}

/** Stable sort key for a group, for tie-breaking. */
function labelKey(group: Group): string {
  return group.value ?? Object.values(group.values ?? {}).join(' ');
}

/** Render a dimension value the same way the client-side tally does. */
function labelOf(value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE;
  const text = String(value);
  return text.trim() === '' ? NO_VALUE : text;
}

/** Report the tail beyond `groupLimit` rather than dropping it. */
function foldedGroups(
  groups: Group[],
  limit: number,
): { groupsOmitted?: number; otherCount?: number } {
  if (groups.length <= limit) return {};
  const folded = groups.slice(limit);
  return {
    groupsOmitted: folded.length,
    otherCount: folded.reduce((sum, group) => sum + group.count, 0),
  };
}

/**
 * Detect a `$filter` the service silently ignored.
 *
 * The Cloud ALM Analytics service drops a filter on a field it does not support instead of
 * rejecting the request, and then answers with every row. The count that comes back is a real
 * number for a query nobody asked, which is the worst possible failure here: it is plausible,
 * confident and wrong. Counting the same window without the caller's filter costs one cheap
 * request and catches it.
 *
 * Equal totals are suspicious, not proof: a filter matching every record produces the same
 * equality. The wording says so, and the result is still returned rather than withheld.
 *
 * @returns A warning to append to `note`, or `undefined` when there is nothing to flag.
 */
async function filterWarning(
  clients: CalmClients,
  service: ServiceName,
  entitySet: string,
  request: CountRequest,
  total: number,
  select?: string,
): Promise<string | undefined> {
  const baseline = request.unfilteredBaseline;
  if (baseline === undefined) return undefined;

  const unfiltered = await serverSideCount(clients, service, entitySet, {
    filter: baseline,
    select,
  });
  if (unfiltered === undefined || unfiltered !== total) return undefined;

  return (
    `This count is identical to the unfiltered count (${unfiltered}), so the service may have ` +
    'ignored your filter rather than applying it: this service drops a filter on a field it does ' +
    'not support instead of erroring. Do not report this as a filtered count until you have ' +
    'checked it. Re-run with group_by on the field you were filtering, which needs no filter and ' +
    'so cannot be dropped, and read the count off the relevant group.'
  );
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
