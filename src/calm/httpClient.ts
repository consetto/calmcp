// Shared HTTP client for the read-only SAP Cloud ALM services.
//
// One instance is bound to a single Cloud ALM service (e.g. "features"). It resolves auth per
// request via the configured `AuthProvider`, performs GET requests, and maps non-success
// responses to `ApiError` — recognising the OData v4 structured error body when present.

import type { Logger } from 'pino';
import type { AuthProvider } from '../auth/index.js';
import { SERVICE_PATHS, type ServiceName } from '../config.js';
import { ApiError } from '../errors.js';

/** Maximum characters of a response body to include in debug logs. */
const MAX_BODY_LOG_CHARS = 500;

/** Options shared by every HTTP client instance. */
export interface HttpClientOptions {
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Application logger (debug level traces requests and responses). */
  logger: Logger;
}

/** The shape of an OData v4 error response body. */
interface ODataErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * HTTP client for one Cloud ALM service. Read-only: it exposes GET helpers only.
 */
export class CalmHttpClient {
  private readonly auth: AuthProvider;
  private readonly service: ServiceName;
  private readonly options: HttpClientOptions;

  /**
   * @param auth - Provider resolving the base URL and auth headers.
   * @param service - The Cloud ALM service this client targets.
   * @param options - Shared HTTP options (timeout, logger).
   */
  constructor(auth: AuthProvider, service: ServiceName, options: HttpClientOptions) {
    this.auth = auth;
    this.service = service;
    this.options = options;
  }

  /**
   * GET a resource and parse the JSON response.
   *
   * @typeParam T - The expected response type.
   * @param endpoint - Service-relative path beginning with `/` (e.g. `/Features`).
   * @param query - Optional query string including the leading `?`.
   * @returns The parsed response body.
   * @throws {ApiError} On a non-success status or an unparseable body.
   * @throws {AuthError} If authentication cannot be resolved.
   */
  async get<T>(endpoint: string, query = ''): Promise<T> {
    const { baseUrl, headers } = await this.auth.authorize();
    const url = `${baseUrl}${SERVICE_PATHS[this.service]}${endpoint}${query}`;

    this.options.logger.debug({ url }, 'GET request');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { ...headers, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // Network failure / timeout — never produced a response. Surface as an ApiError (status 0).
      throw new ApiError(`HTTP request error: ${(error as Error).message}`, 0);
    }

    return this.handleResponse<T>(response, url);
  }

  /** Parse a successful body, or convert a failure into the most specific `ApiError`. */
  private async handleResponse<T>(response: Response, url: string): Promise<T> {
    const body = await response.text();

    if (response.ok) {
      if (this.options.logger.isLevelEnabled('debug')) {
        const preview =
          body.length > MAX_BODY_LOG_CHARS
            ? `${body.slice(0, MAX_BODY_LOG_CHARS)}...(truncated)`
            : body;
        this.options.logger.debug({ response: preview }, 'response received');
      }
      // Some endpoints (e.g. 204) legitimately return an empty body.
      if (body.length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(body) as T;
      } catch (error) {
        throw new ApiError(
          `Failed to parse response from ${url}: ${(error as Error).message}`,
          response.status,
        );
      }
    }

    this.options.logger.debug({ status: response.status, body }, 'error response');
    throw parseErrorResponse(response.status, body);
  }
}

/**
 * Convert an error response body into an `ApiError`, preferring the OData structured form.
 *
 * @param status - HTTP status code.
 * @param body - Raw response body text.
 * @returns An `ApiError` carrying the status and any OData code/message.
 */
export function parseErrorResponse(status: number, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as ODataErrorBody;
    if (parsed.error?.code && parsed.error?.message) {
      return ApiError.odata(status, parsed.error.code, parsed.error.message);
    }
  } catch {
    // Not JSON / not an OData error envelope — fall through to a plain HTTP error.
  }
  return ApiError.http(status, body);
}
