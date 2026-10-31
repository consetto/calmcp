// Local / stdio authentication: OAuth2 client-credentials for productive tenants, or a static
// API key for sandbox mode. Tokens are cached in memory and refreshed shortly before expiry.

import type { Logger } from 'pino';
// undici's fetch, not the global one — see the note in `calm/httpClient.ts`.
import { fetch, type Response } from 'undici';
import type { Config } from '../config.js';
import { AuthError, summarizeBody } from '../errors.js';
import type { AuthContext, AuthProvider } from './index.js';

/** An OAuth2 token response from the SAP authorization server. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** A cached token plus the epoch-millis timestamp at which it should be considered expired. */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Resolves auth from local configuration.
 *
 * - Sandbox mode returns the static API key as an `APIKey` header.
 * - Productive mode performs the OAuth2 client-credentials grant and caches the bearer token.
 */
export class ClientCredentialsAuthProvider implements AuthProvider {
  private readonly config: Config;
  private readonly logger: Logger;
  private cached?: CachedToken;
  /** The token request in flight, shared by every call that needs a token meanwhile. */
  private pending?: Promise<string>;

  /**
   * @param config - Validated configuration (sandbox or OAuth2).
   * @param logger - Application logger.
   */
  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** @inheritdoc */
  async authorize(): Promise<AuthContext> {
    const baseUrl = this.config.apiBaseUrl();

    if (this.config.sandbox) {
      if (!this.config.apiKey) {
        throw new AuthError('No API key configured for sandbox mode');
      }
      return { baseUrl, headers: { APIKey: this.config.apiKey } };
    }

    const token = await this.getToken();
    return { baseUrl, headers: { Authorization: `Bearer ${token}` } };
  }

  /** @inheritdoc */
  invalidate(refused: AuthContext): void {
    if (this.cached && refused.headers.Authorization === `Bearer ${this.cached.token}`) {
      this.cached = undefined;
    }
  }

  /**
   * Return a cached token if still valid, otherwise fetch a fresh one. Calls arriving while a fetch
   * is running wait for it instead of starting their own.
   */
  private async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Perform the OAuth2 client-credentials grant and cache the result. */
  private async fetchToken(): Promise<string> {
    const tokenUrl = this.config.tokenUrl();
    if (!tokenUrl) {
      throw new AuthError('No token URL available outside of OAuth2 mode');
    }

    // HTTP Basic auth header: base64(client_id:client_secret).
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );

    this.logger.debug({ url: tokenUrl }, 'fetching OAuth2 token');

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.config.timeoutMs()),
      });
    } catch (error) {
      throw new AuthError(`Token request error: ${(error as Error).message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AuthError(
        `Token request failed with status ${response.status}: ${tokenErrorDetail(body)}`,
      );
    }

    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch (error) {
      throw new AuthError(`Token response could not be read: ${(error as Error).message}`);
    }
    if (typeof data?.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw new AuthError('Token response has no access_token and expires_in');
    }
    // Treat the token as expired a configurable buffer before the server's stated expiry.
    const expiresAt = Date.now() + data.expires_in * 1000 - this.config.tokenBufferMs();
    this.cached = { token: data.access_token, expiresAt };

    this.logger.debug({ expiresAt }, 'OAuth2 token acquired');
    return data.access_token;
  }
}

/**
 * The useful part of a token endpoint error: the OAuth `error`/`error_description` pair when the
 * body is JSON, otherwise a short plain-text summary.
 */
function tokenErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === 'string') {
      return typeof parsed.error_description === 'string'
        ? `${parsed.error}: ${summarizeBody(parsed.error_description)}`
        : parsed.error;
    }
  } catch {
    // Not JSON; fall through to the plain-text summary.
  }
  return summarizeBody(body);
}
