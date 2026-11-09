// Resolve the engine checkout and its one persona data root. NEPTUNIA_DATA_DIR selects the persona directory,
// defaulting to <root>/data. privateDir is its compatibility alias; a different legacy selection requires migration.

import path from 'node:path';
// A parsed JSON value or an argument no module types yet: the alias of src/tools/types.ts, restated so this leaf
// imports nothing from src/tools/ (src/memory/ reaches it).
type Untyped = ReturnType<typeof JSON.parse>;

/** The legacy alias of the persona data root; a conflicting value is refused. */
export const PRIVATE_DIR_VAR = 'NEPTUNIA_PRIVATE_DIR';
/** The variable naming the directory everything the engine writes goes under. */
export const DATA_DIR_VAR = 'NEPTUNIA_DATA_DIR';

/** `env[name]` trimmed, or null when it is unset or blank (a blank value counts as unset). */
function setValue(env: Untyped, name: string) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Absolute engine and persona paths. Relative selections resolve against the engine root. */
export function resolvePaths({
  rootDir,
  env = process.env,
}: {
  rootDir: string;
  env?: Record<string, string | undefined>;
}): { rootDir: string; privateDir: string; dataDir: string } {
  const root = path.resolve(rootDir);
  const privateValue = setValue(env, PRIVATE_DIR_VAR);
  const dataValue = setValue(env, DATA_DIR_VAR);
  const data = dataValue ? path.resolve(root, dataValue) : path.join(root, 'data');
  if (privateValue && path.resolve(root, privateValue) !== data)
    throw new Error('NEPTUNIA_PRIVATE_DIR must match NEPTUNIA_DATA_DIR');
  return { rootDir: root, privateDir: data, dataDir: data };
}
