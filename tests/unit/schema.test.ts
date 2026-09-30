// Tool-schema guard, run in CI with the unit tests.
//
// Compatibility: several MCP hosts (Microsoft Copilot Studio, Gemini, Azure AI) silently drop a
// whole server when one tool schema uses JSON Schema composition or nullable types. Zod produces
// those easily (`.nullable()`, `z.union`, a shared sub-schema turning into `$ref`), so the check is
// structural rather than left to review.
//
// Size: every tool schema is sent to the model on every turn. The budgets leave some headroom over
// today's size; raising one should be a deliberate decision, not a side effect.
//
// Strictness: every tool advertises `additionalProperties: false` and rejects a parameter outside
// its schema. Zod 4 stopped emitting that for a plain object, and a parameter the model invented
// (`projectId` for `project_id`) was then dropped without a word.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../../src/server.js';
import { makeClients } from './helpers.js';

/** The deployments whose tool lists differ, each with its serialized `tools/list` budget in bytes. */
const MODES = [
  { label: 'read-only', writeEnabled: false, updateEnabled: false, budget: 14_000 },
  { label: 'with calm_create', writeEnabled: true, updateEnabled: false, budget: 16_000 },
  {
    label: 'with calm_create and calm_update',
    writeEnabled: true,
    updateEnabled: true,
    budget: 18_500,
  },
];

type Access = { writeEnabled: boolean; updateEnabled?: boolean };

/** Keywords some hosts cannot handle anywhere in a tool schema. */
const FORBIDDEN_KEYS = [
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'nullable',
];

async function connect(access: Access) {
  const server = buildMcpServer(makeClients(access), pino({ level: 'silent' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listTools(access: Access) {
  return (await (await connect(access)).listTools()).tools;
}

/** Every problem found while walking a schema, as `path: reason`. */
function incompatibilities(node: unknown, path: string): string[] {
  if (Array.isArray(node))
    return node.flatMap((item, i) => incompatibilities(item, `${path}[${i}]`));
  if (typeof node !== 'object' || node === null) return [];
  const problems: string[] = [];
  // The keys of a `properties` object are field names, which may legitimately be called anything.
  const keysAreFieldNames = path.endsWith('.properties');
  for (const [key, value] of Object.entries(node)) {
    if (!keysAreFieldNames) {
      if (FORBIDDEN_KEYS.includes(key)) problems.push(`${path}.${key}: forbidden keyword`);
      if (key === 'type' && Array.isArray(value)) problems.push(`${path}.type: array of types`);
    }
    problems.push(...incompatibilities(value, `${path}.${key}`));
  }
  return problems;
}

describe('tool schemas', () => {
  it('detects the constructs it guards against', () => {
    const schema = {
      type: 'object',
      properties: {
        not: { type: ['string', 'null'] },
        pick: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    expect(incompatibilities(schema, 't')).toEqual([
      't.properties.not.type: array of types',
      't.properties.pick.anyOf: forbidden keyword',
    ]);
  });

  for (const { label, budget, ...access } of MODES) {
    it(`use only widely supported JSON Schema (${label})`, async () => {
      const tools = await listTools(access);
      const problems = tools.flatMap((tool) => incompatibilities(tool.inputSchema, tool.name));
      expect(problems).toEqual([]);
    });

    it(`reject parameters outside the schema (${label})`, async () => {
      const tools = await listTools(access);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }
    });

    it(`stay within the size budget (${label})`, async () => {
      const bytes = JSON.stringify(await listTools(access)).length;
      expect(bytes).toBeLessThan(budget);
    });
  }

  it('names an invented parameter instead of dropping it', async () => {
    const client = await connect({ writeEnabled: false });
    const result = await client.callTool({
      name: 'calm_list',
      arguments: { resource: 'tasks', projectId: 'p' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('projectId');
  });
});
