// HTTP-transport authentication wiring.
//
// `setupHttpAuth` builds the bearer-auth guard for `/mcp` from whichever methods are configured:
//   - a static API key (shared secret), and/or
//   - XSUAA + the MCP-native OAuth proxy (RFC 8414 discovery + RFC 7591 dynamic client registration
//     delegated to XSUAA; the `/oauth/callback` route re-emits the client's original `state` to work
//     around XSUAA's `+`-in-state bug).
// When both are configured they coexist on the same endpoint (tried API key first, then XSUAA), so
// e.g. Copilot Studio can use an API key while Claude Desktop uses interactive OAuth.

import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { createApiKeyVerifier } from './apiKey.js';
import type { StatelessDcrClientStore } from './dcrClientStore.js';
import type { OAuthStateCodec } from './oauthState.js';
import {
  createXsuaaOAuthProvider,
  createXsuaaTokenVerifier,
  MCP_SCOPES,
  type XsuaaCredentials,
} from './xsuaa.js';

export {
  getAppUrl,
  loadXsuaaCredentials,
  type XsuaaCredentials,
} from './xsuaa.js';

/** Authentication methods to enable on the HTTP `/mcp` endpoint. */
export interface HttpAuthOptions {
  /** Static API key (shared secret). Callers send `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** XSUAA bearer validation plus the MCP-native OAuth proxy. */
  xsuaa?: { credentials: XsuaaCredentials; appUrl: string };
}

/** A bearer-token verifier (returns `AuthInfo` or throws). */
type Verifier = (token: string) => Promise<AuthInfo>;

/** A short terminal HTML page for callback errors we cannot safely redirect. */
function errorPage(message: string): string {
  return (
    '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
    '<h1>Authentication failed</h1>' +
    `<p>${message}</p>` +
    '</body></html>'
  );
}

/**
 * Express handler for calmcp's `/oauth/callback` — the second half of the XSUAA callback proxy.
 *
 * XSUAA redirects here with calmcp's opaque base64url `state`. We verify + decode it to recover the
 * client's original `redirect_uri` and `state`, validate the redirect_uri is registered for the
 * client (authorization-code interception defense, fail-closed), then forward the `code` (or error)
 * to the client with the original `state` re-attached and correctly `%2B`-encoded.
 */
export function createOAuthCallbackHandler(
  stateCodec: OAuthStateCodec,
  clientStore: StatelessDcrClientStore,
  logger: Logger,
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
    const decoded = stateCodec.decode(stateToken);
    if (decoded.kind !== 'ok') {
      logger.warn({ reason: decoded.reason }, 'OAuth callback: invalid state token');
      res
        .status(400)
        .type('html')
        .send(errorPage('The OAuth state token was invalid or expired. Please retry the sign-in.'));
      return;
    }

    // Client-binding validation: the recovered redirect_uri must be allowed for the client_id that
    // minted this state. Fails closed.
    let verdict: 'ok' | 'unknown_client' | 'unregistered';
    try {
      verdict = await clientStore.checkRedirectUri(decoded.clientId, decoded.clientRedirectUri);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'OAuth callback: redirect_uri check threw — failing closed',
      );
      verdict = 'unknown_client';
    }
    if (verdict !== 'ok') {
      logger.warn(
        { clientId: decoded.clientId, verdict },
        'OAuth callback: redirect_uri not allowed',
      );
      res
        .status(400)
        .type('html')
        .send(errorPage('The redirect URI in the state token is not registered for this client.'));
      return;
    }

    let target: URL;
    try {
      target = new URL(decoded.clientRedirectUri);
    } catch {
      res.status(400).type('html').send(errorPage('Invalid redirect target.'));
      return;
    }

    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    if (error) {
      const errorDescription =
        typeof req.query.error_description === 'string' ? req.query.error_description : '';
      if (decoded.clientState !== undefined) target.searchParams.set('state', decoded.clientState);
      target.searchParams.set('error', error);
      if (errorDescription) target.searchParams.set('error_description', errorDescription);
      logger.warn(
        { error, host: target.host },
        'OAuth callback: identity provider returned an error',
      );
      res.redirect(302, target.toString());
      return;
    }

    // Success: forward the code with the client's ORIGINAL state (URLSearchParams encodes `+` as
    // `%2B`, which is exactly the round-trip fix).
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    target.searchParams.set('code', code);
    if (decoded.clientState !== undefined) target.searchParams.set('state', decoded.clientState);
    logger.debug({ host: target.host }, 'OAuth callback: redirecting to client');
    res.redirect(302, target.toString());
  };
}

/** Try each verifier in order; return the first success, or throw if none accept the token. */
function chainVerifiers(verifiers: Verifier[]): Verifier {
  return async (token: string): Promise<AuthInfo> => {
    for (const verify of verifiers) {
      try {
        return await verify(token);
      } catch {
        // Try the next method.
      }
    }
    throw new InvalidTokenError(
      'No valid credentials (a valid API key or XSUAA token is required)',
    );
  };
}

/**
 * Mount the XSUAA OAuth proxy (callback + discovery/authorize/token/register/revoke) on the app and
 * return its bearer-token verifier.
 */
function mountOAuthRouter(
  app: Express,
  credentials: XsuaaCredentials,
  appUrl: string,
  logger: Logger,
): Verifier {
  const { provider, clientStore, stateCodec } = createXsuaaOAuthProvider(
    credentials,
    appUrl,
    logger,
  );

  // calmcp's own OAuth callback (the `+`-bug fix). Unauthenticated; does an HMAC verify per hit.
  app.get('/oauth/callback', createOAuthCallbackHandler(stateCodec, clientStore, logger));

  // MCP SDK auth router: /authorize, /token, /register, /revoke + discovery metadata.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(appUrl),
      baseUrl: new URL(appUrl),
      resourceServerUrl: new URL(`${appUrl.replace(/\/$/, '')}/mcp`),
      scopesSupported: MCP_SCOPES,
      resourceName: 'calmcp (SAP Cloud ALM MCP Server)',
    }),
  );

  logger.info({ xsappname: credentials.xsappname, appUrl }, 'XSUAA OAuth proxy enabled on /mcp');
  return createXsuaaTokenVerifier(credentials, logger);
}

/**
 * Configure HTTP authentication for `/mcp`.
 *
 * Mounts the XSUAA OAuth routes when XSUAA is configured, and returns the bearer-auth middleware to
 * place before the `/mcp` handler. Returns `undefined` when no method is configured (the caller then
 * leaves the endpoint open, for local development).
 *
 * @param app - The Express app.
 * @param options - Which auth methods to enable (API key and/or XSUAA).
 * @param logger - Application logger.
 */
export function setupHttpAuth(
  app: Express,
  options: HttpAuthOptions,
  logger: Logger,
): RequestHandler | undefined {
  const verifiers: Verifier[] = [];
  let resourceMetadataUrl: string | undefined;

  if (options.apiKey) {
    verifiers.push(createApiKeyVerifier(options.apiKey, logger));
    logger.info('HTTP API-key authentication enabled on /mcp');
  }
  if (options.xsuaa) {
    verifiers.push(mountOAuthRouter(app, options.xsuaa.credentials, options.xsuaa.appUrl, logger));
    // The 401 WWW-Authenticate header points OAuth clients at the protected-resource metadata.
    resourceMetadataUrl = `${options.xsuaa.appUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
  }

  const [first, ...rest] = verifiers;
  if (!first) {
    return undefined;
  }
  // A single verifier is used directly (preserving its specific error); multiple are chained.
  const verifyAccessToken = rest.length === 0 ? first : chainVerifiers(verifiers);
  return requireBearerAuth({
    verifier: { verifyAccessToken },
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  });
}
