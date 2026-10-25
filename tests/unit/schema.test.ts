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
//
// Patterns: some model APIs validate every `pattern` against a regex subset with no lookaround or
// backreferences (OpenAI's strict tool schemas reject the tool list with "regex lookaround is not
// supported"). Zod copies a `.regex()` verbatim into `pattern`, so the check runs on the output.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../../src/server.js';
import { makeClients } from './helpers.js';

/** Serialized `tools/list` bytes allowed, read-only and with calm_create. */
const BUDGET = { readOnly: 14_000, withWrite: 16_000 };

/**
 * Regex constructs outside the subset model APIs accept in `pattern`: lookahead and lookbehind
 * (`(?=`, `(?!`, `(?<=`, `(?<!`), named groups (`(?<x>`), backreferences (`\\1`, `\\k<x>`) and
 * inline flags (`(?i)`). `(?:` non-capturing groups are portable and pass.
 */
const UNSUPPORTED_REGEX = /\(\?[=!<]|\(\?[a-z]+[-:)]|\\[1-9]|\\k</;

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

async function connect(writeEnabled: boolean) {
  const server = buildMcpServer(makeClients({ writeEnabled }), pino({ level: 'silent' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listTools(writeEnabled: boolean) {
  return (await (await connect(writeEnabled)).listTools()).tools;
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
      if (key === 'pattern' && typeof value === 'string' && UNSUPPORTED_REGEX.test(value))
        problems.push(`${path}.pattern: regex construct outside the portable subset`);
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
        id: { type: 'string', pattern: '^(?!\\.\\.?$).+$' },
        url: { type: 'string', pattern: '^https?://\\S+$' },
      },
    };
    expect(incompatibilities(schema, 't')).toEqual([
      't.properties.not.type: array of types',
      't.properties.pick.anyOf: forbidden keyword',
      't.properties.id.pattern: regex construct outside the portable subset',
    ]);
  });

  it.each([
    ['lookahead', '(?=a)'],
    ['negative lookahead', '^(?!\\.\\.?$).+$'],
    ['lookbehind', '(?<=a)b'],
    ['negative lookbehind', '(?<!a)b'],
    ['backreference', '(a)\\1'],
    ['named backreference', '(?<x>a)\\k<x>'],
    ['inline flag', '(?i)abc'],
  ])('flags a pattern with a %s', (_label, pattern) => {
    expect(UNSUPPORTED_REGEX.test(pattern)).toBe(true);
  });

  it.each(['^[0-9a-f]{32}$', '^(?:a|b)+$', '^https?://\\S+$', '^\\d+-\\d+$'])(
    'accepts the portable pattern %j',
    (pattern) => {
      expect(UNSUPPORTED_REGEX.test(pattern)).toBe(false);
    },
  );

  for (const writeEnabled of [false, true]) {
    const label = writeEnabled ? 'with calm_create' : 'read-only';

    it(`use only widely supported JSON Schema (${label})`, async () => {
      const tools = await listTools(writeEnabled);
      const problems = tools.flatMap((tool) => incompatibilities(tool.inputSchema, tool.name));
      expect(problems).toEqual([]);
    });

    it(`reject parameters outside the schema (${label})`, async () => {
      const tools = await listTools(writeEnabled);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }
    });

    it(`stay within the size budget (${label})`, async () => {
      const bytes = JSON.stringify(await listTools(writeEnabled)).length;
      expect(bytes).toBeLessThan(writeEnabled ? BUDGET.withWrite : BUDGET.readOnly);
    });
  }

  it('names an invented parameter instead of dropping it', async () => {
    const client = await connect(false);
    const result = await client.callTool({
      name: 'calm_list',
      arguments: { resource: 'tasks', projectId: 'p' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('projectId');
  });
});
