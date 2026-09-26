// Gates for the live tests. Each suite declares what it needs; without it the suite is skipped,
// so `npm run test:integration` stays green on a machine without secrets.
//
//   describeLive        - any backend: CALM_SANDBOX=true + CALM_API_KEY, or an OAuth2 tenant
//                         (CALM_TENANT, CALM_REGION, CALM_CLIENT_ID, CALM_CLIENT_SECRET)
//   describeWithProject - a live backend plus CALM_TEST_PROJECT_ID, for project-scoped chains
//
// There is deliberately no gate for writes: calm_create cannot delete what it made, and deleting
// through the API needs a scope the technical user normally lacks, so a write test would leave an
// entry in the tenant on every run.

import { describe } from 'vitest';

export const hasBackend =
  (process.env.CALM_SANDBOX === 'true' && !!process.env.CALM_API_KEY) ||
  (!!process.env.CALM_TENANT && !!process.env.CALM_CLIENT_ID && !!process.env.CALM_CLIENT_SECRET);

/** The project the project-scoped tests read, when configured. */
export const testProjectId = process.env.CALM_TEST_PROJECT_ID?.trim() || undefined;

export const describeLive = describe.skipIf(!hasBackend);
export const describeWithProject = describe.skipIf(!hasBackend || !testProjectId);
