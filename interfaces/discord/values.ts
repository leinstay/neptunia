// Reads an unknown value without a check at every use: the fields of a thrown error, a record, a scalar written as
// text. The Discord interface imports only the protocol of the core, so it keeps its own copies of the three small
// helpers the core's modules share (`src/error-fields.ts`, `src/tools/types.ts`). Called by the files of this folder.

/** What a failure may carry; each field is `undefined` when the thrown value has none. */
export type ErrorFields = { name?: unknown; message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };

/** The fields of `err` listed in `ErrorFields`: none for a value that is not an object. */
export function errorFields(err: unknown): ErrorFields {
  if (typeof err !== 'object' || err === null) return {};
  return {
    name: Reflect.get(err, 'name'),
    message: Reflect.get(err, 'message'),
    code: Reflect.get(err, 'code'),
    status: Reflect.get(err, 'status'),
    statusCode: Reflect.get(err, 'statusCode'),
  };
}

/** `value` as a record, or an empty one when it is not a record. */
export function objOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `value` written out when it is a string, a number, a boolean or a bigint, else the empty string. */
export function scalarText(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}
