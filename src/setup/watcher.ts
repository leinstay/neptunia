// The watcher step of `neptunia setup` (src/setup/run.ts, docs/setup.md): whether the deployment's watcher runs, the
// schedule of its runs (`watcher.schedule`, UTC), the subharness backend it runs through and its model. The watcher
// is not one of the persona's mechanics, so it has a step of its own after hers (src/setup/mechanics.ts). The switch
// and the schedule go into `<private>/config.local/config.json`, the backend and the model into keys.json
// (`subharness.uses.watcher`, `subharness.models.watcher`). On with no source that is installed and logged in, or with
// a backend that is not one, is `refused` and stored off. Nothing is written when no answer changes a value.

import { readConfig } from '../config.ts';
import { readKeys, writeKeys } from '../keys/file.ts';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { availableSources } from '../subharness/sources.ts';
import { updateLocalSettings } from '../service/local-settings.ts';
import { formatSchedule } from '../service/schedule.ts';
import type { ServiceSchedule } from '../service/schedule.ts';
import { setPath } from '../tools/operations/shared.ts';
import { watcherSettings } from '../watcher/settings.ts';
import { askSchedule, askSwitch } from './mechanics.ts';
import type { Ask } from './mechanics.ts';

export type WatcherStepDeps = { ask: Ask };
export type WatcherStepOutcome = { state: 'done' | 'already' | 'refused'; detail: string };

/** Writes `watcher.enabled` and `watcher.schedule` into the local config, every other key kept. */
function storeSettings(privateDir: string, enabled: boolean, schedule: ServiceSchedule): void {
  updateLocalSettings(privateDir, (local) =>
    setPath(setPath(local, ['watcher', 'enabled'], enabled), ['watcher', 'schedule'], formatSchedule(schedule))
  );
}

/** Writes the watcher's backend and model into keys.json when either differs; true when it wrote. */
function storeBackend(privateDir: string, backend: BackendName, model: string | null): boolean {
  const keys = readKeys(privateDir);
  const { uses, models } = keys.subharness;
  if (uses.watcher === backend && (models.watcher ?? null) === model) return false;
  const restModels = Object.fromEntries(Object.entries(models).filter(([agent]) => agent !== 'watcher'));
  writeKeys(privateDir, {
    ...keys,
    subharness: {
      ...keys.subharness,
      uses: { ...uses, watcher: backend },
      models: model === null ? restModels : { ...restModels, watcher: model },
    },
  });
  return true;
}

export async function watcherStep(
  options: { rootDir: string; privateDir: string },
  deps: WatcherStepDeps
): Promise<WatcherStepOutcome> {
  const settings = watcherSettings(readConfig(options.rootDir, { privateDir: options.privateDir }));
  const enabled = await askSwitch(
    deps.ask,
    "The watcher: a daily agent that reads the deployment's logs and writes the owner a report (on or off):",
    settings.enabled
  );
  if (!enabled) {
    if (!settings.enabled) return { state: 'already', detail: 'the watcher is off' };
    storeSettings(options.privateDir, false, settings.schedule);
    return { state: 'done', detail: 'the watcher is off' };
  }
  const schedule = await askSchedule(
    deps.ask,
    "The schedule of the watcher's runs, UTC (at 00:00,12:00 or every 6h):",
    settings.schedule
  );
  const { uses, models } = readKeys(options.privateDir).subharness;
  const backends = await availableSources(options.privateDir);
  const offeredBackend = uses.watcher ?? backends[0] ?? null;
  const backendAnswer = (await deps.ask('The subharness backend the watcher runs through:', offeredBackend)).trim();
  const named = backendAnswer === '' ? offeredBackend : backendAnswer;
  const backend: BackendName | undefined = BACKEND_NAMES.find((one) => one === named);
  if (backend === undefined || !backends.includes(backend)) {
    storeSettings(options.privateDir, false, schedule);
    const why =
      backends.length === 0
        ? 'no subharness source is logged in (neptunia subharness <backend> login)'
        : `${named ?? 'no backend'} is not logged in; logged in: ${backends.join(', ')}`;
    return { state: 'refused', detail: `the watcher stays off: ${why}` };
  }
  const offeredModel = models.watcher ?? null;
  const modelAnswer = (
    await deps.ask('The model the watcher runs on (empty: the backend default):', offeredModel)
  ).trim();
  const model = modelAnswer === '' ? offeredModel : modelAnswer;
  const keysChanged = storeBackend(options.privateDir, backend, model);
  const settingsChanged = !settings.enabled || formatSchedule(schedule) !== formatSchedule(settings.schedule);
  if (settingsChanged) storeSettings(options.privateDir, true, schedule);
  const detail = `the watcher runs ${formatSchedule(schedule)} UTC through ${backend}${model === null ? '' : ` on ${model}`}`;
  return { state: keysChanged || settingsChanged ? 'done' : 'already', detail };
}
