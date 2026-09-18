// Create registry: the resources `calm_create` can add to SAP Cloud ALM, each with the strict payload
// schema transcribed from the `*-create` request bodies in `YAML/CALM_SD.yaml` and the four
// `YAML/CALM_XLIB_*.yaml` specs.
//
// Scope is deliberately narrow: new documents and new library entries (cross-library applications,
// configurations, configuration activities, developments, interfaces). There is no update and no
// delete. A document's stored HTML carries embedded images that a round-trip through an AI client
// would not preserve, so the safe operation is the one that cannot touch an existing record.
//
// Every schema is `.strict()`: an unknown property is an error, not something silently dropped,
// because a caller who typed `projectID` would otherwise get a document in no project at all.

import { z } from 'zod';
import type { ServiceName } from '../config.js';

// ---------------------------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------------------------

const uuid = z.string().uuid();

/** A link (display name + URL) attached to the new entity. Same shape in every service. */
const urlReference = z
  .object({
    name: z.string().min(1).max(255).describe('Display name of the link'),
    url: z.string().min(1).max(1000).describe('Target URL, starting with http:// or https://'),
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
    url: z.string().max(1000).optional().describe('URL pointing into the external system'),
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
      .optional()
      .describe('HTML rich-text body of the document. Plain text is accepted too'),
    scopeId: uuid.optional().describe('UUID of a process scope to assign the document to'),
    statusCode: z
      .union([z.literal(10), z.literal(20), z.literal(30)])
      .optional()
      .describe('Status code (default 10); calm_list resource:document_statuses lists the labels'),
    priorityCode: z
      .union([z.literal(10), z.literal(20), z.literal(30), z.literal(40)])
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
  description: z.string().optional().describe('Free-text description'),
  url: z.string().max(2048).optional().describe('URL to the object, e.g. its documentation'),
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
  })
  .strict();

export const xlibConfigurationCreateSchema = z
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
  })
  .strict();

export const xlibConfigurationActivityCreateSchema = z
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

export const xlibDevelopmentCreateSchema = z
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
    ...systemScope,
  })
  .strict();

export const xlibInterfaceCreateSchema = z
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
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** A `calm_create` resource: one OData entity set plus the strict schema of its create payload. */
export interface CreateResource {
  service: ServiceName;
  entitySet: string;
  /** Strict payload schema; unknown properties are rejected. */
  schema: z.ZodObject<z.ZodRawShape>;
  description: string;
}

/** Resources creatable via `calm_create`, keyed by the public `resource` value. */
export const CREATE_RESOURCES: Record<string, CreateResource> = {
  document: {
    service: 'documents',
    entitySet: 'Documents',
    schema: documentCreateSchema,
    description:
      'A new document in a project, with optional HTML content and assignments (links, ' +
      'processes, hierarchy nodes, tasks, library elements, test cases) created in the same call',
  },
  xlib_application: {
    service: 'xlibApplications',
    entitySet: 'Applications',
    schema: xlibApplicationCreateSchema,
    description: 'A new cross-library application (Fiori app, transaction, program, ...)',
  },
  xlib_configuration: {
    service: 'xlibConfigurations',
    entitySet: 'Configurations',
    schema: xlibConfigurationCreateSchema,
    description: 'A new cross-library configuration (authorization, master data, WRICEF, ...)',
  },
  xlib_configuration_activity: {
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationActivities',
    schema: xlibConfigurationActivityCreateSchema,
    description:
      'A new configuration activity (IMG activity, role, program, transaction), optionally ' +
      'assigned to existing configurations',
  },
  xlib_development: {
    service: 'xlibDevelopments',
    entitySet: 'Developments',
    schema: xlibDevelopmentCreateSchema,
    description: 'A new cross-library development object (class, program, package, ...)',
  },
  xlib_interface: {
    service: 'xlibInterfaces',
    entitySet: 'Interfaces',
    schema: xlibInterfaceCreateSchema,
    description: 'A new cross-library interface (OData, RFC, SOAP, REST, MCP server, ...)',
  },
};

/** Public `resource` values accepted by `calm_create`. */
export const CREATE_RESOURCE_NAMES = Object.keys(CREATE_RESOURCES);

// ---------------------------------------------------------------------------------------------
// Field documentation, derived from the schemas so calm_resources cannot drift from validation
// ---------------------------------------------------------------------------------------------

/** One documented payload field. */
export interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  values?: (string | number)[];
  description?: string;
  /** For arrays of objects: the fields of each element. */
  fields?: FieldDoc[];
}

/** Strip optional/nullable/default wrappers, remembering that the field may be omitted. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let inner = schema;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      inner = inner.unwrap();
      optional = true;
    } else if (inner instanceof z.ZodDefault) {
      inner = inner._def.innerType;
      optional = true;
    } else {
      return { inner, optional };
    }
  }
}

/** Describe the type of one (unwrapped) schema node. */
function describeType(schema: z.ZodTypeAny): Pick<FieldDoc, 'type' | 'values' | 'fields'> {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', values: [...schema.options] };
  if (schema instanceof z.ZodUnion) {
    const values = (schema.options as z.ZodTypeAny[])
      .filter((o): o is z.ZodLiteral<string | number> => o instanceof z.ZodLiteral)
      .map((o) => o.value);
    return { type: typeof values[0] === 'number' ? 'number' : 'string', values };
  }
  if (schema instanceof z.ZodArray) {
    const element = describeType(schema.element);
    return { type: `array of ${element.type}`, values: element.values, fields: element.fields };
  }
  if (schema instanceof z.ZodObject) return { type: 'object', fields: describeObject(schema) };
  return { type: 'unknown' };
}

/**
 * Document every field of a payload schema.
 *
 * @param schema - A `z.object` schema.
 * @returns One entry per property, required ones first.
 */
export function describeObject(schema: z.ZodObject<z.ZodRawShape>): FieldDoc[] {
  const docs = Object.entries(schema.shape).map(([name, property]) => {
    const { inner, optional } = unwrap(property);
    const description = property.description ?? inner.description;
    const doc: FieldDoc = { name, required: !optional, ...describeType(inner) };
    if (doc.values === undefined) delete doc.values;
    if (doc.fields === undefined) delete doc.fields;
    if (description) doc.description = description;
    return doc;
  });
  return [...docs.filter((d) => d.required), ...docs.filter((d) => !d.required)];
}
