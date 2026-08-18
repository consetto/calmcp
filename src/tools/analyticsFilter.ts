// Building the `$filter` expression for the Cloud ALM Analytics service.
//
// Analytics has no query parameters of its own for the time window: `period` and `resolution` are
// control properties that travel *inside* `$filter`, alongside the real dimensions. That is easy to
// get wrong and impossible to guess, so it is expressed once here and shared by `calmAnalytics.ts`
// and `counting.ts`.
//
// Why counting pins them. An analytics row is a data point, not an entity: each task appears once
// per time bucket, so the row count at `period eq 'L4W' and resolution eq 'W'` is roughly four
// times the number of tasks. The service defaults to a single daily bucket, which makes an
// unpinned count right by accident rather than by construction. Pinning the window and echoing it
// back turns a wrong assumption into something visible in the response instead of a plausible
// number with no provenance.

/** Time window used for counting: the current day, i.e. one bucket. */
export const COUNT_PERIOD = 'C1D';

/**
 * Bucket size used for counting.
 *
 * The endpoint prose also lists `R` (raw) and `P` (period), but the per-provider schemas declare
 * `enum: [D, W, M, Y]` with `default: D`, so `D` is the value the service is documented to accept
 * everywhere. Combined with {@link COUNT_PERIOD} it yields exactly one bucket.
 */
export const COUNT_RESOLUTION = 'D';

/** Control properties recognised inside an analytics `$filter`. */
export interface AnalyticsControls {
  period?: string;
  resolution?: string;
}

/**
 * Merge analytics control properties into a `$filter` expression.
 *
 * A control the caller already mentioned in their own `filter` is left alone, so an explicit
 * expression always wins over a default.
 *
 * @param filter - The caller's `$filter`, if any.
 * @param controls - The control properties to ensure are present.
 * @returns The combined expression, or `undefined` when there is nothing to send.
 */
export function mergeAnalyticsFilter(
  filter: string | undefined,
  controls: AnalyticsControls,
): string | undefined {
  const clauses: string[] = [];
  const base = filter?.trim();

  for (const [name, value] of Object.entries(controls)) {
    if (!value) continue;
    if (base && mentionsControl(base, name)) continue;
    clauses.push(`${name} eq '${value}'`);
  }

  if (clauses.length === 0) return base || undefined;
  return base ? `${base} and ${clauses.join(' and ')}` : clauses.join(' and ');
}

/**
 * Whether a `$filter` expression already constrains a control property.
 *
 * Matched on a word boundary so `resolution` does not match a dimension merely containing it.
 *
 * @param filter - The expression to inspect.
 * @param name - The control property name.
 * @returns True when the property is already present.
 */
function mentionsControl(filter: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b\\s+eq\\b`, 'i').test(filter);
}
