// The watcher step of `neptunia setup` (src/setup/run.ts, docs/setup.md): whether the deployment's watcher runs, the
// time of day of its daily run (`watcher.at`, UTC), the subharness backend it runs through and its model. The watcher
// is not one of the persona's mechanics, so it has a step of its own after hers (src/setup/mechanics.ts). The switch
// and the hour go into `<private>/config.local/config.json`, the backend and the model into keys.json
// (`subharness.uses.watcher`, `subharness.models.watcher`). On with no connected backend, or with a backend that is
// not connected, is `refused` and stored off. Nothing is written when no answer changes a value.

import { readConfig } from '../config.ts';
import { localConfigPath } from '../config/files.ts';
import { readKeys, writeKeys } from '../keys/file.ts';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';
import { watcherSettings } from '../watcher/settings.ts';
import { askHour, askSwitch } from './mechanics.ts';
import type { Ask } from './mechanics.ts';

export type WatcherStepDeps = { ask: Ask };
export type WatcherStepOutcome = { state: 'done' | 'already' | 'refused'; detail: string };

/** Writes `watcher.enabled` and `watcher.at` into the local config, every other key kept. */
function storeSettings(privateDir: string, enabled: boolean, at: string): void {
  const file = localConfigPath(privateDir);
  const local = setPath(setPath(readLocalConfig(file), ['watcher', 'enabled'], enabled), ['watcher', 'at'], at);
  writeLocalConfig(file, local);
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
    storeSettings(options.privateDir, false, settings.at);
    return { state: 'done', detail: 'the watcher is off' };
  }
  const at = await askHour(deps.ask, "The time of the watcher's daily run, HH:MM UTC:", settings.at);
  const { backends, uses, models } = readKeys(options.privateDir).subharness;
  const offeredBackend = uses.watcher ?? backends[0] ?? null;
  const backendAnswer = (await deps.ask('The subharness backend the watcher runs through:', offeredBackend)).trim();
  const named = backendAnswer === '' ? offeredBackend : backendAnswer;
  const backend: BackendName | undefined = BACKEND_NAMES.find((one) => one === named);
  if (backend === undefined || !backends.includes(backend)) {
    storeSettings(options.privateDir, false, at);
    const why =
      backends.length === 0
        ? 'no subharness backend is connected (setup subharness)'
        : `${named ?? 'no backend'} is not connected; connected: ${backends.join(', ')}`;
    return { state: 'refused', detail: `the watcher stays off: ${why}` };
  }
  const offeredModel = models.watcher ?? null;
  const modelAnswer = (
    await deps.ask('The model the watcher runs on (empty: the backend default):', offeredModel)
  ).trim();
  const model = modelAnswer === '' ? offeredModel : modelAnswer;
  const keysChanged = storeBackend(options.privateDir, backend, model);
  const settingsChanged = !settings.enabled || at !== settings.at;
  if (settingsChanged) storeSettings(options.privateDir, true, at);
  const detail = `the watcher runs daily at ${at} UTC through ${backend}${model === null ? '' : ` on ${model}`}`;
  return { state: keysChanged || settingsChanged ? 'done' : 'already', detail };
}
