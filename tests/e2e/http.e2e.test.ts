// End-to-end test over the Streamable HTTP transport, in-process via supertest. Verifies the
// health endpoint and an MCP `tools/list` round-trip. No Cloud ALM network calls are made.

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { buildMcpServer, createClients } from '../../src/server.js';
import { createHttpApp } from '../../src/transport/http.js';

function makeApp() {
  const config = new Config({
    sandbox: true,
    apiKey: 'dummy',
    debug: false,
    timeoutSeconds: 30,
    tokenRefreshBufferSeconds: 5,
  });
  const logger = createLogger(false);
  const clients = createClients(config, logger);
  return createHttpApp({
    buildServer: () => buildMcpServer(clients, logger),
    corsOrigins: '*',
    rateLimitPerMinute: 1000,
    logger,
  });
}

/** Extract the JSON payload from a Streamable HTTP SSE response body. */
function parseSse(body: string): unknown {
  const line = body.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line?.slice('data:'.length).trim() ?? 'null');
}

describe('http e2e', () => {
  it('serves the health check', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('handles an MCP tools/list request', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    const payload = parseSse(res.text) as { result: { tools: { name: string }[] } };
    const names = payload.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['calm_analytics', 'calm_get', 'calm_list', 'calm_resources']);
  });

  it('rejects GET /mcp in stateless mode', async () => {
    const res = await request(makeApp()).get('/mcp');
    expect(res.status).toBe(405);
  });
});
