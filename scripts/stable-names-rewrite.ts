// Rewrites the lines a deployment stored before stable names to `:e23:` and gives their emoji and stickers their stable
// names (src/memory/db/stable-names-rewrite.ts). Run once per deployment, with the core stopped, after a backup.
//
//   node scripts/stable-names-rewrite.ts --data <folder>            dry run: counts only, nothing written
//   node scripts/stable-names-rewrite.ts --data <folder> --apply    writes the plan through the memory writer
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
}

const argv = process.argv.slice(2);
const dataAt = argv.indexOf('--data');
if (dataAt < 0 || !argv[dataAt + 1]) {
  console.error('usage: node scripts/stable-names-rewrite.ts --data <folder> [--apply]');
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
  const plan = planStableNamesRewrite(dbOf(handle));
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
