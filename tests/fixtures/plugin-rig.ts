// The pieces the plugin tests share: the manifest of the echo test plugin, a hand-driven client of the link for what a
// well-behaved plugin never sends, the plugin's unit as a child process (`neptunia plugin run`), the core started with
// a recording stand-in for the systemd units, and a scripted model that calls `echo_say` once and then speaks.
// Folders and clients come from tests/fixtures/core-units.ts. Synthetic data only; no provider, no platform.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCore } from '../../src/core.js';
import { envelope } from '../../src/protocol/index.ts';
import type { PluginManifest, ToolAnswer, ToolCallBody, ToolDeclaration } from '../../src/protocol/plugin.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../../src/protocol/wire.ts';
import type { Logger } from '../../src/protocol/serve.ts';
import type { Envelope, Transport } from '../../src/protocol/wire.ts';
import type { PluginUnits } from '../../src/plugins/control.ts';
import { ANSWER, BIN, REPO } from './core-units.ts';
import type { Core, Dirs, Llm } from './core-units.ts';

export { ANSWER };

export const ECHO_DIR = join(REPO, 'tests', 'fixtures', 'plugins', 'echo');
export const quiet: Logger = { info() {}, warn() {}, error() {} };

/** The echo plugin's `plugin.json` as the fixture ships it. */
export function echoManifest(): PluginManifest {
  return JSON.parse(readFileSync(join(ECHO_DIR, 'plugin.json'), 'utf8')) as PluginManifest;
}

/** The one tool of the echo plugin, as declared. */
export function echoTool(): ToolDeclaration {
  const [tool] = echoManifest().tools;
  if (tool === undefined) throw new Error('the echo fixture declares no tool');
  return tool;
}

/** Copies the echo fixture into `<privateDir>/plugins.local/echo`, where the core and the runner look for it. */
export function installEcho(privateDir: string): void {
  const target = join(privateDir, 'plugins.local');
  mkdirSync(target, { recursive: true });
  cpSync(ECHO_DIR, join(target, 'echo'), { recursive: true });
}

/** The token `tools/client-token.mjs` or `/plugins enable` wrote for client `name`. */
export const tokenOf = (dirs: Dirs, name: string): string =>
  readFileSync(join(dirs.privateDir, 'clients', `${name}.token`), 'utf8').trim();

/** The hello of a plugin named `name`, as `servePlugin` says it. */
export function pluginHello(name: string, token: string, id = 'h1'): Envelope {
  return envelope('hello', { iface: 'plugin', self: { id: name, name }, community: null, token }, { id });
}

/** A hand-driven end of a link: sends any envelope, keeps every envelope it receives, waits for one by a match. */
export type Raw = {
  transport: Transport;
  seen: Array<Envelope>;
  closed: () => string | null;
  send(type: string, body: object, id: string, replyTo?: string): void;
  /** Resolves with the first envelope, seen now or later, for which `match` is true. */
  next(match: (value: Envelope) => boolean, what: string, ms?: number): Promise<Envelope>;
  /** The `ack` that answers the envelope `id`. */
  ack(id: string): Promise<Envelope>;
};

export function rawClient(transport: Transport): Raw {
  const seen: Array<Envelope> = [];
  const listeners = new Set<(value: Envelope) => void>();
  let closedWith: string | null = null;
  transport.onEnvelope((value) => {
    seen.push(value);
    for (const listener of [...listeners]) listener(value);
  });
  transport.onClose((reason) => {
    closedWith = reason;
  });
  const next = (match: (value: Envelope) => boolean, what: string, ms = 4000): Promise<Envelope> => {
    const found = seen.find(match);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      const listener = (value: Envelope): void => {
        if (!match(value)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(value);
      };
      listeners.add(listener);
    });
  };
  return {
    transport,
    seen,
    closed: () => closedWith,
    send: (type, body, id, replyTo) => transport.send(envelope(type, body, { id, ...(replyTo === undefined ? {} : { replyTo }) })),
    next,
    ack: (id) => next((value) => value.type === 'ack' && value.replyTo === id, `the ack of ${id}`),
  };
}

/** A raw client over the core's socket at `socketPath`. */
export async function rawOverSocket(socketPath: string): Promise<Raw> {
  return rawClient(await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES }));
}

/** The statuses of an ack as a plain string. */
export const statusOf = (value: Envelope): string => String((value.body as Record<string, unknown>).status);

/** A handler that answers every call with its text behind `prefix` and keeps the calls it got. */
export function echoHandler(calls: Array<ToolCallBody> = [], prefix = 'echo: ') {
  return (call: ToolCallBody): ToolAnswer => {
    calls.push(call);
    return { status: 'ok', data: { text: `${prefix}${typeof call.args.text === 'string' ? call.args.text : ''}` } };
  };
}

/** What `startCore` was told in place of systemctl: the units it was asked to start and stop. */
export type UnitLog = PluginUnits & { started: Array<string>; stopped: Array<string> };

export function recordingUnits(options: { failStart?: boolean } = {}): UnitLog {
  const started: Array<string> = [];
  const stopped: Array<string> = [];
  return {
    started,
    stopped,
    start: (unit) => {
      started.push(unit);
      return options.failStart === true ? Promise.reject(new Error('no such unit')) : Promise.resolve();
    },
    stop: (unit) => {
      stopped.push(unit);
      return Promise.resolve();
    },
  };
}

/** The core as the units run it (no interface of its own) with `units` standing in for systemctl. */
export function startPluginCore(dirs: Dirs, llm: Llm, units: PluginUnits, now?: () => number): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    units,
    ...(now === undefined ? {} : { now }),
  });
}

type Reply = { text: string; usage: object; estimated: number; toolCalls?: Array<object>; finishReason?: string };

/**
 * A scripted model for a turn that may use `echo_say`: while the request offers that tool and no tool message is in
 * it yet, she calls it with `text`; once a tool message is in the request she speaks. Every other request (a helper
 * model of the core) gets the plain answer. `requests` keeps every request's messages.
 */
export type EchoLlm = Llm & { toolMessages(): Array<string> };

export function echoLlm(text: string, speak = ANSWER): EchoLlm {
  const requests: Array<unknown> = [];
  const options: Array<unknown> = [];
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? '').join('')
        : '';
  const toolMessagesOf = (messages: unknown): Array<string> =>
    (Array.isArray(messages) ? (messages as Array<{ role?: string; content?: unknown }>) : [])
      .filter((message) => message.role === 'tool')
      .map((message) => textOf(message.content));
  const offers = (given: unknown): boolean =>
    JSON.stringify((given as { tools?: unknown } | null)?.tools ?? []).includes('echo_say');
  return {
    requests,
    options,
    complete: (messages: unknown, given?: unknown): Promise<Reply> => {
      requests.push(messages);
      options.push(given ?? null);
      if (offers(given) && toolMessagesOf(messages).length === 0) {
        const call = { id: 'call-1', name: 'echo_say', arguments: JSON.stringify({ text }), parsed: { text }, parseError: null };
        return Promise.resolve({ text: '', toolCalls: [call], usage: {}, estimated: 10, finishReason: 'stop' });
      }
      return Promise.resolve({ text: `<msg>${speak}</msg>`, usage: {}, estimated: 10 });
    },
    toolMessages: () => requests.flatMap(toolMessagesOf),
  };
}

/** One `neptunia plugin run <name>` child. */
export type PluginUnit = { child: ChildProcess; output(): string; kill(): Promise<void> };

export function spawnPlugin(dirs: Dirs, name: string, extraEnv: NodeJS.ProcessEnv = {}): PluginUnit {
  const child = spawn(process.execPath, [BIN, 'plugin', 'run', name], {
    cwd: REPO,
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: dirs.privateDir, NEPTUNIA_DATA_DIR: dirs.dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    child,
    output: () => out,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const forced = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(forced);
    },
  };
}
