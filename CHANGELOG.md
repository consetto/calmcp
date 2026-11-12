# Changelog

calmcp follows [semantic versioning](https://semver.org) from 1.0 on; the README section
"Versioning and stability" says what counts as the public interface. Releases before 1.0 are
described on the [GitHub releases page](https://github.com/consetto/calmcp/releases).

## 1.1.0

Tags of tasks and requirement assignments, stricter handling of what calmcp cannot honour
(configuration values, `rest_filters` keys), and hardening of the HTTP transport and the rich-text
check after a security review.

### Added

- `calm_update` takes a second resource, `task_tags`: add tags to and remove tags from a task of
  any type (project task, user story, defect, requirement, sub-task, risk), with
  `changes: { add: [...], remove: [...] }`. The task's other tags stay; a tag that does not exist
  yet is created. Needs `CALM_UPDATE_ENABLED=true` and the `calm-api.tasks.write` scope. See the
  README, "Tags of a task".
- `calm_create` takes `task_requirement_link`: assign an existing project task or user story to
  a requirement of the same project. calmcp reads both first and refuses anything else, a second
  requirement for a task, and a repeat. The README, "Write access", also says how to create a task
  already assigned (the requirement as `parentId`).
- Creating a task with a requirement as `parentId` answers with `requirement: { linked: true }`.
  Cloud ALM stores that link as a relation and leaves `parentId` null, so 1.0.0 reported
  `parentId` under `storedDiffersFromSent` although the link existed. calmcp now reads the new
  task's relations and says what they show: linked, not linked (with the call that links it), or
  unknown. A sub-task, whose parent Cloud ALM keeps in `parentId`, is reported as before.
- `calm_resources` says how to read the tasks of a requirement and the requirement of a task
  (`task_relations`, types `0` and `10`), with two new recipes.
- `expected_modified_at` of `calm_update` is optional in the tool schema. `feature` still requires
  it and refuses a call without it; `task_tags` refuses a call with it.

### Behaviour changes

- `calm_list` refuses a `rest_filters` key that the endpoint does not take, naming the accepted
  keys and the right spelling of one that differs only in case. Cloud ALM ignores an unknown key
  and answers with the unfiltered list (`objecttype=BusinessService` on `landscape_objects`
  returned every object), so a misspelled filter looked applied. `calm_resources` lists the
  accepted keys of each resource as `restFilters`.
- Configuration is checked at startup. A malformed or out-of-range number (`CALM_TIMEOUT_SECONDS=0`,
  `CALM_MAX_RESPONSE_BYTES=100kb`, `PORT=99999`), a switch that is neither true nor false
  (`CALM_WRITE_ENABLED=ture`) and an unknown `CALM_TRANSPORT` now stop calmcp with a message naming
  the variable. Before, a number fell back to its default, a switch read as false and an unknown
  transport started stdio. `CALM_TRANSPORT` and `CALM_HTTP_ALLOW_UNAUTHENTICATED` now accept the same
  spellings as the other switches (`HTTP`, `1`, `yes`). A deployment with such a value stops
  starting after the upgrade; that is intended.
- With XSUAA bound and no `CALM_DCR_SIGNING_SECRET`, calmcp logs a warning that client
  registrations are lost when the XSUAA client secret rotates.

### Security

- Rich text is checked in linear time. One `calm_create` or `calm_update` call with a `<` or `=`
  followed by a long run of spaces took minutes and stalled the server for every caller. The
  summary of an upstream error body is bounded the same way.
- HTTP transport: the rate limit and the bearer check now come before a request body is parsed, a
  request whose body fails to parse counts towards the rate limit, and a compressed request body
  is refused with 415 instead of being inflated. A caller without a valid token gets 401 where a
  malformed body used to give 400.

### Fixes

- Tenants in `eu10-004` can sign in with tenant and region. calmcp requested the token from
  `authentication.eu10-004.hana.ondemand.com`, which does not exist; it now uses the region without
  its data-centre suffix (`authentication.eu10`). `CALM_AUTH_REGION` overrides the token host region.
- BTP destination: after Cloud ALM refused a token (401), for example after the client secret was
  rotated, calmcp kept getting the refused token from the Cloud SDK's destination cache, which does
  not store an uncached lookup. Every later request was refused once before its retry, and of
  several requests refused at the same time only one was sure to retry with a fresh token. calmcp
  now remembers the refused token, fetches the destination afresh once for all waiting requests,
  and uses the fresh token until it expires.
- A browser-based MCP client (listed in `CALM_CORS_ORIGINS`) can call the server after
  `initialize`: CORS now allows the `mcp-protocol-version` header.

## 1.0.0

The first stable release. It settles the parameter names before semver locks them, adds links
between existing objects, and hardens how calmcp reads from Cloud ALM and how it reports writes.

### Breaking changes

| 0.9 | 1.0 | Note |
| --- | --- | --- |
| `limit`, `offset` (REST resources) | `top`, `skip` | One paging pair for every resource; calmcp translates it for each service. `nextPage` is always `{ skip }`. |
| `filters` | `rest_filters` | Query parameters of `landscape_objects`, `landscape_access_control_lists`, `bsm_events`. |
| `count` | `with_count` | Total alongside the records; `count_only` is unchanged. |

A call with an old name is refused before anything is sent, and the message names the new one
("'limit' is now 'top'").

Other changes a client may notice:

- `calm_create` and `calm_update` called with the write switch off answer `CONFIG` instead of
  `INVALID_ARGUMENT` (#59).
- Rich text is checked against an allowlist of elements, attributes and URL schemes instead of a
  blocklist, so HTML outside it is refused (#55). HTML from the Cloud ALM editor passes.
- A create or update that times out or gets a 408 or 5xx answers `retryable: false` and says it may
  or may not have been applied; the audit entry carries `outcome: "unknown"` (#54).
- A REST list without `top` asks for 500 records and announces a full page with `nextPage`; before,
  the service's own default (100 for landscape objects) came back with no hint of more.
- `top`, `skip`, `select` and `with_count` next to `count_only`/`group_by`, and paging keys inside
  `rest_filters`, are refused instead of ignored.
- An id that is neither a uuid nor a display id is refused before any lookup.
- Tool results are compact JSON (no indentation), about a third smaller.
- A Cloud ALM page that is neither an array, `{ value }` nor `{ Resources }` is `UPSTREAM_ERROR`
  instead of being read as empty (#58). A Cloud ALM answer over 8 MB is `RESPONSE_TOO_LARGE` (#57).

### Features

- **Links between existing objects** in `calm_create`: `task_feature_link`, `task_document_link`,
  `task_process_link`, `task_relation`, `task_reference`, `feature_url_reference`,
  `test_case_task_link`. Features, documents, process nodes and manual test cases can be named by
  display id. Needs `calm-api.testcases.write` for test case links (#53).
- **Transports of features**: `feature_transports` and `feature_transport_references` (#51).
- **One display-id lookup** for `calm_get` (features), `calm_create` and `calm_update`, which
  refuses an answer for another object (#56). Three-part display ids such as `8-1-1` (manual test
  cases) are accepted in `calm_create` links.
- **Counts stop after 40 seconds** with `complete: false` and `stoppedBy: "time"` instead of running
  into the client's timeout (#58). The budget also cuts off a page still in flight, and covers
  analytics breakdowns and the timebox walk.
- **`calm_analytics` gives `nextPage`** for a full page, like `calm_list`.
- **Analytics providers that need a filter** (`ServiceLevels`, `MonitoringEvents`) say so in
  `calm_resources` as `requires`.
- **403 hints** name the analytics provider scopes, the operations scopes and the scope for
  landscape access control lists.

### Fixes

- Counting `ConfigurationItems` no longer sends a `resolution`, which that provider does not have.
- `group_by` no longer refuses a field that is missing from the first page but present on later
  ones (Cloud ALM leaves empty attributes out); on OData resources it fetches only the grouped
  fields.
- A page holding a null entry no longer ends paging early; the dropped-filter check of analytics
  counts uses the caller's own time window.
- A burst of 401s no longer discards a freshly fetched token, and BTP destination mode fetches a
  new token after a 401.
- Document lists skip the image lookup when the result is too large to hand over anyway.
- The integration test for the next-page hint no longer fails on an empty tenant (#60).

### Security and operations

- Rich text: named entities in `style`, `href` and `src` (`&sol;`, `&colon;`, `&bsol;`, ...) are
  refused, and numeric ones decoded before the check, so a host or CSS escape cannot hide behind
  them. The tag scanner runs in linear time (crafted input took seconds before).
- OAuth: dynamic client registration and the built-in client accept only the redirect URIs of
  known MCP clients (`CALM_OAUTH_REDIRECT_PATTERNS` adds more); before, any `https://` redirect and
  any app on `*.hana.ondemand.com`.
- CI: actions pinned by commit, no persisted git credentials, and the release token only on the
  upload step.
- HTTP hardening: bodies are streamed with an 8 MB cap, a 401 is retried once with a fresh token,
  token fetches are single-flight and validated, and errors on `/mcp` are JSON-RPC errors without
  stack traces (#57).
- `.cfignore`, a new `.dockerignore`, `.gitignore` and the `mta.yaml` ignore list keep local notes,
  scripts, assistant settings and old archives out of every package (#60).
- follow-redirects advisory GHSA-mrwp-f3q8-3g9p fixed by a lockfile update (#60).

### Documentation

- README: the full set of Cloud ALM API scopes as instance JSON, the operations scopes, the
  versioning promise, and a known Cloud ALM limitation: a feature description that contains images
  cannot be changed through the API (Cloud ALM's image service refuses the technical user).
- `SECURITY.md`, this changelog, specs of 2026-10-08 and a reworked roadmap (#52).

### Upgrading from 0.9

- Rename `limit`/`offset` to `top`/`skip`, `filters` to `rest_filters`, `count` to `with_count` in
  saved prompts, recipes or Copilot Studio actions.
- For test case links, add `calm-api.testcases.write` to the Cloud ALM API instance.
- Nothing changes in XSUAA or the destination. If an MCP client other than Claude, ChatGPT, Cursor,
  VS Code, Mistral, Copilot Studio or a localhost callback signs in over OAuth, add its redirect URI
  with `CALM_OAUTH_REDIRECT_PATTERNS`.
