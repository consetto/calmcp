import { afterEach, describe, expect, it } from 'vitest';
import {
  configureResults,
  errorResult,
  jsonResult,
  responseBudget,
} from '../../src/tools/result.js';

const DEFAULT_BUDGET = responseBudget();

/** A record wide enough that a few hundred of them blow any sensible budget. */
function wideTask(index: number): Record<string, unknown> {
  const task: Record<string, unknown> = { displayId: `6-${index}`, title: 'x'.repeat(200) };
  for (let field = 0; field < 30; field += 1) task[`attribute${field}`] = 'y'.repeat(40);
  return task;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? '';
}

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

afterEach(() => {
  configureResults({ maxBytes: DEFAULT_BUDGET });
});

describe('jsonResult under budget', () => {
  it('returns the payload verbatim as pretty-printed JSON', () => {
    const data = { value: [{ a: 1 }] };
    expect(textOf(jsonResult(data))).toBe(JSON.stringify(data, null, 2));
  });

  it('is not flagged as an error', () => {
    expect(jsonResult({ ok: true }).isError).toBeFalsy();
  });
});

describe('jsonResult over budget', () => {
  it('withholds an oversized OData envelope and says what it held back', () => {
    configureResults({ maxBytes: 2000 });
    const records = Array.from({ length: 50 }, (_, i) => wideTask(i));
    const result = jsonResult({ '@count': 50, value: records });

    expect(result.isError).toBeFalsy();
    const summary = parse(result);
    expect(summary.complete).toBe(false);
    expect(summary.reason).toBe('RESPONSE_TOO_LARGE');
    expect(summary.recordsInResponse).toBe(50);
    expect(summary.budgetBytes).toBe(2000);
    expect(summary.bytes as number).toBeGreaterThan(2000);
    expect(summary.availableFields).toContain('displayId');
    expect(summary.hint).toContain('count_only');
    expect(summary.hint).toContain('group_by');
    // The record count must never read as an answer to "how many are there?": the endpoint may
    // have paged the result, and a caller quoting it would be reporting a floor as a total.
    expect(summary.recordsAreATotal).toBe(false);
    expect(summary.message).toContain('not a total');
  });

  it('does the same for a bare REST array', () => {
    configureResults({ maxBytes: 2000 });
    const result = jsonResult(Array.from({ length: 50 }, (_, i) => wideTask(i)));
    const summary = parse(result);
    expect(summary.complete).toBe(false);
    expect(summary.recordsInResponse).toBe(50);
  });

  it('includes no sample records, so the model cannot answer from a fragment', () => {
    configureResults({ maxBytes: 2000 });
    const text = textOf(jsonResult(Array.from({ length: 50 }, (_, i) => wideTask(i))));
    expect(text).not.toContain('6-1');
    expect(text).not.toContain('yyyy');
  });

  it('stays small itself even for very wide records', () => {
    configureResults({ maxBytes: 2000 });
    const records = Array.from({ length: 200 }, (_, i) => wideTask(i));
    const text = textOf(jsonResult(records));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);
  });

  it('omits record details for a payload that is not a collection', () => {
    configureResults({ maxBytes: 100 });
    const summary = parse(jsonResult('z'.repeat(500)));
    expect(summary.complete).toBe(false);
    expect(summary.recordsInResponse).toBeUndefined();
    expect(summary.availableFields).toBeUndefined();
  });
});

describe('configureResults', () => {
  it('applies the configured budget', () => {
    configureResults({ maxBytes: 1234 });
    expect(responseBudget()).toBe(1234);
  });

  it('ignores a non-positive or non-finite budget rather than disabling the guard', () => {
    configureResults({ maxBytes: 1234 });
    configureResults({ maxBytes: 0 });
    configureResults({ maxBytes: Number.NaN });
    expect(responseBudget()).toBe(1234);
  });
});

describe('errorResult', () => {
  it('flags the result and passes the message through', () => {
    const result = errorResult('boom');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('boom');
  });
});
