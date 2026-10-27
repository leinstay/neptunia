// A small validator for the skills' argument schemas (src/tools/registry.ts): a plain,
// JSON-schema-like object, checked before the persona's call may run (src/tools/gateway.ts).
// The model's arguments are data: an unknown key, a wrong type or an over-long text refuses the
// call instead of being coerced. Pure. Only the keywords below are read: `type` (object, string,
// integer, number, boolean, array), `properties`, `required`, `additionalProperties: false`,
// `minLength` / `maxLength` (code points), `minimum` / `maximum`, `enum`, `items`, `minItems` /
// `maxItems`, `anyOf`.

import { isObj, objOf } from './types.ts';
import type { Obj } from './types.ts';

/** A finite number, as a type guard. */
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** True when `value` has the schema type `type`. */
function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object':
      return isObj(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return finite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * The first way `value` breaks `schema`, as `<path>:<rule>` (`args.text:max-length`,
 * `args.messageId:type`, `args.extra:unknown`, `args:any-of`), or null when it holds. `where` is the path of
 * `value`, `args` at the top.
 */
export function schemaError(value: unknown, schema: unknown, where = 'args'): string | null {
  if (!isObj(schema)) return `${where}:schema`;
  const fail = (rule: string): string => `${where}:${rule}`;

  if (schema.type !== undefined && !hasType(value, schema.type)) return fail('type');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return fail('enum');

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (finite(schema.minLength) && length < schema.minLength) return fail('min-length');
    if (finite(schema.maxLength) && length > schema.maxLength) return fail('max-length');
  }
  if (typeof value === 'number') {
    if (finite(schema.minimum) && value < schema.minimum) return fail('minimum');
    if (finite(schema.maximum) && value > schema.maximum) return fail('maximum');
  }
  if (Array.isArray(value)) {
    if (finite(schema.minItems) && value.length < schema.minItems) return fail('min-items');
    if (finite(schema.maxItems) && value.length > schema.maxItems) return fail('max-items');
    if (isObj(schema.items)) {
      for (let i = 0; i < value.length; i += 1) {
        const error = schemaError(value[i], schema.items, `${where}.${i}`);
        if (error) return error;
      }
    }
  }
  if (isObj(value)) {
    const properties: Obj = objOf(schema.properties);
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key !== 'string') continue;
      if (!Object.hasOwn(value, key) || value[key] === undefined) return `${where}.${key}:required`;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) return `${where}.${key}:unknown`;
        continue;
      }
      if (value[key] === undefined) continue;
      const error = schemaError(value[key], properties[key], `${where}.${key}`);
      if (error) return error;
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((option) => schemaError(value, option, where) === null)) return fail('any-of');
  }
  return null;
}
