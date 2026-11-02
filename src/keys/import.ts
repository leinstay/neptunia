// The one-time move of the model keys of a deployment into the key store: the `OPENROUTER_*_KEY` variables of the parsed
// `.env`, the `llm.keyByRole` map (which keys form the core list, which roles are bound to a key) and the `llm.keys`
// grants. The core list is `llm.keyByRole.core`, else `OPENROUTER_CORE_KEY` then `OPENROUTER_CORE_BACKUP_KEY`; its keys are
// named `core-1`, `core-2` in that order and take the grant of the variable they came from. Every other
// `OPENROUTER_<X>_KEY` becomes the extra key `<x>`, and a base role mapped to it is bound. Errand and development roles
// are left to the subharness, their key kept as an extra key. A variable that is not an OpenRouter key never enters
// the store. The report holds names, never a value. Run by scripts/keys-import.ts; it leaves `.env` and the config alone.

import { roleGroup } from '../llm/roles.ts';
import { KeysError } from './store.ts';
import type { KeyStore } from './store.ts';

export type ImportReport = {
  /** The core names written, in order. */
  core: Array<string>;
  /** The extra keys written, with the variable each came from. */
  extra: Array<{ name: string; from: string }>;
  bound: Array<{ role: string; name: string }>;
  /** What was left out: a variable or a role, with the reason. Names only. */
  skipped: Array<{ what: string; reason: string }>;
};

const MAIN_VARIABLE = 'OPENROUTER_CORE_KEY';
const BACKUP_VARIABLE = 'OPENROUTER_CORE_BACKUP_KEY';
const KEY_VARIABLE = /^OPENROUTER_([A-Z0-9_]+)_KEY$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The value a variable holds, or null when it is unset or blank. */
const valueOf = (env: Readonly<Record<string, string>>, name: string): string | null => {
  const value = Object.hasOwn(env, name) ? (env[name] ?? '').trim() : '';
  return value === '' ? null : value;
};

/** `llm.keyByRole` as a map of role to variable names: a name or a list of names, anything else left out. */
function keyByRoleOf(config: unknown): Map<string, Array<string>> {
  const llm = isRecord(config) ? config.llm : undefined;
  const map = isRecord(llm) ? llm.keyByRole : undefined;
  const roles = new Map<string, Array<string>>();
  if (!isRecord(map)) return roles;
  for (const [role, entry] of Object.entries(map)) {
    const names = (Array.isArray(entry) ? (entry as Array<unknown>) : [entry]).filter(
      (name): name is string => typeof name === 'string'
    );
    roles.set(role, [...new Set(names)]);
  }
  return roles;
}

/** The grant `llm.keys` gives a variable, or null when there is none or it is not `{ grant, resetDay }`. */
function grantOf(config: unknown, variable: string): { grant: number; resetDay: number } | null {
  const llm = isRecord(config) ? config.llm : undefined;
  const keys = isRecord(llm) ? llm.keys : undefined;
  const entry = isRecord(keys) && Object.hasOwn(keys, variable) ? keys[variable] : undefined;
  if (!isRecord(entry) || typeof entry.grant !== 'number' || typeof entry.resetDay !== 'number') return null;
  return { grant: entry.grant, resetDay: entry.resetDay };
}

/** The extra key name of a variable: `OPENROUTER_SIM_KEY` is `sim`, `OPENROUTER_CORE_BACKUP_KEY` is `core-backup`. */
const extraNameOf = (variable: string): string | null => {
  const found = KEY_VARIABLE.exec(variable);
  return found?.[1] === undefined ? null : found[1].toLowerCase().replaceAll('_', '-');
};

/** Writes the core list: the mapped names, else the main key and its backup. Returns the variables that became core keys. */
function importCore({ env, config, store, byRole, report }: Context): Set<string> {
  const variables = byRole.has('core') ? (byRole.get('core') ?? []) : [MAIN_VARIABLE, BACKUP_VARIABLE];
  const used = new Set<string>();
  for (const variable of variables) {
    const value = valueOf(env, variable);
    if (value === null) {
      // The backup is optional unless the owner named it.
      if (variable !== BACKUP_VARIABLE || byRole.has('core')) report.skipped.push({ what: variable, reason: 'unset' });
      continue;
    }
    const name = `core-${report.core.length + 1}`;
    try {
      store.addCore({ name, value, ...grantOf(config, variable) });
    } catch (err) {
      if (!(err instanceof KeysError)) throw err;
      if (err.code !== 'bad-grant') {
        report.skipped.push({ what: variable, reason: err.code });
        continue;
      }
      // A grant the store refuses is left out; the key itself is kept.
      store.addCore({ name, value });
    }
    report.core.push(name);
    used.add(variable);
  }
  return used;
}

/** Writes every other OpenRouter key variable as an extra key. Returns the extra name of each variable written. */
function importExtra({ env, store, report }: Context, coreUsed: ReadonlySet<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const variable of Object.keys(env)) {
    const extra = extraNameOf(variable);
    if (extra === null || coreUsed.has(variable)) continue;
    const value = valueOf(env, variable);
    if (value === null) {
      report.skipped.push({ what: variable, reason: 'blank' });
      continue;
    }
    try {
      store.addExtra({ name: extra, value });
    } catch (err) {
      if (!(err instanceof KeysError)) throw err;
      report.skipped.push({ what: variable, reason: err.code });
      continue;
    }
    names.set(variable, extra);
    report.extra.push({ name: extra, from: variable });
  }
  return names;
}

/** Binds the base roles `llm.keyByRole` maps to a key; an errand or development role waits for the subharness. */
function importBindings(
  { env, store, byRole, report }: Context,
  coreUsed: ReadonlySet<string>,
  names: ReadonlyMap<string, string>
): void {
  for (const [role, variables] of byRole) {
    if (role === 'core') continue;
    const group = roleGroup(role);
    const variable = variables.find((one) => valueOf(env, one) !== null);
    if (group === undefined) report.skipped.push({ what: role, reason: 'unknown-role' });
    else if (group !== 'base') report.skipped.push({ what: role, reason: 'subharness' });
    else if (variable === undefined) report.skipped.push({ what: role, reason: 'unset' });
    else if (!names.has(variable))
      report.skipped.push({ what: role, reason: coreUsed.has(variable) ? 'core-key' : 'not-a-key-variable' });
    else {
      const name = names.get(variable) ?? '';
      store.bind(role, name);
      report.bound.push({ role, name });
    }
  }
}

type Context = {
  env: Record<string, string>;
  config: unknown;
  store: KeyStore;
  byRole: Map<string, Array<string>>;
  report: ImportReport;
};

export function importKeys({
  env,
  config,
  store,
}: {
  env: Record<string, string>;
  config: unknown;
  store: KeyStore;
}): ImportReport {
  const listing = store.list();
  if (listing.core.length + listing.extra.length > 0) throw new KeysError('store-not-empty');
  const context: Context = {
    env,
    config,
    store,
    byRole: keyByRoleOf(config),
    report: { core: [], extra: [], bound: [], skipped: [] },
  };
  const coreUsed = importCore(context);
  importBindings(context, coreUsed, importExtra(context, coreUsed));
  return context.report;
}
