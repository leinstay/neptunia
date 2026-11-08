// The rows that say what is off: the shape of the tool-availability rows of Hermes (hermes_cli/setup_summary.py: a name,
// whether it is available and a hint) that its doctor and its setup summary both print. Here the rows come from
// keys.json, the routing of config.json and the installed sources, and `neptunia doctor` carries them as one `features` check (bin/neptunia.ts). Reads only, creates nothing.

import { readRouting } from './routing.ts';
import { readKeys, hasExtraKey } from '../keys/file.ts';
import { availableSources } from './sources.ts';

/** One feature the owner switches on from the chat. */
export type FeatureRow = { name: 'subharness' | 'simulation'; available: boolean; hint: string | null };

/** The subharness and the simulation: available when on, else the command that turns the feature on. */
export async function featureRows(privateDir: string): Promise<Array<FeatureRow>> {
  const store = readKeys(privateDir);
  const subharnessOn = (await availableSources(privateDir)).length > 0;
  const simulationKey = readRouting(privateDir).simulation.key;
  const simulationOn = simulationKey !== null && hasExtraKey(store, simulationKey);
  return [
    {
      name: 'subharness',
      available: subharnessOn,
      hint: subharnessOn ? null : 'neptunia subharness codex|claude|opencode login',
    },
    {
      name: 'simulation',
      available: simulationOn,
      hint: simulationOn
        ? null
        : simulationKey === null
          ? 'simulation enable --key <name>'
          : `the key ${simulationKey} left the store: simulation enable --key <name>`,
    },
  ];
}
