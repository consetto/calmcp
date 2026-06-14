// XSUAA OAuth proxy + bearer-token verification for the HTTP transport.
//
// Two responsibilities:
//   1. createXsuaaTokenVerifier — validate a bearer JWT with @sap/xssec and require the read scope.
//   2. createXsuaaOAuthProvider — an MCP-native OAuth provider (RFC 8414 discovery + RFC 7591 DCR)
//      that proxies the OAuth flow to XSUAA, so Claude Desktop / Cursor / VS Code can sign in
//      automatically. Trimmed to calmcp's single read-only scope.

import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { XsuaaService } from '@sap/xssec';
import type { Logger } from 'pino';
import { StatelessDcrClientStore } from './dcrClientStore.js';
import { OAuthStateCodec } from './oauthState.js';

/** The single local scope calmcp requires (read-only). Matches `$XSAPPNAME.Viewer` in xs-security.json. */
export const READ_SCOPE = 'Viewer';

/** MCP scope names advertised to clients via OAuth metadata. */
export const MCP_SCOPES = [READ_SCOPE];

/** XSUAA credentials from the bound service (VCAP_SERVICES). */
export interface XsuaaCredentials {
  url: string;
  clientid: string;
  clientsecret: string;
  xsappname: string;
  uaadomain: string;
}

/** An OAuth token endpoint response. */
interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Load XSUAA credentials from the bound service instance (parsing `VCAP_SERVICES`), or `undefined`
 * when none is bound (e.g. local development) — in which case the caller leaves the HTTP endpoint
 * unauthenticated.
 */
export function loadXsuaaCredentials(logger: Logger): XsuaaCredentials | undefined {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) return undefined;
  try {
    const vcap = JSON.parse(raw) as Record<
      string,
      Array<{ credentials?: Partial<XsuaaCredentials> }>
    >;
    const instances = vcap.xsuaa;
    const creds = instances?.[0]?.credentials;
    if (creds?.clientid && creds.clientsecret && creds.url && creds.xsappname && creds.uaadomain) {
      return creds as XsuaaCredentials;
    }
    if (instances?.length) {
      logger.warn('XSUAA service is bound but its credentials are incomplete — HTTP auth disabled');
    }
    return undefined;
  } catch {
    logger.warn('Failed to parse VCAP_SERVICES — HTTP auth disabled');
    return undefined;
  }
}

/**
 * Resolve calmcp's public base URL for OAuth metadata: `CALM_PUBLIC_URL` if set, else the first
 * Cloud Foundry route from `VCAP_APPLICATION`. Returns `undefined` when neither is available.
 */
export function getAppUrl(): string | undefined {
  const override = process.env.CALM_PUBLIC_URL?.trim();
  if (override) {
    return override.replace(/\/$/, '');
  }
  const vcapApp = process.env.VCAP_APPLICATION;
  if (!vcapApp) return undefined;
  try {
    const app = JSON.parse(vcapApp) as { application_uris?: string[]; uris?: string[] };
    const uris = app.application_uris ?? app.uris;
    if (Array.isArray(uris) && uris.length > 0) {
      return `https://${uris[0]}`;
    }
  } catch {
    // Not valid JSON.
  }
  return undefined;
}

/**
 * Create a bearer-token verifier that validates an XSUAA JWT and requires the read scope.
 *
 * @returns A verifier suitable for the MCP SDK's `requireBearerAuth`. Throws `InvalidTokenError`
 *   when the token is invalid or lacks the read scope.
 */
export function createXsuaaTokenVerifier(
  credentials: XsuaaCredentials,
  logger: Logger,
): (token: string) => Promise<AuthInfo> {
  const xsuaaService = new XsuaaService({
    clientid: credentials.clientid,
    clientsecret: credentials.clientsecret,
    url: credentials.url,
    xsappname: credentials.xsappname,
    uaadomain: credentials.uaadomain,
  });

  return async (token: string): Promise<AuthInfo> => {
    let securityContext: Awaited<ReturnType<XsuaaService['createSecurityContext']>>;
    try {
      securityContext = await xsuaaService.createSecurityContext(token, { jwt: token });
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'XSUAA token validation failed');
      throw new InvalidTokenError('Invalid XSUAA token');
    }

    if (!securityContext.checkLocalScope(READ_SCOPE)) {
      logger.debug('XSUAA token valid but missing read scope');
      throw new InvalidTokenError(
        `Token is missing the required '${READ_SCOPE}' scope — assign the CALMCP_Viewer role collection.`,
      );
    }

    const expiresAt = securityContext.token?.payload?.exp;
    const authInfo: AuthInfo = {
      token,
      clientId: securityContext.getClientId(),
      scopes: [READ_SCOPE],
      expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
      extra: {
        userName: securityContext.getLogonName?.() ?? undefined,
        email: securityContext.getEmail?.() ?? undefined,
      },
    };
    logger.debug(
      { clientId: authInfo.clientId, user: authInfo.extra?.email ?? authInfo.extra?.userName },
      'XSUAA token verified',
    );
    return authInfo;
  };
}

/** OIDC/UAA scopes that must not be prefixed with the xsappname. */
const RESERVED_OAUTH_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * Qualify short MCP scope names (`Viewer`) with the XSUAA xsappname prefix XSUAA requires. Already
 * qualified scopes (contain `.`) and reserved OIDC scopes pass through; empty entries are dropped.
 */
export function qualifyXsuaaScopes(scopes: string[], xsappname: string): string[] {
  return scopes
    .filter((s) => s.length > 0)
    .map((s) => (s.includes('.') || RESERVED_OAUTH_SCOPES.has(s) ? s : `${xsappname}.${s}`));
}

/**
 * XSUAA-proxying OAuth provider.
 *
 * MCP clients register via DCR and get a local client_id, but XSUAA only knows its own client_id.
 * This provider swaps in the XSUAA credentials when forwarding to XSUAA, and routes the callback
 * through calmcp's own `/oauth/callback` so the client's original `state` round-trips correctly.
 */
export class XsuaaProxyOAuthProvider extends ProxyOAuthServerProvider {
  private readonly xsuaaClientId: string;
  private readonly xsuaaClientSecret: string;
  private readonly xsuaaTokenUrl: string;
  private readonly xsuaaAuthUrl: string;
  private readonly xsuaaXsappname: string;
  private readonly localClientStore: StatelessDcrClientStore;
  private readonly callbackUrl: string;
  private readonly stateCodec: OAuthStateCodec;
  private readonly log: Logger;

  constructor(
    credentials: XsuaaCredentials,
    verifier: (token: string) => Promise<AuthInfo>,
    localClientStore: StatelessDcrClientStore,
    callbackUrl: string,
    stateCodec: OAuthStateCodec,
    logger: Logger,
  ) {
    const authUrl = `${credentials.url}/oauth/authorize`;
    const tokenUrl = `${credentials.url}/oauth/token`;
    super({
      endpoints: {
        authorizationUrl: authUrl,
        tokenUrl,
        revocationUrl: `${credentials.url}/oauth/revoke`,
      },
      verifyAccessToken: verifier,
      getClient: (clientId: string) => localClientStore.getClient(clientId),
    });
    this.xsuaaClientId = credentials.clientid;
    this.xsuaaClientSecret = credentials.clientsecret;
    this.xsuaaTokenUrl = tokenUrl;
    this.xsuaaAuthUrl = authUrl;
    this.xsuaaXsappname = credentials.xsappname;
    this.localClientStore = localClientStore;
    this.callbackUrl = callbackUrl;
    this.stateCodec = stateCodec;
    this.log = logger;
    this.skipLocalPkceValidation = true;
  }

  override get clientsStore() {
    return this.localClientStore;
  }

  override async authorize(
    client: OAuthClientInformationFull,
    params: {
      state?: string;
      scopes?: string[];
      codeChallenge: string;
      redirectUri: string;
      resource?: URL;
    },
    res: { redirect(url: string): void },
  ): Promise<void> {
    // Callback proxy: send XSUAA calmcp's OWN /oauth/callback and an opaque, URL-safe state token
    // carrying the client's real redirect_uri + state (works around XSUAA echoing a literal `+`).
    const proxyState = this.stateCodec.encode({
      clientState: params.state,
      clientRedirectUri: params.redirectUri,
      clientId: client.client_id,
    });
    const targetUrl = new URL(this.xsuaaAuthUrl);
    const searchParams = new URLSearchParams({
      client_id: this.xsuaaClientId,
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: proxyState,
    });
    if (params.scopes?.length) {
      const qualifiedScopes = qualifyXsuaaScopes(params.scopes, this.xsuaaXsappname);
      if (qualifiedScopes.length > 0) {
        searchParams.set('scope', qualifiedScopes.join(' '));
      }
    }
    if (params.resource) searchParams.set('resource', params.resource.toString());
    targetUrl.search = searchParams.toString();
    this.log.debug(
      { clientRedirectUri: params.redirectUri, callbackUrl: this.callbackUrl },
      'XSUAA authorize redirect (callback proxy)',
    );
    res.redirect(targetUrl.toString());
  }

  override async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
  ) {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: this.xsuaaClientId,
      client_secret: this.xsuaaClientSecret,
      // Must match the redirect_uri sent at authorize time (calmcp's own callback).
      redirect_uri: this.callbackUrl,
    });
    if (codeVerifier) params.set('code_verifier', codeVerifier);
    const response = await fetch(this.xsuaaTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.log.error(
        { status: response.status, body: text.slice(0, 200) },
        'XSUAA token exchange failed',
      );
      throw new Error(`XSUAA token exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as TokenResponse;
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      scope: data.scope,
    };
  }

  override async exchangeRefreshToken(_client: OAuthClientInformationFull, refreshToken: string) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.xsuaaClientId,
      client_secret: this.xsuaaClientSecret,
    });
    const response = await fetch(this.xsuaaTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!response.ok) {
      throw new Error(`XSUAA refresh token exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as TokenResponse;
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      scope: data.scope,
    };
  }

  override revokeToken = async (
    _client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> => {
    const revokeUrl = this.xsuaaTokenUrl.replace('/oauth/token', '/oauth/revoke');
    const params = new URLSearchParams({ token: request.token });
    if (request.token_type_hint) params.set('token_type_hint', request.token_type_hint);
    try {
      const response = await fetch(revokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${this.xsuaaClientId}:${this.xsuaaClientSecret}`).toString('base64')}`,
        },
        body: params.toString(),
      });
      if (!response.ok) {
        this.log.warn({ status: response.status }, 'XSUAA token revocation failed');
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'XSUAA token revocation error');
    }
  };
}

/**
 * Build the XSUAA OAuth provider, its stateless DCR client store, and the state codec.
 *
 * @param credentials - XSUAA service credentials.
 * @param appUrl - calmcp's public base URL (for the callback URL).
 * @param logger - Application logger.
 */
export function createXsuaaOAuthProvider(
  credentials: XsuaaCredentials,
  appUrl: string,
  logger: Logger,
): {
  provider: ProxyOAuthServerProvider;
  clientStore: StatelessDcrClientStore;
  stateCodec: OAuthStateCodec;
} {
  // The signing secret defaults to the XSUAA clientsecret (the trust anchor for minting client_ids).
  // A dedicated CALM_DCR_SIGNING_SECRET survives `cf deploy` (which rotates the binding secret).
  const dcrSigningSecret = process.env.CALM_DCR_SIGNING_SECRET?.trim() || credentials.clientsecret;
  const clientStore = new StatelessDcrClientStore(
    credentials.clientid,
    credentials.clientsecret,
    dcrSigningSecret,
    logger,
  );
  const verifier = createXsuaaTokenVerifier(credentials, logger);
  const stateCodec = new OAuthStateCodec(dcrSigningSecret);
  const callbackUrl = `${appUrl.replace(/\/$/, '')}/oauth/callback`;
  const provider = new XsuaaProxyOAuthProvider(
    credentials,
    verifier,
    clientStore,
    callbackUrl,
    stateCodec,
    logger,
  );
  logger.info(
    { xsappname: credentials.xsappname, appUrl, callbackUrl },
    'XSUAA OAuth provider created (stateless DCR + callback proxy)',
  );
  return { provider, clientStore, stateCodec };
}
