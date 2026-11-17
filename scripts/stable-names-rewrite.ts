// Rewrites what a deployment stored before stable names to `:e23:`, gives its emoji and stickers their stable names and
// links each line to the emoji its text names (src/memory/db/stable-names-rewrite.ts). Run once per deployment, with the
// core stopped, after a backup.
//
//   node scripts/stable-names-rewrite.ts --data <folder>            dry run: counts only, nothing written
//   node scripts/stable-names-rewrite.ts --data <folder> --apply    writes the plan through the memory writer
//   --choose <platformName>=<platformId>                            ties a name two emoji hold to one of them; repeatable
//
// The core's own start check refuses the run while an engine holds the folder. Output holds counts and names of kinds.

import fs from 'node:fs';
import path from 'node:path';
import { claimCore, openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { planStableNamesRewrite } from '../src/memory/db/stable-names-rewrite.ts';
import type { StableNamesPlan } from '../src/memory/db/stable-names-rewrite.ts';
import { dbOf } from '../src/memory/db/types.ts';

function print(plan: StableNamesPlan): void {
  const { counts } = plan;
  console.log(`lines to rewrite: ${counts.lines}`);
  console.log(`tokens to rewrite: ${counts.tokens}`);
  console.log(`media rows to rename: ${counts.media}`);
  for (const key of Object.keys(counts.issue).sort()) console.log(`names to issue, ${key}: ${counts.issue[key]}`);
  console.log(`lines not tied: ${counts.untied}`);
  for (const table of Object.keys(counts.tables).sort())
    console.log(`rows to change, ${table}: ${counts.tables[table]}`);
  console.log(`left, a name two emoji hold: ${counts.left.sharedName}`);
  console.log(`left, a sticker reference of a line that links no one sticker: ${counts.left.unlinkedSticker}`);
}

/** The `--choose <platformName>=<platformId>` arguments as one choice. */
function choiceOf(args: ReadonlyArray<string>): Record<string, string> {
  const choose: Record<string, string> = {};
  args.forEach((arg, at) => {
    if (arg !== '--choose') return;
    const [name, id] = (args[at + 1] ?? '').split('=');
    if (!name || !id) {
      console.error('usage: --choose <platformName>=<platformId>');
      process.exit(2);
    }
    choose[name] = id;
  });
  return choose;
}

const argv = process.argv.slice(2);
const dataAt = argv.indexOf('--data');
if (dataAt < 0 || !argv[dataAt + 1]) {
  console.error(
    'usage: node scripts/stable-names-rewrite.ts --data <folder> [--apply] [--choose <platformName>=<platformId>]...'
  );
  process.exit(2);
}
const dbPath = path.join(argv[dataAt + 1], 'memory.db');
if (!fs.existsSync(dbPath)) {
  console.error('refused: the folder holds no memory.db');
  process.exit(2);
}
// The core's start check refuses while an engine holds the folder. Its lock goes at once: a writing open takes its own.
claimCore(dbPath)();
const apply = argv.includes('--apply');
const handle = openMemoryDb(dbPath, { readOnly: !apply });
try {
  const plan = planStableNamesRewrite(dbOf(handle), { choose: choiceOf(argv) });
  print(plan);
  if (!apply) console.log('dry run, nothing written');
  else
    console.log(
      'applied',
      JSON.stringify(applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...plan, now: Date.now() }))
    );
} finally {
  handle.close();
}
