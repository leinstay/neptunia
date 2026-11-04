// The entry point resolves the engine and persona data roots, selects the interface mode and starts the core.
// In-process interfaces load the selected personal or engine package and receive only their platform credential.
// The entry owns process signals, startup failure and clean shutdown. Platform SDKs stay in interface packages.

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR, env, readConfig, interfaceLaunch } from './config.ts';
import { startCore } from './core.ts';
import { interfaceMode } from './interface/mode.ts';
import { log } from './log.ts';
import { guardProcessErrors } from './process-errors.ts';
import { resolvePaths } from './paths.ts';
import type { InterfaceMode } from './interface/mode.ts';

/** An interface as the core takes it. */
type CoreInterface = Parameters<typeof startCore>[0]['interfaces'][number];

/** Print a one-line, secret-free error and terminate with a non-zero exit code. */
function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// The three directories, resolved once (src/paths.ts): the checkout, the private layer
// (NEPTUNIA_PRIVATE_DIR: config.local/, prompts.local/, .env) and the data directory
// (NEPTUNIA_DATA_DIR). The two variables come from the process environment (the unit file), never
// from .env, whose own place depends on them.
const paths = resolvePaths({ rootDir: ROOT_DIR });

// Where the interfaces run, read once: the mode decides what this process is.
let mode: InterfaceMode = 'inprocess';
try {
  mode = interfaceMode(readConfig(paths.rootDir, { privateDir: paths.privateDir }));
} catch (err) {
  die(`index: ${err instanceof Error ? err.message : String(err)}`);
}

/** The Discord interface started in this process, as the core takes it. */
async function inProcessDiscord() {
  // Handed to the Discord interface at its start, which logs in with it. Never logged.
  const { token: discordToken, packageDir: folder } = interfaceLaunch({ ...paths, name: 'discord' });
  if (discordToken === null) die('index: missing Discord token in data/interfaces/discord/credentials.json.');

  // The interface is loaded by name at run time.
  const entry = ['index.ts', 'index.js'].map((name) => path.join(folder, name)).find((file) => fs.existsSync(file));
  if (!entry) die('index: Discord package entry is unavailable');
  const loaded: unknown = await import(pathToFileURL(entry).href);
  // The package is found by path at run time, so its shape is the one the core declares for an interface's `start`.
  const discordPackage = loaded as Pick<CoreInterface, 'start'>;
  return {
    name: 'discord',
    // The core's host carries no keys: the Discord token is the entry's to hand over.
    start: (host: Parameters<CoreInterface['start']>[0]) =>
      discordPackage.start({ ...host, env: { DISCORD_TOKEN: discordToken } }),
  };
}

const starting = startCore({
  paths,
  env,
  interfaces: mode === 'units' ? [] : [await inProcessDiscord()],
});

// A signal during the start waits for it: the core stops once it exists.
const stopOnSignal = (signal: string) => {
  starting
    .then((core) => core.stop(signal))
    .catch((err: unknown) => log.warn('index: stop failed', { error: err }))
    .finally(() => process.exit(0));
};
process.on('SIGINT', () => stopOnSignal('SIGINT'));
process.on('SIGTERM', () => stopOnSignal('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('index: unhandled rejection', { error: err }));
guardProcessErrors(log);

await starting.catch((err) => die(err instanceof Error ? err.message : String(err)));
