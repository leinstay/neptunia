// The settings schema of `selfimprovement` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SELFIMPROVEMENT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'selfimprovement.enabled',
    'types': ['boolean'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': true,
    'text':
      'Whether the selfimprovement wake falls due and the beat of `neptunia selfimprovement run` works. Off, neither starts',
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
      'The absolute path of the dev checkout that `neptunia setup` renders `neptunia-selfimprovement.service` and its timer over, so the beat works there. Setup renders no selfimprovement units while it is unset, relative or the deployed checkout itself',
  },
  {
    'key': 'selfimprovement.repository',
    'types': ['string', 'null'],
    'reader': 'src/selfimprovement/settings.ts',
    'default': null,
    'text':
      'The repository her pull requests open against and her branches are pushed to, as `owner/name`. `neptunia setup` asks for it and stores it only when her gh login can push there. While it is unset every selfimprovement beat pauses',
  },
  {
    'key': 'selfimprovement.at',
    'types': ['string'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': '03:00',
    'text':
      "The time of the daily selfimprovement wake, `HH:MM` of the UTC day, after the watcher's run so the wake carries its report. `neptunia setup` asks for it, and a value that is no `HH:MM` reads as the default",
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
