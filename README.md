# calmcp - Cloud ALM MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that bridges AI
assistants (Claude, GitHub Copilot, …) to **SAP Cloud ALM** (aka CALM). It exposes the Cloud ALM read APIs
through four consolidated, intent-based tools, runs over **stdio** locally or **Streamable HTTP**
remotely, and deploys to **SAP BTP Cloud Foundry**.

> calmcp is read-only: it never creates, updates or deletes data in SAP Cloud ALM.

`calmcp` is my second SAP Cloud ALM MCP bridge . It succeeds an earlier
**Rust** implementation [sap-cloud-alm-mcp](https://github.com/consetto/sap-cloud-alm-odata-mcp) and reuses the knowledge of the Cloud ALM APIs, while taking a different technical direction.

The Architecture is based on [`marianfoo's`](https://github.com/marianfoo) [`arc-1`](https://github.com/marianfoo/arc-1) as reference architecutre. See [docs/PREDECESSOR.md](docs/PREDECESSOR.md) for the project's lineage.

## Tools

| Tool | Purpose |
| --- | --- |
| `calm_list` | List/query any collection — tasks (incl. **requirements**, **user stories** and **defects**), projects, features, documents, test cases, hierarchy nodes, cross-library objects, landscape objects, status events, code lists. OData resources accept `$filter/$select/$expand/$orderby/$top/$skip`; REST resources accept contextual params (`project_id`, `task_id`, `task_type`, `timebox_id`/`timebox_name`, …). `fields` projects the response on any resource; `count_only`/`group_by` return a live count instead of the records. |
| `calm_get` | Fetch a single entity by id (a feature also by display id, e.g. `6-123`). |
| `calm_analytics` | Query an analytics provider (`Defects`, `Tasks`, `Tests`, …). Supports `$orderby` — use it for sorted/aggregated questions. Providers span the whole tenant, so `count_only`/`group_by` here answer "how many across all projects". |
| `calm_resources` | Discovery: the catalog of resources/providers, per-provider analytics dimensions and measures, the task type/status/priority code lists, and worked recipes. |

### Worked examples

- **How many user stories are there in the tenant?**

  ```json
  calm_analytics({ "provider": "Tasks", "filter": "type eq 'User Story'", "count_only": true })
  ```

- **Open defects per project**

  ```json
  calm_analytics({ "provider": "Defects", "filter": "defectStatus eq 'CIPDFCTOPEN'", "group_by": "projectName" })
  ```

- **All open defects ordered by priority**

  ```json
  calm_analytics({ "provider": "Defects", "filter": "status eq 'CIPDFCTOPEN'", "orderby": "priority desc" })
  ```

- **Assigned features for defect `Y`** (two steps)

  ```json
  calm_list({ "resource": "task_feature_assignments", "task_id": "Y" })   // -> featureIds
  calm_get({ "resource": "feature", "id": "<featureId>" })                 // -> details
  ```

- **Open user stories in a sprint**

  ```json
  calm_list({
    "resource": "tasks", "project_id": "<uuid>",
    "task_type": "CALMUS", "status": "CIPUSOPEN", "timebox_name": "Sprint 5",
    "fields": "displayId,title,status,assigneeName,dueDate"
  })
  ```

Call `calm_resources` (optionally `{ "topic": "recipes" }`) at any time to discover valid
`resource`/`provider` values and required parameters.

### Keeping responses small

A task carries 67 attributes, most of them null, and the Tasks REST endpoint supports neither
`$select` nor a timebox filter. Unprojected task lists therefore run to hundreds of KB and overflow
agent hosts such as Microsoft Copilot Studio. `calm_list` adds two options, both applied by calmcp
after fetching: `fields` projects the records, and `timebox_id`/`timebox_name` selects one sprint
(paging through the project so the filter is complete). Unknown field names and unknown timebox
names are rejected rather than silently ignored.

calmcp also caps the response itself. A payload over `CALM_MAX_RESPONSE_BYTES` (default 100 KB) is
withheld and replaced by a summary naming how many records matched, which fields they carry, and
how to ask again. Handing the payload over instead means the client truncates the JSON mid-record
and the model answers from a fragment, which reads as authoritative and is wrong.

### Counting and breakdowns

Never answer "how many?" by listing records and counting them. Both query tools take:

| Option | Effect |
| --- | --- |
| `count_only: true` | Returns only the total. One `$count` request on OData and analytics; on REST resources calmcp pages and keeps just the tally. |
| `group_by: "status"` | Returns `{ total, groups: [{ value, count }] }` instead of records. Accepts several fields (`"projectName,priority"`). Doubles as a way to discover the values a field actually takes. |
| `group_limit` | Caps the number of groups (default 50); the tail folds into `otherCount` rather than being dropped. |
| `count: true` | Returns the total *alongside* the records (OData and analytics only). |

Which tool you call decides where the number comes from:

- **`calm_analytics`** counts tenant-wide, with no `project_id`. It reads a daily snapshot, so the
  result carries a note saying so, and the `period`/`resolution` window is pinned and echoed back
  in the response. That matters because an analytics row is a data point, not an entity: a wide
  window with a small bucket counts each record once per bucket.
- **`calm_list`** counts live, within whatever the resource is scoped to (`resource: "tasks"` needs
  a `project_id`).

The analytics service drops a `$filter` on a field it does not support instead of rejecting it,
and then answers with every row, so a wrong field name yields a confident count of the wrong thing.
A filtered analytics count therefore also counts the same window unfiltered, and sets
`filterVerified: false` when the two totals match. That detects a dropped filter but cannot prove
one was applied, so prefer `group_by` on the field you would have filtered: it sends no filter, so
nothing can be dropped, and it returns every value with its count in one call.

Every counting result reports `method`, the effective `filter`, and `complete`. A walk stopped by
the 20 000-record page cap comes back with `complete: false` and says the real total is higher,
rather than presenting a floor as the answer.

### Covered services

Tasks, Projects (incl. programs and program teams), Features, Documents, Process Hierarchy,
Process Scopes, Custom Processes, Test Management (manual + automated), Test Plans *(BETA)*,
Analytics, BSM/Status Events, Landscape, and Cross-Library (Applications, Configurations,
Developments, Interfaces).

In Cloud ALM the Tasks service is not just to-dos: **requirements, user stories, defects,
sub-tasks, roadmap and project tasks, quality gates, checklist items and risks are all tasks**,
distinguished by a `type` code. So `resource: "tasks"` with `task_type: "CALMREQU"`, `"CALMUS"` or
`"CALMDEF"` is how you list requirements, user stories or defects. Call `calm_resources` for the
full code list.

All services are on API version `v1`. For the spec revision behind each one, and how to refresh
them, see [docs/API_VERSIONS.md](docs/API_VERSIONS.md).

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

## Install in Claude Desktop — one-click (`.mcpb`)

The simplest path for a single developer: install calmcp as a Claude Desktop extension.

1. Download the latest `calmcp-<version>.mcpb` from the Releases page (or build it locally — see
   below).
2. Double-click it, or open **Claude Desktop → Settings → Extensions** and drag the file in.
3. Claude prompts for your Cloud ALM connection. **Tenant**, **Region**, **Client ID** and
   **Client Secret** are required (the secret is stored in your OS keychain). To use the SAP
   Business Accelerator Hub sandbox instead, turn on **Use Sandbox** and supply a **Sandbox API
   Key**. **Debug Logging** and **Request Timeout** are optional. Fill them in and enable the
   extension.
4. Ask Claude: *"Using the SAP Cloud ALM tools, list the open defects ordered by priority."* — it
   should call `calm_analytics`.

**What the bundle is:** a pure-JS, cross-platform (macOS / Windows / Linux) build of the stdio
server packaged with its dependencies — calmcp has no native modules, so one bundle runs
everywhere. It is **read-only** like the rest of calmcp. For multi-user, HTTP, or BTP deployments,
use the Docker image or deploy to Cloud Foundry instead (see below).

### Build the bundle locally

```bash
npm run build:mcpb        # → calmcp-<version>.mcpb in the repo root
```

This compiles `dist/`, installs production dependencies, then validates and packs the bundle with
the pinned [`@anthropic-ai/mcpb`](https://github.com/anthropics/mcpb) CLI. The form Claude Desktop
shows is defined in [`mcpb-manifest.json`](mcpb-manifest.json); keep its `version` in sync with
`package.json` (the build fails if they differ).

> Prefer to hand-edit JSON? Use the `claude_desktop_config.json` snippet under
> [Run over stdio](#run-over-stdio-local-mcp-clients) — that path also supports sandbox-only setups.

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

### Prerequisites

The deployment needs the Cloud Foundry CLI, the MultiApps plugin (which provides `cf deploy`), and
the MTA build tool:

1. **Cloud Foundry CLI** — install for your OS (macOS, Windows, Linux) per the
   [official guide](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html).
2. **MultiApps plugin and MTA build tool** (cross-platform):

   ```bash
   cf install-plugin multiapps -f   # registers the `cf deploy` command used below
   npm install --global mbt         # MTA build tool

   cf login -a https://api.cf.<region>.hana.ondemand.com --sso   # then pick the org/space
   ```

> If `cf install-plugin multiapps` fails with `bad CPU type` / architecture errors (e.g. on
> arm64 machines), download the matching binary for your platform from the
> [MultiApps releases](https://github.com/cloudfoundry/multiapps-cli-plugin/releases) and install it
> from file: `cf install-plugin <downloaded-binary> -f`.

### Using the MTA descriptor

```bash
mbt build
cf deploy mta_archives/calmcp_<version>.mtar   # <version> is the one in package.json
```

This creates and binds `calmcp-xsuaa` (XSUAA), `calmcp-destination` (Destination) and
`calmcp-logs` (Application Logs), and runs the HTTP transport with a `/health` check.

Bump the version before deploying a new build — see [Releasing](#releasing). Redeploying different
code under the version already running leaves `cf deploy` reporting the same number for both, so
there is no way to tell afterwards which build a space is on.

### Using `cf push`

Create the services, build, then push (see [`manifest.yml`](manifest.yml)):

```bash
cf create-service xsuaa application calmcp-xsuaa -c xs-security.json
cf create-service destination lite calmcp-destination
cf create-service application-logs lite calmcp-logs
npm run build
cf push
```

After deploy, assign the `CALMCP_Viewer` role collection to authorized users and create the
**destination** as described below.

### Configure the destination

Two differently-named things are involved — don't confuse them:

- **`calmcp-destination`** — the destination *service instance* created and bound by the deploy
  (mta.yaml / manifest.yml). It is the container that holds destinations; you do not edit it by hand.
- **`CALM_DESTINATION_NAME`** (default `SAP_CALM`) — the name of the destination *entry* the app
  looks up at runtime. **This is the name you give the destination you create.** It must match the
  value of `CALM_DESTINATION_NAME`; change one and change the other.

Create the entry either at the **subaccount level** (Connectivity → Destinations) or inside the
`calmcp-destination` service instance — the Cloud SDK checks both. Fill it in from your Cloud ALM
API service key (an OAuth2 client-credentials key for the Cloud ALM API):

| Field | Value |
| --- | --- |
| **Name** | the value of `CALM_DESTINATION_NAME` (default `SAP_CALM`) |
| **Type** | `HTTP` |
| **Proxy Type** | `Internet` |
| **URL** | your Cloud ALM API base **including the `/api` suffix**: `https://<tenant>.<region>.alm.cloud.sap/api` (the region-only form `https://<region>.alm.cloud.sap/api` works too) |
| **Authentication** | `OAuth2ClientCredentials` |
| **Client ID** | `clientid` from the service key |
| **Client Secret** | `clientsecret` from the service key |
| **Token Service URL** | the service key's `url` plus `/oauth/token`: `https://<tenant>.authentication.<region>.hana.ondemand.com/oauth/token` |
| **Token Service URL Type** | `Dedicated` |

Notes:

- The **`/api` suffix on the URL is required** — calmcp appends per-service paths (e.g.
  `/calm-features/v1`) directly to this URL.
- The destination's **Check Connection** button may report 401/403; that is expected for an
  unauthenticated probe. The real check is the deployed app calling a tool.
- No additional destination properties are needed.

### Endpoint authentication (HTTP transport)

The destination above is how calmcp authenticates **to** Cloud ALM. Separately, the `/mcp` endpoint
itself is protected so only authorized callers can reach it.

**Standard approach: a BTP user signing in from an AI tool.** When the `calmcp-xsuaa` service is
bound, `/mcp` requires a valid XSUAA token carrying the `Viewer` scope (granted via the
`CALMCP_Viewer` role collection). calmcp detects the bound service from `VCAP_SERVICES` and enables
this automatically. It also exposes MCP-native OAuth (RFC 8414 discovery + RFC 7591 dynamic client
registration, proxied to XSUAA), so an AI tool such as Claude Desktop, Cursor or VS Code **signs the
user in interactively** with no manual token handling. The OAuth flow is delegated to XSUAA; calmcp
never sees the user's password. This is the recommended path: each user authenticates as themselves
with a BTP user and the `CALMCP_Viewer` role collection.

**Alternative: a static API key** for non-interactive, server-to-server callers (for example
Microsoft Copilot Studio). Set `CALM_HTTP_API_KEY` and the caller sends `Authorization: Bearer <key>`.
This authenticates the caller, not a user. Both methods coexist on the one endpoint. See
[Connecting calmcp to Microsoft Copilot Studio](docs/copilot-studio.md).

**Locally, with neither configured, `/mcp` is left open** for development and a warning is logged. Do
not expose an unauthenticated instance publicly.

Relevant environment variables (HTTP transport):

| Variable | Description |
| --- | --- |
| `CALM_PUBLIC_URL` | Public base URL used in OAuth metadata and the callback. Defaults to the first route in `VCAP_APPLICATION`, so it's normally not needed. |
| `CALM_DCR_SIGNING_SECRET` | Secret for HMAC-signing dynamic client registrations. Set it (e.g. `cf set-env calmcp-srv CALM_DCR_SIGNING_SECRET "$(openssl rand -base64 48)"`) so registered clients survive a `cf deploy` (which rotates the XSUAA `clientsecret`). Defaults to the XSUAA `clientsecret`. |
| `CALM_HTTP_API_KEY` | Shared secret for the alternative API-key path. Generate with `openssl rand -base64 48`. Leave empty to rely on XSUAA only. See the [Copilot Studio guide](docs/copilot-studio.md). |

### Consuming the deployed server from an AI tool

This is the standard way to use the deployed server. `/mcp` speaks the **Streamable HTTP** MCP
transport, so point a remote-MCP-capable client at it:

- **Claude Code:** `claude mcp add --transport http calmcp https://<route>/mcp`
- **Claude Desktop:** Settings → Connectors → add a custom connector with the `/mcp` URL.
- **Cursor / VS Code / others:** add an MCP server of type HTTP (Streamable) at the `/mcp` URL.

On first connect the client triggers the OAuth login; **sign in with your BTP user**, which must hold
the `CALMCP_Viewer` role collection. The four tools (`calm_list`, `calm_get`, `calm_analytics`,
`calm_resources`) then appear.

For non-interactive server-to-server callers such as Microsoft Copilot Studio, use the API-key path
instead: see [Connecting calmcp to Microsoft Copilot Studio](docs/copilot-studio.md).

## Testing

```bash
npm test                 # unit (mocked HTTP via undici MockAgent)
npm run test:integration # live sandbox/destination — skipped without credentials
npm run build && npm run test:e2e   # real MCP calls over stdio and HTTP
```

Pushes to `main` and every pull request run `npm ci`, the version check, lint, unit tests and the
build on Node 22 and 24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). `npm ci` installs
strictly from the lockfile, so a stale local `node_modules` can never be mistaken for a real
failure again.

## Releasing

`package.json` is the single source of truth for the version. Four other files carry a copy —
`mcpb-manifest.json`, `mta.yaml`, `src/server.ts` (advertised to MCP clients) and the `.mtar`
filename — so bump them together, never by hand:

```bash
npm version patch     # or minor / major
```

The `version` lifecycle script runs [`scripts/sync-version.mjs`](scripts/sync-version.mjs), which
rewrites the copies and stages them; npm then makes the commit and the tag. `npm run version:check`
verifies the files agree and runs in CI, so drift fails the build rather than reaching a deploy.

**Bump before every deploy to a shared space.** The MTA version is what `cf deploy` reports and what
names the archive; reusing it for different code makes deploys indistinguishable after the fact.

## License

MIT

## Contributing

Contributions are welcome! Please ensure your code:

- Builds without errors (`npm run build`)
- Passes all tests (`npm test`)
- Passes linting and formatting (`npm run lint`, or `npm run lint:fix` to auto-fix)

## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied.

### No Responsibility

The author(s) and contributor(s) of this tool assume no responsibility or liability for any damages,
losses, or consequences that may result from the use or misuse of this software. This includes, but
is not limited to:

- Any kind of data loss
- Any damage to systems, networks, or data
- Any legal consequences resulting from unauthorized or improper use
- Any business losses or operational disruptions
- Any security incidents or breaches
