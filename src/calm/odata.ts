// OData v4 query-string construction and the shared collection-response shape, plus a generic
// query builder for the REST (non-OData) Cloud ALM services.

/** OData v4 system query options. All optional; only set options are emitted. */
export interface ODataQueryOptions {
  /** `$filter` expression, e.g. `displayId eq '6-123'`. */
  filter?: string;
  /** `$select` — comma-separated field list. */
  select?: string;
  /** `$expand` — comma-separated navigation properties. */
  expand?: string;
  /** `$orderby` — e.g. `modifiedAt desc,status asc`. */
  orderby?: string;
  /** `$top` — maximum number of records. */
  top?: number;
  /** `$skip` — number of records to skip (pagination). */
  skip?: number;
  /** `$count` — include the total count when true. */
  count?: boolean;
  /** `$search` — free-text search term. */
  search?: string;
}

/**
 * OData v4 collection-response envelope.
 *
 * @typeParam T - The entity type contained in `value`.
 */
export interface ODataCollection<T> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

/**
 * Build an OData query string (including the leading `?`) from system query options.
 *
 * Values are percent-encoded so the resulting URL is always valid; structural keys like
 * `$filter` are kept literal.
 *
 * @param options - The OData system query options.
 * @returns A query string such as `?$filter=...&$top=50`, or `''` when nothing is set.
 */
export function buildODataQueryString(options: ODataQueryOptions): string {
  const params: string[] = [];

  if (options.filter) params.push(`$filter=${encodeURIComponent(options.filter)}`);
  if (options.select) params.push(`$select=${encodeURIComponent(options.select)}`);
  if (options.expand) params.push(`$expand=${encodeURIComponent(options.expand)}`);
  if (options.orderby) params.push(`$orderby=${encodeURIComponent(options.orderby)}`);
  if (options.top !== undefined) params.push(`$top=${options.top}`);
  if (options.skip !== undefined) params.push(`$skip=${options.skip}`);
  if (options.count) params.push('$count=true');
  if (options.search) params.push(`$search=${encodeURIComponent(options.search)}`);

  return params.length > 0 ? `?${params.join('&')}` : '';
}

/** A value accepted by {@link buildQueryString}. Arrays emit one repeated key per element. */
export type QueryValue = string | number | boolean | string[] | undefined | null;

/**
 * Build a plain REST query string (including the leading `?`) for the non-OData services.
 *
 * `undefined`/`null` values are skipped; array values are emitted as repeated keys
 * (e.g. `tags=a&tags=b`), which is how the Tasks and Landscape APIs expect list parameters.
 *
 * @param params - A map of query parameter names to values.
 * @returns A query string, or `''` when no parameters are set.
 */
export function buildQueryString(params: Record<string, QueryValue>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
