// The watcher's settings, read from a config at the moment of use: `watcher.enabled` (on only when it is `true`),
// `watcher.at`, the time of the UTC day its timer fires (`HH:MM`, the default for anything else), and `watcher.dir`
// (src/watcher/read.ts). `neptunia setup` (src/setup/watcher.ts) writes the first two, the unit renderer
// (src/setup/install.ts) reads the hour, and the report in her selfimprovement wake (src/watcher/news.ts) reads the switch.

import { isClockTime } from '../time.ts';
import { objOf } from '../tools/types.ts';
import { watcherDir } from './read.ts';

/** The time of day of the watcher's run when `watcher.at` is unset (config/config.json carries the same). */
export const DEFAULT_WATCHER_AT = '00:00';

export type WatcherSettings = { enabled: boolean; at: string; dir: string };

/** The watcher's settings of `config`. */
export function watcherSettings(config: unknown): WatcherSettings {
  const section = objOf(objOf(config).watcher);
  return {
    enabled: section.enabled === true,
    at: isClockTime(section.at) ? section.at : DEFAULT_WATCHER_AT,
    dir: watcherDir(config),
  };
}
