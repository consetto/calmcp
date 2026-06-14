// HTTP-transport authentication wiring.
//
// `mountXsuaaAuth` installs the MCP-native OAuth proxy (RFC 8414 discovery + RFC 7591 dynamic client
// registration delegated to XSUAA) and returns the bearer-auth middleware that guards `/mcp`. The
// `/oauth/callback` route re-emits the client's original `state` correctly (XSUAA `+`-bug fix).

import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
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

/**
 * Install the XSUAA OAuth proxy on the Express app and return the bearer-auth middleware for `/mcp`.
 *
 * @param app - The Express app (OAuth + discovery routes are mounted on it).
 * @param credentials - XSUAA service credentials.
 * @param appUrl - calmcp's public base URL (for OAuth metadata + callback).
 * @param logger - Application logger.
 * @returns The bearer-auth middleware to place before the `/mcp` handler.
 */
export function mountXsuaaAuth(
  app: Express,
  credentials: XsuaaCredentials,
  appUrl: string,
  logger: Logger,
): RequestHandler {
  const { provider, clientStore, stateCodec } = createXsuaaOAuthProvider(
    credentials,
    appUrl,
    logger,
  );
  const verifier = createXsuaaTokenVerifier(credentials, logger);

  // The 401 WWW-Authenticate header points clients at the protected-resource metadata for discovery.
  const resourceMetadataUrl = `${appUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
  const bearerAuth = requireBearerAuth({
    verifier: { verifyAccessToken: verifier },
    resourceMetadataUrl,
  });

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
      resourceName: 'calmcp — SAP Cloud ALM MCP Server',
    }),
  );

  logger.info({ xsappname: credentials.xsappname, appUrl }, 'XSUAA OAuth proxy enabled on /mcp');
  return bearerAuth;
}
