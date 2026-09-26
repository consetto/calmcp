// Drift guard: every analytics field that a recipe, a provider description or the calm_analytics
// tool description tells a client to use must exist in the transcribed catalogue. Descriptions are
// prose, so nothing else would notice when one names a field the service does not have (as the
// calm_analytics description once did with `type` instead of `typeID`).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../../src/server.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { ANALYTICS_PROVIDER_FIELDS, RECIPES } from '../../src/tools/constants.js';
import { makeClients, parse } from './helpers.js';

/** Fields a provider accepts in `$filter` or returns as a dimension. */
function knownFields(provider: string): string[] {
  const fields = ANALYTICS_PROVIDER_FIELDS[provider];
  return fields ? [...fields.filterable, ...fields.dimensions] : [];
}

/** Every `calm_analytics({ provider: 'P', ... })` call in a text, with the fields it names. */
function analyticsCalls(text: string): { provider: string; fields: string[] }[] {
  const calls = text.matchAll(/calm_analytics\(\{ provider: '(\w+)'([^)]*)\)/g);
  return [...calls].map(([, provider = '', rest = '']) => ({
    provider,
    fields: [
      ...[...rest.matchAll(/group_by: '([\w,]+)'/g)].flatMap(([, list = '']) => list.split(',')),
      ...[...rest.matchAll(/(\w+) eq /g)].map(([, field = '']) => field),
    ],
  }));
}

describe('analytics field names in prose', () => {
  it('recipes only name catalogued fields', () => {
    const text = RECIPES.flatMap((recipe) => [recipe.question, ...recipe.steps]).join(' ');
    const calls = analyticsCalls(text);
    expect(calls.length).toBeGreaterThan(0);
    for (const { provider, fields } of calls) {
      if (!ANALYTICS_PROVIDER_FIELDS[provider]) continue;
      for (const field of fields) expect(knownFields(provider), provider).toContain(field);
    }
  });

  it('provider breakdown examples group by a field the provider has', () => {
    for (const provider of Object.keys(ANALYTICS_PROVIDER_FIELDS)) {
      const described = parse(handleCalmResources({ topic: provider })) as {
        breakdownExample: string;
      };
      for (const { fields } of analyticsCalls(described.breakdownExample)) {
        for (const field of fields) expect(knownFields(provider), provider).toContain(field);
      }
    }
  });

  it('the calm_analytics description filters Tasks by a field the service honours', async () => {
    const server = buildMcpServer(makeClients(), pino({ level: 'silent' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'calm_analytics')?.description ?? '';
    const filtered = [...description.matchAll(/filter="(\w+) eq /g)].map(([, field]) => field);
    expect(filtered.length).toBeGreaterThan(0);
    for (const field of filtered) expect(knownFields('Tasks')).toContain(field);
    // `type` is listed as filterable by the spec but silently ignored by the service.
    expect(filtered).not.toContain('type');
  });
});
