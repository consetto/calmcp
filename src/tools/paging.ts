// Paging that calmcp performs itself, for the cases where one upstream page is not the answer.
//
// Two callers need it, for different reasons:
//   - `calmList.ts` — the Tasks REST endpoint has no timebox filter, so the filter is applied here
//     and a single page would silently miss matches on later pages.
//   - `counting.ts` — a total or a group-by tally must cover every matching record, and most Cloud
//     ALM REST endpoints expose no count at all.
//
// Both caps below are deliberate stopping points, never silent truncation: a caller that hits one
// gets `complete: false` and must say so. The counting cap is the larger of the two because a tally
// discards each page as it goes, but it is still far below "unbounded" because a few dozen
// sequential upstream requests will exhaust an agent host's request timeout long before memory
// becomes a concern.
//
// Pages are fetched one after another. SAP's API guide caps every Cloud ALM pull API at 500 requests
// per 5 seconds, which sequential paging cannot approach; fetching pages in parallel would have to
// stay under that, since the budget is shared with every other client of the tenant.

import type { CalmClients } from '../calm/index.js';
import { currentSignal, runWithContext } from '../context.js';
import { UnexpectedResponseError } from '../errors.js';
import type { ODataListResource, RestListResource } from './registry.js';
import { locateRecords, type Record_ } from './shape.js';

/** Upstream page size used whenever calmcp pages a collection itself. */
export const PAGE_SIZE = 500;

/** Page cap when the records themselves are returned to the caller (5000 records). */
export const MAX_PAGES_RETURN = 10;

/** Page cap when only a tally is kept and each page is discarded (20000 records). */
export const MAX_PAGES_COUNT = 40;

/**
 * Time a count may spend paging. Pages are fetched one after another, so 40 pages of large tasks
 * can take longer than the roughly 60 s an agent host waits for a tool; stopping here returns the
 * tally so far, marked incomplete, instead of nothing.
 */
export const COUNT_TIME_BUDGET_MS = 40_000;

/** Outcome of a paged fetch. */
export interface PagedFetch {
  /** The accumulated records, or `[]` when an `onPage` callback consumed them instead. */
  records: Record_[];
  /** False when the page cap stopped the walk before the collection was exhausted. */
  complete: boolean;
  /** Number of upstream requests issued. */
  pages: number;
  /** Why an incomplete walk stopped: the page cap, or the time budget. */
  stoppedBy?: 'pages' | 'time';
}

/** Options shared by both paged fetchers. */
export interface PagingOptions {
  /** Page cap (default {@link MAX_PAGES_RETURN}). */
  maxPages?: number;
  /**
   * Called with each page as it arrives. When supplied, pages are not accumulated and
   * `records` comes back empty, so a large tally never materialises the records.
   */
  onPage?: (rows: Record_[]) => void;
  /**
   * Epoch milliseconds after which no further page is requested. The first page is always fetched;
   * a walk stopped here is incomplete, like one stopped by the page cap.
   */
  deadline?: number;
}

/**
 * Page through a REST resource until a short page arrives or the cap is reached.
 *
 * Not every REST resource can be paged; those that do not return their whole
 * collection in one response. That case is detected by the built query being identical for two
 * consecutive pages, and the walk stops after the first page rather than requesting the same rows
 * again forever.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The REST resource definition.
 * @param params - The caller's parameters (its own `top`/`skip` are overridden).
 * @param options - Page cap and per-page callback.
 * @returns The records (or an empty list when `onPage` consumed them), plus completeness.
 */
export async function fetchAllRest(
  clients: CalmClients,
  def: RestListResource,
  params: Parameters<RestListResource['build']>[0],
  options: PagingOptions = {},
): Promise<PagedFetch> {
  const maxPages = options.maxPages ?? MAX_PAGES_RETURN;
  const all: Record_[] = [];
  let previousQuery: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    if (pastDeadline(page, options))
      return { records: all, complete: false, pages: page, stoppedBy: 'time' };
    const { path, query } = def.build({
      ...params,
      top: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    });

    // The resource ignores top/skip, so page 0 already held everything it will ever return.
    if (previousQuery !== undefined && query === previousQuery) {
      return { records: all, complete: true, pages: page };
    }
    previousQuery = query;

    // Some REST endpoints answer with a bare array, others (process authoring/management) wrap
    // the records in an OData-style `{ value: [...] }` envelope. Both shapes must page, or a
    // count silently walks zero records and reports a total of 0.
    const fetched = await beforeDeadline(page, options, () =>
      clients.getRest(def.service, path, query),
    );
    if (!fetched) return { records: all, complete: false, pages: page, stoppedBy: 'time' };
    const body = fetched.value;
    const { rows, size } = pageRows(body, def.service);
    collect(rows, all, options.onPage);
    if (size < PAGE_SIZE) return { records: all, complete: true, pages: page + 1 };
  }

  return { records: all, complete: false, pages: maxPages, stoppedBy: 'pages' };
}

/**
 * Page through an OData entity set with `$top`/`$skip`.
 *
 * A service may cap its pages below {@link PAGE_SIZE} (server-driven paging). It then signals the
 * rest with `@odata.nextLink`/`@nextLink`, so a short page ends the walk only when no next link
 * is present, and `$skip` advances by the rows actually received. The link itself is never
 * followed: it is an absolute URL from the response, and calmcp only requests URLs it built.
 *
 * @param clients - The Cloud ALM client container.
 * @param service - The owning service.
 * @param entitySet - The entity set name.
 * @param query - `$filter`/`$select`/`$orderby` to repeat on every page.
 * @param options - Page cap and per-page callback.
 * @returns The records (or an empty list when `onPage` consumed them), plus completeness.
 */
export async function fetchAllOData(
  clients: CalmClients,
  service: ODataListResource['service'],
  entitySet: string,
  query: { filter?: string; select?: string; orderby?: string },
  options: PagingOptions = {},
): Promise<PagedFetch> {
  const maxPages = options.maxPages ?? MAX_PAGES_RETURN;
  const all: Record_[] = [];
  let skip = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (pastDeadline(page, options))
      return { records: all, complete: false, pages: page, stoppedBy: 'time' };
    const fetched = await beforeDeadline(page, options, () =>
      clients.listOData(service, entitySet, { ...query, top: PAGE_SIZE, skip }),
    );
    if (!fetched) return { records: all, complete: false, pages: page, stoppedBy: 'time' };
    const body = fetched.value;
    const { rows, size } = pageRows(body, service);
    collect(rows, all, options.onPage);
    skip += size;
    if (size === 0 || (size < PAGE_SIZE && !hasNextLink(body))) {
      return { records: all, complete: true, pages: page + 1 };
    }
  }

  return { records: all, complete: false, pages: maxPages, stoppedBy: 'pages' };
}

/**
 * Whether an OData response announces a further page.
 *
 * @param body - A parsed response body.
 * @returns True when it carries `@odata.nextLink` or `@nextLink`.
 */
export function hasNextLink(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const envelope = body as { '@odata.nextLink'?: unknown; '@nextLink'?: unknown };
  return Boolean(envelope['@odata.nextLink'] ?? envelope['@nextLink']);
}

/** Whether the time budget is spent; the first page is always fetched. */
function pastDeadline(page: number, options: PagingOptions): boolean {
  return page > 0 && options.deadline !== undefined && Date.now() >= options.deadline;
}

/**
 * Fetch one page, cut off when the time budget runs out while it is in flight (including a throttle
 * wait). Without this a page started just before the deadline could add its own timeout and a retry,
 * and a 40-second count would run for well over a minute.
 *
 * @returns The page, or undefined when the deadline stopped it. The first page is never cut off.
 */
async function beforeDeadline<T>(
  page: number,
  options: PagingOptions,
  fetch: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  if (page === 0 || options.deadline === undefined) return { value: await fetch() };
  const deadline = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()));
  const caller = currentSignal();
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  try {
    return { value: await runWithContext({ signal }, fetch) };
  } catch (error) {
    if (deadline.aborted && !caller?.aborted) return undefined;
    throw error;
  }
}

/**
 * The records of one page: a bare array, an OData `{ value: [...] }` or a SCIM
 * `{ Resources: [...] }` envelope. Anything else is refused. Read as a single record, an
 * unexpected envelope would be counted as 1 and reported as complete.
 */
function pageRows(body: unknown, service: string): { rows: Record_[]; size: number } {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null
      ? ((body as { value?: unknown; Resources?: unknown }).value ??
        (body as { Resources?: unknown }).Resources)
      : undefined;
  if (!Array.isArray(list)) {
    throw new UnexpectedResponseError(
      `The ${service} service answered a list request with something that is not a list, so ` +
        'calmcp did not count or return it.',
    );
  }
  // The page size counts every entry, so a null among them does not make a full page look short.
  const rows = list.filter(
    (row): row is Record_ => typeof row === 'object' && row !== null && !Array.isArray(row),
  );
  return { rows, size: list.length };
}

/** Hand a page to the callback, or accumulate it when there is none. */
function collect(rows: Record_[], all: Record_[], onPage?: (rows: Record_[]) => void): void {
  if (onPage) {
    onPage(rows);
    return;
  }
  all.push(...rows);
}

/**
 * Add a `nextPage` hint naming the exact parameters for the following page, when this page is
 * full or the service announced more. Without it a caller has to work out the next offset itself,
 * and a wrong guess silently skips or repeats records.
 *
 * @param shaped - The response after field projection.
 * @param raw - The response as the service sent it (for its `@nextLink`).
 * @param window - The `top`/`skip` the page was requested with.
 * @returns The response, with the hint when another page is likely.
 */
export function withNextPage(
  shaped: unknown,
  raw: unknown,
  window: { top?: number; skip?: number },
): unknown {
  const located = locateRecords(shaped);
  const count = located?.records.length ?? 0;
  if (!located || count === 0) return shaped;
  if (!(hasNextLink(raw) || count === window.top)) return shaped;
  const nextPage = { skip: (window.skip ?? 0) + count };
  return Array.isArray(shaped)
    ? { records: shaped, nextPage }
    : { ...(shaped as object), nextPage };
}
