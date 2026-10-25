// Schema v12 (spec 2026-10-24-memory-authority, stage W2a): a data step, no table. The diary's legacy mirrors name no
// place, so their publications have no destination; the deployment's diary channel becomes it at the first open that
// knows the channel (the bot's), and a database with nothing to give it to waits for nothing. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { channelPlaceId } from '../src/memory/db/ids.js';
import { CHANNEL, buildDataDir } from './fixtures/memory-db/datadir.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v12-'));

test('schema v12: the legacy diary mirrors get the diary channel as destination, at the first open that knows it', () => {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(data, 'memory.db');
  try {
    // A database of schema 11 with the legacy mirrors, then opened by a tool (no channel), then by the bot.
    const v11 = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 11) });
    try { seedUnits(v11, data, { now: () => NOW }); } finally { v11.close(); }
    openMemoryDb(file).close();
    const plain = openMemoryDb(file, { readOnly: true });
    try {
      assert.equal(plain.db.prepare("SELECT COUNT(*) AS n FROM publications WHERE row_kind = 'diary' AND destination_place_id IS NULL").get().n, 1);
      assert.equal(plain.db.prepare("SELECT value FROM meta WHERE key = 'diary_destination_pending'").get()?.value, '1', 'opened by a tool without the channel');
    } finally { plain.close(); }
    const known = openMemoryDb(file, { context: { diaryPlaceId: channelPlaceId(CHANNEL) } });
    try {
      assert.equal(known.db.prepare("SELECT destination_place_id AS d FROM publications WHERE row_kind = 'diary'").get().d, channelPlaceId(CHANNEL));
      assert.equal(known.db.prepare("SELECT 1 AS ok FROM meta WHERE key = 'diary_destination_pending'").get(), undefined);
    } finally { known.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('schema v12 on a new database: no publication to wait for, no mark', () => {
  const root = tmpRoot();
  try {
    const handle = openMemoryDb(path.join(root, 'memory.db'));
    try {
      assert.equal(handle.db.prepare("SELECT 1 AS ok FROM meta WHERE key = 'diary_destination_pending'").get(), undefined);
      assert.equal(handle.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, MIGRATIONS.length);
    } finally { handle.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
