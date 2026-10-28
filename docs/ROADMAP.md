# Roadmap

Ideas and deferred work, roughly in order of value. Every PR checks this file: add what it defers,
narrow what it partly does, and remove what it completes. Link the PR or analysis behind an item.

## In progress

| Item | Where | Open before merging |
| --- | --- | --- |
| Feature create, `calm_update` for features, `imagesOmitted` on document reads | #24 (draft) | Test against a real tenant: create, update, image guard, conflict, `null` clears, HTML check against real document HTML |
| Audit log for `calm_create` | #26 (draft, stacked on #24) | Merge after #24 |
| Create tasks (incl. user stories, defects, requirements, sub-tasks, risks) and task comments | `create-tasks` (draft) | Review; tested on a real tenant |

## Next

- **`project_name` for `calm_create`**, resolved like `calm_list` does, for documents, features and
  tasks.
- **Links between existing objects** (additive only): task to feature, document or process node,
  task to user story, URL references, test case to requirement.
- **`calm_update` for tasks** (status, assignee, sprint), after #24 proved itself on a tenant. First
  sample whether task descriptions hold images; the Tasks REST API has no server-side filter.
- **Text search** on task titles (case-insensitive, applied while paging, like the timebox filter).
- **Several ids in one `calm_get`**, e.g. all features of a defect in one call.

## Reliability

- **Time budget for long counts.** Up to 40 pages are fetched in sequence; stop at about 45 s and
  return the partial tally with `complete: false` instead of losing it to a client timeout.
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

- **Updating documents.** The Documents API cannot change a document's title or body
  (docs/UPDATES.md, in #24).
- **Live tests in CI.** The sandbox API key changes regularly, so a stored secret would go stale;
  integration tests run locally against a tenant from `.env`.
