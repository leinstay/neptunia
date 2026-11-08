// Node's compile cache for the owner's commands: the `neptunia` entry (bin/neptunia-launch.ts) names the folder before
// it loads the engine, so the second command and every one after it reuse the compiled modules instead of stripping the
// types of the engine again. A cache named already, as a unit's `NODE_COMPILE_CACHE` (src/setup/units.ts), stays. The
// folder is the one a user unit gets from systemd: `$XDG_CACHE_HOME/neptunia-compile`, else `~/.cache/neptunia-compile`.
// The variable is set too, so the processes the command starts use the same folder.

import module from 'node:module';
import path from 'node:path';

/** The folder of the cache the owner's commands share. */
export const COMPILE_CACHE_NAME = 'neptunia-compile';

/** Names the cache in `env` when it names none, and turns it on for this process. A folder that cannot be made is no error. */
export function useCompileCache(env: NodeJS.ProcessEnv, home: string): void {
  if (env.NODE_COMPILE_CACHE !== undefined && env.NODE_COMPILE_CACHE !== '') return;
  const root =
    env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== '' ? env.XDG_CACHE_HOME : path.join(home, '.cache');
  const dir = path.join(root, COMPILE_CACHE_NAME);
  env.NODE_COMPILE_CACHE = dir;
  module.enableCompileCache(dir);
}
