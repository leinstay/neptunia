// B10 of the master plan, the folder: the files of her entries move from `media/diary` to `media/selfreflection` at the
// migration, with `media.path`. A move and a database commit cannot be one atomic step, so these tests stand a database
// and a folder at each point a crash can leave them, and the next open has to finish the work with no file lost and no
// path pointing at nothing. A mirror still delivers the picture afterwards. Real temporary databases and files,
// synthetic data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMirrors } from '../src/behavior/mirror.ts';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { moveSelfreflectionMedia } from '../src/memory/migration/selfreflection-names.ts';
import { PLACE, SHIPPED, seedDiaryDatabase } from './fixtures/diary-database.ts';
import { createTransport } from './fixtures/mirror-scene.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const PICTURE = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
const OLD_NAME = 'dy-e2-1.png';
const OLD_PATH = `media/diary/${OLD_NAME}`;
const NEW_PATH = `media/selfreflection/${OLD_NAME}`;
const AT = '2026-10-01T00:00:00.000Z';

/** A database at the last shipped schema whose entry `dy-e2` shows one picture at the old path, and its data folder. */
function shippedWithPicture(): { file: string; dataDir: string } {
  const file = seedDiaryDatabase();
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, SHIPPED) });
  try {
    const db = dbOf(old);
    db.prepare(
      `INSERT INTO media (id, kind, path, availability, mime, bytes, owner, audience_id, scope_kind, scope_iface)
       VALUES ('media:diary:dy-e2-1', 'image', ?, 'present', 'image/png', ?, 'dy-e2', 'aud:group:fake', 'group', 'fake')`
    ).run(OLD_PATH, PICTURE.length);
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('diary', 'dy-e2', 0, 'media:diary:dy-e2-1')"
    ).run();
  } finally {
    old.close();
  }
  return { file, dataDir: path.dirname(file) };
}

const put = (dataDir: string, relative: string, bytes: Buffer = PICTURE): void => {
  const target = path.join(dataDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
};

const has = (dataDir: string, relative: string): boolean => fs.existsSync(path.join(dataDir, relative));

/** The stored path of the picture after the engine opened the database. */
function openedPath(file: string, dataDir?: string): unknown {
  const handle = openMemoryDb(file, dataDir === undefined ? {} : { context: { dataDir } });
  try {
    // The owner's answer 13 of 2026-11-07: the open also moves the picture's id to the `media:selfreflection:` prefix.
    return dbOf(handle).prepare("SELECT path FROM media WHERE id = 'media:selfreflection:dy-e2-1'").get()?.path;
  } finally {
    handle.close();
  }
}

test('the first open moves the folder and rewrites the path, and the old folder is gone', () => {
  // Bug: the row names the new folder while the file stays in the old one, and the picture reads as missing.
  const { file, dataDir } = shippedWithPicture();
  put(dataDir, OLD_PATH);
  assert.equal(openedPath(file, dataDir), NEW_PATH);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, NEW_PATH)), PICTURE);
  assert.equal(has(dataDir, 'media/diary'), false);
});

test('a crash after the move and before the commit leaves the rows to the next open, the files where they are', () => {
  // Bug: the step wants the old folder to exist and fails the start for good, or it moves nothing and the rows stay old.
  const { file, dataDir } = shippedWithPicture();
  put(dataDir, NEW_PATH);
  assert.equal(openedPath(file, dataDir), NEW_PATH);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, NEW_PATH)), PICTURE);
});

test('a crash in the middle of the move leaves a file in each folder, and the next open finishes it', () => {
  // Bug: the move renames the folder as a whole, which fails when the new folder already exists.
  const { file, dataDir } = shippedWithPicture();
  put(dataDir, NEW_PATH);
  put(dataDir, 'media/diary/dy-e3-1.png');
  assert.equal(openedPath(file, dataDir), NEW_PATH);
  assert.equal(has(dataDir, NEW_PATH), true);
  assert.equal(has(dataDir, 'media/selfreflection/dy-e3-1.png'), true);
  assert.equal(has(dataDir, 'media/diary'), false);
});

test('a tool that opens the database without the data folder rewrites the rows, and the next open moves the files', () => {
  // Bug: the move runs only with the migration step, so a folder left behind once stays behind for good.
  const { file, dataDir } = shippedWithPicture();
  put(dataDir, OLD_PATH);
  assert.equal(openedPath(file), NEW_PATH);
  assert.equal(has(dataDir, OLD_PATH), true);
  assert.equal(openedPath(file, dataDir), NEW_PATH);
  assert.equal(has(dataDir, NEW_PATH), true);
  assert.equal(has(dataDir, 'media/diary'), false);
});

test('a restored old folder never overwrites a file of the new one, and an equal copy is dropped', () => {
  // Bug: a restore of an old backup replaces a newer file of the same name in silence.
  const { dataDir } = shippedWithPicture();
  put(dataDir, 'media/selfreflection/same.png');
  put(dataDir, 'media/diary/same.png');
  put(dataDir, 'media/selfreflection/other.png', Buffer.from([1]));
  put(dataDir, 'media/diary/other.png', Buffer.from([2]));
  assert.deepEqual(moveSelfreflectionMedia(dataDir), { moved: 1, kept: 1 });
  assert.equal(has(dataDir, 'media/diary/same.png'), false);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'media/selfreflection/other.png')), Buffer.from([1]));
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'media/diary/other.png')), Buffer.from([2]));
});

test('with no old folder there is nothing to do and no new folder appears', () => {
  // Bug: every open of a deployment with no entries makes an empty folder, or fails on the missing one.
  const { dataDir } = shippedWithPicture();
  assert.deepEqual(moveSelfreflectionMedia(dataDir), { moved: 0, kept: 0 });
  assert.equal(has(dataDir, 'media/selfreflection'), false);
});

const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

test('a publication queued before the migration goes out afterwards with its picture from the new folder', async () => {
  // Bug: the entry reads as incomplete after the rename, so nothing is posted again, or its key changes and it posts twice.
  const { file, dataDir } = shippedWithPicture();
  put(dataDir, OLD_PATH);
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, SHIPPED) });
  try {
    dbOf(old)
      .prepare(
        `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key, receipts, created_at)
         VALUES ('pub:two', 'diary', 'dy-e2', 'hash-two', 'text dy-e2', ?, 'queued', ?, '[]', ?)`
      )
      .run(PLACE, `diary:dy-e2:${PLACE}`, AT);
  } finally {
    old.close();
  }

  const at = Date.parse(AT);
  const memory = await openTestMemory({ dataDir, now: () => at, iface: () => 'fake' });
  OPEN.push(memory);
  const transport = createTransport('fake', { now: () => at });
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => transport,
    now: () => at,
    dataDir,
    config: () => ({ mirrors: { claimLeaseMs: 600_000, sendTimeoutMs: 600_000 } }),
  });
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(
    // An entry goes out as segments: its message, then its pictures.
    transport.attempts.map((attempt) => [attempt.chatId, attempt.files]),
    [
      ['d1', 0],
      ['d1', 1],
    ]
  );
  assert.equal(has(dataDir, NEW_PATH), true);
  assert.equal(mirrors.publicationState('dy-e2', PLACE)?.status, 'sent');
});
