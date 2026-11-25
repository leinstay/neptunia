// The interfaces step of `neptunia setup` (src/setup/run.ts): every interface package that declares a `setup.json`,
// shipped or authored under `data/interfaces/`, is offered in turn. A yes asks the package's own questions through its
// contract (src/setup/modules.ts) and, with every required value stored, enables it (`interfaces.<name>.enabled`). The
// core knows no question of any platform. A no changes nothing, and an interface can come later through `/interfaces`.
//
// The step registers the interface's client, writes its private token, and starts its instance
// `neptunia-interface@<name>.service` through the scope's manager, with no core running. A repeat keeps a valid token
// and the client as they are. `running` names only the instances the manager accepted.

import { interfacePackageNames, localConfigPath } from '../config/files.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/operations/shared.ts';
import { provisionInterfaceClient } from './clients.ts';
import { systemctlOf, whyFailed } from './install.ts';
import type { RunResult } from './install.ts';
import { moduleValues, readModuleSettings, walkModuleSetup } from './modules.ts';
import type { ModuleRef } from './modules.ts';

export type InterfacesStepDeps = {
  ask: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
  run: (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;
  /** Puts the unit template in place before the first start; the reason when it could not. */
  prepareUnits?: () => Promise<string | null>;
};
type Where = { rootDir: string; dataDir: string; system: boolean };
export type InterfacesStepOutcome = { state: 'done' | 'already' | 'failed'; detail: string; running: Array<string> };

type Offer = { complete: boolean; changed: boolean };

async function offer(ref: ModuleRef, { ask }: InterfacesStepDeps): Promise<Offer> {
  const settings = readModuleSettings(ref);
  if (settings === null) return { complete: false, changed: false };
  const answer = (await ask(`Set up the ${ref.name} interface? (yes or no)`, 'no')).trim().toLowerCase();
  if (answer !== 'yes' && answer !== 'y') return { complete: false, changed: false };
  const before = JSON.stringify(moduleValues(ref, settings));
  const { missing } = await walkModuleSetup(ref, settings, (setting, current) =>
    ask(setting.question, setting.kind === 'secret' ? null : current, { secret: setting.kind === 'secret' })
  );
  const complete = missing.length === 0;
  if (complete) {
    const file = localConfigPath(ref.dataDir);
    writeLocalConfig(file, setPath(readLocalConfig(file), ['interfaces', ref.name, 'enabled'], true));
  }
  return { complete, changed: JSON.stringify(moduleValues(ref, settings)) !== before };
}

/** Registers the client and starts its instance; why the manager refused, or null. */
async function startInstance(
  name: string,
  { dataDir, system }: Where,
  deps: InterfacesStepDeps
): Promise<string | null> {
  provisionInterfaceClient(dataDir, name);
  const [command, args] = systemctlOf({ system }, 'enable', '--now', `neptunia-interface@${name}.service`);
  try {
    const done = await deps.run(command, args);
    return done.code === 0 ? null : whyFailed(done);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'the manager could not run';
  }
}

export async function interfacesStep(where: Where, deps: InterfacesStepDeps): Promise<InterfacesStepOutcome> {
  const { rootDir, dataDir } = where;
  const changed: Array<string> = [];
  const running: Array<string> = [];
  let prepared = false;
  for (const name of interfacePackageNames(rootDir, dataDir)) {
    const { complete, changed: isChanged } = await offer({ rootDir, dataDir, kind: 'interface', name }, deps);
    if (isChanged) changed.push(name);
    if (!complete) continue;
    if (!prepared) {
      const why = (await deps.prepareUnits?.()) ?? null;
      if (why !== null) return { state: 'failed', detail: `the units of ${name}: ${why}`, running };
      prepared = true;
    }
    const refused = await startInstance(name, where, deps);
    if (refused !== null) return { state: 'failed', detail: `${name} did not start: ${refused}`, running };
    running.push(name);
  }
  const shown = running.length === 0 ? '' : `; running: ${running.join(', ')}`;
  return changed.length === 0
    ? { state: 'already', detail: `no interface setting changed${shown}`, running }
    : { state: 'done', detail: `set up ${changed.join(', ')}${shown}`, running };
}
