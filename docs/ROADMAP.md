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
- **Tags** on tasks and documents (`/tasks/updateTags`, `/updateTags`). These replace the tag list,
  so they need the same care as a PATCH.
- **Timeboxes and workstreams** (`POST /projects/{id}/timeboxes`, `POST /workstreams`).

## Reliability

- **Progress notifications** during long walks, so clients keep waiting and users see progress.

## Security and operations

- **XSUAA upgrade rollout.** The 1.2.0 dependency and local approval regression are in place;
  an operator still needs to verify real-tenant sign-in and reconnect after applying the exact
  callback configuration. See [the upgrade guide](XSUAA-AUTH-UPGRADE.md).

- **Access levels through Cloud ALM API scopes.** Two API service instances and destinations, one
  without the private-project and `*.personal.read` scopes, picked by a new XSUAA role. User
  propagation is not possible: the Cloud ALM API accepts client credentials only, and project
  visibility is a scope of the service instance (SAP API guide, 2026-09-29).

## Smaller

- A short-lived cache for slow-changing lookups (projects, timeboxes, code lists).
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
