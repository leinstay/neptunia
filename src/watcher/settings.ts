// The watcher's settings, read from a config at the moment of use: `watcher.dir` (src/watcher/read.ts) and
// `watcher.degradedAfterMinutes`, how long a route of the core may be down before the evidence lists it
// (src/watcher/routes.ts). The watcher runs only when the owner asks with `/doctor watcher run`, so it has no switch and no
// schedule.

import { objOf } from '../tools/types.ts';
import { watcherDir } from './read.ts';

/** Minutes a route may be down before the evidence lists it, when `watcher.degradedAfterMinutes` is unset. */
const DEFAULT_DEGRADED_AFTER_MINUTES = 60;

export type WatcherSettings = { dir: string; degradedAfterMinutes: number };

/** The watcher's settings of `config`. */
export function watcherSettings(config: unknown): WatcherSettings {
  const section = objOf(objOf(config).watcher);
  return {
    dir: watcherDir(config),
    degradedAfterMinutes:
      typeof section.degradedAfterMinutes === 'number' &&
      Number.isFinite(section.degradedAfterMinutes) &&
      section.degradedAfterMinutes >= 0
        ? section.degradedAfterMinutes
        : DEFAULT_DEGRADED_AFTER_MINUTES,
  };
}
