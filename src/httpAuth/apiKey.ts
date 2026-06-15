// Static API-key bearer verification for the HTTP transport.
//
// A simple shared-secret guard for `/mcp`: the caller presents `Authorization: Bearer <key>` and we
// compare it (constant-time) against the configured key. This authenticates a caller (e.g. a
// Microsoft Copilot Studio agent or a CI job), not an end user — every request still reads SAP Cloud
// ALM as the bound Destination's technical identity. For per-user identity, use the XSUAA OAuth path.

import crypto from 'node:crypto';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Logger } from 'pino';
import { READ_SCOPE } from './xsuaa.js';

/** Client id reported for API-key callers (shows up in logs / request context). */
const API_KEY_CLIENT_ID = 'api-key';

/** API-key "tokens" don't expire; report a far-future expiry (the MCP SDK requires one). */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Create a verifier that accepts a single static API key.
 *
 * @returns A verifier for the MCP SDK's `requireBearerAuth`. Throws `InvalidTokenError` when the
 *   presented token does not match the configured key. Comparison is constant-time (both sides are
 *   SHA-256 hashed first, so neither the value nor its length leaks via timing).
 */
export function createApiKeyVerifier(
  apiKey: string,
  logger: Logger,
): (token: string) => Promise<AuthInfo> {
  if (!apiKey) {
    throw new Error('createApiKeyVerifier requires a non-empty apiKey');
  }
  const expectedHash = crypto.createHash('sha256').update(apiKey, 'utf8').digest();

  return async (token: string): Promise<AuthInfo> => {
    const actualHash = crypto.createHash('sha256').update(token, 'utf8').digest();
    if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
      throw new InvalidTokenError('Invalid API key');
    }
    logger.debug('HTTP API key accepted');
    return {
      token,
      clientId: API_KEY_CLIENT_ID,
      scopes: [READ_SCOPE],
      expiresAt: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
      extra: { auth: 'api-key' },
    };
  };
}
