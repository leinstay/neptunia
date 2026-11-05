// The settings schema of `selfimprovement` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SELFIMPROVEMENT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'selfimprovement.enabled',
    'types': ['boolean'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': true,
    'text':
      'Whether the selfimprovement wake falls due. A task already filed goes on, because the development worker depends on the board alone',
  },
  {
    'key': 'selfimprovement.mode',
    'types': ['string'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': 'approve',
    'text':
      'Who merges a pull request she opened for her own code: `approve` waits for the owner once CI is green, `auto` has the engine merge it when CI is green',
  },
  {
    'key': 'selfimprovement.base',
    'types': ['string'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': 'main',
    'text': 'The branch her worktrees start from and her pull requests target',
  },
  {
    'key': 'selfimprovement.checkout',
    'types': ['string', 'null'],
    'reader': 'src/setup/run.ts',
    'default': null,
    'text':
      "The absolute path of the dev checkout the development worker works on: its working repository, with one worktree per task under `.worktrees/`. The worker's own code runs from the install. Setup renders no development unit while it is unset, relative or the deployed checkout itself",
  },
  {
    'key': 'selfimprovement.repository',
    'types': ['string', 'null'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': null,
    'text':
      "The repository her pull requests open against and her branches are pushed to, as `owner/name`. `neptunia setup` asks for it and stores it only when the system's gh login can push there, so someone else's installation names a fork. While it is unset a filed task blocks with that reason",
  },
  {
    'key': 'selfimprovement.schedule',
    'types': ['string'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 'at 03:00',
    'text':
      "When the selfimprovement wake falls due: daily UTC times such as `at 03:00` or `every 6h`, after the watcher's run so the wake carries its report. `neptunia service selfimprovement setup` writes it, and a value that means nothing reads as the default",
  },
  {
    'key': 'selfimprovement.failuresPerShape',
    'types': ['number'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 3,
    'text': 'How many chains of one shape must fail in a UTC day to raise a selfimprovement wake with that cause',
  },
  {
    'key': 'selfimprovement.tools',
    'types': ['string', 'array'],
    'reader': 'src/tools/access.ts',
    'default': '*',
    'text': 'The tools a selfimprovement wake may call: `"*"` for every granted tool or a list of tool names',
  },
  {
    'key': 'selfimprovement.maxActs',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most actions a selfimprovement wake may take; null: no cap',
  },
  {
    'key': 'selfimprovement.maxTasks',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most errands a selfimprovement wake may start; null: no cap',
  },
  {
    'key': 'selfimprovement.inputTokens',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The input token budget of a selfimprovement wake; null: the loop budget',
  },
];
