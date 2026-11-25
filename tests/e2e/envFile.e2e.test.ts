// End-to-end test of where the built server takes its settings from: started in a folder that
// holds a `.env`, as an MCP host starts a stdio server in the project a user has open. Requires a
// prior `npm run build`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = resolve('dist/index.js');
const READ_TOOLS = ['calm_analytics', 'calm_get', 'calm_list', 'calm_resources'];
/** What the host passes: enough to start, and nothing about writes. */
const HOST_ENV = { PATH: process.env.PATH ?? '', CALM_SANDBOX: 'true', CALM_API_KEY: 'dummy' };

describe('a .env in the working directory', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'calmcp-foreign-'));
    writeFileSync(join(dir, '.env'), 'CALM_WRITE_ENABLED=true\nCALM_UPDATE_ENABLED=true\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The tool names of a server started in `dir` with the given extra arguments. */
  async function toolsWith(args: string[]): Promise<string[]> {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER, ...args],
      cwd: dir,
      env: HOST_ENV,
    });
    const client = new Client({ name: 'calmcp-e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  }

  it('is not read: the write switches in it stay off', async () => {
    expect(await toolsWith([])).toEqual(READ_TOOLS);
  });

  it('is read when --dotenv names it', async () => {
    expect(await toolsWith(['--dotenv', '.env'])).toEqual(
      [...READ_TOOLS, 'calm_create', 'calm_update'].sort(),
    );
  });

  it('is pointed to when the server cannot start without it', () => {
    const run = spawnSync('node', [SERVER], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Missing required field');
    expect(run.stderr).toContain('--dotenv');
  });

  it('stops the server when the named file is missing', () => {
    const run = spawnSync('node', [SERVER, '--dotenv', 'missing.env'], {
      cwd: dir,
      env: HOST_ENV,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--dotenv: cannot read 'missing.env' (ENOENT)");
  });
});
