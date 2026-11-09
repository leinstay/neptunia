// The owner's key commands of the chat: `keys core|extra add|remove|list`, `keys core grant`, `keys bind|unbind|check`
// and `model set`. A binding is a choice of connection: it is written to `llm.boundKeys` of config.json through the key
// store, after one request of the role's model on the bound key.
// The console (src/interface/commands/console.ts) routes them here. A key value is never an argument: every add asks
// for it through the dialog the link gives (a secret prompt, src/interface/commands/dialogs.ts), so the value reaches
// neither the typed line, the chat's history file nor a refusal. A key is checked before it is saved (the first core
// key with the four mandatory model roles, a later one with `/auth/key`), and a failed check saves nothing. An answer
// names keys by name and last four characters and never holds a value; a refusal names the store's code, never the word
// that was refused.

import { matchRoute } from '../llm/openrouter.ts';
import {
  CORE_ROLE,
  EFFORT_LEVELS,
  MEMORY_ROLE,
  REASONING_ROLES,
  SEARCH_ROLE,
  directSelectionOf,
  isEffortLevel,
  roleGroup,
} from '../llm/roles.ts';
import { log } from '../log.ts';
import { checkKey, checkRole } from './check.ts';
import { listRoleModels } from './models.ts';
import type { CheckResult } from './check.ts';
import type { KeyRing } from './ring.ts';
import { isKeyName, KeysError } from './store.ts';
import type { KeyStore } from './store.ts';

/** The model roles a core key must serve before the first add finishes, in the order they are asked. */
export const MANDATORY_ROLES: ReadonlyArray<string> = ['core', 'memory', 'analyzer', 'embedding'];

/** The pause reason that `keys core remove` of the last key sets and the next `keys core add` lifts. */
const NO_CORE_KEY = 'no-core-key';

/** The model roles whose model OpenCode runs: they are not OpenRouter ids, so no request checks them. */
const UNCHECKED_ROLES: ReadonlyArray<string> = ['scout', 'server', 'thinker', 'dev'];

/** What the chat can ask in the middle of a command. */
export type Dialog = {
  ask(
    question: string,
    options?: { secret?: boolean; fallback?: string; choices?: ReadonlyArray<string> }
  ): Promise<string>;
};

/**
 * The core's pause with a reason. `reason()` is null while she runs, `owner` for a pause the owner gave. `resume` with
 * a reason lifts the pause only while it is that reason.
 */
export type PauseControl = {
  pause(reason: string): Promise<void>;
  resume(reason?: string): Promise<void>;
  reason(): string | null;
};

/** What `reasonedPause` runs on: the owner's `bot.pause` and `bot.resume` and the state file they write. */
export type ReasonedPauseDeps = {
  run(op: 'bot.pause' | 'bot.resume', args: Record<string, unknown>): Promise<unknown>;
  store: { state: { data: Record<string, unknown>; markDirty(): void }; flush(): void };
};

/**
 * The core's pause over the owner's operations: `pause(reason)` pauses her and stores the reason, and does nothing
 * while she is paused already, so no reason replaces another or the owner's. `resume(reason)` asks `bot.resume` to lift
 * only a pause of that reason. A pause the owner gives over one of these becomes his (src/tools/operations/pause.ts).
 */
export function reasonedPause(deps: ReasonedPauseDeps): PauseControl {
  const state = () => deps.store.state;
  const reason = (): string | null => {
    const { data } = state();
    if (data.paused !== true) return null;
    return typeof data.pausedReason === 'string' ? data.pausedReason : 'owner';
  };
  return {
    async pause(why) {
      if (state().data.paused === true) return;
      await deps.run('bot.pause', {});
      state().data.pausedReason = why;
      state().markDirty();
      deps.store.flush();
    },
    async resume(why) {
      await deps.run('bot.resume', why === undefined ? {} : { reason: why });
      const now = reason();
      if (now !== null && (why === undefined || now === why))
        throw new Error('she is still paused: run /resume and read its answer');
    },
    reason,
  };
}

/**
 * One command's answer: the status is `ok`, `invalid` (the line or a name is refused), `failed` (a check or a save did
 * not go through), `unsupported` (no check exists for the role, and nothing was sent) or `not_configured` (the role is
 * off), and the code of a refusal that has one.
 */
export type Answer = { text: string; status: string; code?: string };

/** A provider slug of OpenRouter, as `/routes set` takes it (src/tools/operations/route.ts). */
const PROVIDER_SLUG = /^[a-z0-9-]+$/;

export type KeysDeps = {
  store: KeyStore;
  ring: KeyRing;
  fetch: typeof fetch;
  baseUrl(): string;
  /** The tracked model of each mandatory role, offered by the first add. */
  defaults: Readonly<Record<string, string>>;
  /** The live model of a role; '' while the role is off. */
  currentModel(role: string): string;
  /** The live `speech.voice`, which `checkRole` probes the speech role with. */
  speechVoice?(): string;
  /** Saves a role's model (the console runs the `model.set` operation). */
  saveModel(role: string, model: string): Promise<void>;
  pause: PauseControl;
  /** The live `llm.providerByModel`. */
  routes?(): Readonly<Record<string, unknown>>;
  /** Writes one `llm.providerByModel` entry in the local config. */
  saveRoute?(key: string, value: Record<string, unknown>): Promise<void>;
  /** Writes one setting by its dotted path in the local config. */
  saveSetting?(path: string, value: unknown): Promise<void>;
  /** Told what a check of `role` came to, so a launch's readiness (src/setup/readiness.ts) needs no request of its own. */
  recordCheck?(role: string, check: { selection: string; ok: boolean; code: string | null }): void;
  /** Returns `role` to its direct path: called after a direct model of `memory` or `core` is checked and saved. */
  directPath?(role: string): void;
  /** The backend `role` runs through (core, memory), null on the API: such a role needs no key. */
  harnessOf?: (role: string) => string | null;
  /** The path her memory writer runs on now (keys.json, src/subharness/memory-path.ts), read at every check. */
  memoryPath?: () => MemoryCheckPath | null;
  /** One probe through the subharness path of the memory writer (src/subharness/memory-probe.ts#memoryProbe). */
  probeMemory?: () => Promise<MemoryCheckProbe>;
};

/** The answer for a role that a harness serves and that has no key, null when it runs on the API. */
function servedByHarness(deps: KeysDeps, name: string, role: string): Answer | null {
  const harness = deps.harnessOf?.(role) ?? null;
  if (harness === null) return null;
  if (name === 'keys.core.remove')
    return {
      text: `The last core key is removed. Her core runs through ${harness} and needs no key, so she keeps running.`,
      status: 'ok',
    };
  return { text: `${typed(name)}: the ${role} role runs through ${harness} and needs no key`, status: 'ok' };
}

/** The last core key is gone: she keeps running when a harness carries her core, else she is paused as `no-core-key`. */
async function lastCoreRemoved(deps: KeysDeps, name: string): Promise<Answer> {
  const kept = servedByHarness(deps, name, CORE_ROLE);
  if (kept !== null) return kept;
  const { pause: pauseControl } = deps;
  await pauseControl.pause(NO_CORE_KEY);
  return {
    text: 'The last core key is removed. She is paused (no-core-key) until you add a core key.',
    status: 'ok',
  };
}

/** The path `keys check memory` is asked about: the direct request, or one backend and model. */
export type MemoryCheckPath = { kind: 'direct' } | { kind: 'subharness'; backend: string; model: string };

/** What the probe of a subharness path answers: a pass, or a failure with its code. */
export type MemoryCheckProbe = { ok: true; at: number } | { ok: false; code: string; at: number };

const money = (value: number): string => `$${value.toFixed(4)}`;

/** The answer for a role no request can prove for cents; the key is neither proved nor refused. */
const unsupportedLine = (role: string): string => `No cheap request can check the ${role} role, so nothing was sent.`;

/** What `checkRole` needs beside the model for `role`: the speech probe takes the live voice. */
const voiceOf = (deps: KeysDeps, role: string): { voice?: string } =>
  role === 'speech' ? { voice: deps.speechVoice?.() ?? '' } : {};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** What a check came to, as readiness keeps it: the provider's status, never its words. */
const checkRecord = (result: CheckResult): { selection: string; ok: boolean; code: string | null } => ({
  selection: directSelectionOf(result.model),
  ok: result.ok,
  code: result.ok ? null : result.status === null ? 'no-answer' : `http-${result.status}`,
});

/** The command as the owner typed it, without its arguments: a name or a word of the line may be a pasted key. */
const typed = (name: string): string => `/${name.replaceAll('.', ' ')}`;

const invalid = (name: string, why: string, code?: string): Answer => ({
  text: `${typed(name)}: ${why}`,
  status: 'invalid',
  ...(code === undefined ? {} : { code }),
});
const failed = (name: string, why: string): Answer => ({ text: `${typed(name)}: ${why}`, status: 'failed' });

/** A value read from the dialog: a paste often carries a trailing newline or space. */
const pasted = (answer: string): string => answer.trim();

/** Why a pasted value is no key, or null when it can be one. */
const valueProblem = (value: string): string | null =>
  value === '' || /\s/.test(value) ? 'the value is blank or holds a space' : null;

/** How the chat names a check's outcome: the model, the key, whether the provider billed the key as BYOK, the cost. */
function checkLine(result: CheckResult): string {
  const byok = result.isByok === null ? 'is_byok not reported' : `is_byok ${String(result.isByok)}`;
  const head = `${result.role} on ${result.model} with key ${result.keyName}`;
  return result.ok
    ? `${head}: answered, ${byok}, ${money(result.cost)}`
    : `${head}: failed${result.status === null ? '' : ` (HTTP ${result.status})`}: ${result.error ?? 'no reason given'}`;
}

/** `keys check memory` while the writer runs through a backend: the probe, with no request on the memory key. */
async function checkMemoryBackend(
  name: string,
  path: Extract<MemoryCheckPath, { kind: 'subharness' }>,
  probe: NonNullable<KeysDeps['probeMemory']>
): Promise<Answer> {
  const head = `memory via ${path.backend} ${path.model}`;
  const result = await probe();
  return result.ok ? { text: `${head}: answered`, status: 'ok' } : failed(name, `${head}: failed: ${result.code}`);
}

/** The `--provider` and `--effort` of one model set, by name. */
type ModelFlags = { role: string; provider: string; effort: string };

/** Why the `--provider` and `--effort` of a model set are refused before anything is sent, or null. */
function flagsProblem(deps: KeysDeps, name: string, flags: ModelFlags): Answer | null {
  const { role, provider, effort } = flags;
  if (provider !== '' && !PROVIDER_SLUG.test(provider))
    return invalid(name, 'a provider is one slug of lowercase letters, digits and dashes', 'bad-provider');
  if (effort !== '' && !isEffortLevel(effort))
    return invalid(name, `the effort is one of ${EFFORT_LEVELS.join(', ')}`, 'unknown-effort');
  // The core is not among them: its thinking is her own `<think>`, never provider reasoning (owner, 2026-10-19).
  if (effort !== '' && !REASONING_ROLES.includes(role))
    return invalid(name, `the ${role} role takes no effort; ${REASONING_ROLES.join(', ')} do`, 'effort-unsupported');
  if (provider !== '' && deps.saveRoute === undefined) return failed(name, 'provider routes cannot be written here');
  if (effort !== '' && deps.saveSetting === undefined) return failed(name, 'the effort cannot be written here');
  return null;
}

/** The model to set: the typed one, else the answer to a question offering the role's models from `/models`. */
async function modelToSet(
  deps: KeysDeps,
  input: { args: Record<string, unknown>; role: string; value: string; dialog: Dialog | null }
): Promise<string> {
  const typedModel = text(input.args.model);
  if (typedModel !== '' || input.dialog === null) return typedModel;
  const choices = await listRoleModels({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value: input.value }, input.role);
  const question = `Model for the ${input.role} role (one of the list, or any other OpenRouter id):`;
  return pasted(await input.dialog.ask(question, choices.length === 0 ? {} : { choices }));
}

/** Writes the route and the effort of a model that answered its check; the lines that say what was written. */
async function saveFlags(deps: KeysDeps, flags: ModelFlags & { model: string }): Promise<Array<string>> {
  const { role, model, provider, effort } = flags;
  const lines: Array<string> = [];
  if (provider !== '' && deps.saveRoute !== undefined) {
    // A provider change keeps the BYOK mark of the route that applies now, so the role never moves to credit unseen.
    const isByok = matchRoute(model, deps.routes?.() ?? {}, role)?.value.byok === true;
    const route = { only: [provider], allow_fallbacks: false, ...(isByok ? { byok: true } : {}) };
    await deps.saveRoute(`${model}@${role}`, route);
    lines.push(`It goes out through ${provider} alone${isByok ? ', billed as BYOK' : ''}.`);
  }
  if (isEffortLevel(effort) && deps.saveSetting !== undefined) {
    await deps.saveSetting(`llm.reasoningByRole.${role}`, { effort });
    lines.push(`Its requests ask for ${effort} reasoning effort.`);
  }
  return lines;
}

/**
 * `keys bind <role> <name>`: the choice of the key a role goes out on, written to config.json after one request of
 * the role's model on that key. A refusal binds nothing. A role that is off binds with nothing sent, and a role no
 * cheap request can check binds unverified.
 */
async function bindRole(deps: KeysDeps, name: string, args: Record<string, unknown>): Promise<Answer> {
  const { store } = deps;
  const role = text(args.role);
  const key = text(args.name);
  if (roleGroup(role) !== 'base' && role !== SEARCH_ROLE) throw new KeysError('unknown-role');
  if (!store.list().extra.some((row) => row.name === key)) throw new KeysError('unknown-key');
  const bound = `The ${role} role goes out on key ${key} alone.`;
  const model = deps.currentModel(role);
  if (model === '' || voiceOf(deps, role).voice === '') {
    store.bind(role, key);
    return { text: `${bound} The role is off, so nothing was checked.`, status: 'ok' };
  }
  const result = await checkRole({
    fetch: deps.fetch,
    baseUrl: deps.baseUrl(),
    role,
    model,
    keyName: key,
    value: store.valueOf(key) ?? '',
    ...voiceOf(deps, role),
  });
  if (result.capability === 'unsupported') {
    store.bind(role, key);
    return { text: `${bound} ${unsupportedLine(role)} The binding is saved unverified.`, status: 'ok' };
  }
  if (!result.ok) return failed(name, `${checkLine(result)}\nThe role is not bound.`);
  store.bind(role, key);
  deps.recordCheck?.(role, checkRecord(result));
  return { text: [checkLine(result), bound].join('\n'), status: 'ok' };
}

export function createKeysCommands(deps: KeysDeps): {
  run(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer>;
} {
  const { store, ring, pause: pauseControl } = deps;

  /** Lifts the pause the last removal set, and only that one. */
  async function resumeIfNoKey(): Promise<boolean> {
    if (pauseControl.reason() !== NO_CORE_KEY) return false;
    await pauseControl.resume(NO_CORE_KEY);
    return true;
  }

  /** Name and dialog are fine before anything is asked: a bad or used name never reaches the value prompt. */
  function beforeAsking(name: string, key: string, dialog: Dialog | null): Answer | null {
    if (!isKeyName(key)) return invalid(name, new KeysError('bad-name').message);
    if (dialog === null) return invalid(name, 'the key value is asked in the chat: run this command there');
    const listing = store.list();
    if ([...listing.core, ...listing.extra].some((row) => row.name === key))
      return invalid(name, new KeysError('duplicate-name').message);
    return null;
  }

  /** The grant and reset day asked after the value: both optional, `none` or a blank answer for no grant. */
  async function askGrant(dialog: Dialog, key: string): Promise<{ grant?: number; resetDay?: number } | string> {
    const none = (answer: string): boolean => answer === '' || answer.toLowerCase() === 'none';
    const given = pasted(await dialog.ask(`Grant of ${key} in USD (blank or none for no grant):`, { fallback: '' }));
    if (none(given)) return {};
    const grant = Number(given);
    if (!Number.isFinite(grant) || grant < 0) return 'the grant is a number of dollars from 0 up, or none';
    const day = pasted(
      await dialog.ask(`Day of the month (1 to 31) the grant of ${key} is given again:`, { fallback: '' })
    );
    const resetDay = Number(day);
    if (day === '' || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31)
      return 'the reset day is a whole day of the month from 1 to 31';
    return { grant, resetDay };
  }

  async function askValue(dialog: Dialog, key: string): Promise<string> {
    return pasted(await dialog.ask(`Paste the key ${key}. Nothing is shown while you type.`, { secret: true }));
  }

  /** The first core key: the value, the four models, one request per model on the new key, and only then the save. */
  async function firstCoreKey(name: string, key: string, value: string, dialog: Dialog): Promise<Answer> {
    const models = new Map<string, string>();
    for (const role of MANDATORY_ROLES) {
      const fallback = deps.defaults[role] ?? '';
      const offered = fallback === '' ? '' : ` (blank takes ${fallback})`;
      const given = pasted(await dialog.ask(`Model for the ${role} role${offered}:`, { fallback }));
      const model = given === '' ? fallback : given;
      if (model === '' || /\s/.test(model)) return invalid(name, `no usable model for the ${role} role`);
      models.set(role, model);
    }
    const granted = await askGrant(dialog, key);
    if (typeof granted === 'string') return invalid(name, granted);
    const results = await Promise.all(
      [...models].map(([role, model]) =>
        checkRole({ fetch: deps.fetch, baseUrl: deps.baseUrl(), role, model, keyName: key, value })
      )
    );
    const bad = results.filter((result) => !result.ok);
    if (bad.length > 0)
      return failed(name, ['nothing is saved, no key and no model.', ...bad.map(checkLine)].join('\n'));
    store.addCore({ name: key, value, ...granted });
    for (const [role, model] of models) await deps.saveModel(role, model);
    for (const result of results) deps.recordCheck?.(result.role, checkRecord(result));
    const resumed = await resumeIfNoKey();
    const cost = results.reduce((sum, result) => sum + result.cost, 0);
    return {
      text: [
        `${key} is the first core key. The models are saved:`,
        ...results.map(checkLine),
        `The four checks cost ${money(cost)}.${resumed ? ' She is running again.' : ''}`,
      ].join('\n'),
      status: 'ok',
    };
  }

  async function addCore(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const key = text(args.name);
    const refused = beforeAsking(name, key, dialog);
    if (refused !== null || dialog === null) return refused ?? invalid(name, 'no dialog');
    const value = await askValue(dialog, key);
    const problem = valueProblem(value);
    if (problem !== null) return invalid(name, problem);
    if (store.coreNames().length === 0) return firstCoreKey(name, key, value, dialog);
    const granted = await askGrant(dialog, key);
    if (typeof granted === 'string') return invalid(name, granted);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.addCore({ name: key, value, ...granted });
    const resumed = await resumeIfNoKey();
    return { text: `${key} is added to the core keys.${resumed ? ' She is running again.' : ''}`, status: 'ok' };
  }

  async function removeCore(name: string, args: Record<string, unknown>): Promise<Answer> {
    const { left } = store.removeCore(text(args.name));
    if (left > 0) return { text: `The core key is removed. ${left} left.`, status: 'ok' };
    return lastCoreRemoved(deps, name);
  }

  /** `keys core grant <name> <usd> <day>` sets the grant of a stored core key, `<name> none` clears it; no value is asked. */
  function grantCore(name: string, args: Record<string, unknown>): Answer {
    const key = text(args.name);
    const usd = text(args.usd).trim();
    if (usd.toLowerCase() === 'none') {
      store.setGrant(key, null);
      return { text: `${key} has no grant.`, status: 'ok' };
    }
    const grant = usd === '' ? Number.NaN : Number(usd);
    if (!Number.isFinite(grant) || grant < 0)
      return invalid(name, 'the grant is a number of dollars from 0 up, or none');
    const day = text(args.day).trim();
    const resetDay = /^\d{1,2}$/.test(day) ? Number(day) : Number.NaN;
    if (!(resetDay >= 1 && resetDay <= 31))
      return invalid(name, 'give the day of the month (1 to 31) the grant resets');
    store.setGrant(key, { grant, resetDay });
    return { text: `${key} has a grant of $${grant}, given again on day ${resetDay}.`, status: 'ok' };
  }

  function listCore(): Answer {
    const rows = store.list().core;
    if (rows.length === 0) return { text: 'No core key. Add one with /keys core add <name>.', status: 'ok' };
    const on = ring.route('core')?.name ?? null;
    const lines = rows.map((row) => {
      const grant = row.grant === null ? 'no grant' : `grant $${row.grant}, resets on day ${String(row.resetDay)}`;
      return `${row.name}  ...${row.last4}  ${grant}${row.name === on ? '  (in use)' : ''}`;
    });
    return { text: lines.join('\n'), status: 'ok' };
  }

  async function addExtra(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const key = text(args.name);
    const refused = beforeAsking(name, key, dialog);
    if (refused !== null || dialog === null) return refused ?? invalid(name, 'no dialog');
    const value = await askValue(dialog, key);
    const problem = valueProblem(value);
    if (problem !== null) return invalid(name, problem);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.addExtra({ name: key, value });
    return {
      text: `${key} is added to the extra keys. Bind a role to it with /keys bind <role> ${key}.`,
      status: 'ok',
    };
  }

  function listExtra(): Answer {
    const rows = store.list().extra;
    if (rows.length === 0) return { text: 'No extra key.', status: 'ok' };
    const lines = rows.map(
      (row) =>
        `${row.name}  ...${row.last4}  ${row.roles.length === 0 ? 'bound to no role' : `bound to ${row.roles.join(', ')}`}`
    );
    return { text: lines.join('\n'), status: 'ok' };
  }

  async function checkOne(name: string, role: string): Promise<Answer> {
    const path = role === 'memory' ? (deps.memoryPath?.() ?? null) : null;
    if (path?.kind === 'subharness' && deps.probeMemory !== undefined)
      return checkMemoryBackend(name, path, deps.probeMemory);
    const model = deps.currentModel(role);
    if (model === '' || voiceOf(deps, role).voice === '')
      return {
        text: `${typed(name)}: the ${role} role is off, so there is nothing to check`,
        status: 'not_configured',
      };
    const route = ring.route(role);
    if (route === null)
      return (
        servedByHarness(deps, name, role) ??
        failed(name, `the ${role} role has no key: add a core key or bind the role to an extra key`)
      );
    const result = await checkRole({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl(),
      role,
      model,
      keyName: route.name,
      value: route.value,
      ...voiceOf(deps, role),
    });
    if (result.capability === 'unsupported') return { text: unsupportedLine(role), status: 'unsupported' };
    deps.recordCheck?.(role, checkRecord(result));
    const line = path?.kind === 'direct' ? `${checkLine(result)} (direct path)` : checkLine(result);
    return { text: line, status: result.ok ? 'ok' : 'failed' };
  }

  async function setModel(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const role = text(args.role);
    const provider = text(args.provider);
    const effort = text(args.effort);
    const group = roleGroup(role);
    if (group === undefined) return invalid(name, 'a role and a model are needed');
    const problem = flagsProblem(deps, name, { role, provider, effort });
    if (problem !== null) return problem;
    if (group !== 'base' || UNCHECKED_ROLES.includes(role)) {
      const model = text(args.model);
      if (model === '') return invalid(name, 'a role and a model are needed');
      if (provider !== '') return invalid(name, `the ${role} role takes no provider route`);
      await deps.saveModel(role, model);
      return { text: `The ${role} model is ${model}. Its id is not checked here.`, status: 'ok' };
    }
    const route = ring.route(role);
    if (route === null)
      return failed(name, `the ${role} role has no key: add a core key or bind the role to an extra key`);
    const model = await modelToSet(deps, { args, role, value: route.value, dialog });
    if (model === '' || /\s/.test(model)) return invalid(name, 'a role and a model are needed');
    const routing = provider === '' ? undefined : { only: [provider], allow_fallbacks: false };
    const result = await checkRole({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl(),
      role,
      model,
      keyName: route.name,
      value: route.value,
      ...(routing === undefined ? {} : { provider: routing }),
      ...(isEffortLevel(effort) ? { reasoning: { effort } } : {}),
      ...voiceOf(deps, role),
    });
    if (result.capability === 'unsupported') {
      await deps.saveModel(role, model);
      const saved = await saveFlags(deps, { role, model, provider, effort });
      return {
        text: [`${unsupportedLine(role)} The ${role} model is saved unverified.`, ...saved].join('\n'),
        status: 'ok',
      };
    }
    if (!result.ok) return failed(name, `${checkLine(result)}\nThe model is not saved.`);
    await deps.saveModel(role, model);
    // A refused model saves nothing, so the check of the selection in force stands; only this success replaces it.
    deps.recordCheck?.(role, checkRecord(result));
    if (role === MEMORY_ROLE || role === CORE_ROLE) deps.directPath?.(role);
    const saved = await saveFlags(deps, { role, model, provider, effort });
    return { text: [checkLine(result), `The ${role} model is saved.`, ...saved].join('\n'), status: 'ok' };
  }

  async function dispatch(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    switch (name) {
      case 'keys.core.add':
        return addCore(name, args, dialog);
      case 'keys.core.remove':
        return removeCore(name, args);
      case 'keys.core.list':
        return listCore();
      case 'keys.core.grant':
        return grantCore(name, args);
      case 'keys.extra.add':
        return addExtra(name, args, dialog);
      case 'keys.extra.remove':
        store.removeExtra(text(args.name));
        return { text: 'The extra key is removed.', status: 'ok' };
      case 'keys.extra.list':
        return listExtra();
      case 'keys.bind':
        return bindRole(deps, name, args);
      case 'keys.unbind':
        store.unbind(text(args.role));
        return { text: `The ${text(args.role)} role is back on the core keys.`, status: 'ok' };
      case 'keys.check': {
        const role = text(args.role);
        if (roleGroup(role) !== 'base' && role !== SEARCH_ROLE)
          return invalid(name, new KeysError('unknown-role').message);
        return checkOne(name, role);
      }
      case 'model.set':
        return setModel(name, args, dialog);
      default:
        return invalid(name, 'no such command; type /help');
    }
  }

  return {
    async run(name, args, dialog) {
      try {
        return await dispatch(name, args, dialog);
      } catch (err) {
        if (err instanceof KeysError) return invalid(name, err.message);
        log.warn('keys: command failed', { command: name, error: err });
        return failed(name, err instanceof Error ? err.message : 'it did not go through');
      }
    },
  };
}
