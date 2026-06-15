import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { createApiKeyVerifier } from '../../src/httpAuth/apiKey.js';
import {
  matchesXsuaaRedirectPattern,
  StatelessDcrClientStore,
  validateRedirectUri,
} from '../../src/httpAuth/dcrClientStore.js';
import { OAuthStateCodec } from '../../src/httpAuth/oauthState.js';
import { getAppUrl } from '../../src/httpAuth/xsuaa.js';
import { buildMcpServer, createClients } from '../../src/server.js';
import { createHttpApp } from '../../src/transport/http.js';

const logger = pino({ level: 'silent' });
const SECRET = 'test-signing-secret-at-least-16-bytes-long';

describe('OAuthStateCodec', () => {
  const codec = new OAuthStateCodec(SECRET);

  it('round-trips a state containing "+" (the XSUAA bug case) and stays URL-safe', () => {
    const clientState = 'aa+bb/cc=='; // contains +, / which the bug mangles
    const token = codec.encode({
      clientState,
      clientRedirectUri: 'https://c/cb',
      clientId: 'calmcp-x',
    });
    expect(token).not.toMatch(/[+/]/); // base64url only — immune to the XSUAA `+` echo
    const decoded = codec.decode(token);
    expect(decoded).toMatchObject({ kind: 'ok', clientState, clientRedirectUri: 'https://c/cb' });
  });

  it('rejects a tampered signature', () => {
    const token = codec.encode({ clientRedirectUri: 'https://c/cb', clientId: 'calmcp-x' });
    const tampered = `${token.slice(0, -2)}xy`;
    expect(codec.decode(tampered).kind).toBe('error');
  });

  it('rejects an expired token', () => {
    const t0 = 1_000_000_000_000;
    const token = codec.encode({
      clientRedirectUri: 'https://c/cb',
      clientId: 'calmcp-x',
      now: t0,
    });
    const result = codec.decode(token, t0 + 11 * 60 * 1000); // default TTL is 10 min
    expect(result).toEqual({ kind: 'error', reason: 'expired' });
  });

  it('a different signing secret cannot verify the token', () => {
    const token = codec.encode({ clientRedirectUri: 'https://c/cb', clientId: 'calmcp-x' });
    expect(new OAuthStateCodec('a-different-secret-16bytes').decode(token).kind).toBe('error');
  });
});

describe('StatelessDcrClientStore', () => {
  const store = new StatelessDcrClientStore('sb-calmcp!t1', 'xsuaa-secret', SECRET, logger);

  it('registers a client and resolves it back (stateless round-trip)', async () => {
    const reg = await store.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(reg.client_id).toMatch(/^calmcp-/);
    const got = await store.getClient(reg.client_id);
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('a client_id signed by a different key does not resolve', async () => {
    const other = new StatelessDcrClientStore(
      'sb-calmcp!t1',
      'xsuaa-secret',
      'other-secret-16b!!',
      logger,
    );
    const reg = await other.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(await store.getClient(reg.client_id)).toBeUndefined();
  });

  it('checkRedirectUri uses the baked redirect_uris for a DCR client', async () => {
    const reg = await store.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(
      await store.checkRedirectUri(reg.client_id, 'https://claude.ai/api/mcp/auth_callback'),
    ).toBe('ok');
    expect(await store.checkRedirectUri(reg.client_id, 'https://evil.example/cb')).toBe(
      'unregistered',
    );
    expect(await store.checkRedirectUri('calmcp-forged', 'https://x/cb')).toBe('unknown_client');
  });
});

describe('redirect-uri allowlist (matchesXsuaaRedirectPattern)', () => {
  it('accepts CF routes and loopback callbacks', () => {
    expect(
      matchesXsuaaRedirectPattern('https://calmcp.cfapps.eu10.hana.ondemand.com/oauth/callback'),
    ).toBe(true);
    expect(matchesXsuaaRedirectPattern('http://localhost:6274/oauth/callback')).toBe(true);
    expect(matchesXsuaaRedirectPattern('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('rejects unknown hosts and userinfo-smuggling', () => {
    expect(matchesXsuaaRedirectPattern('https://evil.example/cb')).toBe(false);
    // userinfo trick: glob would match the port segment but the real host is evil.com
    expect(matchesXsuaaRedirectPattern('http://localhost:x@evil.com/cb')).toBe(false);
  });
});

describe('validateRedirectUri', () => {
  it('allows https, loopback http, and known custom schemes', () => {
    expect(() => validateRedirectUri('https://app/cb')).not.toThrow();
    expect(() => validateRedirectUri('http://localhost:3000/cb')).not.toThrow();
    expect(() => validateRedirectUri('cursor://anysphere.cursor-retrieval/cb')).not.toThrow();
  });

  it('rejects dangerous schemes and non-loopback http', () => {
    expect(() => validateRedirectUri('javascript:alert(1)')).toThrow();
    expect(() => validateRedirectUri('http://evil.example/cb')).toThrow();
  });
});

describe('getAppUrl', () => {
  it('prefers CALM_PUBLIC_URL and strips a trailing slash', () => {
    const prev = process.env.CALM_PUBLIC_URL;
    process.env.CALM_PUBLIC_URL = 'https://calmcp.example/';
    try {
      expect(getAppUrl()).toBe('https://calmcp.example');
    } finally {
      if (prev === undefined) delete process.env.CALM_PUBLIC_URL;
      else process.env.CALM_PUBLIC_URL = prev;
    }
  });
});

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
    corsOrigins: '*',
    rateLimitPerMinute: 100,
    logger,
    auth: { xsuaa: { credentials, appUrl: 'https://calmcp.example.hana.ondemand.com' } },
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
  it('does not require a token on /mcp (open) — discovery metadata absent', async () => {
    const app = createHttpApp({
      buildServer: () => undefined as unknown as McpServer,
      corsOrigins: '*',
      rateLimitPerMinute: 100,
      logger,
    });
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });
});

describe('createApiKeyVerifier', () => {
  it('accepts the configured key and grants the read scope', async () => {
    const verify = createApiKeyVerifier('s3cret', logger);
    const info = await verify('s3cret');
    expect(info.scopes).toEqual(['Viewer']);
    expect(info.clientId).toBe('api-key');
  });

  it('rejects a wrong key (including a length-different one)', async () => {
    const verify = createApiKeyVerifier('s3cret', logger);
    await expect(verify('wrong')).rejects.toThrow();
    await expect(verify('s3cret-but-longer')).rejects.toThrow();
  });
});

describe('createHttpApp with API-key auth', () => {
  const config = Config.fromEnv({ CALM_SANDBOX: 'true', CALM_API_KEY: 'x' } as NodeJS.ProcessEnv);
  const clients = createClients(config, logger);
  const app = createHttpApp({
    buildServer: () => buildMcpServer(clients, logger),
    corsOrigins: '*',
    rateLimitPerMinute: 100,
    logger,
    auth: { apiKey: 'super-secret-key' },
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
