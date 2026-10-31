// Create registry: the resources `calm_create` can add to SAP Cloud ALM, each with the strict payload
// schema transcribed from the `*-create` request bodies in `YAML/CALM_SD.yaml`,
// `YAML/CALM_CDM_ODATA.yaml`, `YAML/CALM_TKM.yaml`, `YAML/CALM_TM.yaml` and the four
// `YAML/CALM_XLIB_*.yaml` specs.
//
// Scope is deliberately narrow: new documents, features, tasks, task comments, library entries
// (cross-library applications, configurations, configuration activities, developments,
// interfaces) and links between existing objects. Nothing here changes or deletes an existing
// record; changing fields of a feature is `calm_update`
// (`update.ts`), behind its own switch. Documents cannot be changed through the API at all.
//
// Every schema is `.strict()`: an unknown property is an error, not something silently dropped,
// because a caller who typed `projectID` would otherwise get a document in no project at all.

import { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import { isGuid, odataString } from '../calm/odata.js';
import type { ServiceName } from '../config.js';
import { LookupError } from '../errors.js';
import { DISPLAY_ID } from './displayId.js';

// ---------------------------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------------------------

// `z.guid()`, not `z.uuid()`: zod 4's uuid demands RFC 9562 version and variant bits, which zod 3 did
// not, and an id Cloud ALM issued is valid whether or not it carries them.
const uuid = z.guid();

/**
 * A link target. Only http(s): a `javascript:` or `data:` URL would be stored in Cloud ALM and
 * rendered as a clickable link in its UI.
 */
function httpUrl(max: number, { httpsOnly = false } = {}) {
  return z
    .string()
    .max(max)
    .regex(
      httpsOnly ? /^https:\/\/\S+$/i : /^https?:\/\/\S+$/i,
      httpsOnly ? 'must be an https:// URL' : 'must be an http:// or https:// URL',
    );
}

/** A priority code: 10 very high, 20 high, 30 medium, 40 low (documents, features, tasks). */
const priorityCode = () => z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40)]);

/**
 * An external system identifier of a feature or a task. These two services call the identifier
 * field `id`; documents and library entries use {@link externalReference}.
 */
const idExternalReference = z
  .object({
    id: z.string().min(1).max(255).describe('Identifier in the external system'),
    name: z.string().min(1).max(255).describe('Name of the external system'),
    url: httpUrl(1000).optional().describe('URL pointing into the external system'),
  })
  .strict();

/** A link (display name + URL) attached to the new entity. Same shape in every service. */
const urlReference = z
  .object({
    name: z.string().min(1).max(255).describe('Display name of the link'),
    url: httpUrl(1000).describe('Target URL, starting with http:// or https://'),
  })
  .strict();

/** External system identifier attached to the new entity. */
const externalReference = z
  .object({
    externalReferenceId: z
      .string()
      .min(1)
      .max(255)
      .describe('Identifier in the external system, e.g. its UUID'),
    name: z.string().min(1).max(255).describe('Name of the external system'),
    url: httpUrl(1000).optional().describe('URL pointing into the external system'),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Documents (CALM_SD.yaml — POST /Documents, schema Documents-create)
// ---------------------------------------------------------------------------------------------

/** Document type codes; `calm_list resource:document_types` returns the labels. */
const DOCUMENT_TYPE_CODES = [
  'NA',
  'PJ',
  'BP',
  'SD',
  'FU',
  'TD',
  'CG',
  'IS',
  'TE',
  'EU',
  'TR',
  'FS',
  'NT',
  'JD',
] as const;

export const documentCreateSchema = z
  .object({
    title: z.string().min(1).max(255).describe('Document title'),
    projectId: uuid.describe('UUID of the project the document belongs to'),
    content: z
      .string()
      .max(500_000)
      .optional()
      .describe('HTML rich-text body of the document. Plain text is accepted too'),
    scopeId: uuid.optional().describe('UUID of a process scope to assign the document to'),
    statusCode: z
      .union([z.literal(10), z.literal(20), z.literal(30)])
      .optional()
      .describe('Status code (default 10); calm_list resource:document_statuses lists the labels'),
    priorityCode: priorityCode()
      .optional()
      .describe(
        'Priority code (default 30); calm_list resource:document_priorities lists the labels',
      ),
    sourceCode: z
      .enum(['MANUAL', 'EXTERNAL', 'SAPSOLMAN'])
      .optional()
      .describe('Where the document originates (default MANUAL)'),
    documentTypeCode: z
      .enum(DOCUMENT_TYPE_CODES)
      .optional()
      .describe(
        'Document type code (default NA); calm_list resource:document_types lists the labels',
      ),
    isTemplate: z.boolean().optional().describe('Mark the document as a template (default false)'),
    ownerId: z.string().max(255).optional().describe('User id of the document owner'),
    responsibleId: z.string().max(255).optional().describe('User id of the responsible person'),
    stateCode: z
      .enum(['ACT', 'MDL'])
      .optional()
      .describe('Lifecycle state: ACT active (default) or MDL model'),
    approvalCode: z
      .enum(['NO_APPR_REQ', 'APPR_REQUIRED', 'APPR_PENDING', 'APPROVED', 'REJECTED'])
      .optional()
      .describe('Approval state (default NO_APPR_REQ)'),
    toURLReferences: z.array(urlReference).optional().describe('Links to attach'),
    toSolutionProcessAssignments: z
      .array(
        z
          .object({
            solutionProcessId: z.string().min(1).describe('Solution process id, e.g. SP_BKP_1'),
            scopeId: uuid.describe('UUID of the scope the process is scoped in'),
            solutionScenarioId: z.string().min(1).describe('Solution scenario id'),
          })
          .strict(),
      )
      .optional()
      .describe('Solution processes to assign'),
    toProcessHierarchyAssignments: z
      .array(
        z
          .object({
            displayId: z.string().min(1).describe('Display id of the hierarchy node, e.g. 14-2'),
          })
          .strict(),
      )
      .optional()
      .describe('Process hierarchy nodes to assign'),
    toTaskAssignments: z
      .array(z.object({ id: z.string().min(1).describe('Task id (uuid)') }).strict())
      .optional()
      .describe('Tasks (incl. defects, user stories) to assign'),
    toLibraryAssignments: z
      .array(
        z
          .object({
            libraryUuid: uuid.describe('UUID of the library element (application, interface, ...)'),
          })
          .strict(),
      )
      .optional()
      .describe('Library elements to assign'),
    toTestCaseAssignments: z
      .array(z.object({ testCaseUuid: uuid.describe('UUID of the test case') }).strict())
      .optional()
      .describe('Test cases to assign'),
    toExternalReferences: z
      .array(externalReference)
      .optional()
      .describe('External system references to attach'),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Cross-library entries (CALM_XLIB_*.yaml — POST /Applications, /Configurations, ...)
// ---------------------------------------------------------------------------------------------

/** Library-to-library assignment, nested in a cross-library create. */
const libraryAssignment = z
  .object({
    libraryUuid: uuid.describe('UUID of the library element to link'),
    libraryType: z
      .string()
      .max(40)
      .optional()
      .describe('Type of the linked element: Application, Configuration, Development, Interface'),
    parentUuid: z
      .string()
      .max(36)
      .optional()
      .describe('UUID of the owning element; omit inside a deep create'),
  })
  .strict();

/** Properties every cross-library main entity shares. */
const xlibBase = {
  title: z.string().min(1).max(300).describe('Name of the library entry'),
  description: z.string().max(100_000).optional().describe('Free-text description'),
  url: httpUrl(2048).optional().describe('URL to the object, e.g. its documentation'),
  ownerId: z.string().max(255).optional().describe('Email address of the owner'),
  toURLReferences: z.array(urlReference).optional().describe('Links to attach'),
  toExternalReferences: z
    .array(externalReference)
    .optional()
    .describe('External system references to attach'),
  toLibraryAssignments: z
    .array(libraryAssignment)
    .optional()
    .describe('Other library elements to link'),
};

/**
 * Classification codes shared by all four cross-library entities since the September 2025 specs.
 * Each entity prefixes them with its own name (`applicationPriorityCode`, ...); the matching
 * `calm_list` code lists (`xlib_<entity>_priorities`, ...) return the labels.
 */
const PRIORITY_CODES = ['1', '2', '3', '4'] as const;
const READINESS_CODES = [
  'IMPLEMENTED',
  'PARTLY_IMPLEMENTED',
  'NOT_IMPLEMENTED',
  'PLANNED',
] as const;
const USAGE_STATUS_CODES = ['UNUSED', 'USED', 'USED_IMPACTED'] as const;
const CLEAN_CORE_LEVEL_CODES = ['A', 'B', 'C', 'D', 'X'] as const;
const UPGRADE_IMPACT_CODES = [
  'UNAVAILABLE',
  'DEPRECATED',
  'AVAILABLE_W_SUCCESSOR',
  'ERROR',
  'WARNING',
  'INFORMATION',
  'DEV_UNCLASSIFIED',
  'FUNC_UNAVAILABLE',
  'SERIALIZATION_ISSUE',
  'BLOCKED',
  'UPGRADE_TOOLSET',
  'REMEDIATED',
  'INT_UNCLASSIFIED',
] as const;

/** Priority and readiness: carried by every cross-library entity. */
function classification(entity: string) {
  return {
    [`${entity}PriorityCode`]: z
      .enum(PRIORITY_CODES)
      .optional()
      .describe(`Priority 1 (highest) to 4; calm_list xlib_${entity}_priorities lists the labels`),
    [`${entity}ReadinessCode`]: z
      .enum(READINESS_CODES)
      .optional()
      .describe(`Implementation readiness; calm_list xlib_${entity}_readiness lists the labels`),
  };
}

/** Usage, clean core and upgrade impact: applications, developments and interfaces only. */
function upgradeClassification(entity: string) {
  return {
    [`${entity}UsageStatusCode`]: z
      .enum(USAGE_STATUS_CODES)
      .optional()
      .describe(`Usage status; calm_list xlib_${entity}_usage_statuses lists the labels`),
    [`${entity}UsageNumber`]: z.number().int().optional().describe('Measured number of usages'),
    [`${entity}CleanCoreLevelCode`]: z
      .enum(CLEAN_CORE_LEVEL_CODES)
      .optional()
      .describe(
        `Clean core level A-D or X; calm_list xlib_${entity}_clean_core_levels lists the labels`,
      ),
    [`${entity}UpgradeImpactCode`]: z
      .enum(UPGRADE_IMPACT_CODES)
      .optional()
      .describe(`Upgrade impact; calm_list xlib_${entity}_upgrade_impacts lists the labels`),
  };
}

/** System group / solution component pair carried by applications, configurations, developments. */
const systemScope = {
  systemGroupId: uuid.optional().describe('UUID of the system group (calm_list system_groups)'),
  solutionComponentId: uuid.optional().describe('UUID of the solution component'),
};

export const xlibApplicationCreateSchema = z
  .object({
    ...xlibBase,
    applicationTypeCode: z
      .enum(['FIORI_ACTION', 'PROGID', 'TRANID', 'PWEBLINKKEY', 'APP_CUSTOM_EXTENSION'])
      .optional()
      .describe('Application type (default FIORI_ACTION)'),
    applicationId: z.string().max(255).optional().describe('Technical application id'),
    intent: z
      .string()
      .max(550)
      .optional()
      .describe('Fiori actions only: "<semanticObject>-<action>"'),
    ...systemScope,
    ...classification('application'),
    ...upgradeClassification('application'),
    applicationSuccessor: z
      .string()
      .max(2048)
      .optional()
      .describe('Successor application, for an application that is deprecated or unavailable'),
  })
  .strict();

const xlibConfigurationCreateSchema = z
  .object({
    ...xlibBase,
    configurationTypeCode: z
      .enum([
        'AUTHORIZATION',
        'MASTER_DATA',
        'ORGANIZATIONAL_UNITS',
        'SCENARIO_DEPENDENT_CONFIG',
        'SCENARIO_INDEPENDENT_CONFIG',
        'WRICEFS',
        'BUSINESS_ROLE',
      ])
      .optional()
      .describe('Configuration type (default AUTHORIZATION)'),
    ...systemScope,
    ...classification('configuration'),
  })
  .strict();

const xlibConfigurationActivityCreateSchema = z
  .object({
    title: xlibBase.title,
    description: xlibBase.description,
    url: xlibBase.url,
    ownerId: xlibBase.ownerId,
    configurationActivityTypeCode: z
      .enum(['ROLE', 'PROGRAM', 'TRANSACTION', 'IMG_ACTIVITY'])
      .optional()
      .describe('Activity type (default IMG_ACTIVITY)'),
    objectId: z
      .string()
      .max(255)
      .optional()
      .describe('Technical object id, e.g. a transaction code'),
    toConfigurationAssignments: z
      .array(
        z
          .object({
            configurationUuid: uuid.describe('UUID of the configuration this activity belongs to'),
          })
          .strict(),
      )
      .optional()
      .describe('Configurations to assign the activity to'),
    toURLReferences: xlibBase.toURLReferences,
    toExternalReferences: xlibBase.toExternalReferences,
  })
  .strict();

const xlibDevelopmentCreateSchema = z
  .object({
    ...xlibBase,
    developmentTypeCode: z
      .enum([
        'DEV_BTP_APP_EXTENSION',
        'DEV_CLASS_INTERFACE',
        'DEV_CLASSIC_BADI_IMPLEMENTATION',
        'DEV_CUSTOM_FIORI_APPLICATION',
        'DEV_ENHANCEMENT_IMPLEMENTATION',
        'DEV_EXTRA_WORKBENCH_OBJECT',
        'DEV_FUNCTION_GROUP',
        'DEV_FUNCTION_MODULE',
        'DEV_PACKAGE',
        'DEV_PROGRAM',
        'DEV_TABLE',
        'DEV_TRANSACTION',
      ])
      .optional()
      .describe('Development type (default DEV_CUSTOM_FIORI_APPLICATION)'),
    developmentId: z.string().max(255).optional().describe('Technical development object id'),
    packageName: z.string().max(255).optional().describe('ABAP package of the development object'),
    ...systemScope,
    ...classification('development'),
    ...upgradeClassification('development'),
  })
  .strict();

const xlibInterfaceCreateSchema = z
  .object({
    ...xlibBase,
    interfaceTypeCode: z
      .enum([
        'API',
        'APPLICATION_LINK_ENABLING',
        'BATCH_INPUT',
        'GENERAL_FILE_BASED_INTERFACE',
        'GRAPHQL',
        'HTTP_WEBSERVICE',
        'ODATA',
        'ODATA_V2',
        'ODATA_V4',
        'OTHER',
        'REMOTE_FUNCTION_CALL',
        'REST',
        'SAP_COULD_PLATFORM_INTEGRATION',
        'SOAP',
        'MCP_SERVER',
        'SLT_REPLICATION',
        'FILE',
        'BW_EXTRACTOR',
      ])
      .optional()
      .describe('Interface type (default ODATA)'),
    sendingSystemGroupId: uuid.optional().describe('UUID of the sending system group'),
    sendingSolutionComponentId: uuid.optional().describe('UUID of the sending solution component'),
    receivingSystemGroupId: uuid.optional().describe('UUID of the receiving system group'),
    receivingSolutionComponentId: uuid
      .optional()
      .describe('UUID of the receiving solution component'),
    middlewareSystemGroupId: uuid.optional().describe('UUID of the middleware system group'),
    ...classification('interface'),
    ...upgradeClassification('interface'),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Features (CALM_CDM_ODATA.yaml — POST /Features, schema Features-create)
// ---------------------------------------------------------------------------------------------

/** Feature lifecycle status codes, with the labels the Cloud ALM UI shows. */
const FEATURE_STATUS_CODES = [
  'CREATED',
  'NOT_PLANNED',
  'IN_REALIZATION',
  'IN_TESTING',
  'SUCCESSFULLY_TESTED',
  'APPROVED_FOR_DEPLOYMENT',
  'CONFIRMED',
] as const;

/**
 * The feature fields a caller may set on create and change on update. Shared, so the two cannot
 * drift apart. `projectId` and `type` are create-only: moving a feature between projects or changing
 * its type is not something an update should do on the side.
 */
export const featureEditableFields = {
  title: z.string().min(1).max(600).describe('Feature title'),
  description: z
    .string()
    .max(500_000)
    .describe(
      "HTML rich-text description. Images are <img> tags referencing Cloud ALM's image service; " +
        'keep every such tag when changing the text',
    ),
  scopeId: uuid.describe('UUID of the process scope'),
  statusCode: z
    .enum(FEATURE_STATUS_CODES)
    .describe(
      'Status: CREATED (In Specification), NOT_PLANNED, IN_REALIZATION, IN_TESTING, ' +
        'SUCCESSFULLY_TESTED, APPROVED_FOR_DEPLOYMENT, CONFIRMED',
    ),
  priorityCode: priorityCode().describe('Priority: 10 very high, 20 high, 30 medium, 40 low'),
  responsibleId: z.string().min(1).max(255).describe('User id of the responsible person'),
  releaseId: uuid.describe('UUID of the release'),
  workstreamId: z.string().min(1).max(255).describe('Workstream id'),
};

export const featureCreateSchema = z
  .object({
    title: featureEditableFields.title,
    projectId: uuid.describe('UUID of the project the feature belongs to'),
    description: featureEditableFields.description.optional(),
    scopeId: featureEditableFields.scopeId.optional(),
    statusCode: featureEditableFields.statusCode.optional(),
    priorityCode: featureEditableFields.priorityCode.optional(),
    responsibleId: featureEditableFields.responsibleId.optional(),
    releaseId: featureEditableFields.releaseId.optional(),
    workstreamId: featureEditableFields.workstreamId.optional(),
    toURLReferences: z.array(urlReference).optional().describe('Links to attach'),
    toExternalReferences: z
      .array(idExternalReference)
      .optional()
      .describe('External system identifiers to attach'),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Tasks (CALM_TKM.yaml — POST /tasks, schema TaskCreationRequest; POST /tasks/{taskId}/comments,
// schema CommentCreationRequest)
// ---------------------------------------------------------------------------------------------

/**
 * Task types a caller may create. Roadmap tasks (`CALMTMPL`), quality gates (`CALMQGATE`) and
 * checklist items (`CALMCHKLI`) come from templates and the project setup, not from a model.
 */
const TASK_TYPES = ['CALMTASK', 'CALMUS', 'CALMST', 'CALMREQU', 'CALMDEF', 'CALMRISK'] as const;

/** Classification codes, each valid for one task type only (see `ClassificationId` in the spec). */
const TASK_CLASSIFICATIONS = {
  CALMUS: ['US_GAP', 'US_WRICEF', 'US_FIT', 'US_NOFUNC'],
  CALMREQU: ['REQ_GAP', 'REQ_WRICEF', 'REQ_FIT', 'REQ_NOFUNC'],
  CALMDEF: ['FUNCT', 'TECH', 'USAB', 'DOCU', 'SCOP', 'HAND'],
} as const;

/** Sub-classification codes per classification (see `SubClassification` in the spec). */
const TASK_SUB_CLASSIFICATIONS: Record<string, readonly string[]> = {
  US_GAP: [
    'US_EXT_CONF_NO_ALIGN',
    'US_ROADMAP',
    'US_EXT_PROCESS',
    'US_EXT_NON_PROCESS',
    'US_MACHINE_LEARNING',
  ],
  US_WRICEF: [
    'US_WORKFLOW',
    'US_REPORT',
    'US_INTERFACE',
    'US_CONVERSION',
    'US_ENHANCEMENT',
    'US_FORM',
  ],
  US_FIT: ['US_SAP_CONTENT', 'US_SOFTWARE_VENDOR', 'US_EXT_CONF_ALIGNED'],
  REQ_GAP: [
    'REQ_EXT_CONF_NOALIGN',
    'REQ_ROADMAP',
    'REQ_EXT_PROCESS',
    'REQ_EXT_NON_PROCESS',
    'REQ_MACHINE_LEARNING',
  ],
  REQ_WRICEF: [
    'REQ_WORKFLOW',
    'REQ_REPORT',
    'REQ_INTERFACE',
    'REQ_CONVERSION',
    'REQ_ENHANCEMENT',
    'REQ_FORM',
  ],
  REQ_FIT: ['REQ_SAP_CONTENT', 'REQ_SOFTWARE_VENDOR', 'REQ_EXT_CONF_ALIGNED'],
  FUNCT: ['FUNCT_BUG', 'FUNCT_MISS', 'FUNCT_CONFIG_ERR'],
  TECH: ['TECH_DEF', 'TECH_PERFORMANCE', 'TECH_AUTH', 'TECH_CONF'],
  USAB: ['USAB_NAV', 'USAB_TRANS', 'USAB_CONN'],
  DOCU: ['DOCU_ERROR', 'DOCU_TEST_CASE', 'DOCU_KNOWLEDGE_GAP'],
  SCOP: ['SCOP_CHANGE_REQU', 'SCOP_ENHANCEMENT', 'SCOP_CONSULT_REQU'],
  HAND: ['HAND_NOT_REPRODUCE', 'HAND_DUPLICATE', 'HAND_WORKING_INTEN', 'HAND_USER_ERROR'],
};

/** Fields the spec allows on risks (`CALMRISK`) only. */
const RISK_FIELDS = ['owner', 'impact', 'probability', 'mitigationStrategyId', 'categoryId'];

/** ISO date (YYYY-MM-DD), as the Tasks API expects for start and due dates. */
const isoDate = z.iso.date();

/**
 * New task, user story, sub-task, requirement, defect or risk. Left out of the spec's request body:
 * `source` (calmcp's tasks are MANUAL, the default), `externalIntegration` (set by integrations),
 * `answer` (checklist items only) and the tenant-specific `customField1..20`.
 */
const taskCreateSchema = z
  .object({
    title: z.string().min(1).max(180).describe('Task title'),
    projectId: uuid.describe('UUID of the project the task belongs to'),
    type: z
      .enum(TASK_TYPES)
      .describe(
        'Task type: CALMTASK project task, CALMUS user story, CALMST sub-task (needs parentId), ' +
          'CALMREQU requirement, CALMDEF defect, CALMRISK risk',
      ),
    description: z.string().max(500_000).optional().describe('HTML rich-text description'),
    parentId: uuid
      .optional()
      .describe('UUID of the parent task; required for a sub-task, and not itself a sub-task'),
    priorityId: priorityCode()
      .optional()
      .describe('Priority: 10 very high, 20 high, 30 medium, 40 low'),
    assigneeId: z.string().min(1).max(255).optional().describe('User id of the assignee'),
    reviewerId: z.string().min(1).max(255).optional().describe('User id of the reviewer'),
    startDate: isoDate.optional().describe('Start date, YYYY-MM-DD'),
    dueDate: isoDate.optional().describe('Planned completion date, YYYY-MM-DD'),
    timeboxId: uuid.optional().describe('UUID of the timebox (sprint); calm_list timeboxes'),
    releaseId: uuid.optional().describe('UUID of the release'),
    scopeId: uuid.optional().describe('UUID of the process scope'),
    deliverableId: uuid.optional().describe('UUID of the deliverable; calm_list deliverables'),
    workstream: z
      .string()
      .max(500)
      .optional()
      .describe('Workstream ids, comma separated, e.g. "WS001,WS002"; calm_list workstreams'),
    assignedRoleId: uuid.optional().describe("UUID of the task's responsible role"),
    responsibleTeamId: uuid.optional().describe("UUID of the task's responsible team"),
    responsibleUserType: z
      .enum(['EMPLO', 'SAP', 'PRTNR', 'OTHER'])
      .optional()
      .describe('Kind of responsible user: EMPLO employee, SAP, PRTNR partner, OTHER'),
    involvedParties: z
      .string()
      .max(500)
      .optional()
      .describe('User ids of involved parties, comma separated'),
    storyPoints: z.number().int().min(0).optional().describe('Story points, 0 or more'),
    effort: z
      .number()
      .min(0)
      .max(100_000)
      .optional()
      .describe('Effort in hours (decimal); not for sub-tasks'),
    externalId: z.string().min(1).max(128).optional().describe('Identifier in an external system'),
    classificationId: z
      .enum([
        ...TASK_CLASSIFICATIONS.CALMUS,
        ...TASK_CLASSIFICATIONS.CALMREQU,
        ...TASK_CLASSIFICATIONS.CALMDEF,
      ])
      .optional()
      .describe(
        'Classification: US_* for user stories, REQ_* for requirements, FUNCT, TECH, USAB, DOCU, ' +
          'SCOP or HAND for defects',
      ),
    subClassifications: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Sub-classifications of the classification, e.g. US_REPORT under US_WRICEF or ' +
          'FUNCT_BUG under FUNCT',
      ),
    testClassifications: z
      .array(
        z.enum([
          'ACCEPTANCE',
          'INTEGRATION',
          'SCENARIO',
          'FUNCTIONAL',
          'REGRESSION',
          'SECURITY',
          'PERFORMANCE',
          'USABILITY',
        ]),
      )
      .optional()
      .describe('Test classifications; user stories and requirements only'),
    owner: z.string().min(1).max(255).optional().describe('Risks only: email address of the owner'),
    impact: z.number().int().min(1).max(5).optional().describe('Risks only: impact 1 to 5'),
    probability: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe('Risks only: probability 1 to 5'),
    mitigationStrategyId: z
      .enum(['AVOID', 'REDUCE', 'TRANSFER', 'ACCEPT', 'MONITOR'])
      .optional()
      .describe('Risks only: mitigation strategy'),
    categoryId: z
      .enum(['COMP', 'EXT', 'FIN', 'ORG', 'IT', 'PM'])
      .optional()
      .describe('Risks only: category'),
    externalReferences: z
      .array(idExternalReference)
      .optional()
      .describe('External system identifiers to attach'),
  })
  .strict()
  // The spec states these rules in prose. Cloud ALM may or may not enforce them; checking here means
  // a mistyped combination is refused before anything is created, never stored half-right.
  .superRefine((task, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (task.type === 'CALMST' && task.parentId === undefined) {
      issue('parentId', 'a sub-task (CALMST) needs the parentId of the task it belongs to');
    }
    if (task.type === 'CALMST' && task.effort !== undefined) {
      issue('effort', 'a sub-task (CALMST) carries no effort');
    }
    if (task.type !== 'CALMRISK') {
      for (const field of RISK_FIELDS.filter((f) => f in task)) {
        issue(field, `${field} applies to risks (CALMRISK) only`);
      }
    }
    if (task.classificationId !== undefined) {
      const allowed = (TASK_CLASSIFICATIONS as Record<string, readonly string[]>)[task.type];
      if (!allowed?.includes(task.classificationId)) {
        issue(
          'classificationId',
          allowed
            ? `${task.type} takes one of: ${allowed.join(', ')}`
            : `${task.type} takes no classification; user stories, requirements and defects do`,
        );
      }
    }
    if (task.subClassifications !== undefined) {
      const allowed = TASK_SUB_CLASSIFICATIONS[task.classificationId ?? ''] ?? [];
      const wrong = task.subClassifications.filter((code) => !allowed.includes(code));
      if (wrong.length > 0) {
        issue(
          'subClassifications',
          allowed.length > 0
            ? `${wrong.join(', ')} not valid under ${task.classificationId}; use: ${allowed.join(', ')}`
            : `needs a classificationId that has sub-classifications (${Object.keys(TASK_SUB_CLASSIFICATIONS).join(', ')})`,
        );
      }
    }
    if (
      task.testClassifications !== undefined &&
      task.type !== 'CALMUS' &&
      task.type !== 'CALMREQU'
    ) {
      issue('testClassifications', 'applies to user stories (CALMUS) and requirements only');
    }
  });

/** A comment on an existing task. `taskId` goes into the path, `text` is the body. */
const taskCommentCreateSchema = z
  .object({
    taskId: uuid.describe('UUID of the task (incl. defect, user story) to comment on'),
    text: z.string().min(1).max(100_000).describe('The comment; HTML formatting is allowed'),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Links between existing objects (CALM_TKM.yaml — POST /tasks/{id}/featureAssignments,
// /documentAssignments, /hierarchyNodeAssignments, /tasks/{taskId}/relations, /references;
// CALM_CDM_ODATA.yaml — POST /Features/{uuid}/toURLReferences; CALM_TM.yaml — POST
// /TaskAssignments)
// ---------------------------------------------------------------------------------------------

/**
 * The uuid of an object, or its display id where calmcp can resolve one (features, documents,
 * process hierarchy nodes, manual test cases). Tasks have no display id lookup in their API.
 */
const uuidOrDisplayId = z.string().refine((value) => isGuid(value) || DISPLAY_ID.test(value), {
  message: 'must be a uuid or a display id such as 6-132',
});

const linkTaskId = uuid.describe('UUID of the task (incl. defect, user story); calm_list tasks');

const taskFeatureLinkSchema = z
  .object({
    taskId: linkTaskId,
    featureId: uuidOrDisplayId.describe('UUID or display id (e.g. 6-132) of the feature'),
  })
  .strict();

const taskDocumentLinkSchema = z
  .object({
    taskId: linkTaskId,
    documentId: uuidOrDisplayId.describe('UUID or display id (e.g. 7-1) of the document'),
  })
  .strict();

const taskProcessLinkSchema = z
  .object({
    taskId: linkTaskId,
    hierarchyNodeId: uuidOrDisplayId.describe(
      'UUID or display id (e.g. 14-2) of the process hierarchy node',
    ),
  })
  .strict();

/**
 * Relation types a caller may create. The code names what `relationTaskId` is to `taskId`, as the
 * Cloud ALM UI shows it (checked on a tenant): 2 predecessor, 12 successor, 1 peer. The spec's
 * description calls the successor 20, which Cloud ALM refuses; its enum's 12 is right. Child (0)
 * and parent (10) are accepted by Cloud ALM between any two tasks, but build a hierarchy beside the
 * sub-tasks, so they are left out: a sub-task is a `task` with `parentId`.
 */
const taskRelationSchema = z
  .object({
    taskId: uuid.describe('UUID of the task, defect or user story the relation is added to'),
    type: z
      .enum(['2', '12', '1'])
      .describe(
        "What relationTaskId is to taskId: '2' its predecessor, '12' its successor, '1' a peer " +
          '(project task and user story only). Sub-tasks are created as task with parentId',
      ),
    relationTaskId: uuid.describe('UUID of the related task, defect or user story'),
  })
  .strict()
  .refine((relation) => relation.taskId !== relation.relationTaskId, {
    path: ['relationTaskId'],
    message: 'a task cannot be related to itself',
  });

/** A link on a task. The spec allows https only. */
const taskReferenceSchema = z
  .object({
    taskId: linkTaskId,
    name: z.string().min(1).max(500).describe('Display name of the link'),
    url: httpUrl(2048, { httpsOnly: true }).describe('Target URL, starting with https://'),
  })
  .strict();

const featureUrlReferenceSchema = z
  .object({
    featureId: uuidOrDisplayId.describe('UUID or display id (e.g. 6-132) of the feature'),
    ...urlReference.shape,
  })
  .strict();

const testCaseTaskLinkSchema = z
  .object({
    testCaseId: uuidOrDisplayId.describe(
      'UUID of the manual or automated test case, or display id of a manual one',
    ),
    taskId: uuid.describe('UUID of the user story or requirement the test case covers'),
  })
  .strict();

/**
 * Whether a link with this URL is already on the object; Cloud ALM would store a second one. An
 * answer in an unknown shape is refused, not read as "no links": that would create the duplicate.
 */
async function urlTaken(rows: Promise<unknown>, url: unknown): Promise<boolean> {
  const list = await rows;
  const entries = Array.isArray(list)
    ? list
    : Array.isArray((list as { value?: unknown } | undefined)?.value)
      ? (list as { value: unknown[] }).value
      : undefined;
  if (!entries) {
    throw new LookupError(
      'Cloud ALM answered the check for existing links in an unknown shape, so nothing was sent.',
      'UPSTREAM_ERROR',
    );
  }
  return entries.some((entry) => (entry as { url?: unknown } | null)?.url === url);
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** A `calm_create` resource: one collection plus the strict schema of its create payload. */
export interface CreateResource {
  service: ServiceName;
  /**
   * The collection the POST goes to: an OData entity set, or a REST path below the service. A
   * `{field}` in it names a payload field that is moved into the path instead of the body.
   */
  entitySet: string;
  /** Strict payload schema; unknown properties are rejected. */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Fields Cloud ALM may render as HTML, checked for active content before sending. */
  textFields: string[];
  description: string;
  /** Payload fields that also take a display id, and the OData entity set it is looked up in. */
  displayIds?: Record<string, { service: ServiceName; entitySet: string; noun: string }>;
  /** Payload fields the spec names differently, sent under the spec's name. */
  sendAs?: Record<string, string>;
  /**
   * Whether an equal link already exists. Only for links Cloud ALM stores twice when asked twice;
   * it refuses duplicate assignments and relations itself.
   */
  exists?: (clients: CalmClients, data: Record<string, unknown>) => Promise<boolean>;
}

/** Resources creatable via `calm_create`, keyed by the public `resource` value. */
export const CREATE_RESOURCES: Record<string, CreateResource> = {
  document: {
    service: 'documents',
    entitySet: 'Documents',
    schema: documentCreateSchema,
    textFields: ['content'],
    description:
      'A new document in a project, with optional HTML content and assignments (links, ' +
      'processes, hierarchy nodes, tasks, library elements, test cases) created in the same call',
  },
  feature: {
    service: 'features',
    entitySet: 'Features',
    schema: featureCreateSchema,
    textFields: ['description'],
    description:
      'A new feature in a project, with optional HTML description, status, priority and links ' +
      'created in the same call',
  },
  task: {
    service: 'tasks',
    entitySet: 'tasks',
    schema: taskCreateSchema,
    textFields: ['description'],
    description:
      'A new task in a project: project task, user story, sub-task, requirement, defect or risk, ' +
      'with optional HTML description, assignee, priority, dates and sprint',
  },
  task_comment: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/comments',
    schema: taskCommentCreateSchema,
    textFields: ['text'],
    description: 'A new comment on an existing task, defect or user story',
  },
  xlib_application: {
    service: 'xlibApplications',
    entitySet: 'Applications',
    schema: xlibApplicationCreateSchema,
    textFields: ['description'],
    description: 'A new cross-library application (Fiori app, transaction, program, ...)',
  },
  xlib_configuration: {
    service: 'xlibConfigurations',
    entitySet: 'Configurations',
    schema: xlibConfigurationCreateSchema,
    textFields: ['description'],
    description: 'A new cross-library configuration (authorization, master data, WRICEF, ...)',
  },
  xlib_configuration_activity: {
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationActivities',
    schema: xlibConfigurationActivityCreateSchema,
    textFields: ['description'],
    description:
      'A new configuration activity (IMG activity, role, program, transaction), optionally ' +
      'assigned to existing configurations',
  },
  xlib_development: {
    service: 'xlibDevelopments',
    entitySet: 'Developments',
    schema: xlibDevelopmentCreateSchema,
    textFields: ['description'],
    description: 'A new cross-library development object (class, program, package, ...)',
  },
  xlib_interface: {
    service: 'xlibInterfaces',
    entitySet: 'Interfaces',
    schema: xlibInterfaceCreateSchema,
    textFields: ['description'],
    description: 'A new cross-library interface (OData, RFC, SOAP, REST, MCP server, ...)',
  },
  task_feature_link: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/featureAssignments',
    schema: taskFeatureLinkSchema,
    textFields: [],
    displayIds: { featureId: { service: 'features', entitySet: 'Features', noun: 'feature' } },
    description: 'Link an existing feature to an existing task, defect or user story',
  },
  task_document_link: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/documentAssignments',
    schema: taskDocumentLinkSchema,
    textFields: [],
    displayIds: {
      documentId: { service: 'documents', entitySet: 'Documents', noun: 'document' },
    },
    description: 'Link an existing document to an existing task, defect or user story',
  },
  task_process_link: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/hierarchyNodeAssignments',
    schema: taskProcessLinkSchema,
    textFields: [],
    displayIds: {
      hierarchyNodeId: {
        service: 'processhierarchy',
        entitySet: 'HierarchyNodes',
        noun: 'process hierarchy node',
      },
    },
    description: 'Link an existing process hierarchy node to an existing task or user story',
  },
  task_relation: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/relations',
    schema: taskRelationSchema,
    textFields: [],
    description:
      'Relate two existing tasks, defects or user stories as predecessor, successor or peer',
  },
  task_reference: {
    service: 'tasks',
    entitySet: 'tasks/{taskId}/references',
    schema: taskReferenceSchema,
    textFields: [],
    exists: (clients, data) =>
      urlTaken(
        clients.getRest('tasks', `/tasks/${encodeURIComponent(String(data.taskId))}/references`),
        data.url,
      ),
    description: 'Add a link (name and https URL) to an existing task, defect or user story',
  },
  feature_url_reference: {
    service: 'features',
    entitySet: 'Features/{featureId}/toURLReferences',
    schema: featureUrlReferenceSchema,
    textFields: [],
    displayIds: { featureId: { service: 'features', entitySet: 'Features', noun: 'feature' } },
    // parent_uuid is an Edm.String in the Features API, so the uuid is quoted.
    exists: (clients, data) =>
      urlTaken(
        clients.listOData('features', 'URLReferences', {
          filter: `parent_uuid eq ${odataString(String(data.featureId))}`,
          select: 'url',
        }),
        data.url,
      ),
    description: 'Add a link (name and URL) to an existing feature',
  },
  test_case_task_link: {
    service: 'testmanagement',
    entitySet: 'TaskAssignments',
    schema: testCaseTaskLinkSchema,
    textFields: [],
    displayIds: {
      testCaseId: {
        service: 'testmanagement',
        entitySet: 'ManualTestCases',
        noun: 'manual test case',
      },
    },
    sendAs: { testCaseId: 'parentTestCase_ID' },
    description: 'Link an existing test case to the user story or requirement it covers',
  },
};

/** Public `resource` values accepted by `calm_create`. */
export const CREATE_RESOURCE_NAMES = Object.keys(CREATE_RESOURCES);
