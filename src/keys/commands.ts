// The owner's key commands of the chat: `keys add|remove|list|check` over the named keys of keys.json, and the chain
// commands `model show|set|add|remove`, which write a role's chain of routes to `models.routes` of config.json after one
// check of the route. The console (src/interface/commands/console.ts) routes them here. A key value is never an argument: every add asks
// for it through the dialog the link gives (a secret prompt, src/interface/commands/dialogs.ts), so the value reaches
// neither the typed line, the chat's history file nor a refusal. A key is checked before it is saved (the first key with
// the four mandatory model roles, whose chains it then carries, a later one with `/auth/key`), and a failed check saves
// nothing. An answer names keys by name and last four characters and never holds a value; a refusal names the store's
// code, never the word that was refused.

import { CORE_ROLE, SEARCH_ROLE, directSelectionOf, roleGroup } from '../llm/roles.ts';
import { log } from '../log.ts';
import { checkKey, checkRole } from './check.ts';
import type { CheckResult } from './check.ts';
import type { KeyRing } from './ring.ts';
import { isKeyName, KeysError } from './store.ts';
import { isRefusal, isRouteRole, parseRouteText, routeText, ROUTE_ROLES } from '../llm/route-text.ts';
import type { HarnessRoute, Route, RouteRole } from '../llm/route-text.ts';
import type { KeyStore } from './store.ts';

/** The model roles the first key must serve before its add finishes, in the order they are asked. */
export const MANDATORY_ROLES: ReadonlyArray<RouteRole> = ['core', 'memory', 'analyzer', 'embedding'];

/** The pause reason of a core left with no usable route by `keys remove`; the `keys add` that gives it one lifts it. */
const NO_CORE_ROUTE = 'no-core-route';

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

export type KeysDeps = {
  store: KeyStore;
  /** The key of a role's route in force (src/keys/ring.ts#chainRing). */
  ring: Pick<KeyRing, 'route'>;
  fetch: typeof fetch;
  baseUrl(): string;
  /** The tracked model of each mandatory role, offered by the first add. */
  defaults: Readonly<Record<string, string>>;
  /** The live model of a role; '' while the role is off. */
  currentModel(role: string): string;
  /** The live `speech.voice`, which `checkRole` probes the speech role with. */
  speechVoice?(): string;
  /** Saves an agent's model (the console runs the `model.set` operation). */
  saveModel(role: string, model: string): Promise<void>;
  pause: PauseControl;
  /** Told what a check of `role` came to, so a launch's readiness (src/setup/readiness.ts) needs no request of its own. */
  recordCheck?(role: string, check: { selection: string; ok: boolean; code: string | null }): void;
  /** The backend `role` runs through (core, memory), null on the API: such a role needs no key. */
  harnessOf?: (role: string) => string | null;
  /** The path her memory writer runs on now (its chain's route in force), read at every check. */
  memoryPath?: () => MemoryCheckPath | null;
  /** One probe through the subharness path of the memory writer (src/subharness/memory-probe.ts#memoryProbe). */
  probeMemory?: () => Promise<MemoryCheckProbe>;
  /** The chain of `role` now (src/llm/route-chain.ts). */
  chainOf: (role: RouteRole) => Array<Route>;
  /** Writes the chain of `role` to `models.routes.<role>` of config.json. */
  saveRoutes: (role: RouteRole, routes: Array<Route>) => Promise<void>;
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
    ...(route.effort === null || route.effort === 'disabled' ? {} : { reasoning: { effort: route.effort } }),
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
  return { text: ROUTE_ROLES.map((role) => `${role}: ${chainText(deps.chainOf(role))}`).join('\n'), status: 'ok' };
}

/** The answer of a chain command, or null for one the chains do not take (an agent's `/model set`, an unknown role). */
function chainCommand(deps: KeysDeps, name: string, args: Record<string, unknown>): Promise<Answer> | null {
  if (name === 'model.show') return Promise.resolve(showChains(deps));
  const role = text(args.role);
  if (!isRouteRole(role)) return null;
  if (name === 'model.remove') return removeRoute(deps, name, role, text(args.index));
  return writeRoute(deps, name, role, text(args.model));
}

export function createKeysCommands(deps: KeysDeps): {
  run(name: string, args: Record<string, unknown>, dialog: Dialog | null): Promise<Answer>;
} {
  const { store, ring, pause: pauseControl } = deps;

  /** Whether her core has a route it can take: a harness, or a key keys.json holds. */
  const coreHasRoute = (): boolean =>
    deps.chainOf('core').some((route) => route.via === 'harness' || store.valueOf(route.key) !== null);

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
    if (store.names().includes(key)) return invalid(name, new KeysError('duplicate-name').message);
    return null;
  }

  async function askValue(dialog: Dialog, key: string): Promise<string> {
    return pasted(await dialog.ask(`Paste the key ${key}. Nothing is shown while you type.`, { secret: true }));
  }

  /**
   * The first key: the value, the four models, one request per model on the new key, and only then the save of the key
   * and of each mandatory role's chain, one route on the new key.
   */
  async function firstKey(name: string, key: string, value: string, dialog: Dialog): Promise<Answer> {
    const models = new Map<RouteRole, string>();
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
    store.add({ name: key, value });
    for (const [role, model] of models) await deps.saveRoutes(role, [{ via: 'api', key, model, effort: null }]);
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
    if (store.names().length === 0) return firstKey(name, key, value, dialog);
    const info = await checkKey({ fetch: deps.fetch, baseUrl: deps.baseUrl(), value });
    if (!info.ok)
      return failed(
        name,
        `the provider refused the key${info.status === null ? '' : ` (HTTP ${info.status})`}: ${info.error ?? 'no reason given'}`
      );
    store.add({ name: key, value });
    const resumed = await resumeIfNoRoute();
    const hint = `Put a role on it with /model set <role> ${key}/<model>.`;
    return { text: `${key} is added. ${hint}${resumed ? ' She is running again.' : ''}`, status: 'ok' };
  }

  /** The roles whose chain names `key`, in display order. */
  const rolesOn = (key: string): Array<RouteRole> =>
    ROUTE_ROLES.filter((role) => deps.chainOf(role).some((route) => route.via === 'api' && route.key === key));

  /**
   * `keys remove <name>`: the key leaves keys.json. A chain that named it keeps the route, which is skipped until a key of
   * that name comes back, so its chain is written to config.json first; a core left with no usable route pauses her.
   */
  async function removeKey(name: string, args: Record<string, unknown>): Promise<Answer> {
    const key = text(args.name);
    if (!store.names().includes(key)) throw new KeysError('unknown-key');
    const roles = rolesOn(key);
    for (const role of roles) await deps.saveRoutes(role, deps.chainOf(role));
    store.remove(key);
    const left = roles.length === 0 ? '' : ` Routes of ${roles.join(', ')} named it and are skipped now.`;
    const harness = deps.harnessOf?.(CORE_ROLE) ?? null;
    const kept = harness !== null ? ` Her core runs through ${harness} and needs no key, so she keeps running.` : '';
    if (coreHasRoute()) return { text: `${key} is removed.${left}${kept}`, status: 'ok' };
    await pauseControl.pause(NO_CORE_ROUTE);
    return {
      text: `${key} is removed.${left} Her core has no route left, so she is paused (${NO_CORE_ROUTE}).`,
      status: 'ok',
    };
  }

  /** `keys list`: every key by name and last four characters, with the roles whose chain names it. */
  function listKeys(): Answer {
    const rows = store.list();
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
        failed(
          name,
          `the ${role} role has no key: its chain names no key keys.json holds; /model set ${role} <key>/<model>`
        )
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

  /** `model set` of an agent: its model is an OpenCode id, no OpenRouter model id, so it is saved with no check. */
  async function setAgentModel(name: string, args: Record<string, unknown>): Promise<Answer> {
    const role = text(args.role);
    const model = text(args.model);
    const group = roleGroup(role);
    if (group !== 'errands' && group !== 'development') return invalid(name, `the roles are ${ROUTE_ROLES.join(', ')}`);
    if (model === '') return invalid(name, 'a role and a model are needed');
    if (text(args.provider) !== '' || text(args.effort) !== '')
      return invalid(name, `the ${role} role takes no provider and no effort here`);
    await deps.saveModel(role, model);
    return { text: `The ${role} model is ${model}. Its id is not checked here.`, status: 'ok' };
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
        return chainCommand(deps, name, args) ?? setAgentModel(name, args);
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
