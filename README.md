# calmcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that bridges AI
assistants (Claude, GitHub Copilot, …) to **SAP Cloud ALM**. It exposes the Cloud ALM read APIs
through four consolidated, intent-based tools, runs over **stdio** locally or **Streamable HTTP**
remotely, and deploys to **SAP BTP Cloud Foundry**.

> calmcp is read-only: it never creates, updates or deletes data in SAP Cloud ALM.

Architecture and testing follow the [`marianfoo/arc-1`](https://github.com/marianfoo/arc-1)
reference (TypeScript + Express + the official MCP SDK). See [docs/PREDECESSOR.md](docs/PREDECESSOR.md)
for the project's lineage.

## Tools

| Tool | Purpose |
| --- | --- |
| `calm_list` | List/query any collection — tasks (incl. **defects**), projects, features, documents, test cases, hierarchy nodes, cross-library objects, landscape objects, status events, code lists. OData resources accept `$filter/$select/$expand/$orderby/$top/$skip`; REST resources accept contextual params (`project_id`, `task_id`, `task_type`, …). |
| `calm_get` | Fetch a single entity by id (a feature also by display id, e.g. `6-123`). |
| `calm_analytics` | Query an analytics provider (`Defects`, `Tasks`, `Tests`, …). Supports `$orderby` — use it for sorted/aggregated questions. |
| `calm_resources` | Discovery: the catalog of resources/providers, the task type/status/priority code lists, and worked recipes. |

### Worked examples

- **All open defects ordered by priority**

  ```json
  calm_analytics({ "provider": "Defects", "filter": "status eq 'CIPDFCTOPEN'", "orderby": "priority desc" })
  ```

- **Assigned features for defect `Y`** (two steps)

  ```json
  calm_list({ "resource": "task_feature_assignments", "task_id": "Y" })   // -> featureIds
  calm_get({ "resource": "feature", "id": "<featureId>" })                 // -> details
  ```

Call `calm_resources` (optionally `{ "topic": "recipes" }`) at any time to discover valid
`resource`/`provider` values and required parameters.

### Covered services

Tasks, Projects, Features, Documents, Process Hierarchy, Test Management (manual + automated),
Analytics, BSM/Status Events, Landscape, and Cross-Library (Applications, Configurations,
Developments, Interfaces).

## Configuration

Configuration is read from environment variables (see [`.env.example`](.env.example)). Two local
auth modes, plus a BTP destination mode:

| Variable | Description |
| --- | --- |
| `CALM_SANDBOX` | `true` to use the SAP Business Accelerator Hub sandbox with `CALM_API_KEY`. |
| `CALM_API_KEY` | Sandbox API key (sandbox mode). |
| `CALM_TENANT`, `CALM_REGION` | Tenant subdomain and region (e.g. `eu10`) for OAuth2 mode. |
| `CALM_CLIENT_ID`, `CALM_CLIENT_SECRET` | OAuth2 client-credentials from the service binding. |
| `CALM_DESTINATION_NAME` | Name of a bound BTP Destination (BTP mode; takes precedence). |
| `PORT`, `CALM_CORS_ORIGINS` | HTTP transport port and allowed CORS origins. |
| `CALM_DEBUG`, `CALM_TIMEOUT_SECONDS` | Verbose tracing and request timeout. |

## Local development

```bash
npm install
npm run build
npm test          # unit tests (mocked HTTP)
npm run lint      # biome
```

### Run over stdio (local MCP clients)

```bash
CALM_SANDBOX=true CALM_API_KEY=<key> node dist/index.js
```

Example client config (Claude Desktop):

```json
{
  "mcpServers": {
    "calmcp": {
      "command": "node",
      "args": ["/absolute/path/to/calmcp/dist/index.js"],
      "env": { "CALM_SANDBOX": "true", "CALM_API_KEY": "<key>" }
    }
  }
}
```

### Run over HTTP

```bash
CALM_SANDBOX=true CALM_API_KEY=<key> PORT=8080 node dist/index.js --http
curl http://localhost:8080/health
# MCP endpoint: POST http://localhost:8080/mcp
```

## Deploy to SAP BTP Cloud Foundry

calmcp authenticates to Cloud ALM via a bound **Destination** (type OAuth2 client-credentials,
URL = your Cloud ALM API base, e.g. `https://<tenant>.<region>.alm.cloud.sap/api`). Set
`CALM_DESTINATION_NAME` to that destination's name.

### Using the MTA descriptor

```bash
npm install --global mbt
mbt build
cf deploy mta_archives/calmcp_0.1.0.mtar
```

This creates and binds `calmcp-xsuaa` (XSUAA), `calmcp-destination` (Destination) and
`calmcp-logs` (Application Logs), and runs the HTTP transport with a `/health` check.

### Using `cf push`

Create the services, build, then push (see [`manifest.yml`](manifest.yml)):

```bash
cf create-service xsuaa application calmcp-xsuaa -c xs-security.json
cf create-service destination lite calmcp-destination
cf create-service application-logs lite calmcp-logs
npm run build
cf push
```

After deploy, create the **destination** pointing at your Cloud ALM API and assign the
`CALMCP_Viewer` role collection to authorized users.

## Testing

```bash
npm test                 # unit (mocked HTTP via undici MockAgent)
npm run test:integration # live sandbox/destination — skipped without credentials
npm run build && npm run test:e2e   # real MCP calls over stdio and HTTP
```

## License

MIT
