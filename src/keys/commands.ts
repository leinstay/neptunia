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
import { isRefusal, isRouteRole, parseRouteText, routeText, ROUTE_ROLES } from '../llm/route-text.ts';
import type { HarnessRoute, Route, RouteRole } from '../llm/route-text.ts';
import type { KeyStore } from './store.ts';

/** The model roles a core key must serve before the first add finishes, in the order they are asked. */
export const MANDATORY_ROLES: ReadonlyArray<string> = ['core', 'memory', 'analyzer', 'embedding'];

/** The pause reason of a core left with no usable route by `keys remove`; the `keys add` that gives it one lifts it. */
const NO_CORE_ROUTE = 'no-core-route';

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
  /** The chain of `role` now (src/llm/route-chain.ts); with `saveRoutes` the `/model` commands work on chains. */
  chainOf?: (role: RouteRole) => Array<Route>;
  /** Writes the chain of `role` to `models.routes.<role>` of config.json. */
  saveRoutes?: (role: RouteRole, routes: Array<Route>) => Promise<void>;
  /** One reply through the harness of `route`, as `/model set --via` checks a source (src/subharness/selection.ts). */
  checkHarness?: (route: HarnessRoute) => Promise<{ ok: boolean; code: string }>;
};

/** The answer for a role that a harness serves and that has no key, null when it runs on the API. */
function servedByHarness(deps: KeysDeps, name: string, role: string): Answer | null {
  const harness = deps.harnessOf?.(role) ?? null;
  if (harness === null) return null;
  return { text: `${typed(name)}: the ${role} role runs through ${harness} and needs no key`, status: 'ok' };
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

/** The roles that run with no route at all: a chain of theirs never loses its last route. */
const ROUTE_REQUIRED: ReadonlyArray<string> = MANDATORY_ROLES;

/** Why a route of `/model set` or `/model add` is refused before anything is sent, or the route. */
function routeOfLine(deps: KeysDeps, name: string, role: RouteRole, line: string): Route | Answer {
  const route = parseRouteText(role, line);
  if (isRefusal(route)) return invalid(name, route.reason, route.code);
  if (route.via === 'api' && deps.store.valueOf(route.key) === null)
    return invalid(
      name,
      `keys.json holds no key named ${route.key}; add it with /keys add ${route.key}`,
      'key-unknown'
    );
  return route;
}

/** One check of `route` for `role`: null when it answered or no cheap request proves it, else the refusal. */
async function checkRoute(deps: KeysDeps, name: string, role: RouteRole, route: Route): Promise<Answer | null> {
  if (route.via === 'harness') {
    const result = (await deps.checkHarness?.(route)) ?? { ok: false, code: 'harness-unchecked' };
    return result.ok ? null : failed(name, `${routeText(route)} did not answer (${result.code}); nothing was changed`);
  }
  const voice = voiceOf(deps, role);
  if (role === 'speech' && (deps.speechVoice?.() ?? '') === '') return null;
  const result = await checkRole({
    fetch: deps.fetch,
    baseUrl: deps.baseUrl(),
    role,
    model: route.model,
    keyName: route.key,
    value: deps.store.valueOf(route.key) ?? '',
    ...(route.effort === null ? {} : { reasoning: { effort: route.effort } }),
    ...voice,
  });
  if (result.capability === 'unsupported') return null;
  if (!result.ok) return failed(name, `${checkLine(result)}\nNothing was changed.`);
  deps.recordCheck?.(role, checkRecord(result));
  return null;
}

/** `/model set <role> <route>` and `/model add <role> <route>`: the route checked, then the chain written. */
async function writeRoute(deps: KeysDeps, name: string, role: RouteRole, line: string): Promise<Answer> {
  const { chainOf, saveRoutes } = deps;
  if (chainOf === undefined || saveRoutes === undefined) return failed(name, 'the chains cannot be written here');
  const route = routeOfLine(deps, name, role, line);
  if (!('via' in route)) return route;
  const chain = chainOf(role);
  const adding = name === 'model.add';
  if (adding && chain.some((one) => routeText(one) === routeText(route)))
    return invalid(name, `${routeText(route)} is in the chain already`, 'route-duplicate');
  if (adding && role === 'embedding' && chain.some((one) => one.model !== route.model))
    return invalid(
      name,
      'every route of embedding names one model, since vectors of two models do not compare',
      'route-model-mismatch'
    );
  const refused = await checkRoute(deps, name, role, route);
  if (refused !== null) return refused;
  const next = adding ? [...chain, route] : [route];
  await saveRoutes(role, next);
  return { text: `${role}: ${chainText(next)}`, status: 'ok' };
}

/** `/model remove <role> <n>`: the n-th route of the chain, counted from 1. */
async function removeRoute(deps: KeysDeps, name: string, role: RouteRole, index: string): Promise<Answer> {
  const { chainOf, saveRoutes } = deps;
  if (chainOf === undefined || saveRoutes === undefined) return failed(name, 'the chains cannot be written here');
  const chain = chainOf(role);
  const at = /^\d+$/.test(index) ? Number(index) - 1 : -1;
  if (at < 0 || at >= chain.length)
    return invalid(name, `the ${role} chain has ${chain.length} route(s); give a number from 1`, 'route-unknown');
  if (chain.length === 1 && ROUTE_REQUIRED.includes(role))
    return invalid(name, `${role} cannot run with no route; set another with /model set first`, 'route-required');
  const next = chain.filter((_, i) => i !== at);
  await saveRoutes(role, next);
  return { text: `${role}: ${chainText(next)}`, status: 'ok' };
}

/** A chain in the text form `/model set` takes, its routes in order; `off` for none. */
const chainText = (chain: ReadonlyArray<Route>): string =>
  chain.length === 0 ? 'off' : chain.map(routeText).join(', then ');

/** `/model show`: every chain in the text form. */
function showChains(deps: KeysDeps): Answer {
  const { chainOf } = deps;
  if (chainOf === undefined) return failed('model.show', 'the chains cannot be read here');
  return { text: ROUTE_ROLES.map((role) => `${role}: ${chainText(chainOf(role))}`).join('\n'), status: 'ok' };
}

/** The answer of a chain command, or null for one the chains do not take (an agent's `/model set`, an unknown role). */
function chainCommand(deps: KeysDeps, name: string, args: Record<string, unknown>): Promise<Answer> | null {
  if (name === 'model.show') return Promise.resolve(showChains(deps));
  const role = text(args.role);
  if (!isRouteRole(role) || (name === 'model.set' && deps.saveRoutes === undefined)) return null;
  if (name === 'model.remove') return removeRoute(deps, name, role, text(args.index));
  return writeRoute(deps, name, role, text(args.model));
}

export function createKeysCommands(deps: KeysDeps): {
  run(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer>;
} {
  const { store, ring, pause: pauseControl } = deps;

  /** Whether her core has a route it can take: a harness, or a key keys.json holds. */
  const coreHasRoute = (): boolean =>
    (deps.chainOf?.('core') ?? []).some((route) => route.via === 'harness' || store.valueOf(route.key) !== null) ||
    (deps.chainOf === undefined && store.coreNames().length > 0);

  /** Lifts the pause a removal set once her core has a route again, and only that pause. */
  async function resumeIfNoRoute(): Promise<boolean> {
    if (pauseControl.reason() !== NO_CORE_ROUTE || !coreHasRoute()) return false;
    await pauseControl.resume(NO_CORE_ROUTE);
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
    const results = await Promise.all(
      [...models].map(([role, model]) =>
        checkRole({ fetch: deps.fetch, baseUrl: deps.baseUrl(), role, model, keyName: key, value })
      )
    );
    const bad = results.filter((result) => !result.ok);
    if (bad.length > 0)
      return failed(name, ['nothing is saved, no key and no model.', ...bad.map(checkLine)].join('\n'));
    store.addCore({ name: key, value });
    for (const [role, model] of models) await deps.saveModel(role, model);
    for (const result of results) deps.recordCheck?.(result.role, checkRecord(result));
    const resumed = await resumeIfNoRoute();
    const cost = results.reduce((sum, result) => sum + result.cost, 0);
    return {
      text: [
        `${key} is the first key. The models are saved:`,
        ...results.map(checkLine),
        `The four checks cost ${money(cost)}.${resumed ? ' She is running again.' : ''}`,
      ].join('\n'),
      status: 'ok',
    };
  }

  /** `keys add <name>`: the first key of an empty keys.json asks the four models too; any other is checked and named. */
  async function addKey(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer> {
    const key = text(args.name);
    const refused = beforeAsking(name, key, dialog);
    if (refused !== null || dialog === null) return refused ?? invalid(name, 'no dialog');
    const value = await askValue(dialog, key);
    const problem = valueProblem(value);
    if (problem !== null) return invalid(name, problem);
    const listing = store.list();
    if (listing.core.length + listing.extra.length === 0) return firstCoreKey(name, key, value, dialog);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.addExtra({ name: key, value });
    const resumed = await resumeIfNoRoute();
    const hint = `Put a role on it with /model set <role> ${key}/<model>.`;
    return { text: `${key} is added. ${hint}${resumed ? ' She is running again.' : ''}`, status: 'ok' };
  }

  /** The roles whose chain names `key`, in display order. */
  const rolesOn = (key: string): Array<RouteRole> =>
    ROUTE_ROLES.filter((role) =>
      (deps.chainOf?.(role) ?? []).some((route) => route.via === 'api' && route.key === key)
    );

  /**
   * `keys remove <name>`: the key leaves keys.json. A chain that named it keeps the route, which is skipped until a key of
   * that name comes back, so its chain is written to config.json first; a core left with no usable route pauses her.
   */
  async function removeKey(name: string, args: Record<string, unknown>): Promise<Answer> {
    const key = text(args.name);
    const listing = store.list();
    const inCore = listing.core.some((row) => row.name === key);
    const extra = listing.extra.find((row) => row.name === key);
    if (!inCore && extra === undefined) throw new KeysError('unknown-key');
    const roles = rolesOn(key);
    if (extra !== undefined) {
      for (const role of roles) await deps.saveRoutes?.(role, deps.chainOf?.(role) ?? []);
      for (const role of extra.roles) store.unbind(role);
      store.removeExtra(key);
    } else store.removeCore(key);
    const left = roles.length === 0 ? '' : ` Routes of ${roles.join(', ')} named it and are skipped now.`;
    const harness = deps.harnessOf?.(CORE_ROLE) ?? null;
    const kept =
      inCore && harness !== null ? ` Her core runs through ${harness} and needs no key, so she keeps running.` : '';
    if (coreHasRoute()) return { text: `${key} is removed.${left}${kept}`, status: 'ok' };
    await pauseControl.pause(NO_CORE_ROUTE);
    return {
      text: `${key} is removed.${left} Her core has no route left, so she is paused (${NO_CORE_ROUTE}).`,
      status: 'ok',
    };
  }

  /** `keys list`: every key by name and last four characters, with the roles whose chain names it. */
  function listKeys(): Answer {
    const listing = store.list();
    const rows = [...listing.core, ...listing.extra];
    if (rows.length === 0) return { text: 'No key. Add one with /keys add <name>.', status: 'ok' };
    const lines = rows.map((row) => {
      const roles = rolesOn(row.name);
      return `${row.name}  ...${row.last4}  ${roles.length === 0 ? 'used by no route' : `used by ${roles.join(', ')}`}`;
    });
    return { text: lines.join('\n'), status: 'ok' };
  }

  /** `keys check <name|role>`: a role's route in force with one request, or a key with the free read of its record. */
  async function checkTarget(name: string, target: string): Promise<Answer> {
    if (roleGroup(target) === 'base' || target === SEARCH_ROLE) return checkOne(name, target);
    const value = store.valueOf(target);
    if (value === null) return invalid(name, `${target} is no model role and no key of keys.json`, 'unknown-target');
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    return info.ok
      ? { text: `${target}: the provider knows the key`, status: 'ok' }
      : failed(
          name,
          `${target}: refused${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
        );
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
      case 'keys.add':
        return addKey(name, args, dialog);
      case 'keys.remove':
        return removeKey(name, args);
      case 'keys.list':
        return listKeys();
      case 'keys.check':
        return checkTarget(name, text(args.target ?? args.role));
      case 'model.set':
        return chainCommand(deps, name, args) ?? setModel(name, args, dialog);
      case 'model.add':
      case 'model.remove':
      case 'model.show':
        return chainCommand(deps, name, args) ?? invalid(name, `the roles are ${ROUTE_ROLES.join(', ')}`);
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
