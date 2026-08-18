// Response shaping applied by calmcp *after* fetching from Cloud ALM.
//
// Two concerns live here, both driven by the same problem: the Tasks REST API returns every field
// of every record (67 per task, ~40 of them null in practice) and offers no timebox filter. A
// single "open user stories" call is therefore ~260 KB, which overflows the context window of
// agent hosts such as Microsoft Copilot Studio and makes the tool unusable there.
//
//   - `projectFields` — narrow each record to an explicit field list.
//   - `pickTimebox`   — select the records belonging to one timebox.
//
// `locateRecords` and `collectFieldNames` are the shared primitives underneath, reused by the
// response-size guard in `result.ts` and by the group-by tally in `aggregate.ts`.
//
// Both are deliberately strict: an unknown field name or an unknown timebox is reported as an
// error rather than silently yielding empty objects or an empty list. Silent filter drops are the
// worst failure mode for an LLM caller, because the answer looks authoritative and is wrong.

/** A generic JSON record returned by the Cloud ALM APIs. */
export type Record_ = Record<string, unknown>;

/** Raised when a requested field or timebox does not exist in the fetched data. */
export class ShapeError extends Error {}

/** Type guard for a plain (non-array, non-null) object. */
function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow an arbitrary response body to the object records it contains.
 *
 * @param data - The parsed response body (expected to be an array for REST list endpoints).
 * @returns The records, or an empty array when the body is not a list of objects.
 */
export function asRecords(data: unknown): Record_[] {
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

/**
 * Split a comma-separated field list into trimmed, non-empty names.
 *
 * @param fields - The raw `fields` argument.
 * @returns The parsed field names.
 */
export function parseFields(fields: string): string[] {
  return fields
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Locate the record array inside a Cloud ALM response.
 *
 * REST endpoints return a bare array; OData endpoints return a `{ value: [...] }` envelope.
 *
 * @param data - The parsed response body.
 * @returns The records plus a function rebuilding the original shape around new records.
 */
export function locateRecords(data: unknown): {
  records: Record_[];
  rebuild: (records: Record_[]) => unknown;
} | null {
  if (Array.isArray(data)) {
    return { records: data.filter(isRecord), rebuild: (records) => records };
  }
  if (isRecord(data) && Array.isArray(data.value)) {
    const envelope = data;
    return {
      records: data.value.filter(isRecord),
      rebuild: (records) => ({ ...envelope, value: records }),
    };
  }
  if (isRecord(data)) {
    return { records: [data], rebuild: (records) => records[0] ?? {} };
  }
  return null;
}

/**
 * Collect every key present on at least one record.
 *
 * Cloud ALM omits rather than nulls some attributes, so the union across records is the only
 * reliable field list. Used both to validate a projection and to tell a caller which field names
 * they could have asked for.
 *
 * @param records - The records to inspect.
 * @returns The field names, sorted.
 */
export function collectFieldNames(records: Record_[]): string[] {
  const available = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) available.add(key);
  }
  return [...available].sort();
}

/**
 * Narrow every record in a response to the requested fields.
 *
 * Keeps the surrounding shape intact: a bare array stays an array, an OData envelope keeps its
 * `@odata.*` annotations. Absent keys are simply omitted from a record rather than emitted as
 * `null`, which is what makes the projection worth doing.
 *
 * @param data - The parsed response body.
 * @param fields - Comma-separated field names to keep.
 * @returns The projected response body.
 * @throws {ShapeError} When a requested field exists on none of the returned records.
 */
export function projectFields(data: unknown, fields: string): unknown {
  const names = parseFields(fields);
  if (names.length === 0) return data;

  const located = locateRecords(data);
  if (!located) return data;
  const { records, rebuild } = located;
  // Nothing came back — there are no keys to validate against, so return the empty shape as is.
  if (records.length === 0) return data;

  const available = collectFieldNames(records);
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new ShapeError(
      `Unknown field(s) in 'fields': ${unknown.join(', ')}. ` +
        `Available fields: ${available.join(', ')}`,
    );
  }

  return rebuild(
    records.map((record) => {
      const projected: Record_ = {};
      for (const name of names) {
        if (name in record) projected[name] = record[name];
      }
      return projected;
    }),
  );
}

/**
 * Select the records assigned to one timebox.
 *
 * @param records - The records to filter (each may carry a `timeboxId`).
 * @param timeboxId - The timebox id to keep.
 * @returns The matching records.
 */
export function pickTimebox(records: Record_[], timeboxId: string): Record_[] {
  return records.filter((record) => record.timeboxId === timeboxId);
}

/** A timebox as returned by `/projects/{id}/timeboxes`. */
interface Timebox {
  id?: unknown;
  name?: unknown;
}

/**
 * Resolve a timebox name (e.g. "Sprint 5") to its id within a project.
 *
 * Matching is case-insensitive and whitespace-tolerant so an agent can pass the name a user typed.
 *
 * @param timeboxes - The project's timeboxes.
 * @param name - The timebox name to resolve.
 * @returns The matching timebox id.
 * @throws {ShapeError} When the name matches no timebox, or more than one.
 */
export function resolveTimeboxName(timeboxes: unknown, name: string): string {
  const list = Array.isArray(timeboxes) ? (timeboxes as Timebox[]) : [];
  const wanted = name.trim().toLowerCase();
  const matches = list.filter(
    (timebox) => typeof timebox.name === 'string' && timebox.name.trim().toLowerCase() === wanted,
  );

  if (matches.length === 1) {
    const id = matches[0]?.id;
    if (typeof id === 'string') return id;
  }
  if (matches.length > 1) {
    throw new ShapeError(
      `Timebox name '${name}' is ambiguous (${matches.length} matches). Pass timebox_id instead.`,
    );
  }

  const known = list
    .map((timebox) => timebox.name)
    .filter((value): value is string => typeof value === 'string')
    .sort();
  throw new ShapeError(
    `No timebox named '${name}' in this project. Known timeboxes: ${known.join(', ')}`,
  );
}
