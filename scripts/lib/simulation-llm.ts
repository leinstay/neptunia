// The llm of a paid script (scripts/replay.ts, scripts/inner-week.ts, scripts/memory-session.ts,
// scripts/recall-eval.ts), re-exported by scripts/lib/cli.ts. The script reads the simulation's route of keys.json
// (`models.harness.simulation`, src/subharness/subscription-path.ts) once at its start. With no route stored, every request
// spends the simulation key through the direct client. With a route stored, requests of the role `core` run through
// `claude` or `codex` (src/subharness/subscription-client.ts), and every other role (the analyzer, the describers, the
// embedder) spends the simulation key when one is set and is refused with `simulation-off` when none is. A core step
// with tools reaches the CLI through `bin/neptunia-mcp.ts`, which connects to a tool bridge the script serves on a
// private Unix socket of its own; the script's step loop runs the tools in process and answers the waiting calls, as
// the core's bridge does over the core socket. Nothing here prints a key value.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../../src/paths.ts';
import { MAX_FRAME_BYTES, wrapSocket } from '../../src/protocol/wire.ts';
import { simulationKey } from '../../src/simulation/key.ts';
import { createSubscriptionClient, spawnSubscriptionChild } from '../../src/subharness/subscription-client.ts';
import type { SubscriptionClientDeps } from '../../src/subharness/subscription-client.ts';
import { subscriptionPath, subscriptionPathText } from '../../src/subharness/subscription-path.ts';
import type { SubscriptionPath } from '../../src/subharness/subscription-path.ts';
import { createToolBridge, serveBridge } from '../../src/subharness/tool-bridge.ts';
import type { ToolBridge } from '../../src/subharness/tool-bridge.ts';
import { CliError } from './cli-args.ts';

/** The checkout this file belongs to. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Direct = SubscriptionClientDeps['direct'];

export type SimulationDeps<TDirect extends Direct> = {
  /** Where `NEPTUNIA_DATA_DIR` names the persona folder; the process's own by default. */
  env?: Record<string, string | undefined>;
  /** The direct client on `apiKey`, built only when the simulation key is set. */
  createDirect(apiKey: string): TDirect;
  /** The script's live settings; the client reads their `llm` object. */
  getConfig(): unknown;
  /** The script's counters, for the daily request count of a step on the route. */
  state: SubscriptionClientDeps['state'];
  spawn?: SubscriptionClientDeps['spawn'];
  /** Each CLI run gets a folder `turn-*` inside it. */
  workDir?: string;
  hostEnv?: SubscriptionClientDeps['hostEnv'];
};

export type SimulationLlm = {
  /** `subscription` while the route is stored, `key` otherwise. */
  route: 'subscription' | 'key';
  /** What the run spends, in one line for the script to print. */
  said: string;
  /** The simulation key for the script's embedder and pictures, or null when the route runs without one. */
  key: string | null;
  /** The direct client on the key; on the route a `complete` that sends each request by its role. */
  llm: Direct;
  /** Stops the tool bridge's socket and removes its folder. */
  close(): Promise<void>;
};

/** The refusal of a helper's request while the route runs with no key: one line, the code `simulation-off`. */
function refused(tool: string, reason: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(`${tool}: ${reason}`), { code: 'simulation-off' }));
}

/** The `llm` object of a settings value, or an empty one. */
function llmOf(config: unknown): Record<string, unknown> {
  // Both casts read an object by key after the checks beside them; its values stay unknown.
  const llm = typeof config === 'object' && config !== null ? (config as { llm?: unknown }).llm : undefined;
  return typeof llm === 'object' && llm !== null ? (llm as Record<string, unknown>) : {};
}

/** The first line of a thrown value's message. */
const firstLine = (err: unknown, otherwise: string): string =>
  err instanceof Error ? (err.message.split('\n')[0] ?? otherwise) : otherwise;

/** The bridge's socket: a folder of mode 700 under TMPDIR, made when the first core step with tools starts. */
function bridgeSocket(bridge: ToolBridge): { socketPath: string; ready(): Promise<void>; close(): Promise<void> } {
  const dir = path.join(os.tmpdir(), `nep-sim-${randomBytes(6).toString('hex')}`);
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

/** Whether a request is a core step that offers tools, the one kind that needs the bridge's socket. */
function offersTools(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  // A non-null object read by two keys whose values stay unknown.
  const { role, tools } = options as { role?: unknown; tools?: unknown };
  return role === 'core' && Array.isArray(tools) && tools.length > 0;
}

/** The script's llm on the stored route `fixed`, with the simulation key `key` for every other role. */
function onRoute<TDirect extends Direct>(
  tool: string,
  deps: SimulationDeps<TDirect>,
  privateDir: string,
  fixed: SubscriptionPath,
  key: { value: string | null; reason: string }
): SimulationLlm {
  // Built on the first request of another role, so a run of core steps alone never makes a client on the key.
  let helpers: TDirect | null = null;
  const direct: Direct = {
    complete(messages, options) {
      if (key.value === null) return refused(tool, key.reason);
      helpers ??= deps.createDirect(key.value);
      return helpers.complete(messages, options);
    },
  };
  const bridge = createToolBridge({ token: () => randomBytes(32).toString('hex') });
  const socket = bridgeSocket(bridge);
  const client = createSubscriptionClient({
    privateDir,
    route: 'simulation',
    fixedPath: fixed,
    direct,
    bridge,
    spawn: deps.spawn ?? spawnSubscriptionChild,
    mcp: {
      command: process.execPath,
      args: [path.join(ROOT, 'bin', 'neptunia-mcp.ts')],
      socketPath: socket.socketPath,
    },
    workDir: deps.workDir ?? path.join(os.tmpdir(), 'neptunia-simulation-turns'),
    getConfig: () => ({ llm: llmOf(deps.getConfig()) }),
    state: deps.state,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
    // The handles are the ones setTimer above made.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(deps.hostEnv === undefined ? {} : { hostEnv: deps.hostEnv }),
  });
  const complete = async (messages: unknown, options?: unknown) => {
    if (offersTools(options)) await socket.ready();
    return client.complete(messages, options);
  };
  const helpersSaid =
    key.value === null ? 'other roles refused: no simulation key' : 'other roles on the simulation key';
  return {
    route: 'subscription',
    said: `core requests ${subscriptionPathText(fixed)}, ${helpersSaid}`,
    key: key.value,
    llm: { complete },
    close: () => socket.close(),
  };
}

/**
 * The llm a paid script spends, read once: the stored simulation route, else the simulation key. With neither, a
 * CliError of one line that names `tool`. `said` tells the script what to print about the route it spends.
 */
export function simulationLlm<TDirect extends Direct>(tool: string, deps: SimulationDeps<TDirect>): SimulationLlm {
  let privateDir: string;
  let fixed: SubscriptionPath;
  try {
    privateDir = resolvePaths({ rootDir: ROOT, env: deps.env ?? process.env }).privateDir;
    fixed = subscriptionPath(privateDir, 'simulation');
  } catch (err) {
    throw new CliError(`${tool}: ${firstLine(err, 'the simulation route cannot be read')}`);
  }
  let key: { value: string | null; reason: string };
  try {
    key = { value: simulationKey(privateDir), reason: '' };
  } catch (err) {
    key = { value: null, reason: firstLine(err, 'the simulation key cannot be read') };
  }
  if (fixed.kind === 'subharness') return onRoute(tool, deps, privateDir, fixed, key);
  if (key.value === null) throw new CliError(`${tool}: ${key.reason}`);
  return {
    route: 'key',
    said: 'every request on the simulation key',
    key: key.value,
    llm: deps.createDirect(key.value),
    close: () => Promise.resolve(),
  };
}
