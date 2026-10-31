// The checks of what a board operation is given: strings, integers, amounts, times and JSON, the task fields and
// their aliases, and the auto-triage entries of the settings. src/board/board.ts calls them; each refusal is a
// BoardError 'invalid' that names the field.

import { BoardError } from './machine.ts';

export type SqlValue = string | number | null;
export type Args = Readonly<Record<string, unknown>>;

export const invalid = (message: string): BoardError => new BoardError('invalid', message);

// The short names the CLI and the settings use for three task fields.
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  budget: 'budget_usd',
  estimate: 'estimate_minutes',
  steps: 'step_cap',
};
export const UPDATABLE = [
  'title',
  'description',
  'acceptance',
  'priority',
  'risk',
  'role',
  'budget_usd',
  'step_cap',
  'estimate_minutes',
  'defer_until',
  'metadata',
] as const;
// The fields the owner and the reviewer may still change on a closed task (a failed task's next run), and of them
// the ones task.retry takes along.
export const BUDGET_FIELDS: ReadonlyArray<string> = ['budget_usd', 'step_cap', 'estimate_minutes'];
export const RETRY_FIELDS: ReadonlyArray<string> = ['budget_usd', 'step_cap'];
// The fields `task.add` with `auto` fills from the settings when the caller left them out.
export const AUTO_TRIAGE_FIELDS = ['role', 'budget_usd', 'step_cap', 'estimate_minutes'] as const;
export type TriageFields = Partial<Record<(typeof AUTO_TRIAGE_FIELDS)[number], SqlValue>>;

const given = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

export function str(value: unknown, name: string, { required = false, max = 100000 } = {}): string | null {
  if (!given(value)) {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  if (value.length > max) throw invalid(`${name} is too long`);
  return value;
}

export function int(value: unknown, name: string, { min = -Infinity, max = Infinity } = {}): number | null {
  if (!given(value)) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw invalid(`${name} must be an integer${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}`);
  }
  return n;
}

export function num(value: unknown, name: string): number | null {
  if (!given(value)) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw invalid(`${name} must be a non-negative number`);
  return n;
}

function isoTime(value: unknown, name: string): string | null {
  if (!given(value)) return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw invalid(`${name} must be an ISO time`);
  return new Date(ms).toISOString();
}

export function jsonText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
    } catch {
      throw invalid(`${name} must be JSON`);
    }
    return value;
  }
  return JSON.stringify(value);
}

/** One value under two names (the errand mirror sends the alias): either, or both when they agree. */
export function aliased(args: Args, name: string, alias: string): unknown {
  const a = args[name];
  const b = args[alias];
  const has = (v: unknown): boolean => v !== undefined && v !== null;
  if (has(a) && has(b) && a !== b) throw invalid(`${name} and ${alias} differ`);
  return has(a) ? a : b;
}

/**
 * The lease of a claim or a heartbeat in minutes: ttl_minutes, or lease_seconds rounded up to whole minutes (at least
 * 1); both given must agree; neither, `fallback`.
 */
export function leaseMinutes(args: Args, fallback: number): number {
  const ttl = int(args.ttl_minutes, 'ttl_minutes', { min: 1, max: 24 * 60 });
  const seconds = int(args.lease_seconds, 'lease_seconds', { min: 1, max: 24 * 60 * 60 });
  const fromSeconds = seconds === null ? null : Math.max(1, Math.ceil(seconds / 60));
  if (ttl !== null && fromSeconds !== null && ttl !== fromSeconds)
    throw invalid('ttl_minutes and lease_seconds differ');
  return ttl ?? fromSeconds ?? fallback;
}

/** A task field as stored; throws BoardError 'invalid' for a bad value or an unknown field. */
export function normalizeField(name: string, value: unknown): SqlValue {
  switch (name) {
    case 'title':
      return str(value, 'title', { required: true, max: 500 });
    case 'description':
    case 'acceptance':
    case 'role':
      return str(value, name);
    case 'priority':
      return int(value, 'priority', { min: 0, max: 4 }) ?? 2;
    case 'risk':
      if (value === undefined || value === null) return 'normal';
      if (value !== 'low' && value !== 'normal' && value !== 'high') throw invalid('risk must be low, normal or high');
      return value;
    case 'budget_usd':
      return num(value, 'budget');
    case 'step_cap':
      return int(value, 'step_cap', { min: 1, max: 100000 });
    case 'estimate_minutes':
      return int(value, 'estimate', { min: 1, max: 100000 });
    case 'defer_until':
      return isoTime(value, 'defer_until');
    default:
      throw invalid(`unknown field ${name}`);
  }
}

/** The entries of `args` whose name (or alias) is in `allowed`, under their long names. */
export function pickFields(args: unknown, allowed: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args === null || typeof args !== 'object') return out;
  for (const [key, value] of Object.entries(args)) {
    const name = FIELD_ALIASES[key] ?? key;
    if (allowed.includes(name)) out[name] = value;
  }
  return out;
}

/**
 * The picked fields as columns of a task whose stored metadata is `metadata`. Metadata merges shallowly, a null value
 * deleting its key.
 */
export function applyFields(
  metadata: string | null,
  picked: Readonly<Record<string, unknown>>
): Record<string, SqlValue> {
  const fields: Record<string, SqlValue> = {};
  for (const [name, value] of Object.entries(picked)) {
    if (name === 'metadata') {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw invalid('metadata must be an object');
      // The stored metadata is always the JSON of an object: applyFields and task.add are its only writers.
      const merged = { ...(metadata ? (JSON.parse(metadata) as Record<string, unknown>) : {}) };
      for (const [key, item] of Object.entries(value)) {
        if (item === null) delete merged[key];
        else merged[key] = item;
      }
      fields.metadata = JSON.stringify(merged);
    } else if (name === 'defer_until' && value === null) {
      fields.defer_until = null;
    } else {
      fields[name] = normalizeField(name, value);
    }
  }
  return fields;
}

/**
 * An auto-triage entry of the settings, `{ role, budget, steps, estimate }` (the long field names too), as task
 * fields. Throws a plain Error naming `where` for an unknown or invalid field.
 */
export function normalizeAutoTriage(entry: unknown, where: string): TriageFields {
  if (entry === undefined || entry === null) return {};
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`);
  const out: TriageFields = {};
  for (const [key, value] of Object.entries(entry)) {
    const name = FIELD_ALIASES[key] ?? key;
    const field = AUTO_TRIAGE_FIELDS.find((f) => f === name);
    if (field === undefined) throw new Error(`${where}: unknown field ${key}`);
    try {
      out[field] = normalizeField(field, value);
    } catch (error) {
      throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return out;
}

/** A value of an argument as text for a message or a parse: a string as it is, anything else as JSON. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
