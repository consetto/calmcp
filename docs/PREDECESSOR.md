# Predecessor and provenance

`calmcp` is my second SAP Cloud ALM MCP bridge . It succeeds an earlier
**Rust** implementation [sap-cloud-alm-mcp](https://github.com/consetto/sap-cloud-alm-odata-mcp) and reuses the knowledge of the Cloud ALM APIs, while taking a different technical direction.

## What was carried over

- **API knowledge** — authentication flow (OAuth2 client-credentials + sandbox API key), the
  per-service URL layout, OData v4 query conventions, and the error taxonomy
  (config / auth / API-with-HTTP-status-and-OData-detail). The authoritative source for the
  re-implementation is the set of OpenAPI specs in `YAML/`.


## What changed

| Aspect | Predecessor (`sap-cloud-alm-mcp`) | `calmcp` |
| --- | --- | --- |
| Language / runtime | Rust (`rmcp`) | TypeScript / Node.js (`@modelcontextprotocol/sdk`) |
| Transport | stdio | stdio **and** Streamable HTTP |
| Direction | read + write | **read-only** |
| Tools | ~73 fine-grained tools | 4 consolidated tools (`calm_list`, `calm_get`, `calm_analytics`, `calm_resources`) |
| Deployment | local binary | SAP BTP Cloud Foundry (`mta.yaml`, XSUAA, Destination) |
| Auth source | config file | BTP Destination service (with local env fallback) |
| Reference architecture | — | [`marianfoo/arc-1`](https://github.com/marianfoo/arc-1) |

