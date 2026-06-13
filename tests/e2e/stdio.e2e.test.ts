// End-to-end test over the stdio transport: spawns the built server as a child process and drives
// it with the official MCP client. Exercises `tools/list` and `calm_resources` (no Cloud ALM
// network calls needed). Requires a prior `npm run build`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('stdio e2e', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      // Sandbox config keeps startup credential validation happy; no API is actually called here.
      env: {
        PATH: process.env.PATH ?? '',
        CALM_SANDBOX: 'true',
        CALM_API_KEY: 'dummy',
      },
    });
    client = new Client({ name: 'calmcp-e2e', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('lists exactly the four read tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['calm_analytics', 'calm_get', 'calm_list', 'calm_resources']);
  });

  it('returns the discovery catalog from calm_resources', async () => {
    const result = await client.callTool({ name: 'calm_resources', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    const catalog = JSON.parse(content[0]?.text ?? 'null') as {
      analyticsProviders: string[];
      codeLists: { taskTypes: { code: string }[] };
    };
    expect(catalog.analyticsProviders).toContain('Defects');
    expect(catalog.codeLists.taskTypes.some((t) => t.code === 'CALMDEF')).toBe(true);
  });

  it('validates input and reports an error result for a bad resource', async () => {
    const result = await client.callTool({
      name: 'calm_list',
      arguments: { resource: 'does_not_exist' },
    });
    expect(result.isError).toBe(true);
  });
});
