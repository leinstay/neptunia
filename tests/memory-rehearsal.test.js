// The rehearsal of the memory writer switch (tools/memory-rehearsal.mjs, spec 2026-10-24-memory-authority section 6
// item 9, stage W5) end to end on the test fixture data directory with her session on fixed plans (`--session fake`):
// every row passes, and a writer that drops one line of the day makes the sole-authority row fail. The fixture's day
// also holds a line of hers the record kept as `seen` (a post no turn wrote, such as a diary post): the database keeps
// it as her `said` row, counted apart. Synthetic data only; nothing leaves the process, no model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { ROWS, refuseProduction, rehearse } from '../tools/memory-rehearsal.mjs';
import { CHANNEL, buildDataDir, guildDir, seen } from './fixtures/memory-db/datadir.js';
import { labels } from './fixtures/labels.js';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = '2026-10-20';
/** Her id in the fixture (no account of hers is stored: the tool's default). */
const SELF = '100000000000000009';

const prompts = {
  'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', 'memory-session': 'SESSION',
  'description-draft': 'DRAFT', 'description-check': 'CHECK', labels,
};

/** The fixture data directory with its database synced (the life under `json` before the switch). */
function frozenCopy() {
  const root = tempDir('memory-rehearsal-test-');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  // A line of hers the record kept from the gateway (no turn wrote a said line for it).
  fs.appendFileSync(path.join(guildDir(data), 'record', '2026-10', `${DAY}.jsonl`), `${JSON.stringify(seen('400000000000000007', 1, 'Το ημερολόγιο της ημέρας.', {
    by: SELF, participants: [SELF], occurredAt: `${DAY}T08:30:00.000Z`, recordedAt: `${DAY}T08:30:01.000Z`, scope: { channel: CHANNEL },
  }))}\n`);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    syncOnce(handle, data, { now: () => Date.parse('2026-10-21T00:00:00.000Z') });
    handle.db.prepare("INSERT INTO meta (key, value) VALUES ('service_import_done', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  } finally { handle.close(); }
  return { root, data };
}

const base = () => ({ config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')), prompts });

test('the rehearsal on the fixture: every row passes, the given copy is only read', async () => {
  const { root, data } = frozenCopy();
  const before = fs.readFileSync(path.join(data, 'memory.db'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const done = await rehearse({ data, db: path.join(data, 'memory.db'), day: DAY, session: 'fake', base: base(), root: work });
  const failed = done.rows.filter((row) => !row.pass).map((row) => `${row.key}: ${row.numbers.join(' | ')}`);
  assert.deepEqual(failed, [], 'every row PASS');
  assert.deepEqual(done.rows.map((row) => row.key), ROWS.map(([key]) => key));
  assert.ok(!ROWS.some(([key]) => key === 'fallback'), 'no legacy fallback row');
  assert.match(done.report, /verdict: every row PASS/);
  const sole = done.rows.find((row) => row.key === 'sole').numbers.join('\n');
  assert.match(sole, /\(1 of them her own lines the record kept as seen, her said rows here\), 0 missing/);
  assert.match(sole, /0 wait; never embedded: 1 older revisions of edited messages/);
  assert.match(sole, /none failed/);
  assert.match(done.rows.find((row) => row.key === 'switch').numbers.join('\n'), /memory files deleted/);
  assert.match(done.rows.find((row) => row.key === 'failures').numbers.join('\n'), /PASS the observation queue overflowing before the open: queued 5001, the status says dropped 1, told with its count 1; written after the open 5000/);
  assert.ok(before.equals(fs.readFileSync(path.join(data, 'memory.db'))), 'the given database untouched');
});

test('a writer that drops one line of the day fails the sole-authority row', async () => {
  const { root, data } = frozenCopy();
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const done = await rehearse({ data, db: path.join(data, 'memory.db'), day: DAY, session: 'fake', base: base(), root: work, faults: { dropLine: true } });
  const sole = done.rows.find((row) => row.key === 'sole');
  assert.equal(sole.pass, false);
  assert.match(sole.numbers.join('\n'), /1 missing/);
  assert.match(done.report, /verdict: 1 row\(s\) FAIL/);
});

test('a path under the production root is refused', () => {
  assert.throws(() => refuseProduction('/opt/neptunia/data', '--data'), /give a frozen copy/);
  assert.equal(refuseProduction('/srv/elsewhere/data', '--data'), '/srv/elsewhere/data');
});
