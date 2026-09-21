import { describe, expect, it } from 'vitest';
import {
  locateRecords,
  parseFields,
  pickTimebox,
  projectFields,
  resolveTimeboxName,
  ShapeError,
} from '../../src/tools/shape.js';

describe('parseFields', () => {
  it('trims names and drops empty entries', () => {
    expect(parseFields(' displayId , title ,, ')).toEqual(['displayId', 'title']);
  });
});

describe('locateRecords', () => {
  it('unwraps a SCIM ListResponse and rebuilds it around new records', () => {
    const body = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        { id: 'g1', displayName: 'ACL_Admins' },
        { id: 'g2', displayName: 'ACL_Ops' },
      ],
    };
    const located = locateRecords(body);
    expect(located?.records).toEqual(body.Resources);
    expect(located?.rebuild([{ id: 'g1' }])).toEqual({
      schemas: body.schemas,
      totalResults: 2,
      Resources: [{ id: 'g1' }],
    });
  });

  it('still treats a single entity as one record', () => {
    expect(locateRecords({ id: 'x' })?.records).toEqual([{ id: 'x' }]);
  });
});

describe('projectFields', () => {
  const tasks = [
    { displayId: '3-1', title: 'One', status: 'CIPUSOPEN', customField1: null },
    { displayId: '3-2', title: 'Two', status: 'CIPUSOPEN', customField1: null },
  ];

  it('narrows a REST array and drops the unrequested fields', () => {
    expect(projectFields(tasks, 'displayId,title')).toEqual([
      { displayId: '3-1', title: 'One' },
      { displayId: '3-2', title: 'Two' },
    ]);
  });

  it('preserves the OData envelope while projecting value[]', () => {
    const collection = { '@odata.context': 'ctx', '@odata.count': 2, value: tasks };
    expect(projectFields(collection, 'displayId')).toEqual({
      '@odata.context': 'ctx',
      '@odata.count': 2,
      value: [{ displayId: '3-1' }, { displayId: '3-2' }],
    });
  });

  it('omits absent keys instead of emitting null', () => {
    const projected = projectFields([{ a: 1 }, { a: 2, b: 3 }], 'a,b') as Record<string, unknown>[];
    expect(projected[0]).toEqual({ a: 1 });
    expect('b' in (projected[0] ?? {})).toBe(false);
  });

  it('rejects an unknown field rather than returning empty objects', () => {
    expect(() => projectFields(tasks, 'displayId,sprint')).toThrow(ShapeError);
    expect(() => projectFields(tasks, 'displayId,sprint')).toThrow(/sprint/);
  });

  it('lists the available fields in the error', () => {
    expect(() => projectFields(tasks, 'nope')).toThrow(/customField1, displayId, status, title/);
  });

  it('leaves an empty result set untouched', () => {
    expect(projectFields([], 'anything')).toEqual([]);
  });

  it('is a no-op for an empty field list', () => {
    expect(projectFields(tasks, '  ')).toEqual(tasks);
  });
});

describe('pickTimebox', () => {
  it('keeps only the records of the given timebox', () => {
    const rows = [
      { id: 'a', timeboxId: 't1' },
      { id: 'b', timeboxId: 't2' },
      { id: 'c', timeboxId: null },
    ];
    expect(pickTimebox(rows, 't1')).toEqual([{ id: 'a', timeboxId: 't1' }]);
  });
});

describe('resolveTimeboxName', () => {
  const timeboxes = [
    { id: 't5', name: 'Sprint 5' },
    { id: 't6', name: 'Sprint 6' },
    { id: 'tp', name: 'Prepare' },
  ];

  it('resolves a name to its id', () => {
    expect(resolveTimeboxName(timeboxes, 'Sprint 5')).toBe('t5');
  });

  it('matches case-insensitively and tolerates surrounding whitespace', () => {
    expect(resolveTimeboxName(timeboxes, '  sprint 6 ')).toBe('t6');
  });

  it('errors with the known names when nothing matches', () => {
    expect(() => resolveTimeboxName(timeboxes, 'Sprint 99')).toThrow(
      /Known timeboxes: Prepare, Sprint 5, Sprint 6/,
    );
  });

  it('errors instead of guessing when a name is ambiguous', () => {
    const duplicated = [
      { id: 'a', name: 'Sprint 5' },
      { id: 'b', name: 'Sprint 5' },
    ];
    expect(() => resolveTimeboxName(duplicated, 'Sprint 5')).toThrow(/ambiguous/);
  });
});
