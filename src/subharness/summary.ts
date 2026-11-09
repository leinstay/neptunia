// The rows that say what is off: the shape of the tool-availability rows of Hermes (hermes_cli/setup_summary.py: a name,
// whether it is available and a hint) that its doctor and its setup summary both print. Here the row comes from the
// installed sources, and `neptunia doctor` carries it as the `features` check (bin/neptunia.ts). Reads only, creates
// nothing.

import { availableSources } from './sources.ts';

/** One feature the owner switches on from the chat. */
export type FeatureRow = { name: 'subharness'; available: boolean; hint: string | null };

/** The subharness: available when a source can run, else the command that logs one in. */
export async function featureRows(privateDir: string): Promise<Array<FeatureRow>> {
  const subharnessOn = (await availableSources(privateDir)).length > 0;
  return [
    {
      name: 'subharness',
      available: subharnessOn,
      hint: subharnessOn ? null : 'neptunia subharness codex|claude|opencode login',
    },
  ];
}
