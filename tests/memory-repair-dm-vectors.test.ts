// `scripts/memory-repair-dm-vectors.ts`, run as a process over a synthetic database closed the way a stopped core leaves
// it. The fixture is what a restart loop leaves: a cli DM's own lines filed under the Discord DM of the same native id, the
// same records appended again under suffixed keys and quarantined to internal, and a manifest that counts rows and bytes
// the month does not hold. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { createRecord } from '../src/memory/record.ts';
import { createVectors } from '../src/memory/vectors.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'memory-repair-dm-vectors.ts');
const MONTH = '2026-11';
const AT = Date.parse('2026-11-03T10:00:00.000Z');
const CLI_DM = 'cli:dm:owner';
const DISCORD_DM = 'discord:dm:owner';
const GROUP = 'discord:channel:room';
const MODEL = 'test/embedder';
const owner = (placeId: string) => storageId({ ...placeCollection('vectors', placeId), partition: MONTH });

const observed = (iface: string, key: string, kind: 'dm' | 'channel', native: string) => ({
  v: OBSERVATION_VERSION,
  iface,
  authority: `${iface}/global`,
  native: { kind: 'message', key: native, revision: 1 },
  place: { authority: `${iface}/global`, key, kind, chat: kind === 'dm' ? 'dm' : 'group' },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: kind === 'dm',
  relations: [],
});

const vectorRow = (id: string, minute: number, placeId: string | null = null) => ({
  meta: {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: new Date(AT + minute * 60_000).toISOString(),
    placeId,
    by: 'owner',
    participants: ['owner'],
    sourceIds: [id],
  },
  vector: Float32Array.from([0.5, 0.5, minute + 1, 0.25]),
});

const line = (id: string, minute: number) => ({
  v: 1,
  kind: 'seen',
  messageId: id,
  revision: 1,
  occurredAt: new Date(AT + minute * 60_000).toISOString(),
  scope: {},
  by: 'owner',
  text: `a synthetic line ${id}`,
  participants: ['owner'],
});

/** What the old append wrote: the row of `chunkKey` beside the record under a suffixed key, quarantined. */
function addRepeat(db: DatabaseSync, month: string, id: string, audience: string) {
  const held = db.prepare('SELECT * FROM vectors WHERE owner_key = ? AND item_id = ? LIMIT 1').get(month, id)!;
  const context = JSON.parse(String(held.context)) as Record<string, unknown>;
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE owner_key = ?').get(month)!.n);
  const internal = audience === 'aud:internal';
  db.prepare(
    `INSERT INTO vectors (item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface,
       scope_dm, audience_id, owner_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `${String(held.chunk_key)}-2`,
    held.model as string,
    held.dims as number,
    held.scale as number,
    held.norm as number,
    held.bytes as Uint8Array,
    JSON.stringify({ ...context, row: count }),
    held.occurred_at as string,
    internal ? 'internal' : held.scope_kind,
    internal ? null : held.scope_iface,
    internal ? null : held.scope_dm,
    audience,
    month
  );
}

/** The closed database of a stopped core with the family of damage above, and what the month reads back as. */
async function damaged() {
  const env = await openTestMemory({ log: { info() {}, debug() {}, warn() {}, error() {} } });
  const { dataDir, memoryDb } = env;
  await memoryDb.observe(observed('cli', 'dm:owner', 'dm', 'cli-first'), null);
  await memoryDb.observe(observed('discord', 'dm:owner', 'dm', 'discord-first'), null);
  const room = (await memoryDb.observe(observed('discord', 'channel:room', 'channel', 'room-first'), null)) as {
    placeId: string;
  };
  assert.equal(room.placeId, GROUP);
  const record = createRecord({ dataDir, memoryDb });
  await record.append(CLI_DM, [line('seen-1', 0), line('said-1', 1)]);
  const vectors = createVectors({ dataDir, memoryDb });
  await vectors.append(CLI_DM, [vectorRow('seen-1', 0)], { model: MODEL });
  await vectors.append(DISCORD_DM, [vectorRow('said-1', 1, CLI_DM)], { model: MODEL });
  await vectors.append(GROUP, [vectorRow('room-1', 2), vectorRow('room-2', 3)], { model: MODEL });
  const file = path.join(dataDir, 'memory.db');
  await env.close();
  const db = new DatabaseSync(file);
  addRepeat(db, owner(CLI_DM), 'seen-1', 'aud:internal');
  addRepeat(db, owner(GROUP), 'room-1', 'aud:group:discord');
  db.prepare("INSERT INTO co_owners (tbl, key, owner_key) VALUES ('vectors', ?, ?)").run(
    'private:owner:record:said-1:1',
    owner(CLI_DM)
  );
  const bump = db.prepare(`UPDATE operational SET value = ? WHERE kind = 'vectors' AND owner_key = ?`);
  for (const [placeId, rows] of [
    [CLI_DM, 6],
    [GROUP, 3],
  ] as const) {
    const stored = db
      .prepare("SELECT value FROM operational WHERE kind = 'vectors' AND owner_key = ?")
      .get(owner(placeId));
    const { manifest } = JSON.parse(String(stored!.value)) as { manifest: Record<string, number> };
    bump.run(
      JSON.stringify({ manifest: { ...manifest, rows, bytes: rows * 4, metaBytes: manifest.metaBytes + 90 }, gen: 1 }),
      owner(placeId)
    );
  }
  db.close();
  return file;
}

function run(file: string, ...flags: Array<string>) {
  const done = spawnSync(process.execPath, [SCRIPT, '--db', file, ...flags], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout) as Record<string, number> & {
    mode: string;
    done: Record<string, number>;
    remaining: Record<string, number>;
  };
}

function liveRows(file: string, month: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT item_id, chunk_key, audience_id, source_rowid FROM vectors WHERE owner_key = ? AND retired_at IS NULL ORDER BY item_id'
      )
      .all(month)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** The month as the engine reads it again: what `has` answers and what search finds, with what it warned of. */
async function reread(file: string, placeId: string) {
  const warnings: Array<string> = [];
  const log = { info() {}, debug() {}, error() {}, warn: (message: string) => warnings.push(message) };
  const env = await openTestMemory({ dataDir: path.dirname(file), log });
  try {
    const vectors = createVectors({ dataDir: env.dataDir, log, memoryDb: env.memoryDb });
    const keys = [...(await vectors.has(placeId, MONTH))].sort();
    const found = await vectors.search(placeId, [1, 1, 1, 1], { k: 10 });
    return { keys, found: found.length, warnings };
  } finally {
    await env.close();
  }
}

test('a dry run counts the repair and writes nothing', async () => {
  const file = await damaged();
  const before = liveRows(file, owner(CLI_DM));
  const answer = run(file);
  assert.equal(answer.mode, 'dry-run');
  assert.equal(answer.moved, 1);
  assert.equal(answer.duplicatesDm, 1);
  assert.equal(answer.duplicatesGroup, 1);
  assert.deepEqual(liveRows(file, owner(CLI_DM)), before);
  assert.equal(run(file).moved, 1, 'the same counts again');
});

test('the repair files a cli DM under its own place, in its audience, with a manifest that reads whole', async () => {
  const file = await damaged();
  const answer = run(file, '--apply');
  assert.equal(answer.done.moved, 1);

  assert.deepEqual(
    liveRows(file, owner(CLI_DM)).map((row) => [row.chunk_key, row.audience_id, row.source_rowid !== null]),
    [
      ['private:owner:record:said-1:1', 'aud:dm:cli:dm:owner', true],
      ['private:owner:record:seen-1:1', 'aud:dm:cli:dm:owner', true],
    ]
  );
  assert.deepEqual(liveRows(file, owner(DISCORD_DM)), []);
  const db = new DatabaseSync(file, { readOnly: true });
  const shared = db.prepare('SELECT COUNT(*) AS n FROM co_owners').get()!.n;
  db.close();
  assert.equal(shared, 0);
  assert.deepEqual(await reread(file, CLI_DM), {
    keys: ['record:said-1:1', 'record:seen-1:1'],
    found: 2,
    warnings: [],
  });
});

test('the repair drops a repeated record of a group month and reads the month whole', async () => {
  const file = await damaged();
  run(file, '--apply');
  assert.deepEqual(
    liveRows(file, owner(GROUP)).map((row) => row.item_id),
    ['room-1', 'room-2']
  );
  assert.deepEqual(await reread(file, GROUP), { keys: ['record:room-1:1', 'record:room-2:1'], found: 2, warnings: [] });
});

test('a second run finds nothing to do', async () => {
  const file = await damaged();
  const first = run(file, '--apply');
  assert.equal(first.remaining.rewritten, 0);
  const again = run(file, '--apply');
  assert.deepEqual(
    [again.done.rewritten, again.done.moved, again.done.duplicatesDm, again.done.duplicatesGroup, again.done.rescoped],
    [0, 0, 0, 0, 0]
  );
});

test('--dm-only leaves a group month as it found it', async () => {
  const file = await damaged();
  const before = liveRows(file, owner(GROUP));
  run(file, '--apply', '--dm-only');
  assert.deepEqual(liveRows(file, owner(GROUP)), before);
  assert.deepEqual(
    liveRows(file, owner(CLI_DM)).map((row) => row.audience_id),
    ['aud:dm:cli:dm:owner', 'aud:dm:cli:dm:owner']
  );
});

test('a month with an evicted vector is counted and left as it is', async () => {
  const file = await damaged();
  const db = new DatabaseSync(file);
  db.prepare('UPDATE vectors SET bytes = NULL WHERE owner_key = ? AND item_id = ?').run(owner(GROUP), 'room-2');
  db.close();
  const before = liveRows(file, owner(GROUP));
  const answer = run(file, '--apply');
  assert.equal(answer.done.leftEvicted, 1);
  assert.deepEqual(liveRows(file, owner(GROUP)), before);
});

test('it refuses a database another writer holds', async () => {
  const env = await openTestMemory();
  try {
    const done = spawnSync(process.execPath, [SCRIPT, '--db', path.join(env.dataDir, 'memory.db'), '--apply'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(done.status, 1);
  } finally {
    await env.close();
  }
});

test('it asks for the database and starts nothing without one', () => {
  const done = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.equal(done.status, 2);
});
