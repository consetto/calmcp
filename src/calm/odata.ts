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
 * Cloud ALM emits the OData 4.01 minimal-metadata annotations (`@count`, `@nextLink`), not the
 * `@odata.`-prefixed forms: `@odata.count` appears in none of the OpenAPI specs under `YAML/`.
 * Both spellings are declared so the type also fits a gateway that uses the full metadata form,
 * and `@count` is typed `number | string` because the specs declare it `anyOf: [number, string]`.
 * Read it through {@link readODataCount} rather than reaching for a key directly.
 *
 * @typeParam T - The entity type contained in `value`.
 */
export interface ODataCollection<T> {
  '@odata.context'?: string;
  '@context'?: string;
  '@odata.count'?: number | string;
  '@count'?: number | string;
  '@odata.nextLink'?: string;
  '@nextLink'?: string;
  value: T[];
}

/**
 * Read the total-match count from an OData collection envelope.
 *
 * Only meaningful when the request asked for it with `$count=true`.
 *
 * @param data - A parsed response body.
 * @returns The count, or `undefined` when the envelope carries none or it is not numeric.
 */
export function readODataCount(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const envelope = data as Record<string, unknown>;
  for (const key of ['@count', '@odata.count']) {
    const raw = envelope[key];
    if (raw === undefined || raw === null) continue;
    // `Number('')` is 0, which would report an empty annotation as a real count of zero.
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
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
    // Some REST services (Process Scopes, Custom Processes) accept the OData system options
    // `$top`/`$skip`/`$orderby` alongside their own parameters. Keep the leading `$` literal
    // rather than percent-encoding it to `%24`, which is what those gateways expect to see.
    const name = encodeURIComponent(key).replace(/^%24/, '$');
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${name}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${name}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
