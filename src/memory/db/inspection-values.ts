// The typed values of the owner's storage inspection (src/memory/db/inspection.ts). A value keeps its storage class and its
// exact bytes: an integer is its decimal text, because a 64-bit integer does not fit a JavaScript number, a blob is base64,
// and a REAL that JSON has no number for (SQLite stores infinities) is the word that names it.

import { coded } from './read-page.ts';

export type InspectionValue =
  | { kind: 'null' }
  | { kind: 'text'; value: string }
  | { kind: 'integer'; value: string }
  | { kind: 'real'; value: number }
  | { kind: 'real'; text: 'Infinity' | '-Infinity' }
  | { kind: 'blob'; encoding: 'base64'; value: string };

const BIG_INTEGER = /^-?\d+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INTEGER_MAX = 9223372036854775807n;
const INTEGER_MIN = -9223372036854775808n;

const bad = (what: string): Error => coded('INSPECTION_BAD_VALUE', `${what} cannot be represented exactly`);

function integerValue(raw: unknown): InspectionValue {
  if (typeof raw === 'bigint') return { kind: 'integer', value: raw.toString() };
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return { kind: 'integer', value: String(raw) };
  throw bad('this integer');
}

function realValue(raw: unknown): InspectionValue {
  if (typeof raw !== 'number' || Number.isNaN(raw)) throw bad('this real');
  if (Number.isFinite(raw)) return { kind: 'real', value: raw };
  return { kind: 'real', text: raw > 0 ? 'Infinity' : '-Infinity' };
}

/** The typed value of `raw` as a connection read it, under the storage class SQLite gives it. */
export function inspectionValueOf(
  storage: 'null' | 'integer' | 'real' | 'text' | 'blob',
  raw: unknown
): InspectionValue {
  switch (storage) {
    case 'null':
      return { kind: 'null' };
    case 'integer':
      return integerValue(raw);
    case 'real':
      return realValue(raw);
    case 'text':
      if (typeof raw !== 'string') throw bad('this text');
      return { kind: 'text', value: raw };
    case 'blob':
      if (!(raw instanceof Uint8Array)) throw bad('this blob');
      return { kind: 'blob', encoding: 'base64', value: Buffer.from(raw).toString('base64') };
  }
}

/** The value to bind for a filter or a locator; one that names no exact value is refused. */
export function sqlValueOf(typed: InspectionValue): null | string | number | bigint | Uint8Array {
  switch (typed.kind) {
    case 'null':
      return null;
    case 'text':
      return typed.value;
    case 'integer': {
      if (!BIG_INTEGER.test(typed.value)) throw bad('this integer');
      const parsed = BigInt(typed.value);
      if (parsed > INTEGER_MAX || parsed < INTEGER_MIN) throw bad('this integer');
      return parsed;
    }
    case 'real':
      if ('text' in typed) return typed.text === 'Infinity' ? Infinity : -Infinity;
      return typed.value;
    case 'blob':
      if (!BASE64.test(typed.value)) throw bad('this blob');
      return new Uint8Array(Buffer.from(typed.value, 'base64'));
  }
}

/** Whether `input`, from a command line or a file, has the shape of a typed value. */
export function isInspectionValue(input: unknown): input is InspectionValue {
  if (input === null || typeof input !== 'object') return false;
  const { kind, value, encoding, text } = input as Record<string, unknown>;
  switch (kind) {
    case 'null':
      return true;
    case 'text':
    case 'integer':
      return typeof value === 'string';
    case 'real':
      return (typeof value === 'number' && Number.isFinite(value)) || text === 'Infinity' || text === '-Infinity';
    case 'blob':
      return encoding === 'base64' && typeof value === 'string';
    default:
      return false;
  }
}
