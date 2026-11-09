// The watcher's settings, read from a config at the moment of use: `watcher.enabled` (on only when it is `true`),
// `watcher.schedule`, what its timer fires on (the default for anything that means nothing), and `watcher.dir`
// (src/watcher/read.ts). `neptunia services watcher` and `neptunia setup` write the first two, and the unit renderer
// (src/setup/install.ts) reads the schedule. `watcher.degradedAfterMinutes` is how long a route of the core may be down before the evidence lists it
// (src/watcher/routes.ts). A config that did not pass the loader's moves may still hold the old `watcher.at`.

import { isClockTime } from '../time.ts';
import { parseSchedule } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { objOf } from '../tools/types.ts';
import { watcherDir } from './read.ts';

/** The watcher's schedule when `watcher.schedule` is unset (config/config.json carries the same). */
export const DEFAULT_WATCHER_SCHEDULE: ServiceSchedule = { kind: 'at', at: ['00:00'] };

/** Minutes a route may be down before the evidence lists it, when `watcher.degradedAfterMinutes` is unset. */
const DEFAULT_DEGRADED_AFTER_MINUTES = 60;

export type WatcherSettings = {
  enabled: boolean;
  schedule: ServiceSchedule;
  dir: string;
  degradedAfterMinutes: number;
};

/** The watcher's settings of `config`. */
export function watcherSettings(config: unknown): WatcherSettings {
  const section = objOf(objOf(config).watcher);
  return {
    enabled: section.enabled === true,
    schedule:
      parseSchedule(section.schedule) ??
      (isClockTime(section.at) ? { kind: 'at', at: [section.at] } : DEFAULT_WATCHER_SCHEDULE),
    dir: watcherDir(config),
    degradedAfterMinutes:
      typeof section.degradedAfterMinutes === 'number' &&
      Number.isFinite(section.degradedAfterMinutes) &&
      section.degradedAfterMinutes >= 0
        ? section.degradedAfterMinutes
        : DEFAULT_DEGRADED_AFTER_MINUTES,
  };
}
