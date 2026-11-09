// The watcher step of `neptunia setup` (src/setup/run.ts, docs/setup.md): the subharness backend the watcher runs through
// and its model, beside the persona's routes in `<private>/config/config.json` (`models.agents.via.watcher`,
// `models.agents.model.watcher`, src/subharness/routing.ts). The watcher runs only when the owner asks with
// `/doctor watcher run`, so the step asks for no switch and no schedule. A backend that is not installed and logged in is
// `refused` and nothing is stored. Nothing is written when no answer changes a value.

import { readRouting, updateRouting } from '../subharness/routing.ts';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { availableSources } from '../subharness/sources.ts';
import type { Ask } from './mechanics.ts';

export type WatcherStepDeps = { ask: Ask };
export type WatcherStepOutcome = { state: 'done' | 'already' | 'refused'; detail: string };

/** Writes the watcher's backend and model into config.json when either differs; true when it wrote. */
function storeBackend(privateDir: string, backend: BackendName, model: string | null): boolean {
  const { uses, models } = readRouting(privateDir).subharness;
  if (uses.watcher === backend && (models.watcher ?? null) === model) return false;
  updateRouting(privateDir, (routing) => {
    const restModels = Object.fromEntries(
      Object.entries(routing.subharness.models).filter(([agent]) => agent !== 'watcher')
    );
    return {
      ...routing,
      subharness: {
        ...routing.subharness,
        uses: { ...routing.subharness.uses, watcher: backend },
        models: model === null ? restModels : { ...restModels, watcher: model },
      },
    };
  });
  return true;
}

export async function watcherStep(
  options: { rootDir: string; privateDir: string },
  deps: WatcherStepDeps
): Promise<WatcherStepOutcome> {
  const { uses, models } = readRouting(options.privateDir).subharness;
  const backends = await availableSources(options.privateDir);
  const offeredBackend = uses.watcher ?? backends[0] ?? null;
  const backendAnswer = (await deps.ask('The subharness backend the watcher runs through:', offeredBackend)).trim();
  const named = backendAnswer === '' ? offeredBackend : backendAnswer;
  const backend: BackendName | undefined = BACKEND_NAMES.find((one) => one === named);
  if (backend === undefined || !backends.includes(backend)) {
    const why =
      backends.length === 0
        ? 'no subharness source is logged in (neptunia subharness <backend> login)'
        : `${named ?? 'no backend'} is not logged in; logged in: ${backends.join(', ')}`;
    return { state: 'refused', detail: `the watcher has no backend: ${why}` };
  }
  const offeredModel = models.watcher ?? null;
  const modelAnswer = (
    await deps.ask('The model the watcher runs on (empty: the backend default):', offeredModel)
  ).trim();
  const model = modelAnswer === '' ? offeredModel : modelAnswer;
  const changed = storeBackend(options.privateDir, backend, model);
  const detail = `the watcher runs on /doctor watcher run through ${backend}${model === null ? '' : ` on ${model}`}`;
  return { state: changed ? 'done' : 'already', detail };
}
