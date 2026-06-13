// Local / stdio authentication: OAuth2 client-credentials for productive tenants, or a static
// API key for sandbox mode. Tokens are cached in memory and refreshed shortly before expiry.

import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { AuthError } from '../errors.js';
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

  /** Return a cached token if still valid, otherwise fetch a fresh one. */
  private async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    return this.fetchToken();
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
      throw new AuthError(`Token request failed with status ${response.status}: ${body}`);
    }

    const data = (await response.json()) as TokenResponse;
    // Treat the token as expired a configurable buffer before the server's stated expiry.
    const expiresAt = Date.now() + data.expires_in * 1000 - this.config.tokenBufferMs();
    this.cached = { token: data.access_token, expiresAt };

    this.logger.debug({ expiresAt }, 'OAuth2 token acquired');
    return data.access_token;
  }
}
