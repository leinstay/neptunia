// The interfaces step of `neptunia setup` (src/setup/run.ts): every interface package that declares a `setup.json`,
// shipped or authored under `data/interfaces/`, is offered in turn. A yes asks the package's own questions through its
// contract (src/setup/modules.ts) and, with every required value stored, enables it (`interfaces.<name>.enabled`). The
// core knows no question of any platform. A no changes nothing, and an interface can come later through `/interfaces`.

import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../config/files.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/impl/shared.ts';
import { moduleValues, readModuleSettings, walkModuleSetup } from './modules.ts';
import type { ModuleRef } from './modules.ts';

export type InterfacesStepDeps = {
  ask: (question: string, offered: string | null, options?: { secret: boolean }) => Promise<string>;
};
type Where = { rootDir: string; dataDir: string };

function packagesIn(dir: string): Array<string> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'setup.json')))
    .map((entry) => entry.name);
}

async function offer(ref: ModuleRef, { ask }: InterfacesStepDeps): Promise<'skipped' | 'unchanged' | 'changed'> {
  const settings = readModuleSettings(ref);
  if (settings === null) return 'skipped';
  const answer = (await ask(`Set up the ${ref.name} interface? (yes or no)`, 'no')).trim().toLowerCase();
  if (answer !== 'yes' && answer !== 'y') return 'skipped';
  const before = JSON.stringify(moduleValues(ref, settings));
  const { missing } = await walkModuleSetup(ref, settings, (setting, current) =>
    ask(setting.question, setting.kind === 'secret' ? null : current, { secret: setting.kind === 'secret' })
  );
  if (missing.length === 0) {
    const file = localConfigPath(ref.dataDir);
    writeLocalConfig(file, setPath(readLocalConfig(file), ['interfaces', ref.name, 'enabled'], true));
  }
  return JSON.stringify(moduleValues(ref, settings)) === before ? 'unchanged' : 'changed';
}

export async function interfacesStep(
  { rootDir, dataDir }: Where,
  deps: InterfacesStepDeps
): Promise<{ state: 'done' | 'already'; detail: string }> {
  const names = new Set([
    ...packagesIn(path.join(rootDir, 'interfaces')),
    ...packagesIn(path.join(dataDir, 'interfaces')),
  ]);
  const changed: Array<string> = [];
  for (const name of [...names].sort()) {
    if ((await offer({ rootDir, dataDir, kind: 'interface', name }, deps)) === 'changed') changed.push(name);
  }
  return changed.length === 0
    ? { state: 'already', detail: 'no interface setting changed' }
    : { state: 'done', detail: `set up ${changed.join(', ')}` };
}
