// SAP BTP authentication: resolve the Cloud ALM host and auth token from a bound Destination.
//
// The Destination service holds the target URL and the OAuth2 client-credentials configuration,
// so calmcp does not handle tenant secrets itself when deployed on BTP. The Cloud SDK fetches and
// caches tokens; `buildHeadersForDestination` returns ready-to-use auth headers.

import { buildHeadersForDestination, getDestination } from '@sap-cloud-sdk/connectivity';
import type { Logger } from 'pino';
import { AuthError } from '../errors.js';
import type { AuthContext, AuthProvider } from './index.js';

/**
 * Resolves auth from a bound BTP Destination.
 */
export class DestinationAuthProvider implements AuthProvider {
  private readonly destinationName: string;
  private readonly logger: Logger;

  /**
   * @param destinationName - Name of the bound Destination pointing at the Cloud ALM API.
   * @param logger - Application logger.
   */
  constructor(destinationName: string, logger: Logger) {
    this.destinationName = destinationName;
    this.logger = logger;
  }

  /** @inheritdoc */
  async authorize(): Promise<AuthContext> {
    this.logger.debug({ destination: this.destinationName }, 'resolving destination');

    const destination = await getDestination({ destinationName: this.destinationName });
    if (!destination) {
      throw new AuthError(`Destination '${this.destinationName}' not found`);
    }
    if (!destination.url) {
      throw new AuthError(`Destination '${this.destinationName}' has no URL`);
    }

    // The Cloud SDK resolves OAuth2 tokens and returns them as request headers.
    const headers = await buildHeadersForDestination(destination);

    // The Destination URL is the Cloud ALM API base; service path suffixes are appended to it.
    // Strip any trailing slash so URL composition stays consistent.
    const baseUrl = destination.url.replace(/\/$/, '');
    return { baseUrl, headers };
  }
}
