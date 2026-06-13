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

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }

  /** A non-success HTTP response that was not a structured OData error. */
  static http(status: number, body: string): ApiError {
    return new ApiError(`HTTP error ${status}: ${body}`, status);
  }

  /** A structured OData v4 error body (`{ error: { code, message } }`). */
  static odata(status: number, code: string, message: string): ApiError {
    return new ApiError(`OData error [${code}]: ${message}`, status);
  }
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
