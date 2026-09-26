// Input and output hardening: OData literal quoting, path-segment ids, filter precedence, tenant
// validation, write URLs, prototype-safe topic lookup, upstream error summaries, and server-driven
// OData paging.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { odataString } from '../../src/calm/odata.js';
import { Config } from '../../src/config.js';
import { ConfigError, summarizeBody } from '../../src/errors.js';
import { mergeAnalyticsFilter } from '../../src/tools/analyticsFilter.js';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { documentCreateSchema, xlibApplicationCreateSchema } from '../../src/tools/create.js';
import { fetchAllOData, PAGE_SIZE } from '../../src/tools/paging.js';
import { calmGetShape, calmListShape } from '../../src/tools/schemas.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const FEATURES = '/api/calm-features/v1/Features';

describe('OData string literals', () => {
  it('doubles embedded quotes', () => {
    expect(odataString("x' or true or displayId eq '")).toBe("'x'' or true or displayId eq '''");
  });
});

describe('analytics filter merging', () => {
  it('parenthesises the caller expression so an `or` cannot swallow the controls', () => {
    expect(mergeAnalyticsFilter("a eq '1' or b eq '2'", { period: 'C1D' })).toBe(
      "(a eq '1' or b eq '2') and period eq 'C1D'",
    );
  });
});

describe('path-segment ids', () => {
  it.each(['.', '..', ''])('rejects %j', (id) => {
    expect(calmGetShape.id.safeParse(id).success).toBe(false);
    expect(calmListShape.task_id.safeParse(id).success).toBe(false);
  });

  it('accepts ordinary ids, including ones with dots inside', () => {
    expect(calmGetShape.id.safeParse('6-123').success).toBe(true);
    expect(calmGetShape.id.safeParse('a.b').success).toBe(true);
  });
});

describe('tenant validation', () => {
  const env = {
    CALM_TENANT: 'evil.com/x#',
    CALM_REGION: 'eu10',
    CALM_CLIENT_ID: 'id',
    CALM_CLIENT_SECRET: 'secret',
  } as NodeJS.ProcessEnv;

  it('rejects anything beyond a DNS label', () => {
    expect(() => Config.fromEnv(env)).toThrow(ConfigError);
  });

  it('accepts a plain subdomain', () => {
    expect(() => Config.fromEnv({ ...env, CALM_TENANT: 'acme-dev' })).not.toThrow();
  });
});

describe('write payload URLs', () => {
  const projectId = '11111111-1111-1111-1111-111111111111';

  it('rejects javascript: links', () => {
    const result = documentCreateSchema.safeParse({
      title: 't',
      projectId,
      toURLReferences: [{ name: 'x', url: 'javascript:alert(1)' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-http object URL on a library entry', () => {
    expect(
      xlibApplicationCreateSchema.safeParse({ title: 't', url: 'data:text/html,hi' }).success,
    ).toBe(false);
  });

  it('accepts https links', () => {
    const result = documentCreateSchema.safeParse({
      title: 't',
      projectId,
      toURLReferences: [{ name: 'x', url: 'https://example.com/a' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('calm_resources topic lookup', () => {
  it('treats prototype names as unknown topics', async () => {
    const body = parse(await handleCalmResources({ topic: 'constructor' })) as object;
    expect(body).toHaveProperty('listResources');
  });
});

describe('upstream error summaries', () => {
  it('strips HTML and caps the length', () => {
    const page = `<html><head><style>p{}</style></head><body><h1>502 Bad Gateway</h1>${'x'.repeat(
      2000,
    )}</body></html>`;
    const text = summarizeBody(page);
    expect(text.startsWith('502 Bad Gateway')).toBe(true);
    expect(text).not.toContain('<');
    expect(text.length).toBeLessThan(520);
  });
});

describe('network-backed hardening', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('quotes a feature display id inside the lookup filter', async () => {
    const hostile = "x' or true or displayId eq '";
    agent
      .get(ORIGIN)
      .intercept({
        path: `${FEATURES}?$filter=${encodeURIComponent(`displayId eq ${odataString(hostile)}`)}&$top=1`,
      })
      .reply(200, { value: [] });
    const result = await handleCalmGet(makeClients(), { resource: 'feature', id: hostile });
    expect(result.content[0]?.text).toContain('No feature found');
  });

  it('keeps paging past a short page when the service announces a next link', async () => {
    const rows = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ uuid: `f${from + i}` }));
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: `${FEATURES}?$top=${PAGE_SIZE}&$skip=0` })
      .reply(200, { value: rows(100, 0), '@odata.nextLink': 'Features?$skiptoken=100' });
    pool
      .intercept({ path: `${FEATURES}?$top=${PAGE_SIZE}&$skip=100` })
      .reply(200, { value: rows(30, 100) });

    const fetched = await fetchAllOData(makeClients(), 'features', 'Features', {});
    expect(fetched.records).toHaveLength(130);
    expect(fetched.complete).toBe(true);
    expect(fetched.pages).toBe(2);
  });
});
