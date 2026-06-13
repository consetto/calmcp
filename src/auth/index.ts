// Authentication abstraction for calmcp.
//
// A provider resolves, per request, the API base URL and the HTTP headers needed to call SAP
// Cloud ALM. Two implementations exist:
//   - `clientCredentials.ts` — local/stdio: OAuth2 client-credentials, or a static sandbox API key.
//   - `destination.ts`       — SAP BTP: a bound Destination supplies both the host and the token.
//
// Keeping this an interface means the `calm/` HTTP clients are agnostic to where auth comes from.

/**
 * Everything an HTTP client needs to authenticate one request.
 */
export interface AuthContext {
  /**
   * API base URL including the `/api` prefix (productive), the sandbox base, or the Destination
   * URL. Per-service path suffixes from `SERVICE_PATHS` are appended to this.
   */
  baseUrl: string;
  /** Authentication headers (e.g. `Authorization: Bearer …` or `APIKey: …`). */
  headers: Record<string, string>;
}

/**
 * Resolves authentication for outbound Cloud ALM requests.
 */
export interface AuthProvider {
  /**
   * Resolve the base URL and auth headers for the next request, refreshing tokens as needed.
   *
   * @returns The {@link AuthContext} to apply to the request.
   * @throws {AuthError} If a token cannot be obtained.
   */
  authorize(): Promise<AuthContext>;
}

// Imports for the factory live below the interface so the public type stays at the top of the file.
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ClientCredentialsAuthProvider } from './clientCredentials.js';
import { DestinationAuthProvider } from './destination.js';

/**
 * Select the appropriate auth provider for the current environment.
 *
 * A bound Destination (BTP) takes precedence; otherwise local OAuth2 / sandbox credentials are used.
 *
 * @param config - Validated configuration.
 * @param logger - Application logger.
 * @returns The chosen {@link AuthProvider}.
 */
export function createAuthProvider(config: Config, logger: Logger): AuthProvider {
  if (config.destinationName) {
    logger.debug({ destination: config.destinationName }, 'using destination auth');
    return new DestinationAuthProvider(config.destinationName, logger);
  }
  logger.debug({ sandbox: config.sandbox }, 'using local credentials auth');
  return new ClientCredentialsAuthProvider(config, logger);
}
