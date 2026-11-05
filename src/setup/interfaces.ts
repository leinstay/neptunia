// The interfaces step of `neptunia setup` (src/setup/run.ts): every interface package that declares a `setup.json`,
// shipped or authored under `data/interfaces/`, is offered in turn. A yes asks the package's own questions through its
// contract (src/setup/modules.ts) and, with every required value stored, enables it (`interfaces.<name>.enabled`). The
// core knows no question of any platform. A no changes nothing, and an interface can come later through `/interfaces`.
//
// On a clean install `interfaces.mode` becomes `units`: the step registers the interface's client, writes its private
// token, and starts its instance `neptunia-interface@<name>.service` through the scope's manager, with no core running. A
// repeat keeps a valid token and the client as they are. A deployment that already runs its interfaces inside the core
// (`inprocess`, said outright or implied by an interface already enabled) stays that way, with no client and no unit.
// `running` names only the instances the manager accepted.

import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../config/files.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';
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

function packagesIn(dir: string): Array<string> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'setup.json')))
    .map((entry) => entry.name);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Where the interfaces of this deployment run; null on a clean install, which has not said. */
function modeInForce(dataDir: string): string | null {
  const { interfaces } = readLocalConfig(localConfigPath(dataDir));
  if (!isObject(interfaces)) return null;
  if (typeof interfaces.mode === 'string') return interfaces.mode;
  return Object.values(interfaces).some((one) => isObject(one) && one.enabled === true) ? 'inprocess' : null;
}

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
  const names = new Set([
    ...packagesIn(path.join(rootDir, 'interfaces')),
    ...packagesIn(path.join(dataDir, 'interfaces')),
  ]);
  const mode = modeInForce(dataDir);
  const changed: Array<string> = [];
  const running: Array<string> = [];
  let prepared = false;
  for (const name of [...names].sort()) {
    const { complete, changed: isChanged } = await offer({ rootDir, dataDir, kind: 'interface', name }, deps);
    if (isChanged) changed.push(name);
    if (!complete) continue;
    if (mode === null) {
      const file = localConfigPath(dataDir);
      writeLocalConfig(file, setPath(readLocalConfig(file), ['interfaces', 'mode'], 'units'));
    }
    if (mode !== null && mode !== 'units') continue;
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
