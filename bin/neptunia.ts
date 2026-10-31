#!/usr/bin/env node
// The `neptunia` command (package.json `bin`). Its one command so far runs an interface as its own process, the way
// its systemd unit starts it (deploy/neptunia-interface@.service):
//
//   neptunia interface run <name> [--interfaces-dir <dir>]
//
// It loads `<dir>/<name>/index.ts` or `index.js` (the default dir is the checkout's `interfaces/`), reads the client's
// token from `$NEPTUNIA_PRIVATE_DIR/clients/<name>.token` (tools/client-token.mjs writes it), connects to the core's
// socket `$NEPTUNIA_DATA_DIR/run/core.sock` and calls the package's `start(host)` with `host.dataDir` set to
// `<data>/interfaces/<name>`, where the interface keeps its outbox. It needs no `.env` and no config.local.json: the
// settings it hands over are config.json, then the package's own config.json, then config.local.json when this user
// can read it, read again whenever one of the files changes. A link that drops is opened again with backoff, from a
// quarter second doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. An interface
// that cannot reconnect (no `reconnect()`) ends the process with exit code 1, and its unit restarts it. SIGTERM and
// SIGINT stop the interface and exit 0.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, deepMerge, resolveEnvRefs } from '../src/config.js';
import { moveConfigKeys } from '../src/config-moves.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { log } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import type { Transport } from '../src/protocol/wire.ts';

const USAGE = 'usage: neptunia interface run <name> [--interfaces-dir <dir>]';

/** The first wait before a new connection, and the longest. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** A link that stayed up this long was healthy: the backoff starts over after it. */
const STABLE_MS = 30_000;

/** An interface name as tools/client-token.mjs accepts a client name. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Settings = Record<string, unknown>;
type InterfacePackage = { start(host: InterfaceHost): Promise<RunningInterface> };

function die(message: string): never {
  console.error(`neptunia: ${message}`);
  process.exit(message.startsWith('usage:') ? 2 : 1);
}

/** The interface name and folder of `interface run`, or a usage error. */
function parseRun(argv: ReadonlyArray<string>): { name: string; interfacesDir: string } {
  const [group, command, name, ...rest] = argv;
  if (group !== 'interface' || command !== 'run' || name === undefined) die(USAGE);
  if (!NAME.test(name)) die(`invalid interface name "${name}"; use lowercase letters, digits, - and _`);
  let interfacesDir = path.join(ROOT_DIR, 'interfaces');
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i + 1];
    if (rest[i] !== '--interfaces-dir' || value === undefined) die(USAGE);
    interfacesDir = path.resolve(value);
    i += 1;
  }
  return { name, interfacesDir };
}

/** The package's entry, `index.ts` before `index.js`. */
async function loadPackage(dir: string): Promise<InterfacePackage> {
  const entry = ['index.ts', 'index.js'].map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
  if (entry === undefined) die(`no index.ts or index.js in ${dir}`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const start: unknown = loaded !== null && typeof loaded === 'object' ? Reflect.get(loaded, 'start') : undefined;
  if (typeof start !== 'function') die(`${entry} exports no start(host)`);
  // The package's start is the function the interface contract names (src/protocol/host.ts).
  return { start: start as InterfacePackage['start'] };
}

/** The client's token, a trailing newline dropped. */
function readToken(privateDir: string, name: string): string {
  const file = path.join(privateDir, 'clients', `${name}.token`);
  let token: string;
  try {
    token = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    die(
      `cannot read the token ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'}); run tools/client-token.mjs add`
    );
  }
  if (token === '') die(`the token file ${file} is empty`);
  return token;
}

/** A JSON object file, or null when it is absent or this user cannot read it. */
function readObject(file: string): Settings | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  if (text === '') return null;
  const value: unknown = JSON.parse(text);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Settings) : null;
}

/** When `file` last changed, or 0 when it cannot be seen. */
function changedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The interface's settings, read again when a file changed. Each change that read well is told to the listeners. */
function createSettings(files: ReadonlyArray<string>) {
  const listeners = new Set<(what: string) => void>();
  let stamp = '';
  let current: Settings = {};
  function read(): Settings {
    const now = files.map(changedAt).join(':');
    if (now === stamp) return current;
    const [base = '', ...layers] = files;
    try {
      let merged = readObject(base) ?? {};
      for (const [index, file] of layers.entries()) {
        const layer = readObject(file);
        if (layer === null) continue;
        // The last layer is config.local.json, read with its keys of an old name under the new one, as the core reads it.
        merged = deepMerge(merged, index === layers.length - 1 ? moveConfigKeys(layer).config : layer) as Settings;
      }
      current = resolveEnvRefs(merged) as Settings;
    } catch (err) {
      if (stamp === '') throw err;
      log.warn('interface: settings not reloaded, keeping the previous ones', { error: err });
    }
    const first = stamp === '';
    stamp = now;
    if (!first) for (const listener of listeners) listener('config');
    return current;
  }
  return {
    read,
    onChange(listener: (what: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runInterface(argv: ReadonlyArray<string>): Promise<void> {
  const { name, interfacesDir } = parseRun(argv);
  const paths = resolvePaths({ rootDir: ROOT_DIR });
  const packageDir = path.join(interfacesDir, name);
  const pkg = await loadPackage(packageDir);
  const token = readToken(paths.privateDir, name);
  const socketPath = coreSocketPath(paths.dataDir);
  const settings = createSettings([
    path.join(paths.rootDir, 'config.json'),
    path.join(packageDir, 'config.json'),
    path.join(paths.privateDir, 'config.local.json'),
  ]);
  settings.read();

  let delays = 0;
  let stopping = false;
  let reconnecting = false;
  let lostEarly = false;
  let running: RunningInterface | null = null;
  const nextDelay = (): number => {
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** delays);
    delays = Math.min(delays + 1, 16);
    return ms;
  };

  function reconnect(): void {
    if (stopping || reconnecting) return;
    if (running === null) {
      lostEarly = true;
      return;
    }
    const again: (() => Promise<void>) | undefined = running.reconnect?.bind(running);
    if (again === undefined) {
      log.error('interface: link lost and the interface cannot reconnect, exiting for a restart', { name });
      process.exit(1);
    }
    reconnecting = true;
    const ms = nextDelay();
    log.info('interface: link lost, connecting again', { name, inMs: ms });
    setTimeout(() => {
      again()
        .catch((err: unknown) => log.warn('interface: reconnect failed', { name, error: err }))
        .finally(() => {
          reconnecting = false;
        });
    }, ms);
  }

  // A transport that this side closed (`closed`) was closed by the interface itself, on a reconnect or a stop.
  function watch(transport: Transport): void {
    const openedAt = Date.now();
    transport.onClose((reason) => {
      if (reason === 'closed' || stopping) return;
      if (Date.now() - openedAt >= STABLE_MS) delays = 0;
      reconnect();
    });
  }

  async function connect(): Promise<Transport> {
    for (;;) {
      if (stopping) throw new Error('the interface is stopping');
      try {
        const transport = await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES });
        watch(transport);
        return transport;
      } catch (err) {
        const ms = nextDelay();
        log.info('interface: core not reachable, trying again', {
          name,
          code: (err as NodeJS.ErrnoException).code ?? null,
          inMs: ms,
        });
        await sleep(ms);
      }
    }
  }

  const host: InterfaceHost = {
    connect,
    token,
    dataDir: path.join(paths.dataDir, 'interfaces', name),
    env: process.env,
    config: () => settings.read(),
    onConfigChange: (listener) => settings.onChange(listener),
    log,
  };

  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('interface: stopping', { name, signal });
    await running?.stop().catch((err: unknown) => log.warn('interface: stop failed', { name, error: err }));
    process.exit(0);
  }
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  running = await pkg.start(host);
  running.open();
  log.info('interface: running', { name, iface: running.iface });
  if (lostEarly) reconnect();
}

const [group] = process.argv.slice(2);
if (group !== 'interface') die(USAGE);
await runInterface(process.argv.slice(2)).catch((err: unknown) =>
  die(err instanceof Error ? err.message : String(err))
);
