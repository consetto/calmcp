// Configuration management for the calmcp SAP Cloud ALM MCP server.
//
// calmcp is configured from environment variables so it runs cleanly both locally (stdio) and on
// SAP BTP Cloud Foundry. On BTP the API host and OAuth token are normally supplied by a bound
// Destination instead of these variables (see `auth/`).

import { ConfigError } from './errors.js';
import { redirectPatterns } from './transport/redirects.js';

/** Sandbox API base URL for SAP Cloud ALM (SAP Business Accelerator Hub). */
const SANDBOX_BASE_URL = 'https://sandbox.api.sap.com/SAPCALM';

/**
 * Default cap on a serialized tool result, in bytes.
 *
 * An unprojected list of a few hundred tasks runs to ~260 KB (see `tools/shape.ts`), which several
 * agent hosts silently cut mid-JSON. 100 KB leaves ample room for a legitimately large list while
 * staying well inside the limits those hosts impose.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 100_000;

/** Regions accepted for productive (OAuth2) tenants. */
const VALID_REGIONS = [
  'eu10',
  'eu20',
  'us10',
  'us20',
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
  processManagement: '/calm-processmanagement/v1',
  processAuthoring: '/calm-processauthoring/v1',
  testPlans: '/calm-testmanagement-testplans/v1',
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
  /**
   * Maximum size of a serialized tool result in bytes. Beyond this calmcp returns an explicit
   * summary instead of the payload, rather than letting the AI client truncate the JSON itself.
   * Defaults to {@link DEFAULT_MAX_RESPONSE_BYTES} when omitted.
   */
  maxResponseBytes?: number;
  /**
   * Enable the create-only write tool (`calm_create`). Off by default: calmcp stays read-only unless
   * an operator turns this on deliberately via `CALM_WRITE_ENABLED=true`.
   */
  writeEnabled?: boolean;
  /**
   * Enable the update tool (`calm_update`), which changes fields of existing objects. Off by
   * default and separate from `writeEnabled`: changing a record can lose what creating one cannot.
   */
  updateEnabled?: boolean;
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
  readonly maxResponseBytes: number;
  readonly writeEnabled: boolean;
  readonly updateEnabled: boolean;

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
    this.maxResponseBytes = values.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.writeEnabled = values.writeEnabled ?? false;
    this.updateEnabled = values.updateEnabled ?? false;
  }

  /**
   * Build and validate configuration from a record of environment variables.
   *
   * @param env - Environment map (defaults to `process.env`).
   * @returns A validated {@link Config}.
   * @throws {ConfigError} If a required field is missing or a value is invalid.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
    const sandbox = parseBool(env, 'CALM_SANDBOX');
    const values: ConfigValues = {
      sandbox,
      apiKey: env.CALM_API_KEY?.trim() || undefined,
      tenant: env.CALM_TENANT?.trim() || undefined,
      region: env.CALM_REGION?.trim() || undefined,
      clientId: env.CALM_CLIENT_ID?.trim() || undefined,
      clientSecret: env.CALM_CLIENT_SECRET?.trim() || undefined,
      debug: parseBool(env, 'CALM_DEBUG'),
      // A timeout of 0 would end every request at once; one beyond 10 minutes outlasts any client.
      timeoutSeconds: parseNumber(env, 'CALM_TIMEOUT_SECONDS', 30, { min: 1, max: 600 }),
      tokenRefreshBufferSeconds: parseNumber(env, 'CALM_TOKEN_REFRESH_BUFFER_SECONDS', 5, {
        min: 0,
        max: 3600,
      }),
      destinationName: env.CALM_DESTINATION_NAME?.trim() || undefined,
      // Below 1000 bytes not even the summary of a withheld result fits.
      maxResponseBytes: parseNumber(env, 'CALM_MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES, {
        min: 1000,
        integer: true,
      }),
      writeEnabled: parseBool(env, 'CALM_WRITE_ENABLED'),
      updateEnabled: parseBool(env, 'CALM_UPDATE_ENABLED'),
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

    // The tenant becomes part of the token and API hostnames; anything beyond a DNS label could
    // redirect the client secret to another host.
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(this.tenant)) {
      throw ConfigError.invalid(`Invalid tenant '${this.tenant}': expected the subdomain only`);
    }
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

/**
 * The trimmed value of a variable, or undefined when it is unset, empty, or a placeholder the host
 * left unfilled. The MCPB bundle passes its settings as `${user_config.<name>}`; a host that leaves
 * one in place would otherwise stop the server that used to start with the default.
 */
function setValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && !/^\$\{[^}]*\}$/.test(value) ? value : undefined;
}

/** Values accepted as true and as false; anything else is a startup error. */
const TRUE_VALUES = ['true', '1', 'yes'];
const FALSE_VALUES = ['false', '0', 'no'];

/**
 * Read a boolean environment variable. Unset or empty is false. Any other value outside the
 * accepted ones is refused rather than read as false: `CALM_WRITE_ENABLED=ture` would otherwise
 * start a read-only server that looks configured for writes.
 *
 * @param env - The environment.
 * @param name - The variable.
 * @returns The value.
 * @throws {ConfigError} On a value that is neither true nor false.
 */
export function parseBool(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = setValue(env, name)?.toLowerCase();
  if (!value) return false;
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw ConfigError.invalid(
    `${name} must be true or false (also accepted: 1/0, yes/no), not '${env[name]}'`,
  );
}

/**
 * Read a numeric environment variable. Unset or empty gives the default. A value that is not a
 * number, or outside the range, is refused rather than replaced by the default: the operator set it
 * for a reason, and running with a different value than the one configured is the wrong-but-plausible
 * failure calmcp avoids elsewhere.
 *
 * @param env - The environment.
 * @param name - The variable.
 * @param fallback - The default.
 * @param range - Inclusive bounds, and whether only whole numbers are accepted.
 * @returns The value.
 * @throws {ConfigError} On a malformed or out-of-range value.
 */
export function parseNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = setValue(env, name);
  if (!raw) return fallback;
  const n = Number(raw);
  const bounds =
    range.max !== undefined
      ? `between ${range.min ?? 0} and ${range.max}`
      : `at least ${range.min ?? 0}`;
  if (!Number.isFinite(n) || (range.integer && !Number.isInteger(n))) {
    throw ConfigError.invalid(
      `${name} must be ${range.integer ? 'a whole number' : 'a number'} ${bounds}, not '${raw}'`,
    );
  }
  if ((range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max)) {
    throw ConfigError.invalid(`${name} must be ${bounds}, not ${raw}`);
  }
  return n;
}

/** Default HTTP port when neither `--port` nor `PORT` is set. */
const DEFAULT_PORT = 8080;

/** Which transport to start. */
export type Transport = 'stdio' | 'http';

/**
 * The transport: `--http`, else `CALM_TRANSPORT`, else stdio. An unknown value is refused, so
 * `CALM_TRANSPORT=HTTPS` does not quietly start stdio on a server that waits for HTTP.
 *
 * @param env - The environment.
 * @param cliHttp - Whether `--http` was given.
 * @returns The transport.
 * @throws {ConfigError} On a value other than stdio or http.
 */
export function transportFromEnv(env: NodeJS.ProcessEnv, cliHttp?: boolean): Transport {
  if (cliHttp) return 'http';
  const value = env.CALM_TRANSPORT?.trim().toLowerCase();
  if (!value || value === 'stdio') return 'stdio';
  if (value === 'http') return 'http';
  throw ConfigError.invalid(`CALM_TRANSPORT must be stdio or http, not '${env.CALM_TRANSPORT}'`);
}

/** Settings of the HTTP transport, read and checked before it starts. */
export interface HttpSettings {
  port: number;
  /** Running on Cloud Foundry (`VCAP_APPLICATION` set). */
  onCloudFoundry: boolean;
  /**
   * `CALM_HTTP_ALLOW_UNAUTHENTICATED`, already false on Cloud Foundry: a lost xsuaa binding must
   * never expose Cloud ALM publicly.
   */
  allowUnauthenticated: boolean;
  /** `CALM_HTTP_API_KEY`, the shared key of the API-key path. */
  apiKey?: string;
  /** Exact CORS origins, or false for no CORS headers. */
  corsOrigins: string[] | false;
  /** `CALM_DCR_SIGNING_SECRET`; when unset, the XSUAA client secret is used. */
  dcrSigningSecret?: string;
  /** OAuth redirect URI patterns: the known clients plus `CALM_OAUTH_REDIRECT_PATTERNS`. */
  redirectPatterns: string[];
}

/**
 * Read and check the HTTP transport settings. `CALM_PUBLIC_URL` is read by the auth package's
 * `resolveAppUrl` itself, and the XSUAA binding from `VCAP_SERVICES`.
 *
 * @param env - The environment.
 * @param cliPort - The `--port` option, which takes precedence over `PORT`.
 * @returns The settings.
 * @throws {ConfigError} On a malformed port or boolean.
 * @throws {Error} On a malformed CORS origin (see {@link parseCorsOrigins}).
 */
export function httpSettingsFromEnv(env: NodeJS.ProcessEnv, cliPort?: string): HttpSettings {
  // `--port` overrides PORT; an error names whichever was given.
  const [source, name] = cliPort !== undefined ? [{ '--port': cliPort }, '--port'] : [env, 'PORT'];
  const port = parseNumber(source, name, DEFAULT_PORT, { min: 1, max: 65535, integer: true });
  const onCloudFoundry = Boolean(env.VCAP_APPLICATION);
  // Parsed on Cloud Foundry too, so a typo is reported there as well, then ignored.
  const allowOpen = parseBool(env, 'CALM_HTTP_ALLOW_UNAUTHENTICATED');
  return {
    port,
    onCloudFoundry,
    allowUnauthenticated: allowOpen && !onCloudFoundry,
    apiKey: env.CALM_HTTP_API_KEY?.trim() || undefined,
    corsOrigins: parseCorsOrigins(env.CALM_CORS_ORIGINS),
    dcrSigningSecret: env.CALM_DCR_SIGNING_SECRET?.trim() || undefined,
    redirectPatterns: redirectPatterns(env),
  };
}

/** One origin as a browser sends it: scheme, host and optional port, nothing else. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * Parse `CALM_CORS_ORIGINS` into the origins the `cors` middleware may allow. Unset means no CORS
 * headers: MCP clients call the endpoint server-side, so only browser-based clients need an entry.
 *
 * A wildcard is refused rather than honoured. Behind auth it gains nothing, and on the open local
 * endpoint (`CALM_HTTP_ALLOW_UNAUTHENTICATED`) it would let any website the developer visits call
 * 127.0.0.1 from the browser and read Cloud ALM data: without CORS headers the browser's preflight
 * blocks that. A malformed entry is refused too, so a typo cannot quietly disable a client.
 *
 * @param value - The raw environment value, a comma-separated list of origins.
 * @returns The origins, or `false` when none are configured.
 * @throws {Error} On `*` or an entry that is not `http(s)://host[:port]`.
 */
export function parseCorsOrigins(value: string | undefined): string[] | false {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) return false;
  for (const origin of origins) {
    if (origin.includes('*')) {
      throw new Error(
        `CALM_CORS_ORIGINS must list exact origins; the wildcard "${origin}" is not supported. ` +
          'Name each browser client, e.g. CALM_CORS_ORIGINS=http://localhost:6274.',
      );
    }
    if (!ORIGIN.test(origin)) {
      throw new Error(
        `CALM_CORS_ORIGINS entry "${origin}" is not an origin: use scheme://host[:port] with no ` +
          'path or trailing slash, e.g. https://client.example.com.',
      );
    }
  }
  return origins;
}
