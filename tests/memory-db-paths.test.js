// The path allowlist of the writer switch (spec 2026-10-24-memory-authority, section 6 item 8; stage W4): every path
// the unit mappers map or skip, the data layout of src/memory/store.js and the files of the fixture data directory are
// in exactly one of the two lists (operational: still written as files; memory: in the database only). Synthetic paths
// and data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_PATTERNS,
  OPERATIONAL_PATTERNS,
  isMemoryPath,
  isOperational,
  pathClass,
} from '../src/memory/db/paths.js';
import { MAPPERS, classify } from '../src/memory/db/map/index.js';
import { operationalJsonPath } from '../src/memory/store.js';
import { GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';

const G = `guilds/${GUILD}`;
const L = `${G}/private/${MEMBER}`;

/** One path of every pattern the sync maps (map/index.js KINDS), with the kind it maps to and the list it is in. */
const MAPPED = [
  [`${G}/record/2026-10/2026-10-20.jsonl`, 'record', 'memory'],
  [`${L}/record/2026-10/2026-10-20.jsonl`, 'record', 'memory'],
  [`${G}/record/2026-10/ids.json`, 'verbatim', 'memory'],
  [`${L}/record/2026-10/ids.json`, 'verbatim', 'memory'],
  [`${G}/record/backfill.json`, 'verbatim', 'operational'],
  [`${G}/journal/2026-10-20.jsonl`, 'journal', 'memory'],
  [`${L}/journal/2026-10-20.jsonl`, 'journal', 'memory'],
  [`${G}/journal/requests/tools/a1b2.json`, 'verbatim', 'operational'],
  [`${L}/journal/requests/tools/a1b2.json`, 'verbatim', 'operational'],
  [`${G}/journal/requests/2026-10-20/turn-1-s1.json`, 'requests', 'operational'],
  [`${L}/journal/requests/2026-10-20/turn-2-s1.json`, 'requests', 'operational'],
  [`${G}/journal/.running`, 'verbatim', 'operational'],
  [`${L}/journal/.running`, 'verbatim', 'operational'],
  [`${G}/archive/2026-10.jsonl`, 'archive', 'memory'],
  [`${L}/archive/2026-10.jsonl`, 'archive', 'memory'],
  [`${G}/archive/2026-10.ids.json`, 'verbatim', 'memory'],
  [`${L}/archive/2026-10.ids.json`, 'verbatim', 'memory'],
  [`${G}/archive/pending.jsonl`, 'verbatim', 'operational'],
  [`${G}/archive/pending-2026-10.jsonl`, 'verbatim', 'operational'],
  [`${L}/archive/pending.jsonl`, 'verbatim', 'operational'],
  [`${G}/vectors/2026-10/manifest.json`, 'vectors', 'memory'],
  [`${G}/vectors/2026-10/3.i8`, 'vectors', 'memory'],
  [`${G}/vectors/2026-10/3.jsonl`, 'vectors', 'memory'],
  [`${L}/vectors/2026-10/manifest.json`, 'vectors', 'memory'],
  [`${G}/versions/users/${MEMBER}.json`, 'versions', 'memory'],
  [`${G}/versions/lore/clé.json`, 'versions', 'memory'],
  [`${G}/users/${MEMBER}.json`, 'user', 'memory'],
  [`${G}/private/${MEMBER}.json`, 'private', 'memory'],
  [`${G}/channels/200000000000000001.json`, 'channel', 'memory'],
  [`${G}/guild.json`, 'guild', 'memory'],
  [`${G}/lore.json`, 'lore', 'memory'],
  [`${G}/participation.json`, 'participation', 'operational'],
  [`${G}/recent.json`, 'recent', 'memory'],
  [`${G}/diary.json`, 'diary', 'memory'],
  [`${G}/intentions.json`, 'intentions', 'memory'],
  [`${G}/intentions-archive.jsonl`, 'intentions', 'memory'],
  [`${G}/tasks.json`, 'tasks', 'memory'],
  [`${G}/tasks.jsonl`, 'tasks', 'memory'],
  [`${G}/media.json`, 'media', 'operational'],
  [`${G}/gifs.json`, 'gifs', 'operational'],
  [`${G}/recall-trace.jsonl`, 'verbatim', 'operational'],
  [`${G}/voice.json`, 'verbatim', 'memory'],
  [`${G}/buffer.json`, 'verbatim', 'memory'],
  [`${G}/inner.json`, 'verbatim', 'operational'],
  [`${G}/missed.json`, 'verbatim', 'operational'],
  [`${G}/forgotten.json`, 'verbatim', 'memory'],
  [`${G}/forgetting/${MEMBER}.json`, 'verbatim', 'memory'],
  [`${G}/backfill/candidates.jsonl`, 'verbatim', 'operational'],
  [`${G}/backfill/progress.json`, 'verbatim', 'operational'],
];

/** One path of every pattern the sync skips (map/index.js SKIPPED): all operational. */
const SKIPPED = [
  'state.json',
  'usage.json',
  'metrics.json',
  `${G}/state.json`,
  `${G}/usage.json`,
  `${G}/metrics.json`,
  'mentor/2026-10-20/run.json',
  'recall-eval/questions.json',
  'vision-compare/2026-10-20/a.json',
  `${G}/recall-eval/out.json`,
  `${G}/users/${MEMBER}.json.bak`,
  `${G}/users/${MEMBER}.json.bak-2026`,
  `${G}/guild.json.bak.1`,
  `${G}/intentions.json.unreadable-1761300000000`,
  `${L}/record/2026-10/2026-10-20.jsonl.bak`,
];

/** The rest of the data layout (store.js and the other owners under `data/`), with its list. */
const INVENTORY = [
  ['memory.db', 'operational'],
  ['memory.db-wal', 'operational'],
  ['memory.db-shm', 'operational'],
  ['memory.db.lock', 'operational'],
  ['memory-pending/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567.json', 'operational'],
  [`vault/forget-${MEMBER}-1761300000000/users/${MEMBER}.json`, 'operational'],
  [`snapshots/2026-10-20/${G}/users/${MEMBER}.json`, 'operational'],
  ['media/diary/d-1-1.png', 'operational'],
  ['media/diary/d-1-2.ogg', 'operational'],
  [`${G}/journal/2026-10-20.jsonl.torn-1761300000000`, 'operational'],
  [`${G}/record/2026-10/2026-10-20.jsonl.tmp`, 'operational'],
  [`${G}/users/${MEMBER}.json.4242.tmp`, 'operational'],
  ['media/diary/d-1-3.png.tmp-4242', 'operational'],
  [`${L}/participation.json`, 'operational'],
  [`${G}/journal/notes.txt`, null],
  [`${G}/something-new.json`, null],
];

/** Every regular file under `dir`, relative with forward slashes. */
function filesOf(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(dir, child, out);
    else out.push(child);
  }
  return out;
}

const inLists = (rel) => [
  OPERATIONAL_PATTERNS.some((entry) => entry.re.test(rel)),
  MEMORY_PATTERNS.some((entry) => entry.re.test(rel)),
];

test('allowlist: every path the sync maps is in exactly one list, the one the spec puts it in', () => {
  for (const [rel, kind, expected] of MAPPED) {
    const info = classify(rel);
    assert.ok(info && !info.skipped, `${rel} is a path the sync maps`);
    assert.equal(info.kind, kind, rel);
    const [operational, memory] = inLists(rel);
    assert.ok(operational !== memory, `${rel} is in exactly one list (operational ${operational}, memory ${memory})`);
    assert.equal(pathClass(rel), expected, rel);
  }
  // Every mapper the sync has is reached by the samples above.
  assert.deepEqual([...new Set(MAPPED.map(([, kind]) => kind))].sort(), Object.keys(MAPPERS).sort());
});

test('allowlist: every path the sync skips is operational, and so are the leftovers of a memory file', () => {
  for (const rel of SKIPPED) {
    assert.equal(classify(rel)?.skipped, true, `${rel} is a path the sync skips`);
    assert.deepEqual(inLists(rel), [true, false], rel);
  }
});

test('allowlist: the rest of the data layout is in one list, and a path neither knows is in none', () => {
  for (const [rel, expected] of INVENTORY) {
    const [operational, memory] = inLists(rel);
    if (expected === null) assert.deepEqual([operational, memory], [false, false], rel);
    else assert.ok(operational !== memory, `${rel} is in exactly one list`);
    assert.equal(pathClass(rel), expected, rel);
    assert.equal(isOperational(rel), expected === 'operational', rel);
    assert.equal(isMemoryPath(rel), expected === 'memory', rel);
  }
});

test('allowlist: every file of the fixture data directory is in exactly one list', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-paths-'));
  try {
    buildDataDir(root);
    const files = filesOf(root);
    assert.ok(files.length > 20);
    for (const rel of files) {
      const [operational, memory] = inLists(rel);
      assert.ok(operational !== memory, `${rel} is in exactly one list (operational ${operational}, memory ${memory})`);
    }
    const operational = files
      .filter(isOperational)
      .map((rel) => rel.replace(`${G}/`, ''))
      .sort();
    assert.deepEqual(operational, [
      'gifs.json',
      'inner.json',
      'journal/requests/2026-10-20/turn-1-s1.json',
      'media.json',
      'participation.json',
      'recall-trace.jsonl',
      'state.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("allowlist: the store's operational JSON files (what /nep resume checks under db) are the allowlist's JSON files", () => {
  const json = [...MAPPED.map(([rel]) => rel), ...SKIPPED, ...INVENTORY.map(([rel]) => rel)].filter((rel) =>
    rel.endsWith('.json')
  );
  assert.ok(json.length > 30);
  // The tools' output folders are on the allowlist (never retired) but are not the process's own state.
  const toolOutput = /^(?:guilds\/[^/]+\/)?(?:mentor|recall-eval|vision-compare)\//;
  for (const rel of json) {
    if (toolOutput.test(rel)) continue;
    assert.equal(operationalJsonPath(rel), isOperational(rel), rel);
  }
});
