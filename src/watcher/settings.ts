// The watcher's settings, read from a config at the moment of use: `watcher.enabled` (on only when it is `true`),
// `watcher.schedule`, what its timer fires on (the default for anything that means nothing), and `watcher.dir`
// (src/watcher/read.ts). `neptunia service watcher` and `neptunia setup` write the first two, the unit renderer
// (src/setup/install.ts) reads the schedule, and the report in her selfimprovement wake (src/watcher/news.ts) reads the
// switch. A config that did not pass the loader's moves may still hold the old `watcher.at`.

import { isClockTime } from '../time.ts';
import { parseSchedule } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { objOf } from '../tools/types.ts';
import { watcherDir } from './read.ts';

/** The watcher's schedule when `watcher.schedule` is unset (config/config.json carries the same). */
export const DEFAULT_WATCHER_SCHEDULE: ServiceSchedule = { kind: 'at', at: ['00:00'] };

export type WatcherSettings = { enabled: boolean; schedule: ServiceSchedule; dir: string };

/** The watcher's settings of `config`. */
export function watcherSettings(config: unknown): WatcherSettings {
  const section = objOf(objOf(config).watcher);
  return {
    enabled: section.enabled === true,
    schedule:
      parseSchedule(section.schedule) ??
      (isClockTime(section.at) ? { kind: 'at', at: [section.at] } : DEFAULT_WATCHER_SCHEDULE),
    dir: watcherDir(config),
  };
}
