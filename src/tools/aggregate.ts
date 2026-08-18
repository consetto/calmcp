// Client-side group-by tally.
//
// Neither the Cloud ALM REST endpoints nor the Analytics OData service offers a grouped count that
// calmcp can rely on, so the tally is done here over records calmcp has already fetched. The point
// is the response size: a breakdown of a few hundred tasks by status is a few hundred bytes, while
// the records themselves are hundreds of KB.
//
// The tally is incremental ({@link createGroupTally}) so a caller paging through 20000 records can
// discard each page as it goes and never hold them all. {@link groupRecords} is the one-shot form
// over records already in hand.
//
// Strict in the same way as `shape.ts`: an unknown group-by field is an error listing the real
// field names, never an empty tally. A tally that silently grouped nothing would read to an LLM
// caller as "there are none", which is a confidently wrong answer.

import { collectFieldNames, type Record_, ShapeError } from './shape.js';

/** Bucket label for records whose group-by field is null, undefined or empty. */
export const NO_VALUE = '(none)';

/** Default cap on the number of groups returned. */
export const DEFAULT_GROUP_LIMIT = 50;

/**
 * Separator joining several field values into one map key. ASCII unit separator, which no Cloud
 * ALM attribute value contains, so a value holding a comma or a space cannot forge a collision.
 */
const KEY_SEPARATOR = '\u001f';

/** One bucket of a tally. */
export interface Group {
  /** The dimension value, when grouping by a single field. */
  value?: string;
  /** The dimension values keyed by field name, when grouping by several fields. */
  values?: Record<string, string>;
  count: number;
}

/** The result of a tally. */
export interface GroupTally {
  groupBy: string[];
  total: number;
  groups: Group[];
  /** Number of groups beyond `groupLimit`, present only when some were folded away. */
  groupsOmitted?: number;
  /** Combined count of the folded groups, present only when some were folded away. */
  otherCount?: number;
}

/** An incremental tally: feed it pages, then read the result. */
export interface GroupAccumulator {
  /**
   * Add a page of records.
   *
   * @throws {ShapeError} When a group-by key exists on none of the records seen so far. Validation
   *   happens on the first non-empty page, so a bad field name fails before the whole walk runs.
   */
  add(records: Record_[]): void;
  /** The tally so far. */
  result(): GroupTally;
}

/**
 * Start an incremental group-by tally.
 *
 * @param keys - The field name(s) to group by.
 * @param groupLimit - Maximum groups to return (default {@link DEFAULT_GROUP_LIMIT}). The tail is
 *   folded into `otherCount`/`groupsOmitted` rather than dropped.
 * @returns The accumulator.
 * @throws {ShapeError} When `keys` is empty.
 */
export function createGroupTally(
  keys: string[],
  groupLimit: number = DEFAULT_GROUP_LIMIT,
): GroupAccumulator {
  if (keys.length === 0) {
    throw new ShapeError("'group_by' needs at least one field name.");
  }

  const counts = new Map<string, number>();
  let total = 0;
  let validated = false;

  return {
    add(records: Record_[]): void {
      if (records.length === 0) return;
      if (!validated) {
        assertKnownKeys(records, keys);
        validated = true;
      }
      for (const record of records) {
        const composite = keys.map((key) => bucketOf(record[key])).join(KEY_SEPARATOR);
        counts.set(composite, (counts.get(composite) ?? 0) + 1);
      }
      total += records.length;
    },

    result(): GroupTally {
      const sorted = [...counts.entries()].sort(
        ([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey),
      );
      const kept = sorted.slice(0, groupLimit);
      const folded = sorted.slice(groupLimit);

      const tally: GroupTally = {
        groupBy: keys,
        total,
        groups: kept.map(([composite, count]) =>
          toGroup(keys, composite.split(KEY_SEPARATOR), count),
        ),
      };
      if (folded.length > 0) {
        tally.groupsOmitted = folded.length;
        tally.otherCount = folded.reduce((sum, [, count]) => sum + count, 0);
      }
      return tally;
    },
  };
}

/**
 * Tally records by the values of one or more fields, in one shot.
 *
 * Groups are ordered by descending count, then by value ascending so the order is stable for a tie.
 * Grouping by a single field yields `{ value, count }`; by several, `{ values, count }`.
 *
 * @param records - The records to tally.
 * @param keys - The field name(s) to group by.
 * @param groupLimit - Maximum groups to return (default {@link DEFAULT_GROUP_LIMIT}).
 * @returns The tally.
 * @throws {ShapeError} When `keys` is empty, or a key exists on none of the records.
 */
export function groupRecords(
  records: Record_[],
  keys: string[],
  groupLimit: number = DEFAULT_GROUP_LIMIT,
): GroupTally {
  const tally = createGroupTally(keys, groupLimit);
  tally.add(records);
  return tally.result();
}

/** Reject group-by keys that appear on none of the records. */
function assertKnownKeys(records: Record_[], keys: string[]): void {
  const available = collectFieldNames(records);
  const unknown = keys.filter((key) => !available.includes(key));
  if (unknown.length > 0) {
    throw new ShapeError(
      `Unknown field(s) in 'group_by': ${unknown.join(', ')}. ` +
        `Available fields: ${available.join(', ')}`,
    );
  }
}

/** Render one field value as its bucket label. */
function bucketOf(value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE;
  const text = String(value);
  return text.trim() === '' ? NO_VALUE : text;
}

/** Build a {@link Group}, flat for one key and keyed by field name for several. */
function toGroup(keys: string[], parts: string[], count: number): Group {
  if (keys.length === 1) {
    return { value: parts[0] ?? NO_VALUE, count };
  }
  const values: Record<string, string> = {};
  keys.forEach((key, index) => {
    values[key] = parts[index] ?? NO_VALUE;
  });
  return { values, count };
}
