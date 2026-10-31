// Where a deployment's private material lives, resolved once at start. The checkout holds the
// public engine; a deployment may keep its own layers apart from it, so that a checkout, a
// worktree or a deploy never carries them:
//   NEPTUNIA_PRIVATE_DIR  config.local/, prompts.local/ and .env (default: the checkout root)
//   NEPTUNIA_DATA_DIR     everything the engine writes (default: <checkout root>/data)
// Both are optional; with neither set every path is the one the engine always used. This module
// is the single place that knows the two names: src/index.js and the tools (tools/lib/cli.mjs)
// read them through `resolvePaths`.

import path from 'node:path';

/** The variable naming the directory of config.local/, prompts.local/ and .env. */
export const PRIVATE_DIR_VAR = 'NEPTUNIA_PRIVATE_DIR';
/** The variable naming the directory everything the engine writes goes under. */
export const DATA_DIR_VAR = 'NEPTUNIA_DATA_DIR';

/** `env[name]` trimmed, or null when it is unset or blank (a blank value counts as unset). */
function setValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The three directories of a deployment, every one absolute: `rootDir` (the checkout: config/,
 * prompts/), `privateDir` (`NEPTUNIA_PRIVATE_DIR` when set, else `rootDir`) and `dataDir`
 * (`NEPTUNIA_DATA_DIR` when set, else `<rootDir>/data`). A relative value is resolved against
 * `rootDir`, never against the process's working directory. Pure: `env` is only read.
 * @param {{ rootDir: string, env?: Record<string, string | undefined> }} options
 * @returns {{ rootDir: string, privateDir: string, dataDir: string }}
 */
export function resolvePaths({ rootDir, env = process.env }) {
  const root = path.resolve(rootDir);
  const privateValue = setValue(env, PRIVATE_DIR_VAR);
  const dataValue = setValue(env, DATA_DIR_VAR);
  return {
    rootDir: root,
    privateDir: privateValue ? path.resolve(root, privateValue) : root,
    dataDir: dataValue ? path.resolve(root, dataValue) : path.join(root, 'data'),
  };
}
