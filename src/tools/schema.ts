// A small validator for the skills' argument schemas (src/tools/registry.ts): a plain,
// JSON-schema-like object, checked before the persona's call may run (src/tools/gateway.ts).
// The model's arguments are data: an unknown key, a wrong type or an over-long text refuses the
// call instead of being coerced. Pure. Only the keywords below are read: `type` (object, string,
// integer, number, boolean, array), `properties`, `required`, `additionalProperties: false`,
// `minLength` / `maxLength` (code points), `minimum` / `maximum`, `enum`, `items`, `minItems` /
// `maxItems`, `anyOf`.

import { isPlainObject } from '../config.js';

/** True when `value` has the schema type `type`. */
function hasType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * The first way `value` breaks `schema`, as `<path>:<rule>` (`args.text:max-length`,
 * `args.messageId:type`, `args.extra:unknown`, `args:any-of`), or null when it holds.
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [where]  The path of `value`, `args` at the top.
 * @returns {string|null}
 */
export function schemaError(value, schema, where = 'args') {
  if (!isPlainObject(schema)) return `${where}:schema`;
  const fail = (rule) => `${where}:${rule}`;

  if (schema.type !== undefined && !hasType(value, schema.type)) return fail('type');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return fail('enum');

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (Number.isFinite(schema.minLength) && length < schema.minLength) return fail('min-length');
    if (Number.isFinite(schema.maxLength) && length > schema.maxLength) return fail('max-length');
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return fail('minimum');
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return fail('maximum');
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return fail('min-items');
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return fail('max-items');
    if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i += 1) {
        const error = schemaError(value[i], schema.items, `${where}.${i}`);
        if (error) return error;
      }
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
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
