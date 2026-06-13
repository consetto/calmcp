// Configuration management for the calmcp SAP Cloud ALM MCP server.
//
// calmcp is configured from environment variables so it runs cleanly both locally (stdio) and on
// SAP BTP Cloud Foundry. On BTP the API host and OAuth token are normally supplied by a bound
// Destination instead of these variables (see `auth/`).

import { ConfigError } from './errors.js';

/** Sandbox API base URL for SAP Cloud ALM (SAP Business Accelerator Hub). */
const SANDBOX_BASE_URL = 'https://sandbox.api.sap.com/SAPCALM';

/** Regions accepted for productive (OAuth2) tenants. */
const VALID_REGIONS = [
  'eu10',
  'eu20',
  'us10',
  'ap10',
  'jp10',
  'eu10-004',
  'ca10',
  'eu11',
  'cn20',
] as const;

/**
 * Per-service path suffixes appended to the API base (after the `/api` prefix in productive mode).
 * Verified against the OpenAPI specs in `YAML/`. The `key` is the internal service name used by
 * the `calm/` clients.
 */
export const SERVICE_PATHS = {
  features: '/calm-features/v1',
  documents: '/calm-documents/v1',
  tasks: '/calm-tasks/v1',
  projects: '/calm-projects/v1',
  testmanagement: '/calm-testmanagement/v1',
  processhierarchy: '/calm-processhierarchy/v1',
  analytics: '/calm-analytics/v1/odata/v4/analytics',
  bsm: '/bsm-service/v1',
  landscape: '/calm-landscape/v1',
  xlibApplications: '/calm-crosslibraryapplications/v1',
  xlibConfigurations: '/calm-crosslibraryconfigurations/v1',
  xlibDevelopments: '/calm-crosslibrarydevelopments/v1',
  xlibInterfaces: '/calm-crosslibraryinterfaces/v1',
} as const;

/** Name of a `calm/` service whose base URL can be built. */
export type ServiceName = keyof typeof SERVICE_PATHS;

/** Raw configuration values, after reading the environment. */
export interface ConfigValues {
  /** Sandbox mode — use a static API key instead of OAuth2. */
  sandbox: boolean;
  /** API key for sandbox mode (required when `sandbox` is true). */
  apiKey?: string;
  /** SAP Cloud ALM tenant identifier (e.g. "my-company-calm"); required in OAuth2 mode. */
  tenant?: string;
  /** SAP Cloud ALM region (e.g. "eu10"); required in OAuth2 mode. */
  region?: string;
  /** OAuth2 client ID from the service binding; required in OAuth2 mode. */
  clientId?: string;
  /** OAuth2 client secret from the service binding; required in OAuth2 mode. */
  clientSecret?: string;
  /** Enable verbose request/response tracing. */
  debug: boolean;
  /** HTTP request timeout in seconds. */
  timeoutSeconds: number;
  /** Buffer before token expiry at which a refresh is forced, in seconds. */
  tokenRefreshBufferSeconds: number;
  /** Name of the bound BTP Destination pointing at the Cloud ALM API (optional, BTP only). */
  destinationName?: string;
}

/**
 * Validated configuration with URL-building helpers.
 *
 * Construct via {@link Config.fromEnv}. The constructor assumes values have already been
 * validated; {@link Config.validate} establishes that invariant.
 */
export class Config {
  readonly sandbox: boolean;
  readonly apiKey?: string;
  readonly tenant?: string;
  readonly region?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly debug: boolean;
  readonly timeoutSeconds: number;
  readonly tokenRefreshBufferSeconds: number;
  readonly destinationName?: string;

  constructor(values: ConfigValues) {
    this.sandbox = values.sandbox;
    this.apiKey = values.apiKey;
    this.tenant = values.tenant;
    this.region = values.region;
    this.clientId = values.clientId;
    this.clientSecret = values.clientSecret;
    this.debug = values.debug;
    this.timeoutSeconds = values.timeoutSeconds;
    this.tokenRefreshBufferSeconds = values.tokenRefreshBufferSeconds;
    this.destinationName = values.destinationName;
  }

  /**
   * Build and validate configuration from a record of environment variables.
   *
   * @param env - Environment map (defaults to `process.env`).
   * @returns A validated {@link Config}.
   * @throws {ConfigError} If a required field is missing or a value is invalid.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
    const sandbox = parseBool(env.CALM_SANDBOX);
    const values: ConfigValues = {
      sandbox,
      apiKey: env.CALM_API_KEY?.trim() || undefined,
      tenant: env.CALM_TENANT?.trim() || undefined,
      region: env.CALM_REGION?.trim() || undefined,
      clientId: env.CALM_CLIENT_ID?.trim() || undefined,
      clientSecret: env.CALM_CLIENT_SECRET?.trim() || undefined,
      debug: parseBool(env.CALM_DEBUG),
      timeoutSeconds: parseNumber(env.CALM_TIMEOUT_SECONDS, 30),
      tokenRefreshBufferSeconds: parseNumber(env.CALM_TOKEN_REFRESH_BUFFER_SECONDS, 5),
      destinationName: env.CALM_DESTINATION_NAME?.trim() || undefined,
    };

    const config = new Config(values);
    config.validate();
    return config;
  }

  /**
   * Validate that the configuration is internally consistent.
   *
   * When a Destination is configured we defer credential validation to the Destination service,
   * so only the API-key / OAuth2 local modes are checked here.
   *
   * @throws {ConfigError} If a required field is missing or the region is unknown.
   */
  validate(): void {
    // When a destination is bound, credentials come from BTP — nothing else to validate locally.
    if (this.destinationName) {
      return;
    }

    if (this.sandbox) {
      if (!this.apiKey) {
        throw ConfigError.missingField('api_key (required in sandbox mode)');
      }
      return;
    }

    // OAuth2 mode: tenant, region, client_id and client_secret are all required.
    if (!this.tenant) throw ConfigError.missingField('tenant');
    if (!this.region) throw ConfigError.missingField('region');
    if (!this.clientId) throw ConfigError.missingField('client_id');
    if (!this.clientSecret) throw ConfigError.missingField('client_secret');

    if (!(VALID_REGIONS as readonly string[]).includes(this.region)) {
      throw ConfigError.invalid(
        `Invalid region '${this.region}'. Valid regions: ${VALID_REGIONS.join(', ')}`,
      );
    }
  }

  /**
   * The OAuth2 token endpoint URL, or `undefined` in sandbox mode.
   *
   * @returns The token URL for productive tenants.
   */
  tokenUrl(): string | undefined {
    if (this.sandbox) {
      return undefined;
    }
    return `https://${this.tenant}.authentication.${this.region}.hana.ondemand.com/oauth/token`;
  }

  /**
   * The API base URL including the `/api` prefix (productive) or the sandbox base (no prefix).
   * Each service path from {@link SERVICE_PATHS} is appended to this.
   *
   * @returns The base URL the `calm/` clients build service URLs from.
   */
  apiBaseUrl(): string {
    if (this.sandbox) {
      return SANDBOX_BASE_URL;
    }
    return `https://${this.tenant}.${this.region}.alm.cloud.sap/api`;
  }

  /**
   * Full base URL for a single Cloud ALM service.
   *
   * @param service - The service name.
   * @returns e.g. `https://acme.eu10.alm.cloud.sap/api/calm-features/v1`.
   */
  serviceUrl(service: ServiceName): string {
    return `${this.apiBaseUrl()}${SERVICE_PATHS[service]}`;
  }

  /** Request timeout as milliseconds (undici/fetch use ms). */
  timeoutMs(): number {
    return this.timeoutSeconds * 1000;
  }

  /** Token refresh buffer as milliseconds. */
  tokenBufferMs(): number {
    return this.tokenRefreshBufferSeconds * 1000;
  }
}

/** Parse a boolean env var ("true"/"1"/"yes" → true). */
function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Parse a numeric env var, falling back to `fallback` when empty or invalid. */
function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
