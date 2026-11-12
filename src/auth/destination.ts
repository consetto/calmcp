// SAP BTP authentication: resolve the Cloud ALM host and auth token from a bound Destination.
//
// The Destination service holds the target URL and the OAuth2 client-credentials configuration,
// so calmcp does not handle tenant secrets itself when deployed on BTP. The Cloud SDK fetches and
// caches tokens; `buildHeadersForDestination` returns ready-to-use auth headers.
//
// Renewal after a 401: the Cloud SDK caches a destination together with its token until the token
// expires, and a lookup with `useCache: false` is not written back to that cache. So after Cloud
// ALM refused a token (e.g. the client secret was rotated), the cache keeps answering with the
// refused one. This provider remembers which headers were refused, fetches the destination afresh
// whenever the cache still returns them, and keeps the fresh result until its token expires.

import {
  buildHeadersForDestination,
  type Destination,
  getDestination,
} from '@sap-cloud-sdk/connectivity';
import type { Logger } from 'pino';
import { AuthError } from '../errors.js';
import type { AuthContext, AuthProvider } from './index.js';

/** How long a renewed destination is kept when its token states no lifetime. */
const RENEWED_FALLBACK_MS = 5 * 60_000;
/** Margin before a renewed token's stated expiry at which it is no longer used. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Resolves auth from a bound BTP Destination.
 */
export class DestinationAuthProvider implements AuthProvider {
  private readonly destinationName: string;
  private readonly logger: Logger;
  /** The headers Cloud ALM last refused (401), as compared by {@link headerKey}. */
  private refused?: string;
  /** A destination fetched past the cache after a refusal, used until its token expires. */
  private renewed?: { context: AuthContext; expiresAt: number };
  /** The uncached lookup in flight, shared by every call that needs it meanwhile. */
  private renewing?: Promise<AuthContext>;

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
    if (this.renewed && Date.now() < this.renewed.expiresAt) {
      return this.renewed.context;
    }
    this.renewed = undefined;

    const cached = await this.resolve(true);
    if (this.refused === undefined || headerKey(cached.context) !== this.refused) {
      return cached.context;
    }
    // The cache still holds the token Cloud ALM refused. Calls arriving meanwhile wait for the same
    // lookup instead of each asking the Destination service.
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /**
   * Remember that Cloud ALM refused these headers (401). Only the refused headers are forgotten: a
   * late 401 from a request that left before a renewal does not discard the fresh token.
   *
   * @param refused - The context the refused request was sent with.
   */
  invalidate(refused: AuthContext): void {
    const key = headerKey(refused);
    this.refused = key;
    if (this.renewed && headerKey(this.renewed.context) === key) {
      this.renewed = undefined;
    }
  }

  /** Fetch the destination past the Cloud SDK cache and keep it until its token expires. */
  private async renew(): Promise<AuthContext> {
    this.logger.debug({ destination: this.destinationName }, 'renewing refused destination token');
    const { context, expiresInSeconds } = await this.resolve(false);
    const lifetime =
      expiresInSeconds !== undefined
        ? Math.max(0, expiresInSeconds * 1000 - EXPIRY_MARGIN_MS)
        : RENEWED_FALLBACK_MS;
    this.renewed = { context, expiresAt: Date.now() + lifetime };
    return context;
  }

  /** Look the destination up and turn it into a request context. */
  private async resolve(
    useCache: boolean,
  ): Promise<{ context: AuthContext; expiresInSeconds?: number }> {
    this.logger.debug({ destination: this.destinationName, useCache }, 'resolving destination');
    const destination = await getDestination({ destinationName: this.destinationName, useCache });
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
    return { context: { baseUrl, headers }, expiresInSeconds: tokenLifetime(destination) };
  }
}

/** The stated lifetime of the destination's first token in seconds, when it has one. */
function tokenLifetime(destination: Destination): number | undefined {
  const raw = destination.authTokens?.[0]?.expiresIn;
  const seconds = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** A comparable form of the headers a request was authenticated with. */
function headerKey(context: AuthContext): string {
  return JSON.stringify(Object.entries(context.headers).sort(([a], [b]) => a.localeCompare(b)));
}
