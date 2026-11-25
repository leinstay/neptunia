// The entry point resolves the engine and persona data roots and starts the core. The interfaces run as their own units
// and connect to the core's socket (`neptunia interface run <name>`), so the core starts with none of its own.
// The entry owns process signals, startup failure and clean shutdown. Platform SDKs stay in interface packages.

import { ROOT_DIR, env } from './config.ts';
import { startCore } from './core.ts';
import { log } from './log.ts';
import { guardProcessErrors } from './process-errors.ts';
import { resolvePaths } from './paths.ts';

/** Print a one-line, secret-free error and terminate with a non-zero exit code. */
function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// The directories, resolved once (src/paths.ts): the checkout and the data directory
// (NEPTUNIA_DATA_DIR). The variable comes from the process environment (the unit file).
const paths = resolvePaths({ rootDir: ROOT_DIR });

const starting = startCore({ paths, env, interfaces: [] });

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
