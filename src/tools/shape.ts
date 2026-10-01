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
 * REST endpoints return a bare array; OData endpoints return a `{ value: [...] }` envelope; the
 * SCIM endpoints of the Landscape service return a ListResponse with the records under `Resources`.
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
  if (isRecord(data) && Array.isArray(data.Resources)) {
    const envelope = data;
    return {
      records: data.Resources.filter(isRecord),
      rebuild: (records) => ({ ...envelope, Resources: records }),
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
 * Names a caller commonly guesses for a field Cloud ALM spells differently. Only ever offered as a
 * suggestion, never applied silently: a silent rewrite would hide the caller's mistake.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  priority: ['priorityId'],
  approvalstatus: ['approvalState'],
  lastchanged: ['lastChangedTimestamp', 'modifiedAt'],
  lastchangedat: ['lastChangedTimestamp', 'modifiedAt'],
  modified: ['modifiedAt', 'lastChangedTimestamp'],
  created: ['createdAt', 'creationTimestamp'],
  sprint: ['timeboxId', 'timeboxName'],
  timebox: ['timeboxId', 'timeboxName'],
  type: ['typeID', 'type'],
  assignee: ['assigneeId', 'assigneeName'],
};

/**
 * The error text for field names that do not exist, with a "did you mean" hint for each name that
 * has a close match among the available ones.
 *
 * @param parameter - The tool parameter the names came from (`fields`, `group_by`).
 * @param unknown - The names that were not found.
 * @param available - The field names that do exist.
 * @returns The message.
 */
export function unknownFieldsMessage(
  parameter: string,
  unknown: string[],
  available: string[],
): string {
  const hints = unknown
    .map((name) => {
      const match = suggestField(name, available);
      return match ? `'${name}' → did you mean '${match}'?` : undefined;
    })
    .filter(Boolean);
  return (
    `Unknown field(s) in '${parameter}': ${unknown.join(', ')}. ` +
    (hints.length > 0 ? `${hints.join(' ')} ` : '') +
    `Available fields: ${available.join(', ')}`
  );
}

/** The closest available field to a mistyped name, or undefined when nothing is close. */
function suggestField(name: string, available: string[]): string | undefined {
  const lower = name.toLowerCase();
  const alias = FIELD_ALIASES[lower]?.find((candidate) => available.includes(candidate));
  if (alias) return alias;
  const caseOnly = available.find((field) => field.toLowerCase() === lower);
  if (caseOnly) return caseOnly;
  // `priority` → `priorityId`, `status` → `statusCode`: the guess is a prefix of the real name.
  const prefixed = available.filter((field) => field.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0];
  let best: string | undefined;
  let bestDistance = 3;
  for (const field of available) {
    const distance = editDistance(lower, field.toLowerCase());
    if (distance < bestDistance) {
      best = field;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance between two strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
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
    throw new ShapeError(unknownFieldsMessage('fields', unknown, available));
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

/** An entry of a list resolved by name: a timebox or a project. */
interface Named {
  id?: unknown;
  name?: unknown;
}

/**
 * A name as matched: Unicode-normalised, trimmed, runs of whitespace collapsed, case folded. Real
 * Cloud ALM names carry double spaces and umlauts ("Müller GmbH  - ERP"), and an agent passes the
 * name a user typed.
 */
function matchKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Every entry whose name matches `name` exactly (after {@link matchKey}). */
function byName(list: unknown, name: string): Named[] {
  const entries = Array.isArray(list) ? (list as Named[]) : [];
  const wanted = matchKey(name);
  return entries.filter(
    (entry) => typeof entry.name === 'string' && matchKey(entry.name) === wanted,
  );
}

/** The names of a list, sorted. */
function namesOf(list: unknown): string[] {
  return (Array.isArray(list) ? (list as Named[]) : [])
    .map((entry) => entry.name)
    .filter((value): value is string => typeof value === 'string')
    .sort();
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
  const matches = byName(timeboxes, name);
  if (matches.length === 1 && typeof matches[0]?.id === 'string') return matches[0].id;
  if (matches.length > 1) {
    throw new ShapeError(
      `Timebox name '${name}' is ambiguous (${matches.length} matches). Pass timebox_id instead.`,
    );
  }
  throw new ShapeError(
    `No timebox named '${name}' in this project. Known timeboxes: ${namesOf(timeboxes).join(', ')}`,
  );
}

/** Names listed in full when no project matches; a larger tenant gets suggestions instead. */
const MAX_LISTED_PROJECTS = 20;

/**
 * Resolve a project name to its id.
 *
 * Exact match after normalising case and whitespace, never a guess: an ambiguous name lists the
 * candidates with their ids, an unknown one suggests the names that contain it (or that it
 * contains), so the agent can ask the user rather than pick a project for them.
 *
 * @param projects - The projects, as `/projects` returns them.
 * @param name - The project name to resolve.
 * @returns The matching project id.
 * @throws {ShapeError} When the name matches no project, or more than one.
 */
export function resolveProjectName(projects: unknown, name: string): string {
  const matches = byName(projects, name);
  if (matches.length === 1 && typeof matches[0]?.id === 'string') return matches[0].id;
  if (matches.length > 1) {
    const candidates = matches.map((entry) => `'${String(entry.name)}' (${String(entry.id)})`);
    throw new ShapeError(
      `Project name '${name}' is ambiguous: ${candidates.join(', ')}. Pass project_id instead.`,
    );
  }

  const names = namesOf(projects);
  const wanted = matchKey(name);
  const similar = names.filter((candidate) => {
    const key = matchKey(candidate);
    return key.includes(wanted) || wanted.includes(key);
  });
  const hint =
    similar.length > 0
      ? `Did you mean: ${similar
          .slice(0, MAX_LISTED_PROJECTS)
          .map((n) => `'${n}'`)
          .join(', ')}?`
      : names.length <= MAX_LISTED_PROJECTS
        ? `Known projects: ${names.map((n) => `'${n}'`).join(', ')}.`
        : `calm_list({ resource: 'projects', fields: 'id,name' }) lists all ${names.length}.`;
  throw new ShapeError(`No project named '${name}'. ${hint} Names must match exactly.`);
}
