// Stateless OAuth Dynamic Client Registration (DCR) store.
//
// MCP clients (Claude Desktop, Cursor, …) register via RFC 7591 and cache the returned `client_id`.
// With an in-memory store, every restart / `cf push` wipes the registry and the cached `client_id`
// fails with `invalid_client`. This store avoids persistence entirely: each `client_id` is a
// self-validating token carrying its registration payload plus an HMAC-SHA256 signature derived from
// a server-held key. `getClient` re-derives the payload by verifying the signature — any instance
// with the same signing key validates any client_id ever issued (survives restarts and scale-out).
//
// Tradeoff: per-client revocation isn't possible (only TTL or signing-key rotation). The signing key
// derives from the XSUAA `clientsecret` (or a dedicated secret), so it's as stable as the binding.

import crypto from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Logger } from 'pino';

/** All DCR-issued client_ids start with this prefix. */
const ID_PREFIX = 'calmcp-';

/** Domain-separation label bound into the HMAC key derivation. Bump the suffix to invalidate every
 *  previously-issued client_id without a binding rotation. */
const KDF_LABEL = 'calmcp-dcr/v1';

/** Schema version of the JSON payload embedded in the signed client_id. */
const PAYLOAD_VERSION = 1;

/** Truncated HMAC-SHA256 length in bytes (128 bits). */
const SIG_BYTES = 16;

/** Default lifetime of a DCR registration (30 days). Set `ttlSeconds` to `0` to disable expiry. */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

const DEFAULT_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const DEFAULT_RESPONSE_TYPES = ['code'] as const;
const DEFAULT_TOKEN_AUTH_METHOD = 'client_secret_post';

/**
 * Built-in redirect_uris for the pre-registered XSUAA client. Covers common MCP clients; more can be
 * added at `/authorize` time via `ensureRedirectUri()`. Must also be permitted by the
 * `xs-security.json` `oauth2-configuration.redirect-uris` patterns.
 */
const XSUAA_DEFAULT_REDIRECT_URIS = [
  'http://localhost:6274/oauth/callback', // MCP Inspector
  'http://localhost:3000/oauth/callback', // Local dev
  'https://claude.ai/api/mcp/auth_callback', // Claude Desktop / claude.ai
  'cursor://anysphere.cursor-retrieval/oauth/callback', // Cursor
  'vscode://vscode.microsoft-authentication/callback', // VS Code
] as const;

/**
 * Redirect-URI allowlist for the pre-registered XSUAA default client. With the callback proxy (see
 * oauthState.ts), XSUAA only ever sees calmcp's own `/oauth/callback`, so calmcp — not XSUAA —
 * validates the client's redirect_uri. Without this allowlist, `ensureRedirectUri` would auto-trust
 * ANY redirect_uri, enabling authorization-code interception.
 *
 * Glob semantics: `*` matches within one host/path segment (never `/`); `**` matches across segments.
 */
export const XSUAA_REDIRECT_URI_PATTERNS = [
  'http://localhost:*/**',
  'https://*.hana.ondemand.com/**',
  'https://*.applicationstudio.cloud.sap/**',
  'https://claude.ai/api/mcp/auth_callback',
  'cursor://anysphere.cursor-retrieval/**',
  'cursor://anysphere.cursor-mcp/**',
  'vscode://vscode.microsoft-authentication/**',
] as const;

/** Translate one redirect-uri glob into an anchored, case-insensitive RegExp. */
function redirectPatternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split(/(\*\*|\*)/)
    .map((segment) => {
      if (segment === '**') return '.*'; // crosses path separators
      if (segment === '*') return '[^/]*'; // within a single segment (never `/`)
      return segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // escape literal regex metachars
    })
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

const XSUAA_REDIRECT_URI_REGEXPS = XSUAA_REDIRECT_URI_PATTERNS.map(redirectPatternToRegExp);

/**
 * Is `uri` an allowed redirect target for the pre-registered XSUAA default client?
 *
 * SECURITY: the value is later used as the 302 target carrying the OAuth `code`, so we parse before
 * matching — reject anything that doesn't parse, reject userinfo (`user[:pass]@`), and for
 * http/https match the glob against a subject rebuilt from PARSED components (so `\`, `#`, `?` cannot
 * relocate the host past a same-segment wildcard).
 */
export function matchesXsuaaRedirectPattern(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  const subject =
    parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`
      : uri;
  return XSUAA_REDIRECT_URI_REGEXPS.some((re) => re.test(subject));
}

/** Compact JSON shape stored inside the signed `client_id`. Keys are short to keep the id small. */
interface SignedPayload {
  v: number;
  iat: number; // issued-at, seconds since epoch
  ru: string[]; // redirect_uris
  gt?: string[]; // grant_types
  rt?: string[]; // response_types
  am?: string; // token_endpoint_auth_method
  cn?: string; // client_name
}

export interface StatelessDcrClientStoreOptions {
  /** How long an issued client_id remains valid, in seconds. Default 30 days; `0` disables expiry. */
  ttlSeconds?: number;
  /** Clock injection point for tests. Default `Date.now`. */
  now?: () => number;
}

/** Pre-registered XSUAA client config (for clients that hit the XSUAA clientid directly). */
function buildXsuaaDefaultClient(
  clientId: string,
  clientSecret: string,
): OAuthClientInformationFull {
  return {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [...XSUAA_DEFAULT_REDIRECT_URIS],
    grant_types: [...DEFAULT_GRANT_TYPES],
    response_types: [...DEFAULT_RESPONSE_TYPES],
    token_endpoint_auth_method: DEFAULT_TOKEN_AUTH_METHOD,
    client_name: 'calmcp XSUAA Default Client',
  };
}

/**
 * Stateless DCR client store — see file header.
 */
export class StatelessDcrClientStore implements OAuthRegisteredClientsStore {
  private readonly xsuaaClient: OAuthClientInformationFull;
  private readonly hmacKey: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    xsuaaClientId: string,
    xsuaaClientSecret: string,
    signingSecret: string,
    logger: Logger,
    options: StatelessDcrClientStoreOptions = {},
  ) {
    if (!signingSecret) {
      throw new Error('StatelessDcrClientStore requires a non-empty signingSecret');
    }
    const secretBytes = Buffer.byteLength(signingSecret, 'utf8');
    if (secretBytes < 16) {
      logger.warn(
        { bytes: secretBytes },
        'DCR signing secret shorter than 16 bytes (128 bits) — below the recommended minimum.',
      );
    }
    this.hmacKey = crypto.createHmac('sha256', signingSecret).update(KDF_LABEL).digest();
    this.xsuaaClient = buildXsuaaDefaultClient(xsuaaClientId, xsuaaClientSecret);
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options.now ?? (() => Date.now());
    this.logger = logger;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (clientId === this.xsuaaClient.client_id) {
      return this.xsuaaClient;
    }
    if (!clientId.startsWith(ID_PREFIX)) {
      this.logger.debug({ clientId, reason: 'unknown_prefix' }, 'OAuth client lookup failed');
      return undefined;
    }
    const decoded = this.decodeAndVerify(clientId);
    if (decoded.kind === 'error') {
      this.logger.warn({ clientId, reason: decoded.reason }, 'OAuth client lookup failed');
      return undefined;
    }
    if (this.ttlSeconds > 0) {
      const ageSec = Math.floor(this.now() / 1000) - decoded.payload.iat;
      if (ageSec > this.ttlSeconds) {
        this.logger.debug(
          { clientId, ageSec, ttlSeconds: this.ttlSeconds },
          'OAuth client expired',
        );
        return undefined;
      }
    }
    return this.payloadToClientInfo(clientId, decoded.payload);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    if (client.redirect_uris) {
      for (const uri of client.redirect_uris) {
        validateRedirectUri(uri);
      }
    }
    const issuedAt = Math.floor(this.now() / 1000);
    const payload: SignedPayload = {
      v: PAYLOAD_VERSION,
      iat: issuedAt,
      ru: client.redirect_uris ?? [],
    };
    if (client.grant_types) payload.gt = client.grant_types;
    if (client.response_types) payload.rt = client.response_types;
    if (client.token_endpoint_auth_method) payload.am = client.token_endpoint_auth_method;
    if (client.client_name) payload.cn = client.client_name;

    const clientId = this.encode(payload);
    const clientSecret = this.deriveSecret(clientId);
    this.logger.debug(
      { clientId, clientName: client.client_name, idBytes: clientId.length },
      'OAuth client registered (stateless)',
    );
    // RFC 7591 §3.2.1: client_secret_expires_at is REQUIRED when a secret is issued; 0 = never.
    const clientSecretExpiresAt = this.ttlSeconds > 0 ? issuedAt + this.ttlSeconds : 0;
    return {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: clientSecretExpiresAt,
    };
  }

  /**
   * Called by the MCP SDK before redirect_uri validation on `/authorize`. For the pre-registered
   * XSUAA client we add the URI to the in-memory list ONLY if it matches the allowlist (otherwise
   * the callback proxy would let an attacker register an arbitrary redirect_uri). DCR clients are
   * stateless — nothing to mutate.
   */
  ensureRedirectUri(clientId: string, uri: string): void {
    if (clientId !== this.xsuaaClient.client_id) return;
    if (this.xsuaaClient.redirect_uris.includes(uri)) return;
    if (!matchesXsuaaRedirectPattern(uri)) {
      this.logger.warn({ clientId, uri }, 'Dynamic redirect_uri rejected (not in allowlist)');
      return;
    }
    this.xsuaaClient.redirect_uris.push(uri);
    this.logger.debug({ clientId, uri }, 'Dynamic redirect_uri registered for XSUAA client');
  }

  /**
   * Validate that `uri` is an allowed redirect target for `clientId` at the `/oauth/callback` proxy
   * (the control that stops authorization-code interception). Fails closed.
   */
  async checkRedirectUri(
    clientId: string,
    uri: string,
  ): Promise<'ok' | 'unknown_client' | 'unregistered'> {
    if (clientId === this.xsuaaClient.client_id) {
      return matchesXsuaaRedirectPattern(uri) ? 'ok' : 'unregistered';
    }
    const info = await this.getClient(clientId);
    if (!info) return 'unknown_client';
    return info.redirect_uris.includes(uri) ? 'ok' : 'unregistered';
  }

  private payloadToClientInfo(
    clientId: string,
    payload: SignedPayload,
  ): OAuthClientInformationFull {
    return {
      client_id: clientId,
      client_secret: this.deriveSecret(clientId),
      client_id_issued_at: payload.iat,
      redirect_uris: payload.ru,
      grant_types: payload.gt ?? [...DEFAULT_GRANT_TYPES],
      response_types: payload.rt ?? [...DEFAULT_RESPONSE_TYPES],
      token_endpoint_auth_method: payload.am ?? DEFAULT_TOKEN_AUTH_METHOD,
      client_name: payload.cn,
    };
  }

  private encode(payload: SignedPayload): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${ID_PREFIX}${payloadB64}.${this.sign(payloadB64)}`;
  }

  private decodeAndVerify(
    clientId: string,
  ):
    | { kind: 'ok'; payload: SignedPayload }
    | { kind: 'error'; reason: 'malformed' | 'bad_signature' | 'invalid_payload' } {
    const stripped = clientId.slice(ID_PREFIX.length);
    const dot = stripped.lastIndexOf('.');
    if (dot < 0) return { kind: 'error', reason: 'malformed' };
    const payloadB64 = stripped.slice(0, dot);
    const sigB64 = stripped.slice(dot + 1);
    if (!this.verifySignature(payloadB64, sigB64)) {
      return { kind: 'error', reason: 'bad_signature' };
    }
    const payload = parsePayload(payloadB64);
    if (!payload) return { kind: 'error', reason: 'invalid_payload' };
    return { kind: 'ok', payload };
  }

  private verifySignature(payloadB64: string, sigB64: string): boolean {
    const expected = Buffer.from(this.sign(payloadB64), 'base64url');
    const actual = Buffer.from(sigB64, 'base64url');
    if (actual.length !== expected.length || actual.length !== SIG_BYTES) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  private sign(payloadB64: string): string {
    const fullDigest = crypto.createHmac('sha256', this.hmacKey).update(payloadB64).digest();
    return fullDigest.subarray(0, SIG_BYTES).toString('base64url');
  }

  /** The client_secret is derived deterministically from the client_id, so any instance with the
   *  same signing key can validate it. */
  private deriveSecret(clientId: string): string {
    return crypto
      .createHmac('sha256', this.hmacKey)
      .update(`secret:${clientId}`)
      .digest('base64url');
  }
}

/** Parse a base64url-encoded payload back into a typed `SignedPayload`. */
function parsePayload(payloadB64: string): SignedPayload | undefined {
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as SignedPayload;
    if (parsed.v !== PAYLOAD_VERSION) return undefined;
    if (typeof parsed.iat !== 'number' || !Array.isArray(parsed.ru)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Validate a redirect URI against the allowed scheme/host policy. Allowed: `https://*`, `http://` to
 * loopback, and known MCP-client custom schemes. Rejected: `javascript:`/`data:`/`file:`/`ftp:` and
 * `http://` to non-loopback hosts.
 */
export function validateRedirectUri(uri: string): void {
  const ALLOWED_CUSTOM_SCHEMES = ['claude:', 'cursor:', 'vscode:', 'vscode-insiders:'];
  const BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'ftp:'];

  for (const scheme of BLOCKED_SCHEMES) {
    if (uri.toLowerCase().startsWith(scheme)) {
      throw new Error(`Redirect URI rejected: '${scheme}' scheme is not allowed.`);
    }
  }
  for (const scheme of ALLOWED_CUSTOM_SCHEMES) {
    if (uri.toLowerCase().startsWith(scheme)) return;
  }
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return;
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
        return;
      throw new Error(
        `Redirect URI rejected: http:// is only allowed for localhost. Got: '${uri}'`,
      );
    }
    return;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Redirect URI rejected')) throw err;
    // URL parsing failed for some other reason (unknown protocol etc.) — allow.
  }
}
