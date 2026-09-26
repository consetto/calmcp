// Unified error types for the calmcp SAP Cloud ALM MCP server.
//
// A small TypeScript class hierarchy covering configuration, authentication and API failures.
// The MCP SDK surfaces thrown errors to the client, so each error carries a stable,
// human-readable message.

/**
 * Base class for every error raised inside calmcp.
 *
 * The distinct API failure modes are modelled as subclasses, so call sites can branch on them
 * with `instanceof` instead of inspecting message strings.
 */
export class CalmError extends Error {
  override readonly name: string = 'CalmError';

  constructor(message: string) {
    super(message);
    // Restore the prototype chain — required when targeting ES2022 from TypeScript so that
    // `instanceof` works across subclasses (a well-known TS/Babel transpilation caveat).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Configuration could not be loaded or validated. */
export class ConfigError extends CalmError {
  override readonly name = 'ConfigError';

  /** A required configuration field is missing (e.g. "tenant"). */
  static missingField(field: string): ConfigError {
    return new ConfigError(`Missing required field: ${field}`);
  }

  /** A field is present but invalid (e.g. an unknown region). */
  static invalid(detail: string): ConfigError {
    return new ConfigError(`Invalid configuration: ${detail}`);
  }

  /** A write was attempted while calmcp runs in its default read-only mode. */
  static writeDisabled(): ConfigError {
    return new ConfigError(
      'Write access is disabled: calmcp is read-only unless CALM_WRITE_ENABLED=true is set.',
    );
  }
}

/** Authentication / token acquisition failed. */
export class AuthError extends CalmError {
  override readonly name = 'AuthError';
}

/**
 * An API request failed. Keeps the HTTP status and (for OData) the structured error code/message
 * so callers and the MCP client see actionable detail.
 */
export class ApiError extends CalmError {
  override readonly name = 'ApiError';

  /** HTTP status code returned by Cloud ALM (0 when the request never completed). */
  readonly status: number;

  /** Why a request never completed (status 0): no connection, the timeout, or the caller. */
  readonly transport?: 'network' | 'timeout' | 'cancelled';

  /** Seconds the service asked to wait before retrying (`Retry-After`), when it said. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    details: { transport?: ApiError['transport']; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.status = status;
    this.transport = details.transport;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  /** A non-success HTTP response that was not a structured OData error. */
  static http(status: number, body: string, retryAfterSeconds?: number): ApiError {
    return new ApiError(`HTTP error ${status}: ${summarizeBody(body)}`, status, {
      retryAfterSeconds,
    });
  }

  /** A structured OData v4 error body (`{ error: { code, message } }`). */
  static odata(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ): ApiError {
    return new ApiError(`OData error [${code}]: ${summarizeBody(message)}`, status, {
      retryAfterSeconds,
    });
  }
}

/** Characters of an upstream body kept in an error message. */
const MAX_ERROR_BODY_CHARS = 500;

/**
 * Shorten an upstream response body for an error message. Gateways answer with whole HTML pages;
 * those reach the model and the logs, so markup is stripped and the text capped.
 *
 * @param body - The raw body.
 * @param max - Maximum characters to keep.
 * @returns Plain text of at most `max` characters (plus a truncation marker).
 */
export function summarizeBody(body: string, max = MAX_ERROR_BODY_CHARS): string {
  const text = /<[a-z!/][^>]*>/i.test(body)
    ? body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    : body;
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…(truncated)` : compact;
}

/** Machine-readable error codes a tool result carries, so a client can branch without parsing. */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'CANCELLED'
  | 'AUTH'
  | 'CONFIG'
  | 'INTERNAL';

/** The structured body of an error tool result. */
export interface ErrorInfo {
  error: ErrorCode;
  /** Whether the same call may succeed if simply repeated later. */
  retryable: boolean;
  /** The Cloud ALM HTTP status, when there was a response. */
  status?: number;
  message: string;
  /** What to do next, when there is something better than retrying. */
  hint?: string;
}

/**
 * Classify a thrown value for an error tool result.
 *
 * @param error - The caught value.
 * @returns Code, retryability and message; never throws.
 */
export function describeError(error: unknown): ErrorInfo {
  const message = errorMessage(error);
  if (error instanceof ApiError) return describeApiError(error, message);
  if (error instanceof AuthError) {
    return {
      error: 'AUTH',
      retryable: false,
      message,
      hint: 'calmcp could not obtain a Cloud ALM token; the operator must check its credentials.',
    };
  }
  if (error instanceof ConfigError) return { error: 'CONFIG', retryable: false, message };
  return { error: 'INTERNAL', retryable: false, message };
}

/** Map an HTTP status (or a transport failure) to a code. */
function describeApiError(error: ApiError, message: string): ErrorInfo {
  const { status } = error;
  if (status === 0) {
    if (error.transport === 'cancelled') return { error: 'CANCELLED', retryable: false, message };
    if (error.transport === 'timeout') return { error: 'TIMEOUT', retryable: true, message };
    return { error: 'NETWORK', retryable: true, message };
  }
  const base = { status, message };
  if (status === 401) return { ...base, error: 'UNAUTHORIZED', retryable: false };
  if (status === 403) {
    return {
      ...base,
      error: 'FORBIDDEN',
      retryable: false,
      hint: 'The Cloud ALM user behind calmcp lacks the API scope for this resource.',
    };
  }
  if (status === 404) {
    return {
      ...base,
      error: 'NOT_FOUND',
      retryable: false,
      hint: 'Check the id, e.g. by listing the parent collection with calm_list.',
    };
  }
  if (status === 409) return { ...base, error: 'CONFLICT', retryable: false };
  if (status === 408 || status === 504) return { ...base, error: 'TIMEOUT', retryable: true };
  if (status === 429) {
    return {
      ...base,
      error: 'RATE_LIMITED',
      retryable: true,
      ...(error.retryAfterSeconds !== undefined
        ? { hint: `Cloud ALM asked to wait ${Math.ceil(error.retryAfterSeconds)} s.` }
        : {}),
    };
  }
  if (status >= 500) return { ...base, error: 'UPSTREAM_ERROR', retryable: true };
  return { ...base, error: 'BAD_REQUEST', retryable: false };
}

/**
 * Convert any thrown value into a plain message string suitable for an MCP tool error result.
 *
 * @param error - The caught value (may be a `CalmError`, a native `Error`, or anything).
 * @returns A human-readable message; never throws.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof CalmError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
