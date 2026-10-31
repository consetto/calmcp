// HTTP-transport auth wiring tests.
//
// The auth primitives (DCR client store, OAuth-state codec, redirect-uri validation, API-key /
// XSUAA verifiers) now live in `@arc-mcp/xsuaa-auth` and are tested in that package. These tests
// cover calmcp's OWN transport wiring — that `setupHttpAuth` is composed correctly onto `/mcp`:
// /health stays open, /mcp rejects missing/invalid bearer tokens, the OAuth discovery metadata is
// served only when XSUAA is configured, and a valid API key reaches the MCP handler.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { buildMcpServer, createClients } from '../../src/server.js';
import { createHttpApp, parseCorsOrigins } from '../../src/transport/http.js';
import { redirectPatterns } from '../../src/transport/redirects.js';

const logger = pino({ level: 'silent' });

describe('createHttpApp with XSUAA auth', () => {
  const credentials = {
    url: 'https://example.authentication.eu10.hana.ondemand.com',
    clientid: 'sb-calmcp!t1',
    clientsecret: 'xsuaa-secret',
    xsappname: 'calmcp!t1',
    uaadomain: 'authentication.eu10.hana.ondemand.com',
  };
  const app = createHttpApp({
    buildServer: () => undefined as unknown as McpServer, // never invoked on the 401 path
    corsOrigins: false,
    rateLimitPerMinute: 100,
    logger,
    auth: {
      xsuaa: {
        credentials,
        appUrl: 'https://calmcp.example.hana.ondemand.com',
        clientIdPrefix: 'calmcp-',
        scopesSupported: ['Viewer'],
        requiredScopes: ['Viewer'],
        resourceName: 'calmcp (SAP Cloud ALM MCP Server)',
      },
    },
  });

  it('leaves /health unauthenticated', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('rejects POST /mcp without a bearer token (401)', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('serves OAuth authorization-server discovery metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('authorization_endpoint');
    expect(res.body).toHaveProperty('registration_endpoint'); // DCR advertised
  });
});

describe('createHttpApp without auth (local dev)', () => {
  it('does not mount OAuth discovery when no method is configured', async () => {
    const app = createHttpApp({
      buildServer: () => undefined as unknown as McpServer,
      corsOrigins: false,
      rateLimitPerMinute: 100,
      logger,
    });
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });
});

describe('createHttpApp with API-key auth', () => {
  const config = Config.fromEnv({ CALM_SANDBOX: 'true', CALM_API_KEY: 'x' } as NodeJS.ProcessEnv);
  const clients = createClients(config, logger);
  const app = createHttpApp({
    buildServer: () => buildMcpServer(clients, logger),
    corsOrigins: false,
    rateLimitPerMinute: 100,
    logger,
    auth: { apiKeys: [{ key: 'super-secret-key', scopes: ['Viewer'] }] },
  });

  it('answers a body that is not JSON with a JSON-RPC parse error, not a stack trace', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(res.text).not.toMatch(/node_modules|SyntaxError|at /);
  });

  it('rejects POST /mcp without a key (401)', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('rejects POST /mcp with a wrong key (401)', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer nope')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('accepts POST /mcp with the correct key', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer super-secret-key')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      });
    expect(res.status).toBe(200);
  });

  it('does not mount OAuth discovery when only an API key is configured', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });
});

describe('createHttpApp fail-closed and loopback options', () => {
  it('refuses to start when auth is required but no method is configured', () => {
    expect(() =>
      createHttpApp({
        buildServer: () => undefined as unknown as McpServer,
        corsOrigins: false,
        rateLimitPerMinute: 100,
        logger,
        requireAuth: true,
      }),
    ).toThrow(/no authentication method/);
  });

  it('rejects a non-loopback Host header on a local open endpoint (DNS rebinding)', async () => {
    const app = createHttpApp({
      buildServer: () => undefined as unknown as McpServer,
      corsOrigins: false,
      rateLimitPerMinute: 100,
      logger,
      localOnly: true,
    });
    const res = await request(app)
      .post('/mcp')
      .set('Host', 'attacker.example')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(403);
  });
});

describe('calm_create is offered only to callers with the Writer scope', () => {
  const config = Config.fromEnv({
    CALM_SANDBOX: 'true',
    CALM_API_KEY: 'x',
    CALM_WRITE_ENABLED: 'true',
  } as NodeJS.ProcessEnv);
  const clients = createClients(config, logger);
  const app = createHttpApp({
    buildServer: (authInfo) => buildMcpServer(clients, logger, authInfo),
    corsOrigins: false,
    rateLimitPerMinute: 100,
    logger,
    auth: {
      apiKeys: [
        { key: 'viewer-key', scopes: ['Viewer'] },
        { key: 'writer-key', scopes: ['Viewer', 'Writer'] },
      ],
    },
  });

  /** List the tool names the given key sees. */
  async function toolNames(key: string): Promise<string[]> {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${key}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const line = res.text.split('\n').find((l) => l.startsWith('data:')) ?? 'data: null';
    const body = JSON.parse(line.slice('data:'.length)) as {
      result: { tools: { name: string }[] };
    };
    return body.result.tools.map((t) => t.name);
  }

  it('hides calm_create from a Viewer', async () => {
    expect(await toolNames('viewer-key')).not.toContain('calm_create');
  });

  it('offers calm_create to a Writer', async () => {
    expect(await toolNames('writer-key')).toContain('calm_create');
  });
});

describe('CORS origins', () => {
  it('sends no CORS headers when none are configured', () => {
    expect(parseCorsOrigins(undefined)).toBe(false);
    expect(parseCorsOrigins(' , ')).toBe(false);
  });

  it('accepts exact origins', () => {
    expect(parseCorsOrigins('http://localhost:6274, https://client.example.com')).toEqual([
      'http://localhost:6274',
      'https://client.example.com',
    ]);
  });

  it('refuses a wildcard, alone or in a list', () => {
    expect(() => parseCorsOrigins('*')).toThrow(/wildcard/);
    expect(() => parseCorsOrigins('https://a.example.com, *')).toThrow(/wildcard/);
    expect(() => parseCorsOrigins('https://*.example.com')).toThrow(/wildcard/);
  });

  it('refuses an entry that is not an origin', () => {
    expect(() => parseCorsOrigins('https://client.example.com/')).toThrow(/not an origin/);
    expect(() => parseCorsOrigins('client.example.com')).toThrow(/not an origin/);
  });

  it('answers a listed origin and no other', async () => {
    const app = createHttpApp({
      buildServer: () => undefined as unknown as McpServer,
      corsOrigins: ['https://client.example.com'],
      rateLimitPerMinute: 100,
      logger,
    });
    const allowed = await request(app).get('/health').set('Origin', 'https://client.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://client.example.com');
    const other = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends no CORS header by default, so a browser cannot read /mcp cross-origin', async () => {
    const app = createHttpApp({
      buildServer: () => undefined as unknown as McpServer,
      corsOrigins: false,
      rateLimitPerMinute: 100,
      logger,
    });
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OAuth redirect URIs', () => {
  const app = createHttpApp({
    buildServer: () => undefined as unknown as McpServer,
    corsOrigins: false,
    rateLimitPerMinute: 100,
    logger,
    auth: {
      xsuaa: {
        credentials: {
          url: 'https://example.authentication.eu10.hana.ondemand.com',
          clientid: 'sb-calmcp!t1',
          clientsecret: 'xsuaa-secret',
          xsappname: 'calmcp!t1',
          uaadomain: 'authentication.eu10.hana.ondemand.com',
        },
        appUrl: 'https://calmcp.example.hana.ondemand.com',
        clientIdPrefix: 'calmcp-',
        scopesSupported: ['Viewer'],
        requiredScopes: ['Viewer'],
        redirectUriPatterns: redirectPatterns({}),
        dcrRedirectUriPatterns: redirectPatterns({}),
      },
    },
  });
  const register = (uri: string) =>
    request(app)
      .post('/register')
      .send({ redirect_uris: [uri], client_name: 'test', token_endpoint_auth_method: 'none' });

  it('refuses a client registering a redirect to some other https host', async () => {
    // Another BTP app included: the package default would accept it.
    for (const uri of [
      'https://evil.example/cb',
      'https://other.cfapps.eu10.hana.ondemand.com/cb',
    ]) {
      expect((await register(uri)).status).toBe(400);
    }
  });

  it('registers the known MCP clients', async () => {
    for (const uri of [
      'http://localhost:6274/oauth/callback',
      'https://claude.ai/api/mcp/auth_callback',
    ]) {
      expect((await register(uri)).status).toBe(201);
    }
  });

  it('adds the operator patterns', () => {
    expect(
      redirectPatterns({ CALM_OAUTH_REDIRECT_PATTERNS: ' https://my.example/cb , ' }),
    ).toContain('https://my.example/cb');
  });
});
