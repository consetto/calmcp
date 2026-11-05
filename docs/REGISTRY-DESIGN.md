# Declarative resources and domain modules

Status: proposal (2026-11-05), from the architecture review. Covers two roadmap items: declarative
parameter specs for `calm_list`/`calm_get` resources, and domain modules that keep everything calmcp
knows about one Cloud ALM area in one file. Nothing here is implemented yet.

## Why

Today a REST list resource is a `build(params)` closure (`src/tools/registry/list.ts`). Which
parameters it reads is found by calling `build` with and without placeholder values
(`src/tools/registry/probe.ts`). That cannot drift from `build`, but:

- It holds only while every `build` is pure and changes its output for the value `'x'`. A build that
  maps a value through a code list, or drops values it does not know, would be described wrongly,
  and `calm_list` would then refuse a parameter that works or forward one it should refuse.
- `required` is declared next to `build`, not derived from it. No test checks that a required
  parameter is read at all.
- The paging style (limit/offset, `$top`/`$skip`, SCIM `startIndex`/`count`, none) is implicit.
  `fetchAllRest` (`src/tools/paging.ts`) detects "no paging" by comparing the queries of two pages.
- `status` means a task status code for `tasks` and `active`/`archived`/`all` for
  `deployment_plans`. One schema description has to cover both; `calm_resources` lists only the
  name.

Found while researching this proposal:

- **`rest_filters` accepts any key.** `landscape_objects`, `landscape_access_control_lists` and
  `bsm_events` forward every key except the paging ones. The specs name the keys:
  `/landscapeObjects` takes objectType, source, lmsId, serviceType, systemNumber, name, role,
  externalId, deploymentModel (`YAML/CALM_LMS.yaml`); `/events` takes type, serviceName, eventType,
  serviceType, period, startTime, endTime (`YAML/CALM_BSM.yaml`). A misspelled key (`objecttype`,
  `service_name`) goes out unchanged, and Cloud ALM ignores it (tenant check below): the caller
  gets an unfiltered list that looks filtered, the failure AGENTS.md puts first.
- **Scopes are in the specs only partly.** Only the Projects (`CALM_PJM.yaml`) and Tasks
  (`CALM_TKM.yaml`) specs annotate each operation with its OAuth scope. The others rely on SAP's API
  guide, so `src/calm/scopes.ts` can be checked against the specs for two services only.
- Knowledge about one area is spread over the operation files: for tasks, `registry/list.ts`,
  `registry/get.ts`, `create.ts`, `constants.ts`/`codeLists.ts`, `config.ts` (`SERVICE_PATHS`) and
  `calm/scopes.ts`. The "Change these together" table in AGENTS.md exists because of that.

### Tenant check of `rest_filters` (2026-11-05)

Direct requests to `/landscapeObjects` on the test tenant (11 objects: 10 CloudService, 1
BusinessService), each with `limit=500`:

| Query | Answer |
| --- | --- |
| none | 200, 11 objects |
| `objectType=BusinessService` | 200, 1 object |
| `objecttype=BusinessService` | 200, 11 objects |
| `OBJECTTYPE=BusinessService` | 200, 11 objects |
| `object_type=BusinessService` | 200, 11 objects |
| `bogusKey=xyz` | 200, 11 objects |
| `objectType=NO_SUCH_TYPE` | 400 |

Unknown keys are ignored, keys are case-sensitive, unknown values are refused. `/events`
(`bsm_events`) also answers 200 to `bogusKey`. calmcp forwards `rest_filters` keys unchanged
(`filteredCollection` in `src/tools/registry/list.ts`), so `calm_list` passes the misspelling
through and returns the unfiltered list. Because this is a wrong answer today, the allowlist is
not held back for the refactor: it can be added to the current `list.ts` and carried over.

## The constraint: the advertised tool schema stays flat

The obvious typed design, a discriminated union per resource in the `calm_list` input schema, cannot
be advertised. Copilot Studio, Gemini and Azure AI Foundry drop a server whose tool schema uses
`anyOf`/`oneOf`/`allOf`/`$ref` (`tests/unit/schema.test.ts`; a Microsoft Q&A answer reports the
same for Foundry). Splitting `calm_list` into one tool per domain (`calm_list_tasks`, ...) would multiply
the tool count and the schema bytes sent on every turn (budgets of 14 000, 16 000 and 18 500 bytes),
go against the common guidance to keep an MCP server's tool count small, and break every prompt,
recipe and agent configuration that names `calm_list`.

**Decision:** keep the six tools and the flat parameter set. The declarative specs change how calmcp
validates, builds requests and describes resources at runtime, not what the tool schema looks like.

## Part A: declarative parameters

Each REST resource declares its parameters as data; one generic builder turns them into a request.

```ts
/** Where one calm_list parameter goes on the wire. */
type Wire =
  | { in: 'path' } // fills {name} in the path template, encoded
  | { in: 'query'; as: string; list?: 'comma' | 'repeat' };

interface ParamSpec {
  wire: Wire;
  required?: boolean;
  /** Overrides the generic schema description in calm_resources, e.g. what status means here. */
  description?: string;
  /** Accepted values, when the spec enumerates them; anything else is refused before sending. */
  values?: readonly string[];
}

/** How calmcp pages the resource: the window it puts on the query for top/skip. */
type Paging = 'limitOffset' | 'odataSystem' | 'scim' | 'none';

interface RestListSpec {
  kind: 'rest';
  service: ServiceName;
  /** Path template, e.g. '/tasks/{task_id}/comments'. */
  path: string;
  params: Partial<Record<UpstreamParam, ParamSpec>>;
  paging: Paging;
  /** Reads orderby as $orderby (the process services). */
  orderby?: boolean;
  /** Keys rest_filters may carry, transcribed from the spec. Absent: rest_filters is refused. */
  restFilters?: readonly string[];
  description: string;
}
```

`tasks` becomes:

```ts
tasks: {
  kind: 'rest',
  service: 'tasks',
  path: '/tasks',
  paging: 'limitOffset',
  params: {
    project_id: { wire: { in: 'query', as: 'projectId' }, required: true },
    task_type: { wire: { in: 'query', as: 'type' } },
    status: { wire: { in: 'query', as: 'status' }, description: 'Task status code, e.g. CIPDFCTOPEN' },
    // ... subStatus, assigneeId, tags (repeat), lastChangedDate, lastChangedTimestamp
    ids: { wire: { in: 'query', as: 'id', list: 'comma' } },
  },
  description: '...',
}
```

What follows from the spec instead of from probing:

| Today | Declarative |
| --- | --- |
| `readParams` probes `build` | keys of `params`, plus top/skip unless `paging: 'none'`, plus orderby, plus rest_filters when `restFilters` is set |
| `ignoredParams` removes each parameter and compares requests | supplied minus readable; unknown `rest_filters` keys are named too |
| `required` declared by hand, unchecked | `required: true` on the parameter; a path placeholder is required by construction |
| `fetchAllRest` detects "no paging" by comparing two queries | `paging: 'none'` says so; the comparison stays as an assertion |
| `withDefaultPage` asks `readParams(...).includes('top')` | `paging !== 'none'` |
| SCIM `startIndex = skip + 1` written in one build | `paging: 'scim'` in the builder, once |

All ten hand-written builds in `list.ts` fit this model (tasks, task_solution_process_assignments,
deliverables, system_groups, deployment_plans, scopes, landscape_access_control_lists, and the
`processCollection`/`childCollection`/`filteredCollection`/`plainCollection` helpers). No escape
hatch (`build` override) is proposed: one exception would bring the probe back. A resource that does
not fit gets a new `Wire` or `Paging` variant, with a test.

`calm_get` REST entities become path templates the same way (`'/tasks/{id}'`).

**Checks at load, as unit tests:** every path placeholder has a `path` parameter; no two
parameters share a query name; `restFilters` keys do not collide with declared names or the paging
names; every `values` list is non-empty.

**Checks against the specs, run locally** (`YAML/` is gitignored, so not in CI): a script
`scripts/check-specs.mjs`, run as part of the spec refresh, with `yaml` as a dev dependency.

- REST: the path exists with a GET; every `as` name and every `restFilters` key is a query
  parameter of that operation; every parameter the spec marks required is `required: true`; the
  paging names exist.
- OData: the entity set exists in the spec.
- Scopes: where the spec annotates `security` (Projects, Tasks), it matches `SERVICES`.
- Create and update payloads: field names, required fields, enums and max lengths of the zod schemas
  against the `*-create`/`*-update` bodies (the spec-drift item of the roadmap; same parser).

## Part B: domain modules

```
src/domains/
  services.ts     SERVICES: path, read scope, write scope, spec file, project-restricted flag
  fragments.ts    shared zod fragments (uuid, httpUrl, priorityCode, references)
  features.ts     list, get, create and update entries for features
  documents.ts
  tasks.ts        incl. task code lists and the risk/classification rules now in create.ts
  projects.ts     projects, programs, teams, timeboxes, deployment plans, system groups
  processes.ts    hierarchy, scopes, process management and authoring
  testing.ts      test cases, activities, actions, test plans
  library.ts      the four cross-library services and their code lists
  landscape.ts    landscape objects, access control lists
  events.ts       status events
  index.ts        DOMAINS in a fixed order; compiles LIST_RESOURCES, GET_RESOURCES,
                  CREATE_RESOURCES, UPDATE_RESOURCES; throws on a duplicate resource name
```

Each module exports `defineDomain({ list, get, create, update })`. The tool handlers in
`src/tools/` keep importing the four compiled registries and do not change. `SERVICE_PATHS`
(`config.ts`) and the scope tables (`calm/scopes.ts`) are derived from `SERVICES` and stay exported
under their current names, so callers outside the registry do not change either. The analytics
catalogue and recipes stay in `src/tools/`: they describe providers and workflows, not resources.

The "Change these together" table in AGENTS.md shrinks to: a new resource is its domain file plus a
test; a new service is `services.ts` plus `docs/API_VERSIONS.md`. README and `mcpb-manifest.json`
stay hand-written, with a unit test that every create and update resource is named in both.

## Side effects for existing agents

"Agents" here means everything already configured against calmcp: models in Claude Desktop and
Claude Code, Copilot Studio agents, MCPB installs, and the prompts, recipes and skills written
around `calm_list` and its parameters. They depend on the tool names, parameter names, resource
names, the wording of refusals they learned to recover from, and the shape of results.

### Phase 1: refactor only, invisible to agents

Parts A and B change no behaviour. Gates, each a test or a CI check:

- **Same tool surface.** The tool-surface comment on the PR shows no diff. Resource enums keep
  their order, so `src/domains/index.ts` compiles the domains in today's key order (features,
  documents, process hierarchy, test management, cross-library, process management and authoring,
  test plans, tasks, projects, landscape, events). Reordering would change the enum order in the
  schema: harmless to a model, but noise in the diff and a changed byte count.
- **Same requests.** Before the refactor, a characterization test records path and query for every
  list and get resource, for each parameter it reads and for typical combinations. After the
  refactor they must be byte-identical, including the order of query parameters (the builder emits
  them in declaration order, so the declarations follow today's builds).
- **Same discovery.** Snapshots of the full `calm_resources` catalogue and of each topic:
  `parameters` in today's order, `required` unchanged.
- **Same refusals.** The texts of "does not read", "This resource reads" and "Missing required
  parameter(s)" stay word for word (`tests/unit/refusals.test.ts`, extended).

If a gate is missed, a call an agent makes today either starts failing (a parameter now considered
unread) or, worse, a parameter silently stops reaching Cloud ALM. Release: a patch version, listed
as internal in the CHANGELOG.

### Phase 2: deliberate changes, each its own PR

Released together as a minor version with a "Behaviour changes" section in the CHANGELOG.

- **`rest_filters` limited to the spec's keys** (may ship earlier, see the tenant check). A call
  with an unknown key becomes `INVALID_ARGUMENT` naming the accepted keys; a key that differs only in case is answered with the right spelling.
  An agent that sent a wrong key got unfiltered data before and gets an error now, which it fixes on
  the next call. Prompts or recipes with a wrong key need correcting.
- **Per-resource parameter descriptions and values in `calm_resources`.** Additive: `parameters`
  gains descriptions (what `status` means for this resource). The per-topic answer grows; the full
  catalogue must stay under the response budget, so details go into the topic answer only.
- **Values checked where the spec enumerates them** (e.g. `deployment_plans` status
  `active`/`archived`/`all`). A value Cloud ALM would have refused or ignored is refused before
  sending.
- **Shorter tool descriptions** for `status` and `rest_filters`, once the details are in
  `calm_resources`. This changes the tool surface: fewer tokens per turn. Hosts that cache the tool
  list (MCPB installs pinned to a version, some Copilot Studio configurations) see it only after an
  upgrade or a tool refresh.

What stays the same in both phases: the six tools, all parameter names, all resource names, result
shapes and error codes. No rename is planned; if one becomes necessary it goes into the renamed
parameter hints in `src/tools/index.ts`, as for 1.0.

## Order of work

1. Characterization tests for requests, `calm_resources` and refusals. No code change.
2. `src/domains/services.ts` with `SERVICES`; `SERVICE_PATHS` and scope tables derived from it.
3. Declarative list and get specs with the generic builder; `probe.ts` removed, `readParams` and
   `ignoredParams` keep their signatures.
4. Domain modules: entries moved per domain, registries compiled, AGENTS.md table updated.
5. `scripts/check-specs.mjs`, including the create and update payloads.
6. Phase 2 PRs. The `rest_filters` allowlist can go first, ahead of step 1.

Steps 1 to 4 should land before the next batch of resources from "More reads" in the roadmap, so
new resources are written in the new form instead of being migrated later.

## Alternatives considered

- **Generate the registry from the OpenAPI specs.** Rejected: the specs are gitignored, uneven
  (scopes on two services only, OData specs without query details) and would produce hundreds of
  resources; the descriptions models read are written by hand. Verify against the specs instead.
- **One tool per domain.** Rejected for tool count, schema size and compatibility (above).
- **Discriminated unions in the input schema.** Rejected: hosts drop the server.
- **Keep the probe and add a test that `required` is read.** The cheapest option. It fixes one
  drift but not `rest_filters`, the implicit paging style or per-resource descriptions. A fallback
  if the refactor is postponed.

## Open questions

- Are the query keys of `/events` case-sensitive? The tenant had events of one service only.
- Should display-id lookups for `calm_get` (roadmap "Next") become a declared property of a get
  resource (`displayId: { entitySet, noun }`)? It fits the domain modules and replaces
  `allowDisplayId`.
