// The routing of a paid script (scripts/replay.ts, scripts/memory-session.ts, scripts/recall-eval.ts,
// scripts/inner-week.ts, scripts/search-compare.ts, scripts/search-policy-eval.ts, scripts/vision-compare.ts). By
// default a script spends what production spends: each role's chain of routes over the keys of keys.json
// (src/llm/route-chain.ts), through the builders the core uses: the chain client of src/llm/chain-client.ts, the
// subscription client of src/subharness/subscription-client.ts and the memory writer client of
// src/subharness/memory-writer.ts. A flag `--<role> <route>` replaces one model role's whole chain for this run alone
// and writes nothing to any file: `<key>/<model>[:<effort>]` sends the role on that key of keys.json with that model,
// and `harness:<backend>/<model>[:<effort>]` sends `core` or `memory` through a connected `claude` or `codex`; the text
// is read by src/llm/route-text.ts.
// `--variant "<flags>"` runs the same inputs on several such setups in one run, and `sideBySide` and `sideBySideText`
// lay their answers side by side per input. A refusal is a CliError of one line that names the tool and a code
// (`route-malformed`, `route-unsupported`, `key-unknown`, `harness-not-connected`, `variant-unsupported`), raised before
// any request goes out. The routing is read at the moment of each request, and nothing here prints a key value.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createKeyRing } from '../../src/keys/ring.ts';
import type { KeyRing } from '../../src/keys/ring.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { createKeyFailover } from '../../src/llm/key-failover.ts';
import { createChainClient, createRouteChainOf } from '../../src/llm/chain-client.ts';
import type { CompleteResult } from '../../src/llm/openrouter.ts';
import { roleModel, searchModel } from '../../src/llm/roles.ts';
import type { EffortLevel } from '../../src/llm/roles.ts';
import { isRefusal, parseRouteText } from '../../src/llm/route-text.ts';
import type { Route } from '../../src/llm/route-text.ts';
import { MAX_FRAME_BYTES, wrapSocket } from '../../src/protocol/wire.ts';
import type { MemoryPath } from '../../src/subharness/memory-path.ts';
import { memoryWriterClient } from '../../src/subharness/memory-writer.ts';
import type { ChildRunner } from '../../src/subharness/memory-writer.ts';
import type { MemoryBackend } from '../../src/subharness/routing.ts';
import { sourceState } from '../../src/subharness/sources.ts';
import { createSubscriptionClient, spawnSubscriptionChild } from '../../src/subharness/subscription-client.ts';
import type { SubscriptionClientDeps } from '../../src/subharness/subscription-client.ts';
import { createToolBridge, serveBridge } from '../../src/subharness/tool-bridge.ts';
import type { ToolBridge } from '../../src/subharness/tool-bridge.ts';
import { runChildProcess } from '../../src/agent-runner/backend.ts';
import { CliError } from './cli-args.ts';

/** The checkout this file belongs to. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The model roles a flag can replace, as the routing knows them. */
export const ROUTE_ROLES = [
  'core',
  'memory',
  'analyzer',
  'vision',
  'video',
  'speech',
  'drawing',
  'embedding',
  'search',
] as const;
export type RouteRole = (typeof ROUTE_ROLES)[number];

/** One role's route for this run: a key of keys.json with a model, or a connected harness with a model. */
export type RoleRoute =
  | { kind: 'key'; key: string; model: string; effort: EffortLevel | null }
  | { kind: 'harness'; backend: MemoryBackend; model: string; effort: EffortLevel | null };

/** The roles a run replaces; a role with no entry runs as production runs it. */
export type Variant = Partial<Record<RouteRole, RoleRoute>>;

type Direct = SubscriptionClientDeps['direct'];
type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const recOf = (value: unknown): Rec => (isRec(value) ? value : {});

/** The refusal of a route: one line, the tool, the flag and the code. */
function refused(tool: string, flag: string, code: string, reason: string): CliError {
  return new CliError(`${tool}: ${flag}: ${code}: ${reason}`);
}

/** The route of `--<role> <text>`, or a CliError of one line that names `tool`. */
export function parseRoute(tool: string, role: RouteRole, text: string): RoleRoute {
  const route = parseRouteText(role, text);
  if (isRefusal(route)) throw refused(tool, `--${role}`, route.code, route.reason);
  return route.via === 'api'
    ? { kind: 'key', key: route.key, model: route.model, effort: route.effort }
    : { kind: 'harness', backend: route.backend, model: route.model, effort: route.effort };
}

/** A flag's route as a route of the chain. */
const chainRouteOf = (route: RoleRoute): Route =>
  route.kind === 'key'
    ? { via: 'api', key: route.key, model: route.model, effort: route.effort }
    : { via: 'harness', backend: route.backend, model: route.model, effort: route.effort };

/** The role a flag names, or null for any other argument. */
function roleOfFlag(arg: string): RouteRole | null {
  return ROUTE_ROLES.find((role) => arg === `--${role}`) ?? null;
}

/** The role flags of `argv` laid over `base`, and the arguments that are none. */
function readRoleFlags(tool: string, argv: ReadonlyArray<string>, base: Variant) {
  const routes: Variant = { ...base };
  const rest: Array<string> = [];
  const variants: Array<string> = [];
  const taken: Array<string> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const role = roleOfFlag(arg);
    if (role === null && arg !== '--variant') {
      rest.push(arg);
      continue;
    }
    const value = argv[(i += 1)];
    if (typeof value !== 'string' || (role !== null && value.startsWith('--')))
      throw refused(tool, arg, 'route-malformed', 'the flag takes one value');
    if (role === null) variants.push(value);
    else {
      routes[role] = parseRoute(tool, role, value);
      taken.push(arg, value);
    }
  }
  return { routes, rest, variants, label: taken.join(' ') };
}

/**
 * The role flags and the `--variant` flags taken out of `argv`. Each variant runs on the role flags given outside any
 * `--variant`, with its own on top; no `--variant` is one variant. A script that runs one setup passes `variants: false`
 * and refuses `--variant` with `variant-unsupported`. `label` is what the output calls the variant.
 */
export function takeRouteFlags(
  tool: string,
  argv: ReadonlyArray<string>,
  { variants: allowed }: { variants: boolean }
): { argv: Array<string>; variants: Array<{ label: string; routes: Variant }> } {
  const top = readRoleFlags(tool, argv, {});
  if (top.variants.length === 0)
    return { argv: top.rest, variants: [{ label: top.label || 'production', routes: top.routes }] };
  if (!allowed) throw refused(tool, '--variant', 'variant-unsupported', 'this script runs one setup');
  const variants = top.variants.map((text) => {
    const own = readRoleFlags(tool, text.split(/\s+/).filter(Boolean), top.routes);
    if (own.rest.length > 0 || own.variants.length > 0)
      throw refused(tool, '--variant', 'route-malformed', 'a variant holds role flags only');
    return { label: text.trim() || 'production', routes: own.routes };
  });
  return { argv: top.rest, variants };
}

/** The role flags of a script that runs one setup: the other arguments and the roles they replace. */
export function takeRoutes(tool: string, argv: ReadonlyArray<string>): { argv: Array<string>; routes: Variant } {
  const taken = takeRouteFlags(tool, argv, { variants: false });
  const [only] = taken.variants;
  return { argv: taken.argv, routes: only.routes };
}

/** A copy of `tree` with `value` at the path `keys`; `tree` is left as it was. */
function placed(tree: unknown, keys: ReadonlyArray<string>, value: unknown): Rec {
  const [head, ...tail] = keys;
  const own = recOf(tree);
  return { ...own, [head]: tail.length === 0 ? value : placed(own[head], tail, value) };
}

/** `config` with the models of the roles `variant` sends on a key; the live object is never changed. */
export function routedConfig<C>(config: C, variant: Variant): C {
  let out: unknown = config;
  for (const role of ROUTE_ROLES) {
    const route = variant[role];
    if (route?.kind !== 'key') continue;
    out = placed(out, role === 'search' ? ['web', 'quickSearch', 'model'] : ['models', 'base', role], route.model);
  }
  // The copy differs from `config` only in model names, string leaves where the settings hold a model, so its shape is C.
  return out as C;
}

/** A view of `hot` whose `config` is `routedConfig` of the live one at each read. */
export function routedHot<T extends object>(hot: T, variant: Variant): T {
  if (Object.keys(variant).length === 0) return hot;
  return new Proxy(hot, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === 'config') return routedConfig(value, variant);
      // A method of the hot view, bound to it so its own reads of `this` keep working.
      return typeof value === 'function' ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
    },
  });
}

export type ScriptRoutingDeps<C = unknown> = {
  /** The persona folder: keys.json and config/config.json. */
  privateDir: string;
  /** The roles the script spends, one start line each. */
  roles: ReadonlyArray<RouteRole>;
  variant: Variant;
  /** The script's live settings, read at each request. */
  getConfig(): C;
  /** The script's direct client over `ring`, which reads `getConfig`: its `createLlm`. */
  createDirect(ring: KeyRing, getConfig: () => C): Direct;
  /** The script's counters, for the daily request count of a step through a harness. */
  state: SubscriptionClientDeps['state'];
  /** The client that answers every request in place of any provider or harness (scripts/replay.ts `--answers-dir`). */
  offline?: Direct;
  spawn?: SubscriptionClientDeps['spawn'];
  runChild?: ChildRunner;
  /** Each harness run gets a folder inside it. */
  workDir?: string;
  hostEnv?: SubscriptionClientDeps['hostEnv'];
};

export type ScriptRouting = {
  /** One line per role of `roles`: its key name or harness and its model, never a key value. */
  said: Array<string>;
  /** The key ring production builds, with the replaced roles on their keys. */
  ring: KeyRing;
  /** The value of the key `role` goes out on, null with none or offline. For the embedder, speech and pictures. */
  keyOf: (role: string) => string | null;
  /** The chat client: each request by its role, as production sends it or as the variant replaces it. */
  llm: Direct;
  /** The memory writer's path now, for a session that checks its key by it. */
  memoryPath: () => MemoryPath;
  /** The chain of `role` for this run: the flag's one route, else production's. */
  routes: (role: RouteRole) => Array<Route>;
  /** Stops the tool bridge's socket and removes its folder. */
  close: () => Promise<void>;
};

/** The bridge's socket: a folder of mode 700 under TMPDIR, made when the first core step with tools starts. */
function bridgeSocket(bridge: ToolBridge): { socketPath: string; ready(): Promise<void>; close(): Promise<void> } {
  const dir = path.join(os.tmpdir(), `nep-script-${randomBytes(6).toString('hex')}`);
  const socketPath = path.join(dir, 'bridge.sock');
  const removeDir = (): void => fs.rmSync(dir, { recursive: true, force: true });
  let listening: Promise<net.Server> | null = null;
  const ready = (): Promise<void> => {
    listening ??= new Promise<net.Server>((resolve, reject) => {
      fs.mkdirSync(dir, { mode: 0o700 });
      process.once('exit', removeDir);
      const server = net.createServer((socket) => serveBridge(wrapSocket(socket, MAX_FRAME_BYTES), bridge));
      server.once('error', reject);
      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        // The script ends when its work is done, whether or not it closed the bridge.
        server.unref();
        resolve(server);
      });
    });
    return listening.then(() => undefined);
  };
  const close = async (): Promise<void> => {
    if (listening !== null) {
      const server = await listening.catch(() => null);
      await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    }
    removeDir();
    process.off('exit', removeDir);
  };
  return { socketPath, ready, close };
}

/** The route `variant` gives the role named `role`, undefined for a role it leaves alone or a name that is no role. */
function routeOf(variant: Variant, role: string): RoleRoute | undefined {
  const known = ROUTE_ROLES.find((one) => one === role);
  return known === undefined ? undefined : variant[known];
}

/** The ring production builds, with each role `variant` sends on a key going out on that key alone. */
function routedRing(privateDir: string, variant: Variant, offline: boolean): KeyRing {
  const store = createKeyStore({ privateDir });
  const base = createKeyRing({ store, failover: createKeyFailover({ now: Date.now }) });
  const keyOf = (role: string): string | null => {
    const route = routeOf(variant, role);
    return route?.kind === 'key' ? route.key : null;
  };
  return {
    ...base,
    route(role) {
      if (offline) return null;
      const name = keyOf(role);
      if (name === null) return base.route(role);
      const value = store.valueOf(name);
      return value === null ? null : { name, value };
    },
    names: (role) => {
      const name = keyOf(role);
      return name === null ? base.names(role) : [name];
    },
    failed: (role, name, status) => (keyOf(role) === null ? base.failed(role, name, status) : null),
  };
}

/** Each replaced role checked against keys.json and the harnesses, before any client is built. */
async function checkRoutes(tool: string, privateDir: string, variant: Variant): Promise<void> {
  const store = createKeyStore({ privateDir });
  for (const role of ROUTE_ROLES) {
    const route = variant[role];
    if (route === undefined) continue;
    if (route.kind === 'key' && store.valueOf(route.key) === null)
      throw refused(tool, `--${role}`, 'key-unknown', `keys.json holds no key named ${route.key}`);
    if (route.kind === 'harness') {
      const state = await sourceState(privateDir, route.backend);
      if (!state.available)
        throw refused(tool, `--${role}`, 'harness-not-connected', `${route.backend} is ${state.code}`);
    }
  }
}

/** The effort of a route in words, or nothing. */
const effortText = (effort: string | null | undefined): string => (effort ? `, effort ${effort}` : '');

/** The start line of `role` on the route it would take now, or with none, why. */
function saidOf(role: RouteRole, route: Route | null, ctx: { config: unknown; offline: boolean }): string {
  if (ctx.offline) return `${role}: answered from files`;
  if (route?.via === 'harness')
    return `${role}: harness ${route.backend}, model ${route.model}${effortText(route.effort)}`;
  if (route?.via === 'api') return `${role}: key ${route.key}, model ${route.model}${effortText(route.effort)}`;
  const model = role === 'search' ? searchModel(ctx.config) : roleModel(ctx.config, role);
  return model === undefined ? `${role}: off` : `${role}: no key, model ${model}`;
}

/**
 * The routing of one run of a paid script on `variant`: production's chains, with the variant's roles replaced whole.
 * Refuses a route whose key keys.json lacks or whose harness is not logged in, with one line that names `tool`, before
 * any client is built.
 */
export async function scriptRouting<C>(tool: string, deps: ScriptRoutingDeps<C>): Promise<ScriptRouting> {
  const { privateDir, variant } = deps;
  const offline = deps.offline !== undefined;
  if (!offline) await checkRoutes(tool, privateDir, variant);
  const ring = routedRing(privateDir, variant, offline);
  const store = createKeyStore({ privateDir });
  const getConfig = (): C => routedConfig(deps.getConfig(), variant);
  let executor: ((role: string) => Direct) | null = null;
  const chain = createChainClient({
    getConfig,
    keys: { coreNames: () => store.coreNames(), valueOf: (name) => store.valueOf(name) },
    chain: createRouteChainOf(getConfig, Date.now),
    executor: (role) => {
      if (executor === null) throw new Error(`${tool}: a model request came before the clients were built`);
      return executor(role);
    },
    routes: (role) => {
      const own = routeOf(variant, role);
      return own === undefined ? null : [chainRouteOf(own)];
    },
  });
  const memoryPath = (): MemoryPath => {
    const route = chain.inForce('memory');
    return route?.via === 'harness'
      ? { kind: 'subharness', backend: route.backend, model: route.model, effort: route.effort }
      : { kind: 'direct' };
  };
  const said = deps.roles.map((role) => saidOf(role, chain.inForce(role), { config: getConfig(), offline }));
  const routes = (role: RouteRole): Array<Route> => chain.routes(role);
  if (deps.offline !== undefined) {
    const answers = deps.offline;
    return { said, ring, keyOf: () => null, llm: answers, memoryPath, routes, close: () => Promise.resolve() };
  }

  const direct = deps.createDirect(ring, getConfig);
  const workDir = deps.workDir ?? path.join(os.tmpdir(), 'neptunia-script-turns');
  const bridge = createToolBridge({ token: () => randomBytes(32).toString('hex') });
  const socket = bridgeSocket(bridge);
  const subscription = createSubscriptionClient({
    privateDir,
    direct,
    bridge,
    spawn: deps.spawn ?? spawnSubscriptionChild,
    mcp: {
      command: process.execPath,
      args: [path.join(ROOT, 'bin', 'neptunia-mcp.ts')],
      socketPath: socket.socketPath,
    },
    workDir,
    getConfig: () => ({ llm: recOf(recOf(getConfig()).llm) }),
    state: deps.state,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
    // The handles are the ones setTimer above made.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(deps.hostEnv === undefined ? {} : { hostEnv: deps.hostEnv }),
  });
  const writer = memoryWriterClient({
    writer: { privateDir, runChild: deps.runChild ?? runChildProcess, workDir },
    direct,
  });
  const core: Direct = {
    async complete(messages, options) {
      const tools = recOf(options).tools;
      if (Array.isArray(tools) && tools.length > 0) await socket.ready();
      return subscription.complete(messages, options);
    },
  };
  const memory: Direct = {
    async complete(messages, options): Promise<CompleteResult> {
      const done = await writer.complete(Array.isArray(messages) ? messages.filter(isRec) : [], recOf(options));
      return { estimated: 0, ...done, text: typeof done.text === 'string' ? done.text : '', usage: done.usage ?? {} };
    },
  };
  executor = (role) => (role === 'core' ? core : role === 'memory' ? memory : direct);
  const llm: Direct = { complete: (messages, options) => chain.complete(messages, options) };
  return { said, ring, keyOf: (role) => chain.keyOf(role), llm, memoryPath, routes, close: () => socket.close() };
}

/**
 * The results of one input on each variant, side by side: what every variant holds alike stays once, a list of the same
 * length is laid side by side item by item, and what differs goes under `variants`, one entry per label.
 */
export function sideBySide(labels: ReadonlyArray<string>, values: ReadonlyArray<unknown>): unknown {
  const [first] = values;
  if (values.every((value) => isDeepStrictEqual(value, first))) return first;
  const each = (pick: (value: unknown) => Rec) => labels.map((label, i) => ({ variant: label, ...pick(values[i]) }));
  if (!values.every(isRec)) return { variants: each((value) => ({ value })) };
  const recs = values;
  const out: Rec = {};
  const differing: Array<string> = [];
  for (const key of [...new Set(recs.flatMap((one) => Object.keys(one)))]) {
    const column = recs.map((one) => one[key]);
    const lists = column.every((value): value is Array<unknown> => Array.isArray(value)) ? column : null;
    if (column.every((value) => isDeepStrictEqual(value, column[0]))) out[key] = column[0];
    else if (lists !== null && lists.every((list) => list.length === lists[0].length))
      out[key] = lists[0].map((_, i) =>
        sideBySide(
          labels,
          lists.map((list) => list[i])
        )
      );
    else differing.push(key);
  }
  if (differing.length > 0)
    out.variants = each((value) =>
      Object.fromEntries(
        differing.filter((key) => Object.hasOwn(recOf(value), key)).map((key) => [key, recOf(value)[key]])
      )
    );
  return out;
}

/**
 * The blocks of each variant's text, side by side: every input once in the order the variants first name it, then each
 * variant's lines beneath it under its label, `(not run)` where a variant has no block for that input.
 */
export function sideBySideText(
  labels: ReadonlyArray<string>,
  runs: ReadonlyArray<ReadonlyArray<{ input: string; lines: ReadonlyArray<string> }>>
): Array<string> {
  const inputs = [...new Set(runs.flatMap((run) => run.map((block) => block.input)))];
  const out: Array<string> = [];
  for (const input of inputs) {
    out.push(input);
    runs.forEach((run, i) => {
      const lines = run.find((block) => block.input === input)?.lines ?? ['(not run)'];
      const [head = '', ...tail] = lines;
      out.push(`  [${labels[i]}] ${head}`, ...tail.map((line) => `    ${line}`));
    });
  }
  return out;
}

/** The start lines of `said` for stderr, each under the tool's name. */
export const routesText = (tool: string, said: ReadonlyArray<string>): string =>
  said.map((line) => `${tool}: ${line}\n`).join('');
