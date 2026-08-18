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

import type { CalmClients } from '../calm/index.js';
import type { ODataListResource, RestListResource } from './registry.js';
import { asRecords, locateRecords, type Record_ } from './shape.js';

/** Upstream page size used whenever calmcp pages a collection itself. */
export const PAGE_SIZE = 500;

/** Page cap when the records themselves are returned to the caller (5000 records). */
export const MAX_PAGES_RETURN = 10;

/** Page cap when only a tally is kept and each page is discarded (20000 records). */
export const MAX_PAGES_COUNT = 40;

/** Outcome of a paged fetch. */
export interface PagedFetch {
  /** The accumulated records, or `[]` when an `onPage` callback consumed them instead. */
  records: Record_[];
  /** False when the page cap stopped the walk before the collection was exhausted. */
  complete: boolean;
  /** Number of upstream requests issued. */
  pages: number;
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
}

/**
 * Page through a REST resource until a short page arrives or the cap is reached.
 *
 * Not every REST resource accepts `limit`/`offset`; those that do not return their whole
 * collection in one response. That case is detected by the built query being identical for two
 * consecutive pages, and the walk stops after the first page rather than requesting the same rows
 * again forever.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The REST resource definition.
 * @param params - The caller's parameters (its own `limit`/`offset` are overridden).
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
    const { path, query } = def.build({
      ...params,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });

    // The resource ignores limit/offset, so page 0 already held everything it will ever return.
    if (previousQuery !== undefined && query === previousQuery) {
      return { records: all, complete: true, pages: page };
    }
    previousQuery = query;

    const rows = asRecords(await clients.getRest(def.service, path, query));
    collect(rows, all, options.onPage);
    if (rows.length < PAGE_SIZE) return { records: all, complete: true, pages: page + 1 };
  }

  return { records: all, complete: false, pages: maxPages };
}

/**
 * Page through an OData entity set with `$top`/`$skip`.
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

  for (let page = 0; page < maxPages; page += 1) {
    const body = await clients.listOData(service, entitySet, {
      ...query,
      top: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    });
    const rows = locateRecords(body)?.records ?? [];
    collect(rows, all, options.onPage);
    if (rows.length < PAGE_SIZE) return { records: all, complete: true, pages: page + 1 };
  }

  return { records: all, complete: false, pages: maxPages };
}

/** Hand a page to the callback, or accumulate it when there is none. */
function collect(rows: Record_[], all: Record_[], onPage?: (rows: Record_[]) => void): void {
  if (onPage) {
    onPage(rows);
    return;
  }
  all.push(...rows);
}
