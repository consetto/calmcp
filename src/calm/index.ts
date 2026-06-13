// SAP Cloud ALM client container.
//
// Holds one read-only HTTP client per Cloud ALM service and exposes three request primitives that
// the MCP tool layer composes via the resource registry:
//   - `listOData`  — GET an OData entity set with system query options.
//   - `getOData`   — GET a single OData entity by key, optionally expanding navigations.
//   - `getRest`    — GET a REST endpoint with a prebuilt query string.
//
// Keeping the per-resource knowledge in the registry (see `tools/registry.ts`) keeps these
// primitives small and avoids duplicating one method per entity set.

import type { Logger } from 'pino';
import type { AuthProvider } from '../auth/index.js';
import { type Config, SERVICE_PATHS, type ServiceName } from '../config.js';
import { CalmHttpClient } from './httpClient.js';
import { buildODataQueryString, type ODataCollection, type ODataQueryOptions } from './odata.js';

/**
 * Container of per-service HTTP clients plus generic read primitives.
 */
export class CalmClients {
  /** One HTTP client per Cloud ALM service, keyed by service name. */
  private readonly clients: Record<ServiceName, CalmHttpClient>;

  /**
   * @param auth - The auth provider shared by every service client.
   * @param config - Validated configuration (for timeout).
   * @param logger - Application logger.
   */
  constructor(auth: AuthProvider, config: Config, logger: Logger) {
    const options = { timeoutMs: config.timeoutMs(), logger };
    // Build a client for every known service. `Object.keys` over a const map needs a cast.
    const services = Object.keys(SERVICE_PATHS) as ServiceName[];
    this.clients = {} as Record<ServiceName, CalmHttpClient>;
    for (const service of services) {
      this.clients[service] = new CalmHttpClient(auth, service, options);
    }
  }

  /**
   * GET an OData entity set as a collection.
   *
   * @param service - The owning service.
   * @param entitySet - The entity set name (e.g. "Features").
   * @param options - OData system query options.
   * @returns The OData collection envelope.
   */
  async listOData(
    service: ServiceName,
    entitySet: string,
    options: ODataQueryOptions = {},
  ): Promise<ODataCollection<unknown>> {
    const query = buildODataQueryString(options);
    return this.clients[service].get<ODataCollection<unknown>>(`/${entitySet}`, query);
  }

  /**
   * GET a single OData entity by key.
   *
   * @param service - The owning service.
   * @param entitySet - The entity set name.
   * @param key - The entity key (placed in the path).
   * @param expand - Optional comma-separated navigation properties to expand.
   * @returns The entity as parsed JSON.
   */
  async getOData(
    service: ServiceName,
    entitySet: string,
    key: string,
    expand?: string,
  ): Promise<unknown> {
    const query = expand ? `?$expand=${encodeURIComponent(expand)}` : '';
    return this.clients[service].get(`/${entitySet}/${encodeURIComponent(key)}`, query);
  }

  /**
   * GET a REST endpoint.
   *
   * @param service - The owning service.
   * @param path - Service-relative path beginning with `/` (e.g. `/tasks`).
   * @param query - Prebuilt query string including the leading `?` (or empty).
   * @returns The response as parsed JSON (array or object).
   */
  async getRest(service: ServiceName, path: string, query = ''): Promise<unknown> {
    return this.clients[service].get(path, query);
  }
}
