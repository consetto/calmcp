// The OAuth scopes each Cloud ALM service needs, from the "API Scopes" table of SAP's API Guide for
// SAP Cloud ALM. Scopes are `authorities` of the Cloud ALM API service instance, never of a person,
// so a 403 is fixed by an operator updating that instance. The hint says which scope to add rather
// than leaving the model to guess.

import type { ServiceName } from '../config.js';
import type { HttpMethod } from './httpClient.js';

/** Scope a GET on each service needs. */
const READ_SCOPES: Record<ServiceName, string> = {
  features: 'calm-api.features.read',
  documents: 'calm-api.documents.read',
  tasks: 'calm-api.tasks.read',
  projects: 'calm-api.projects.read',
  testmanagement: 'calm-api.testcases.read',
  processhierarchy: 'calm-api.processhierarchy.read',
  analytics:
    "calm-api.analytics.read plus the provider's own read scope (e.g. calm-api.tasks.read for " +
    'Tasks, calm-api.defects.read for Defects)',
  bsm: 'calm-api.bsm.read',
  landscape: 'calm-api.landscape.read',
  xlibApplications: 'calm-api.lib.read',
  xlibConfigurations: 'calm-api.lib.read',
  xlibDevelopments: 'calm-api.lib.read',
  xlibInterfaces: 'calm-api.lib.read',
  processManagement: 'calm-api.processmanagement.read',
  processAuthoring: 'calm-api.processauthoring.read',
  testPlans: 'calm-api.testplans.read',
};

/** Scope a POST or PATCH needs, for the services `calm_create` and `calm_update` write to. */
const WRITE_SCOPES: Partial<Record<ServiceName, string>> = {
  documents: 'calm-api.documents.write',
  features: 'calm-api.features.write',
  xlibApplications: 'calm-api.lib.write',
  xlibConfigurations: 'calm-api.lib.write',
  xlibDevelopments: 'calm-api.lib.write',
  xlibInterfaces: 'calm-api.lib.write',
};

/** Services whose data is withheld for private and protected projects without extra scopes. */
const PROJECT_RESTRICTED = new Set<ServiceName>(['projects', 'analytics']);

/**
 * The hint for a 403 from one Cloud ALM service.
 *
 * @param service - The service that refused the request.
 * @param method - The request method; a POST or PATCH needs the write scope.
 * @returns Which scope the Cloud ALM API service instance behind calmcp is missing.
 */
export function forbiddenHint(service: ServiceName, method: HttpMethod): string {
  const scope = (method !== 'GET' ? WRITE_SCOPES[service] : undefined) ?? READ_SCOPES[service];
  const project = PROJECT_RESTRICTED.has(service)
    ? ' A private or protected project also needs calm-api.projects.private.read or ' +
      'calm-api.projects.protected.read.'
    : '';
  return (
    `The Cloud ALM API service instance behind calmcp probably lacks the scope ${scope}.` +
    project +
    " An operator adds scopes to the instance's authorities in the SAP BTP cockpit."
  );
}
