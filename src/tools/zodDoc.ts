// Field documentation derived from zod schemas, so what `calm_resources` tells a client about a
// `calm_create` payload cannot drift from what the validation actually accepts.
//
// Reads zod v3 internals (`_def`); a zod major upgrade has to revisit `unwrap` and `describeType`.

import { z } from 'zod';

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
