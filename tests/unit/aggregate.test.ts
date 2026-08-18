import { describe, expect, it } from 'vitest';
import { createGroupTally, groupRecords, NO_VALUE } from '../../src/tools/aggregate.js';
import { ShapeError } from '../../src/tools/shape.js';

const tasks = [
  { status: 'CIPUSOPEN', team: 'A' },
  { status: 'CIPUSOPEN', team: 'B' },
  { status: 'CIPUSCLOSE', team: 'A' },
  { status: 'CIPUSOPEN', team: 'A' },
];

describe('groupRecords', () => {
  it('tallies a single key, ordered by descending count', () => {
    const tally = groupRecords(tasks, ['status']);
    expect(tally.groupBy).toEqual(['status']);
    expect(tally.total).toBe(4);
    expect(tally.groups).toEqual([
      { value: 'CIPUSOPEN', count: 3 },
      { value: 'CIPUSCLOSE', count: 1 },
    ]);
  });

  it('breaks a tie on the value, ascending', () => {
    const tally = groupRecords([{ s: 'b' }, { s: 'a' }], ['s']);
    expect(tally.groups.map((g) => g.value)).toEqual(['a', 'b']);
  });

  it('buckets null, undefined and blank values together', () => {
    const tally = groupRecords(
      [{ team: null }, { team: undefined }, { team: '  ' }, { team: 'A' }],
      ['team'],
    );
    expect(tally.groups).toEqual([
      { value: NO_VALUE, count: 3 },
      { value: 'A', count: 1 },
    ]);
  });

  it('emits keyed values when grouping by several fields', () => {
    const tally = groupRecords(tasks, ['status', 'team']);
    expect(tally.total).toBe(4);
    expect(tally.groups[0]).toEqual({ values: { status: 'CIPUSOPEN', team: 'A' }, count: 2 });
  });

  it('keeps total equal to the record count regardless of grouping', () => {
    expect(groupRecords(tasks, ['status']).total).toBe(tasks.length);
    expect(groupRecords(tasks, ['status', 'team']).total).toBe(tasks.length);
  });

  it('folds the tail into otherCount rather than dropping it', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}` }));
    const tally = groupRecords(records, ['id'], 3);
    expect(tally.groups).toHaveLength(3);
    expect(tally.groupsOmitted).toBe(7);
    expect(tally.otherCount).toBe(7);
    const kept = tally.groups.reduce((sum, g) => sum + g.count, 0);
    expect(kept + (tally.otherCount ?? 0)).toBe(tally.total);
  });

  it('rejects a field that exists on no record, listing the real ones', () => {
    expect(() => groupRecords(tasks, ['nope'])).toThrow(ShapeError);
    try {
      groupRecords(tasks, ['nope']);
    } catch (error) {
      expect((error as Error).message).toContain('status');
      expect((error as Error).message).toContain('team');
    }
  });

  it('rejects an empty key list', () => {
    expect(() => groupRecords(tasks, [])).toThrow(ShapeError);
  });

  it('returns an empty tally for no records', () => {
    const tally = groupRecords([], ['status']);
    expect(tally.total).toBe(0);
    expect(tally.groups).toEqual([]);
  });

  it('does not let a value containing the display separator forge a group', () => {
    const tally = groupRecords([{ a: 'x,y', b: 'z' }], ['a', 'b']);
    expect(tally.groups[0]).toEqual({ values: { a: 'x,y', b: 'z' }, count: 1 });
  });
});

describe('createGroupTally', () => {
  it('adds up across pages exactly as the one-shot form does', () => {
    const tally = createGroupTally(['status']);
    tally.add(tasks.slice(0, 2));
    tally.add(tasks.slice(2));
    expect(tally.result()).toEqual(groupRecords(tasks, ['status']));
  });

  it('validates the keys on the first non-empty page', () => {
    const tally = createGroupTally(['nope']);
    expect(() => tally.add([])).not.toThrow();
    expect(() => tally.add(tasks)).toThrow(ShapeError);
  });
});
