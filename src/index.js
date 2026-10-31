// Entry point: reads the paths and the private layer's .env, decides from `interfaces.mode` (src/interface/mode.ts)
// where the interfaces run, hands them to `startCore` (src/core.js) and owns the process: the signal handlers, the
// exit code of a failed start and the exit after a clean stop. With `inprocess` it loads the Discord interface
// (interfaces/discord/, by path at run time, so nothing here imports discord.js) and the core starts it. With `units`
// the core starts with no interface and each one runs in its own unit (bin/neptunia.ts), so no Discord token is
// read here. Nothing else lives here: the core is built and stopped by `startCore`, and the Discord side is built by
// the interface.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR, env, loadDotEnv, readConfig } from './config.js';
import { startCore } from './core.js';
import { interfaceMode } from './interface/mode.ts';
import { log } from './log.js';
import { resolvePaths } from './paths.js';

/** Print a one-line, secret-free error and terminate with a non-zero exit code. */
function die(message) {
  console.error(message);
  process.exit(1);
}

// The three directories, resolved once (src/paths.js): the checkout, the private layer
// (NEPTUNIA_PRIVATE_DIR: config.local.json, prompts.local/, .env) and the data directory
// (NEPTUNIA_DATA_DIR). The two variables come from the process environment (the unit file), never
// from .env, whose own place depends on them.
const paths = resolvePaths({ rootDir: ROOT_DIR });
loadDotEnv(paths.privateDir);

// Where the interfaces run, read once: the mode decides what this process is.
/** @type {import('./interface/mode.ts').InterfaceMode} */
let mode = 'inprocess';
try {
  mode = interfaceMode(readConfig(paths.rootDir, { privateDir: paths.privateDir }));
} catch (err) {
  die(`index: ${err instanceof Error ? err.message : String(err)}`);
}

/** The Discord interface started in this process, as the core takes it. */
async function inProcessDiscord() {
  // Handed to the Discord interface at its start, which logs in with it. Never logged.
  const discordToken = env.DISCORD_TOKEN;
  if (discordToken === undefined || discordToken === '')
    die(
      'index: missing required environment variable DISCORD_TOKEN — copy .env.example to .env and fill in the real values.'
    );

  // The interface is loaded by name at run time.
  const loaded = /** @type {unknown} */ (
    await import(pathToFileURL(path.join(paths.rootDir, 'interfaces', 'discord', 'index.js')).href)
  );
  const discordPackage =
    /** @type {{ start(host: import('./protocol/host.ts').InterfaceHost): Promise<import('./protocol/host.ts').RunningInterface> }} */ (
      loaded
    );
  return {
    name: 'discord',
    // The core's host carries no keys: the Discord token is the entry's to hand over.
    start: (/** @type {import('./protocol/host.ts').InterfaceHost} */ host) =>
      discordPackage.start({ ...host, env: { DISCORD_TOKEN: discordToken } }),
  };
}

const starting = startCore({
  paths,
  env,
  interfaces: mode === 'units' ? [] : [await inProcessDiscord()],
});

// A signal during the start waits for it: the core stops once it exists.
const stopOnSignal = (/** @type {string} */ signal) => {
  starting
    .then((core) => core.stop(signal))
    .catch((/** @type {unknown} */ err) => log.warn('index: stop failed', { error: err }))
    .finally(() => process.exit(0));
};
process.on('SIGINT', () => stopOnSignal('SIGINT'));
process.on('SIGTERM', () => stopOnSignal('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('index: unhandled rejection', { error: err }));

await starting.catch((err) => die(err instanceof Error ? err.message : String(err)));
