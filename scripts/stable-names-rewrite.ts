// Rewrites what a deployment stored before stable names to `:e23:`, gives its emoji and stickers their stable names and
// links each line to the emoji its text names (src/memory/db/stable-names-rewrite.ts). It then rewrites the log of
// requests and the recall traces in batches (src/memory/db/stable-names-logs.ts). Run once per deployment, with the core
// stopped, after a backup.
//
//   node scripts/stable-names-rewrite.ts --data <folder>            dry run: counts only, nothing written
//   node scripts/stable-names-rewrite.ts --data <folder> --apply    writes the plan through the memory writer
//   --choose <platformName>=<platformId>                            ties a name two emoji hold to one of them; repeatable
//   --markup-iface <interface>                                      the interface of raw markup whose id no row holds
//   --confirmed <file>                                              ids of the lines the platform answered for, one per line
//
// The core's own start check refuses the run while an engine holds the folder. Output holds counts and names of kinds.

import fs from 'node:fs';
import path from 'node:path';
import { claimCore, openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { planStableNamesRewrite } from '../src/memory/db/stable-names-rewrite.ts';
import type { StableNamesPlan } from '../src/memory/db/stable-names-rewrite.ts';
import { planLogBatches } from '../src/memory/db/stable-names-logs.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';

/** Rows of a log table read per batch: a few hundred requests hold some tens of megabytes of JSON. */
const BATCH_SIZE = 200;

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
  console.log(`left, raw markup ids of no known interface: ${counts.left.markupIface}`);
  console.log(`left, a confirmed line with a typed emoji name and no link: ${counts.left.plainText}`);
  if (counts.left.markupIface > 0)
    console.log('give the interface their markup belongs to with --markup-iface <interface>');
}

/**
 * The log batches: each applied at once with `--apply`, counted only in a dry run, where a batch reads the names as the
 * main plan leaves them unwritten. Prints rows to change per table and progress, counts only.
 */
function runLogs(handle: MemoryHandle, options: { choose: Record<string, string>; markupIface: string | null }): void {
  const sums: Record<string, number> = {};
  const left = { sharedName: 0, unlinkedSticker: 0 };
  let batches = 0;
  for (const batch of planLogBatches(dbOf(handle), { batchSize: BATCH_SIZE, ...options })) {
    if (apply) applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...batch, now: Date.now() });
    batches += 1;
    const { tables, left: batchLeft } = batch.counts;
    for (const [table, count] of Object.entries(tables)) sums[table] = (sums[table] ?? 0) + count;
    left.sharedName += batchLeft.sharedName;
    left.unlinkedSticker += batchLeft.unlinkedSticker;
    if (batches % 10 === 0) console.log(`log batches read: ${batches}`);
  }
  console.log(`log batches read: ${batches}`);
  for (const table of ['model_requests', 'operational'])
    console.log(`log rows to change, ${table}: ${sums[table] ?? 0}`);
  console.log(`log left, a name two emoji hold: ${left.sharedName}`);
  console.log(`log left, an old sticker reference of a name no one sticker holds: ${left.unlinkedSticker}`);
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

/** The `--markup-iface <interface>` argument, null when absent. */
function markupIfaceOf(args: ReadonlyArray<string>): string | null {
  const at = args.indexOf('--markup-iface');
  return at < 0 ? null : (args[at + 1] ?? null);
}

/** The ids of `--confirmed <file>`, one per line; undefined when absent. Refuses a file it cannot read. */
function confirmedOf(args: ReadonlyArray<string>): Set<string> | undefined {
  const at = args.indexOf('--confirmed');
  if (at < 0) return undefined;
  try {
    const lines = fs.readFileSync(args[at + 1] ?? '', 'utf8').split('\n');
    return new Set(lines.map((one) => one.trim()).filter((one) => one !== ''));
  } catch {
    // A missing path or a file the run may not read: the run would tie every line by name.
    console.error('refused: cannot read the --confirmed file');
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
const dataAt = argv.indexOf('--data');
if (dataAt < 0 || !argv[dataAt + 1]) {
  console.error(
    'usage: node scripts/stable-names-rewrite.ts --data <folder> [--apply] [--choose <platformName>=<platformId>]... [--markup-iface <interface>] [--confirmed <file>]'
  );
  process.exit(2);
}
const dbPath = path.join(argv[dataAt + 1], 'memory.db');
if (!fs.existsSync(dbPath)) {
  console.error('refused: the folder holds no memory.db');
  process.exit(2);
}
const confirmed = confirmedOf(argv);
// The core's start check refuses while an engine holds the folder. Its lock goes at once: a writing open takes its own.
claimCore(dbPath)();
const apply = argv.includes('--apply');
const handle = openMemoryDb(dbPath, { readOnly: !apply });
try {
  const options = { choose: choiceOf(argv), markupIface: markupIfaceOf(argv) };
  const plan = planStableNamesRewrite(dbOf(handle), { ...options, confirmed });
  print(plan);
  if (apply)
    console.log(
      'applied',
      JSON.stringify(applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...plan, now: Date.now() }))
    );
  runLogs(handle, options);
  if (!apply) console.log('dry run, nothing written');
} finally {
  handle.close();
}
