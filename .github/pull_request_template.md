<!-- One coherent change per PR. Open it as a draft until it is finished and tested; mark it
ready for review only then. Fill every section; write N/A with a reason where one does not apply.
Redact credentials, tokens, tenant names and customer data from all examples and evidence. -->

## Change

- Problem and resulting behavior:
- Dependent PRs (merge order), related issues:
- Before → after (an example call and its answer):

<!-- For a Cloud ALM API change, link the evidence: the OpenAPI spec in YAML/, SAP's API guide, or
a redacted live request/response. A mock accepting a field does not prove Cloud ALM accepts it. -->

## Compatibility and scope

- Defaults, new settings, breaking behavior:
- Security impact (writes, scopes, data a model can now see or change):
- Tool surface (the bot comment shows the diff; say why it is worth the tokens):

## Validation

### Automated

- Commands and results, including failed, skipped or not-run checks:
- Guards proven by breaking them: <!-- e.g. "removing .strict() fails 3 tests". For every new
  check that refuses something, show that a test fails when the check is removed. -->

### Real tenant

Write tools (`calm_create`, `calm_update`) and changes to how calmcp talks to Cloud ALM need a test
against a real tenant before merging. Use a test project and disposable objects.

- Status: <!-- Tested / Not tested (reason) / N/A (reason) -->
- Build and environment: <!-- calmcp commit or version, tenant region, auth route (OAuth client,
  BTP destination, sandbox), MCP client. -->
- Scenario and observed result: <!-- The actual tool call. Verify the outcome in Cloud ALM (read it
  back with calm_get or in the UI), not only a success message. -->
- Not tested, cleanup: <!-- What is left unverified; objects created and whether they were
  removed. Refresh this after substantive code changes. -->

## Roadmap

- [ ] Checked [docs/ROADMAP.md](../blob/main/docs/ROADMAP.md): added deferred work, removed what this PR completes, or "no roadmap impact".
