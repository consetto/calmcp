# Roadmap

Ideas and deferred work, roughly in order of value. Every PR checks this file: add what it defers,
narrow what it partly does, and remove what it completes. Link the PR or analysis behind an item.

## Next

- **`calm_update` for tasks** (status, assignee, sprint, priority), reusing the feature guards.
  First sample whether task descriptions hold images; the Tasks REST API has no server-side filter.
- **`project_name` for `calm_create`**, resolved like `calm_list` does, for documents, features and
  tasks.
- **Text search** on task titles (case-insensitive, applied while paging, like the timebox filter).
- **Several ids in one `calm_get`**, e.g. all features of a defect in one call.
- **Display ids in `calm_get` for documents, process nodes and test cases**, with the lookup
  `calm_create` already uses (only features take one today).

## Architecture

From the architecture review of 2026-11-05, in the order proposed.

- **`CALM_DCR_SIGNING_SECRET` required on Cloud Foundry.** Today calmcp falls back to the XSUAA
  client secret and logs a warning; requiring it stops existing deployments from starting, so it
  waits for a minor release.
- **Declarative resources and domain modules.** Parameters of REST resources declared as data
  instead of probed from `build` closures, explicit paging styles, and one file per Cloud ALM area
  for list, get, create and update entries, with services, paths and scopes in one `SERVICES`
  table. A refactor first that agents cannot notice, then deliberate changes in a minor release.
  Before the next batch of "More reads". See [the design](REGISTRY-DESIGN.md).
- **Spec drift check.** A local script comparing the registries and the create and update schemas
  with `YAML/` (paths, query parameters, required fields, enums, lengths, scopes where the spec has
  them), run with every spec refresh.
- **One context per tool call.** The response budget is module state (`configureResults`), so it
  cannot differ per client although Copilot Studio and Claude have different limits. Pass a context
  (clients, budget, signal, audit, logger, caller) to the handlers; choose the budget by the
  client's `clientInfo`. Fold `ShapeError` and `LookupError` into `CalmError` with a code.
- **Outbound rate limit and cache.** Cloud ALM allows 500 requests per 5 seconds per tenant, shared
  with every other integration; nothing in calmcp limits concurrent calls across users. A token
  bucket in `CalmHttpClient`, and a short-lived cache for projects, timeboxes, code lists and
  display id to uuid lookups (which never change). The inbound rate limit is per instance; document
  that or move it to a shared store.
- **Audit log retention.** Writes are audited only in the application log, which Cloud Foundry
  keeps briefly. Document a log drain as a requirement for write-enabled deployments, or add a
  separate audit sink.
- **Tool schemas per access level.** Every HTTP request builds a server and converts the input
  schemas again; there are three access levels, so the converted schemas can be cached.

## Watch

- **Feature descriptions with images cannot be changed through the API.** Cloud ALM's image service
  answers 403 to the API's technical user (`updateUsedImages`), so the PATCH fails with 500 and
  nothing is saved (tenant test 2026-10-31). Reported to SAP; when fixed, re-test `remove_images`.
- **Analytics `QualityGates` answers 403** with every documented read scope on the instance; the
  scope it needs is not documented. `document_approval_states` answers 404 on a tenant whose
  `$metadata` lists it.

- **Fit and Gap sub-classifications are being discontinued.** The Cloud ALM Tasks app announces
  (seen 2026-10-28) that sub-classifications under Fit and Gap will be deleted from requirements
  and user stories in an upcoming release; the classifications stay. When the Tasks spec drops
  them, remove the `US_FIT`/`US_GAP`/`REQ_FIT`/`REQ_GAP` sub-classification lists from `task`
  create (`src/tools/create.ts`).

## More reads

- **Test execution history**: `/testcases/executionhistory` and `/testdatavariants` (Test
  Automation), for "which automated tests failed in their last runs".
- **Service events with filters**: `/eventsData` (Status Events, OData-like `$filter`), next to the
  plain `/events` behind `bsm_events`.
- **Business services with relations**: `/businessServices` and `/properties` (Landscape).
- **Process flow diagrams**: `solutionProcessFlowDiagrams/{id}/diagramElements` and
  `solutionValueFlowDiagram` (Custom Processes), so a model can walk a flow. Needs
  `processauthoring.read`.
- **Document approval and external files**: `Documents/{uuid}/toApproval`, `/ExternalFiles`.
- **Releases**: `/releases/{id}` (Projects), to resolve the `releaseId` of tasks and features.
- **Analytics provider `ConfigurationChecks`** (Analytics 1.1.0, 2026-10-08).
- **`ownerId` of process hierarchy nodes** (Process Hierarchy 1.3.0): check that
  `hierarchy_nodes` passes it through and add it to the field hints.
- **Evaluate the APIs calmcp does not call yet** (specs in `YAML/`): ITSM, service requests (`SR`),
  raw logs, metrics and traces, resource changes.

## More writes

- **Manual test cases** with activities and actions (`ManualTestCases`, `toActivities`). One POST
  takes the whole structure (tenant test 2026-10-31); it needs `projectId` and `scopeId`.
- **`parentId` of a new task is not checked.** `calm_create` passes it on for every task type, and
  Cloud ALM uses it for sub-tasks and for the requirement of a project task or user story (tenant,
  2026-11-11). Read the parent first, as `task_requirement_link` does, and refuse a parent that
  fits neither, in another project, or below a defect or risk. A narrowing of what 1.0 accepts,
  so it needs a look at what Cloud ALM does with the other combinations first.
- **Removing a task from its requirement**, with "Changing and removing links" below.
- **Tags on documents** (`/updateTags` of the Documents API), like the `task_tags` resource of
  `calm_update`. The call replaces the tag list, so it needs the same add and remove interface;
  check on a tenant whether it also drops tags silently, as the Tasks call does.
- **Timeboxes and workstreams** (`POST /projects/{id}/timeboxes`, `POST /workstreams`).
- **Changing and removing links** (needs research). Most links cannot be changed in place: task
  assignments to features, documents and process nodes, task relations, test case to task links and
  feature URLs have only POST and DELETE, so changing one means removing it. Only task URL
  references (`PATCH /tasks/references/{id}`) and task comments (`PATCH /tasks/comments/{id}`) can
  be changed in place; these fit `calm_update`. Removing links would break "nothing is ever
  deleted": it would need its own switch, a tool limited to link objects, and changes to AGENTS.md,
  the README and the server instructions. Transports of features are read-only in the API.

## Reliability

- **Progress notifications** during long walks, so clients keep waiting and users see progress.
  Over HTTP the server is stateless, one server per POST, so it cannot send them today. Answer the
  POST as an SSE stream (Streamable HTTP allows that without sessions) rather than switching to
  sessions with sticky routing.
- **Shutdown on SIGTERM.** Cloud Foundry stops an instance on every restage and deploy; calmcp
  exits at once, so a write in flight is cut and reported as "outcome unknown". Stop accepting
  requests, let running calls finish within the grace period, then exit.

## Security and operations

- **XSUAA upgrade rollout.** The 1.2.0 dependency and local approval regression are in place;
  an operator still needs to verify real-tenant sign-in and reconnect after applying the exact
  callback configuration. See [the upgrade guide](XSUAA-AUTH-UPGRADE.md).

- **Access levels through Cloud ALM API scopes.** Two API service instances and destinations, one
  without the private-project and `*.personal.read` scopes, picked by a new XSUAA role. User
  propagation is not possible: the Cloud ALM API accepts client credentials only, and project
  visibility is a scope of the service instance (SAP API guide, 2026-09-29).

From the security review of 2026-11-11 (fixed there: #72, #73, #74):

- **`.env` is loaded from the working directory in every mode** (`import 'dotenv/config'` in
  `src/index.ts`). An MCP host often starts a stdio server in the project folder, so a `.env` in a
  repository someone else wrote can set whatever the host left unset: `CALM_WRITE_ENABLED`,
  `CALM_UPDATE_ENABLED`, `NODE_TLS_REJECT_UNAUTHORIZED`. Reasoned from dotenv's defaults, not yet
  reproduced. Load it only for `npm run dev` and the integration tests, or from an explicit path.
- **`data-mce-*` attributes pass the rich-text allowlist** (`src/tools/richText.ts`, any `data-`
  attribute is allowed). `<img src="/ui/imageServiceAPI/…" data-mce-src="https://elsewhere/p.png">`
  and `data-mce-style="background:url(…)"` are accepted today. TinyMCE keeps the original `src`,
  `href` and `style` in these attributes and writes them back when it saves, so the foreign URL
  could become the real one once a user edits the object. Needs a tenant check (does Cloud ALM's
  sanitiser strip them, does the editor restore them); refusing `data-mce-*` is safe either way.
  Also accepted: a link styled `position:fixed` over the whole page.
- **`CALM_HTTP_API_KEY` has no minimum length**, so `test` protects a public endpoint; CI itself
  starts the image with `placeholder`. Require a length (32 characters, say) at startup. String
  settings also skip the check for an unfilled `${user_config.…}` placeholder that booleans and
  numbers get.
- **Inbound rate limit by caller.** The limit is per client address. Hosted clients (claude.ai,
  Copilot Studio) presumably call from a few shared addresses, so all their users would share one
  bucket of 120 requests a minute; not measured. Keep the address limit ahead of sign-in and add
  one per token subject or API key behind it.
- **A log line per read.** Only writes are audited. Every caller reads with the one technical
  identity, so calmcp's log is the only place that can say who read what: caller, tool and resource
  at `info`, no parameters or values. Goes with "Audit log retention" above.
- Smaller: `node-forge` has a moderate advisory through `@sap-cloud-sdk/connectivity` and `jks-js`
  (`npm audit fix`; CI gates on high only). The `ignore` list in `mta.yaml` lacks the `*.local`
  entry `.cfignore` has. The Dockerfile's base image is not pinned by digest and its `npm ci` runs
  install scripts. `trust proxy` is set on Cloud Foundry only, so a container behind another
  reverse proxy puts every client into one rate-limit bucket.

## Smaller

- The recipes as MCP prompts, so clients can offer them as slash commands.
- `structuredContent` with an `outputSchema` for count and group-by results.
- A coverage floor in `vitest.config.ts`.
- Read the server version from `package.json` instead of syncing it into `src/server.ts`.
- A pre-commit hook running Biome on staged files.

## Not planned

- **Operations writes with outside effects**: closing event situations (`/event-situations`, which
  also closes mapped external tickets), updating issues and actions (`/updateIssueAction`) and
  starting test runs (`/testcases/execute`).
- **Team members** (`/scim/v2/Groups`, `PATCH` on teams): replaces the whole member list.
- **Deletes** of any kind.
- **Updating documents.** The Documents API cannot change a document's title or body
  (docs/UPDATES.md, in #24).
- **Live tests in CI.** The sandbox API key changes regularly, so a stored secret would go stale;
  integration tests run locally against a tenant from `.env`.
