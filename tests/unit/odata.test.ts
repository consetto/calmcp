import { describe, expect, it } from 'vitest';
import { buildODataQueryString, buildQueryString } from '../../src/calm/odata.js';

describe('buildODataQueryString', () => {
  it('returns empty string for no options', () => {
    expect(buildODataQueryString({})).toBe('');
  });

  it('encodes spaces in a filter expression', () => {
    const result = buildODataQueryString({ filter: "name eq 'test'" });
    expect(result.startsWith('?$filter=')).toBe(true);
    // encodeURIComponent encodes spaces (%20) but leaves URL-valid single quotes literal.
    expect(result).toBe("?$filter=name%20eq%20'test'");
  });

  it('emits select and expand', () => {
    expect(buildODataQueryString({ select: 'id,title' })).toBe('?$select=id%2Ctitle');
    expect(buildODataQueryString({ expand: 'toProject,toStatus' })).toBe(
      '?$expand=toProject%2CtoStatus',
    );
  });

  it('emits orderby with direction', () => {
    expect(buildODataQueryString({ orderby: 'modifiedAt desc' })).toBe(
      '?$orderby=modifiedAt%20desc',
    );
  });

  it('combines pagination params', () => {
    expect(buildODataQueryString({ top: 10, skip: 20 })).toBe('?$top=10&$skip=20');
  });

  it('emits count and search', () => {
    expect(buildODataQueryString({ count: true })).toBe('?$count=true');
    expect(buildODataQueryString({ search: 'defect' })).toBe('?$search=defect');
  });

  it('combines multiple options in order', () => {
    const result = buildODataQueryString({
      filter: "projectId eq 'abc'",
      select: 'id,title',
      orderby: 'modifiedAt desc',
      top: 50,
    });
    expect(result).toContain('$filter=');
    expect(result).toContain('$select=id%2Ctitle');
    expect(result).toContain('$orderby=modifiedAt%20desc');
    expect(result).toContain('$top=50');
  });
});

describe('buildQueryString (REST)', () => {
  it('skips undefined and null', () => {
    expect(buildQueryString({ a: undefined, b: null, c: 'x' })).toBe('?c=x');
  });

  it('emits arrays as repeated keys', () => {
    expect(buildQueryString({ tags: ['a', 'b'] })).toBe('?tags=a&tags=b');
  });

  it('encodes values', () => {
    expect(buildQueryString({ type: 'CALMDEF', status: 'CIPDFCTOPEN' })).toBe(
      '?type=CALMDEF&status=CIPDFCTOPEN',
    );
  });

  it('returns empty string when nothing is set', () => {
    expect(buildQueryString({ a: undefined })).toBe('');
  });
});
