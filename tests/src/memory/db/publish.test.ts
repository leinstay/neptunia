// Publications (src/memory/db/publish.ts). An internal draft goes only to a place with an enabled diary mirror, the
// owner's standing grant; a stored text never changes; a crash between queueing and sending sends once; the diary's
// mirrors become sent publications in the migration (a fixture of 51 mirrors) and on every later write of the diary, idempotently, and
// a rewrite keeps the row. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import {
  contentHash,
  mirrorPublicationRow,
  preparePublication,
  publicationKey,
  publicationOf,
  recheck,
} from '../../../../src/memory/db/publish.ts';
import { contextRow, issueContext } from '../../../../src/memory/db/scope.ts';
import { CHANNEL, buildDataDir, guildDir, writeJson, writeLines } from '../../../fixtures/memory-db/datadir.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';
import { T0, mirrorScene, FOUR_HOURS, HOUR, OWNER } from '../../../fixtures/mirror-scene.ts';
import type { Scene } from '../../../fixtures/mirror-scene.ts';
import { createMirrors } from '../../../../src/behavior/mirror.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { ROOT, NOW as MIRROR_NOW, sceneLlm, sceneRunner } from '../../../fixtures/diary-requests-recorded.ts';
import { dbOf as mirrorDbOf, diaryPublications, entryOf, seedMirror } from '../../../fixtures/diary-mirror.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { freshWorld, world } from '../../../fixtures/turn-world.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const count = (db: Db, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params)!.n;
const GENERAL = 'discord:channel:c-general';
const OTHER = 'discord:channel:c-other';

/** A database with two group places and one diary entry. */
function fixture() {
  const handle = openMemoryDb(':memory:');
  insertRows(
    dbOf(handle),
    {
      places: [
        {
          id: GENERAL,
          iface: 'discord',
          kind: 'channel',
          native_id: 'c-general',
          parent_id: null,
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: OTHER,
          iface: 'discord',
          kind: 'channel',
          native_id: 'c-other',
          parent_id: null,
          scope_kind: 'group',
          name: 'other',
        },
      ],
      diary: [
        {
          id: 'entry-1',
          at_ms: NOW,
          kind: 'day',
          gist: 'a quiet day',
          text: null,
          scope_kind: 'group',
          scope_iface: 'discord',
          scope_dm: null,
        },
      ],
    },
    { log: quiet, at: new Date(NOW).toISOString() }
  );
  let n = 0;
  const outward = (destination: string) =>
    issueContext({ iface: 'discord', kind: 'group', destination, now: () => NOW, newId: () => `ctx:out:${(n += 1)}` });
  const internal = () => issueContext({ kind: 'internal', now: () => NOW, newId: () => `ctx:in:${(n += 1)}` });
  return { handle, db: dbOf(handle), outward, internal };
}

const DRAFT = 'Σήμερα ήταν ήσυχα. A private detail she never cited.';

test('publish: an internal draft goes only to a place with an enabled diary mirror; nothing is written on a refusal', () => {
  const { handle, db, outward, internal } = fixture();
  try {
    const before = count(db, 'SELECT COUNT(*) AS n FROM publications');
    const contexts = count(db, 'SELECT COUNT(*) AS n FROM execution_contexts');
    const refusedInternal = preparePublication(handle, {
      context: outward(GENERAL),
      rowKind: 'diary',
      rowId: 'entry-1',
      rendered: DRAFT,
      destination: GENERAL,
      producedIn: internal(),
      now: NOW,
    });
    assert.deepEqual(refusedInternal, { ok: false, code: 'no-grant' });
    // A text with no named origin is treated as internal (fail closed).
    assert.deepEqual(
      preparePublication(handle, {
        context: outward(GENERAL),
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: GENERAL,
        now: NOW,
      }),
      { ok: false, code: 'no-grant' }
    );
    // A text produced for another destination is refused too.
    assert.deepEqual(
      preparePublication(handle, {
        context: outward(GENERAL),
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: GENERAL,
        producedIn: outward(OTHER),
        now: NOW,
      }),
      { ok: false, code: 'no-grant' }
    );
    // The context must be outward and for this destination.
    assert.deepEqual(
      preparePublication(handle, {
        context: internal(),
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: GENERAL,
        producedIn: internal(),
        now: NOW,
      }),
      { ok: false, code: 'not-outward' }
    );
    assert.deepEqual(
      preparePublication(handle, {
        context: outward(OTHER),
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: GENERAL,
        producedIn: internal(),
        now: NOW,
      }),
      { ok: false, code: 'destination-mismatch' }
    );
    assert.deepEqual(
      preparePublication(handle, {
        context: { mode: 'outward', destination: GENERAL },
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: GENERAL,
        now: NOW,
      }),
      { ok: false, code: 'not-outward' },
      'a context the core did not issue (no id) is refused'
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications'), before, 'no row on any refusal');
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM execution_contexts'),
      contexts,
      'no context recorded on a refusal'
    );

    // An enabled diary mirror of the place is the owner's standing grant: an internal draft may go there.
    db.prepare(
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES (?, 'diary', ?, ?, ?, 'owner')"
    ).run('mirror:general', GENERAL, 1, new Date(NOW).toISOString());
    db.prepare(
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES (?, 'diary', ?, ?, ?, 'owner')"
    ).run('mirror:other', OTHER, 0, new Date(NOW).toISOString());
    const done = preparePublication(handle, {
      context: outward(GENERAL),
      rowKind: 'diary',
      rowId: 'entry-1',
      rendered: DRAFT,
      destination: GENERAL,
      producedIn: internal(),
      now: NOW,
    });
    assert.equal(done.ok, true);
    assert.equal(done.publication!.status, 'queued');
    assert.equal(done.publication!.content_hash, contentHash(DRAFT));
    assert.equal(done.publication!.rendered, DRAFT);
    assert.equal(done.publication!.idempotency_key, publicationKey('diary', 'entry-1', GENERAL));
    // A queued internal draft is seen by no outward context in the graph.
    const access = db
      .prepare('SELECT audience_id FROM node_access WHERE node_id = ? AND evidence_id = node_id')
      .all(`publication:${done.publication!.id}`)
      .map((row) => row.audience_id);
    assert.deepEqual(access, ['aud:internal']);
    // A disabled mirror grants nothing.
    assert.deepEqual(
      preparePublication(handle, {
        context: outward(OTHER),
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination: OTHER,
        producedIn: internal(),
        now: NOW,
      }),
      { ok: false, code: 'no-grant' }
    );
    // A text produced in a context for this very destination needs no mirror.
    const own = preparePublication(handle, {
      context: outward(OTHER),
      rowKind: 'diary',
      rowId: 'entry-1',
      rendered: 'Ένα κείμενο για εδώ.',
      destination: OTHER,
      producedIn: outward(OTHER),
      now: NOW,
    });
    assert.equal(own.ok, true);
    // Publications are never deleted.
    assert.throws(() => db.prepare('DELETE FROM publications').run(), /never deleted/);
  } finally {
    handle.close();
  }
});

test('publish: the stored text never changes; the context is checked again at send time', () => {
  const { handle, db, outward, internal } = fixture();
  try {
    const edited = `${DRAFT} One more line, added later.`;
    const done = preparePublication(handle, {
      context: outward(GENERAL),
      rowKind: 'diary',
      rowId: 'entry-1',
      rendered: DRAFT,
      destination: GENERAL,
      producedIn: outward(GENERAL),
      now: NOW,
    });
    assert.equal(done.ok, true);
    assert.throws(
      () =>
        db
          .prepare('UPDATE publications SET rendered = ?, content_hash = ? WHERE id = ?')
          .run(edited, contentHash(edited), done.publication!.id),
      /keeps its content/
    );
    // At send time the context is checked again.
    assert.deepEqual(recheck(handle, done.publication!.id, outward(GENERAL)), { ok: true });
    assert.deepEqual(recheck(handle, done.publication!.id, outward(OTHER)), {
      ok: false,
      code: 'destination-mismatch',
    });
    assert.deepEqual(recheck(handle, done.publication!.id, internal()), { ok: false, code: 'not-outward' });
  } finally {
    handle.close();
  }
});

test('publish: an entry whose publication to a place was retired is refused there, under any key, and nothing is written', () => {
  // Catches: a repeat found by its key alone, which hands back the retired row under the standard key and queues a new
  // row, sent at the next drain, when the retired one carries a legacy key.
  for (const status of ['queued', 'unknown'])
    for (const key of [publicationKey('diary', 'entry-1', GENERAL), `grant:g1:entry-1:${GENERAL}`]) {
      const { handle, db, outward } = fixture();
      try {
        db.prepare(
          `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status,
             idempotency_key, created_at, retired_at) VALUES ('pub:retired', 'diary', 'entry-1', 'h', ?, ?, ?, ?, ?, ?)`
        ).run(DRAFT, GENERAL, status, key, new Date(NOW).toISOString(), new Date(NOW).toISOString());
        const prepare = (destination: string) =>
          preparePublication(handle, {
            context: outward(destination),
            rowKind: 'diary',
            rowId: 'entry-1',
            rendered: DRAFT,
            destination,
            producedIn: outward(destination),
            now: NOW,
          });
        assert.deepEqual(prepare(GENERAL), { ok: false, code: 'retired' }, `${status} under ${key}`);
        assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications'), 1);
        assert.equal(prepare(OTHER).ok, true, 'another place of the same entry is not retired');
      } finally {
        handle.close();
      }
    }
});

// ---------- the diary's mirrors ----------

const POSTS = 51;
const messageOf = (n: number) => `5100000000000000${String(n).padStart(2, '0')}`;

/** A data directory whose diary has 51 mirrored posts (the said lines of the first ten in the record), in a new database. */
function seededAtBaseline() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-v10-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const posts = Array.from({ length: POSTS }, (_, n) => ({
    at: 1792000000000 + n * 86_400_000,
    kind: 'day',
    gist: `day ${n}`,
    picture: null,
    messageIds: [messageOf(n)],
    search: null,
    itemId: `entry-${n}`,
  }));
  writeJson(path.join(guildDir(data), 'diary.json'), { updatedAt: 1792000000000, posts });
  writeLines(
    path.join(guildDir(data), 'record', '2026-10', '2026-10-22.jsonl'),
    Array.from({ length: 10 }, (_, n) => ({
      v: 1,
      id: `r-said-${n}`,
      kind: 'said',
      messageId: messageOf(n),
      revision: 1,
      occurredAt: '2026-10-22T09:00:00.000Z',
      recordedAt: '2026-10-22T09:00:01.000Z',
      placeId: '300000000000000001',
      scope: { channel: CHANNEL },
      text: `Ημερολόγιο ${n}`,
      participants: [],
    }))
  );
  const file = path.join(root, 'memory.db');
  const old = openMemoryDb(file);
  // @ts-expect-error the test fixture takes no `log` option; the test passes one and the fixture ignores it
  assert.equal(seedUnits(old, data, { log: quiet, now: () => NOW }).errors, 0);
  // The diary media job has fetched the text of the first twenty posts.
  for (let n = 0; n < 20; n += 1)
    dbOf(old).prepare('UPDATE diary SET text = ? WHERE id = ?').run(`Ημερολόγιο ${n}`, `entry-${n}`);
  // The diary written again, so the publications of those posts carry the hash of their text.
  // @ts-expect-error the test fixture takes no `log` option; the test passes one and the fixture ignores it
  assert.equal(seedUnits(old, data, { log: quiet, now: () => NOW }).errors, 0);
  old.close();
  return { root, data, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const publicationsOf = (db: Db) =>
  db
    .prepare('SELECT * FROM publications ORDER BY id')
    .all()
    .map((row) => ({ ...row }));

test('v10: a rewrite of the diary keeps the publication; database rows survive', () => {
  const env = seededAtBaseline();
  try {
    const handle = openMemoryDb(env.file);
    const db = dbOf(handle);
    const before = publicationsOf(db);
    // A row the database owns, a prepared publication: the diary's writes never touch it.
    const ctx = issueContext({
      iface: 'discord',
      kind: 'group',
      destination: `discord:channel:${CHANNEL}`,
      now: () => NOW,
      newId: () => 'ctx:out:remap',
    });
    const own = preparePublication(handle, {
      context: ctx,
      rowKind: 'diary',
      rowId: 'entry-0',
      rendered: 'Une autre fois.',
      destination: `discord:channel:${CHANNEL}`,
      producedIn: ctx,
      now: NOW,
    });
    assert.equal(own.ok, true);
    // A rewrite: the diary gains a post and a text arrives for an old one (the hash is filled once, then kept).
    db.prepare('UPDATE diary SET text = ? WHERE id = ?').run('Ημερολόγιο 30', 'entry-30');
    const file = path.join(guildDir(env.data), 'diary.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.posts.push({
      at: 1799000000000,
      kind: 'day',
      gist: 'new',
      picture: null,
      messageIds: ['5199999999999999'],
      search: null,
      itemId: 'entry-new',
    });
    writeJson(file, value);
    // @ts-expect-error the test fixture takes no `log` option; the test passes one and the fixture ignores it
    assert.equal(seedUnits(handle, env.data, { log: quiet, now: () => NOW + 3_600_000 }).errors, 0);
    const after = publicationsOf(db);
    assert.equal(after.length, before.length + 2, 'the new mirror and the prepared one; nothing doubled');
    for (const row of before) {
      const now = after.find((entry) => entry.id === row.id);
      assert.ok(now, `${row.id as string} kept`);
      assert.equal(now.idempotency_key, row.idempotency_key);
      assert.equal(now.retired_at, null);
      if (row.row_id === 'entry-30') assert.equal(now.content_hash, contentHash('Ημερολόγιο 30'));
      else assert.deepEqual(now, row);
    }
    assert.equal(after.find((entry) => entry.row_id === 'entry-new')!.status, 'sent');
    assert.equal(publicationOf(handle, own.publication!.id)!.status, 'queued');
    // A rewrite of the old diary (the new post gone) retires only that mirror's publication.
    value.posts.pop();
    writeJson(file, value);
    // @ts-expect-error the test fixture takes no `log` option; the test passes one and the fixture ignores it
    assert.equal(seedUnits(handle, env.data, { log: quiet, now: () => NOW + 7_200_000 }).errors, 0);
    assert.ok(
      publicationsOf(db).find((entry) => entry.row_id === 'entry-new')!.retired_at,
      'the mirror left the file: its publication is retired'
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications WHERE retired_at IS NOT NULL'), 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    handle.close();
  } finally {
    env.done();
  }
});

test('publish: an open group context is bound to its origin chat exactly as a closed one', () => {
  // Bug: the mark that opens reads to every audience reaches the publication boundary and lets a text go elsewhere.
  const { handle, db } = fixture();
  try {
    const context = (destination: string, open: boolean) =>
      issueContext({ iface: 'discord', kind: 'group', destination, open, now: () => NOW, newId: () => 'ctx:same' });
    const opened = context(GENERAL, true);
    assert.equal(opened.open, true);
    assert.deepEqual(contextRow(opened), contextRow(context(GENERAL, false)));
    const attempt = (destination: string, producedIn: string) =>
      preparePublication(handle, {
        context: opened,
        rowKind: 'diary',
        rowId: 'entry-1',
        rendered: DRAFT,
        destination,
        producedIn: context(producedIn, true),
        now: NOW,
      });
    assert.deepEqual(attempt(OTHER, OTHER), { ok: false, code: 'destination-mismatch' });
    assert.deepEqual(attempt(GENERAL, OTHER), { ok: false, code: 'no-grant' });
    assert.equal(attempt(GENERAL, GENERAL).ok, true);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM publications WHERE destination_place_id = ?', OTHER), 0);
  } finally {
    handle.close();
  }
});

test('mirrorPublicationRow: the derived row of a mirror (pure)', () => {
  const row = mirrorPublicationRow(
    {
      id: 'mirror:e:discord:',
      diary_id: 'e',
      iface: 'discord',
      place_id: null,
      native_ids: '["1","2"]',
      posted_at: null,
      writer: 'diary',
      holder_id: 'persona:local',
      retired_at: null,
    },
    { text: 'Café', placeExists: false, at: '2026-10-24T00:00:00.000Z' }
  );
  assert.deepEqual(row, {
    id: 'mirror:e:discord:',
    row_kind: 'diary',
    row_id: 'e',
    content_hash: contentHash('Café'),
    rendered: 'Café',
    destination_place_id: null,
    context_id: null,
    status: 'sent',
    idempotency_key: 'diary:e:',
    receipts: JSON.stringify([
      { authority: 'discord/global', kind: 'message', key: '1' },
      { authority: 'discord/global', kind: 'message', key: '2' },
    ]),
    created_at: '2026-10-24T00:00:00.000Z',
    sent_at: null,
    writer: 'diary',
    holder_id: 'persona:local',
    retired_at: null,
  });
  assert.equal(contentHash('Café').length, 64);
});

// The persona's publication audience. A diary request shows the places they can name; their
// `<audience>` picks unrestricted, one interface or one canonical place with its descendants; leaving it out on a new
// entry means unrestricted across eligible mirrors, mirrors added later included. An unknown or malformed value fails
// closed with a concrete result. The audience is read again at queue time and right before a send, and it only ever
// narrows what trusted restrictions allow. Old entries keep what they had. Real turn, real store and memory, a scripted
// model and fake transports; assertions read request blocks, never prose. Synthetic data only.

const TEXT = 'ήσυχο βράδυ στο λιμάνι';
const OTHER_D1 = 'other:channel:d1';

/**
 * Two interfaces that share native ids: `fake` and `other`, each with a root `g1` and a channel `d1`, `fake` with
 * another channel `d2` and a channel `d3` outside the root, a private chat, and enabled mirrors as named.
 */
async function places(mirrorOn: ReadonlyArray<'fake:d1' | 'fake:d2' | 'fake:d3' | 'other:d1'> = []) {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fakeRoot = scene.place({ iface: 'fake', native: 'g1', kind: 'root' });
  const otherRoot = scene.place({ iface: 'other', native: 'g1', kind: 'root' });
  scene.place({ iface: 'fake', native: 'd1', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd2', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd3' });
  scene.place({ iface: 'other', native: 'd1', parent: otherRoot });
  scene.place({ iface: 'fake', native: 'u1', kind: 'dm' });
  for (const one of mirrorOn) {
    const [iface, chatId] = one.split(':') as [string, string];
    scene.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

test('the writer itself refuses a publication outside the stored audience', async () => {
  // Catches: the audience enforced only in the publisher, so a direct prepare queues around it.
  const scene = await places(['fake:d1', 'other:d1']);
  scene.entry({ id: 'e1', audience: { kind: 'interface', iface: 'fake' } });
  const context = issueContext({ kind: 'group', iface: 'other', destination: OTHER_D1, now: scene.now });
  const { memoryDb: sceneDb } = scene.memory;
  const answer = await sceneDb.memoryWrite({
    kind: 'publication',
    op: 'prepare',
    input: { context, rowKind: 'diary', rowId: 'e1', rendered: TEXT, destination: OTHER_D1 },
  });
  assert.deepEqual(answer, { ok: false, code: 'audience-excluded' });
});

// PR B: paced historical backfill per mirror (plan section 6). Each mirror holds its interval, enabled state, the
// high-water mark captured at the start and its next due time. The oldest eligible entry goes first, by persisted order,
// one per interval, with no burst after downtime. A blocked entry holds back the later old entries of that mirror,
// visibly, and new entries go out at once and never move the finish line. The drain the scheduler already runs does the
// sending. Injected clock, real memory, fake transports; synthetic data only.

const D1 = 'fake:channel:d1';
const ON = { enabled: true, intervalMs: FOUR_HOURS } as const;

/** A scene whose place `d1` is known, holding old entries `e1`..`e<count>`, oldest first, before T0. */
async function oldEntries(count: number) {
  const scene = await mirrorScene();
  scene.place({ iface: 'fake', native: 'd1' });
  for (let i = 1; i <= count; i += 1) scene.entry({ id: `e${i}`, at: T0 - (count + 1 - i) * HOUR, position: i });
  return { scene, transport: scene.transport(), mirrors: scene.publisher() };
}

const statusOf = (mirrors: ReturnType<Scene['publisher']>) => {
  const [first] = mirrors.mirrorStatus();
  assert.ok(first, 'the mirror is listed');
  return first;
};

/** A publication an upgrade retired: `e1` to `d1` in `status`, under the standard key or a legacy one. */
function retiredPublication(scene: Scene, status: string, key: string): void {
  scene.db
    .prepare(
      `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status,
         idempotency_key, created_at, retired_at) VALUES ('pub:retired', 'diary', 'e1', 'h', 'text of e1', ?, ?, ?, ?, ?)`
    )
    .run(D1, status, key, new Date(T0).toISOString(), new Date(T0).toISOString());
}

/** A copy of `e1` to `d1` queued under another key before the upgrade and still active, in `status` with `delivery`. */
function activeCopy(scene: Scene, status: string, delivery: string | null): void {
  scene.db
    .prepare(
      `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status,
         idempotency_key, created_at, delivery) VALUES ('pub:copy', 'diary', 'e1', 'h', 'text of e1', ?, ?, ?, ?, ?)`
    )
    .run(D1, status, `diary:e1:${D1}`, new Date(T0).toISOString(), delivery);
}

const PARTIAL = JSON.stringify({
  messages: ['text of e1'],
  segments: [{ segment: 0, status: 'sent', key: 'k:0', messageIds: ['m0'], attachmentIds: [] }],
});

for (const { status, delivery } of [
  { status: 'queued', delivery: null },
  { status: 'incomplete', delivery: PARTIAL },
] as const)
  test(`a drain never sends a copy left ${status} beside the entry's retired publication and sends the next entry`, async () => {
    // Catches: a send path that checks only the row's own retirement, so a copy queued under another key before the
    // upgrade goes out though the entry's publication to that place was retired.
    const { scene, transport, mirrors } = await oldEntries(2);
    retiredPublication(scene, 'queued', `grant:g1:e1:${D1}`);
    activeCopy(scene, status, delivery);
    const before = scene.db.prepare("SELECT * FROM publications WHERE id = 'pub:retired'").get();
    await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
    assert.equal(await mirrors.drainQueued(), 1);
    for (let i = 0; i < 3; i += 1) {
      scene.advance(FOUR_HOURS);
      assert.equal(await mirrors.drainQueued(), 0);
    }
    assert.deepEqual(transport.posted('d1'), ['text of e2']);
    assert.equal(statusOf(mirrors).backfill.enabled, false, 'done');
    assert.deepEqual(scene.db.prepare("SELECT * FROM publications WHERE id = 'pub:retired'").get(), before);
    const copy = scene.db
      .prepare("SELECT status, code, receipts, sent_at, delivery FROM publications WHERE id = 'pub:copy'")
      .get();
    assert.deepEqual(
      [copy?.status, copy?.code, copy?.receipts, copy?.sent_at, copy?.delivery],
      ['failed', 'retired', null, null, delivery]
    );
  });

// The grant a diary mirror gives `preparePublication` (src/memory/db/publish.ts): an enabled `diary` mirror of a place
// is the owner's grant, intersected with the stored restriction of the entry, which `recheck` reads again. The
// restriction also hides the media of a saved entry. The publisher's own tests are in tests/src/behavior/mirror.test.ts.
// Every entry comes from a real diary turn over a real store and memory database, on the fake interface, with a
// scripted model. Synthetic text only.
describe('mirror grants', () => {
  const TEXT = 'ήσυχο βράδυ στο λιμάνι';

  /** The memory databases the scenes opened, closed when the file is done. */
  const OPEN: Array<{ close(): unknown }> = [];
  after(async () => {
    for (const item of OPEN.splice(0)) await item.close();
  });

  /**
   * A core with the fake interface (chats `d1` and `d2` of the root), a real store over a memory database
   * holding the mirrors of `mirrors`, the publisher over both, and the diary turn whose entry a test hands to the
   * publisher. `link.connected` is whether an interface is connected (the publisher's port, or none).
   */
  async function scene({
    mirrors: specs,
    connected = true,
  }: {
    mirrors: Array<{ chatId: string; enabled?: boolean }>;
    connected?: boolean;
  }) {
    const memory = await openTestMemory({ now: () => MIRROR_NOW });
    OPEN.push(memory);
    freshWorld();
    world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
    world().channel({ id: 'd2', name: 'notes', placeId: ROOT });
    const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
    const places = specs.map((spec) => seedMirror(memory.memoryDb, { iface: 'fake', at: MIRROR_NOW, ...spec }).placeId);
    const link = { connected };
    const mirrors = createMirrors({
      memoryDb: memory.memoryDb,
      port: () => (link.connected ? world().port : null),
      now: () => MIRROR_NOW,
      // Where the entry's pictures and voice are kept until they are sent (the memory service's data directory).
      dataDir: memory.dataDir,
    });
    const turns = sceneRunner(sceneLlm(), store);
    /** One diary turn as the wake runs it, its entry recorded and its writes landed. */
    async function record() {
      const result = await turns.runTurn({
        mode: 'diary',
        diary: { kind: 'status', forced: true },
        placeId: ROOT,
      });
      await store.flushSettled({});
      return entryOf(result);
    }
    /** The persona's messages the interface holds in `chatId`. */
    const texts = (chatId: string) =>
      world()
        .port.messagesIn(chatId)
        .map((message) => message.text);
    return { memory, store, places, link, mirrors, record, texts };
  }

  // ---- preparePublication and the mirror grant --------------------------------------------------------------------

  /** What `preparePublication` (JS) answers, as these tests read it. */
  type Prepared =
    { ok: true; publication: { status: string; content_hash: string } | null } | { ok: false; code: string };
  /** The node:sqlite connection of an `openMemoryDb` handle, as these tests use it. */
  type Db = { prepare(sql: string): { run(...params: Array<unknown>): unknown } };

  const GENERAL = 'discord:channel:c-general';
  const OTHER = 'discord:channel:c-other';
  const DRAFT = 'Σήμερα ήταν ήσυχα.';

  /** A v15 database with two group places, one diary entry, and a diary mirror on GENERAL (`enabled` or not). */
  function grantFixture({ enabled }: { enabled: boolean }) {
    const handle = openMemoryDb(':memory:');
    OPEN.push(handle);
    const at = new Date(MIRROR_NOW).toISOString();
    const place = (id: string, name: string) => ({
      id,
      iface: 'discord',
      kind: 'channel',
      native_id: id.split(':')[2],
      parent_id: null,
      scope_kind: 'group',
      name,
    });
    insertRows(
      handle.db,
      {
        places: [place(GENERAL, 'general'), place(OTHER, 'other')],
        diary: [
          {
            id: 'entry-1',
            at_ms: MIRROR_NOW,
            kind: 'status',
            gist: DRAFT,
            text: DRAFT,
            scope_kind: 'group',
            scope_iface: 'discord',
            scope_dm: null,
          },
        ],
      },
      { at }
    );
    const db = handle.db as Db; // open.js is untyped JS; `db` is its node:sqlite connection
    db.prepare(
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'diary', ?, ?, ?, 'owner', NULL)"
    ).run(GENERAL, enabled ? 1 : 0, at);
    let n = 0;
    const context = (kind: 'group' | 'internal', destination: string | null = null) =>
      issueContext({
        kind,
        iface: 'discord',
        destination,
        now: () => MIRROR_NOW,
        newId: () => `ctx:${kind}:${(n += 1)}`,
      });
    /** The diary entry, written in the wake's internal context, prepared for `destination` (or `rowKind` instead). */
    const prepare = (destination: string, rowKind = 'diary'): Prepared =>
      // publish.js is untyped JS; it answers one of the two shapes of Prepared.
      preparePublication(handle, {
        context: context('group', destination),
        rowKind,
        rowId: 'entry-1',
        rendered: DRAFT,
        destination,
        producedIn: context('internal'),
        now: MIRROR_NOW,
      }) as Prepared;
    return { handle, prepare };
  }

  test('preparePublication queues a diary entry for the place of an enabled mirror without a grant row', () => {
    const { prepare } = grantFixture({ enabled: true });
    const prepared = prepare(GENERAL);
    assert.ok(prepared.ok, 'the mirror is the grant');
    assert.equal(prepared.publication?.status, 'queued');
    assert.equal(prepared.publication.content_hash, contentHash(DRAFT));
  });

  test('preparePublication refuses the same entry to a place with no mirror', () => {
    const { prepare } = grantFixture({ enabled: true });
    assert.deepEqual(prepare(OTHER), { ok: false, code: 'no-grant' });
  });

  test('preparePublication takes a disabled mirror as no grant', () => {
    const { prepare } = grantFixture({ enabled: false });
    assert.deepEqual(prepare(GENERAL), { ok: false, code: 'no-grant' });
  });

  test('preparePublication keeps the grant rule for a row that is not a diary entry, also to a mirrored place', () => {
    const { prepare } = grantFixture({ enabled: true });
    assert.deepEqual(prepare(GENERAL, 'claim'), { ok: false, code: 'no-grant' });
  });

  const RESTRICTED_ENTRY = { kind: 'internal-turn', origin: { iface: 'cli', chatId: 'd1' } } as const;

  async function restrictStoredEntry(core: Awaited<ReturnType<typeof scene>>, metadata: unknown): Promise<void> {
    const posts = core.store.getDiary().posts.map((post) => ({ ...post, publicationBoundary: metadata }));
    core.store.setDiaryPosts(posts);
    await core.store.flushSettled({});
  }

  test('publication preparation intersects the mirror standing grant with the stored restriction', async () => {
    // Catches direct writer preparation bypassing a restriction enforced only in the mirror wrapper.
    const core = await scene({ mirrors: [{ chatId: 'd1' }] });
    const entry = await core.record();
    await restrictStoredEntry(core, RESTRICTED_ENTRY);
    const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => MIRROR_NOW });
    const { memoryDb: coreDb } = core.memory;
    const result = await coreDb.memoryWrite({
      kind: 'publication',
      op: 'prepare',
      input: {
        context,
        rowKind: 'diary',
        rowId: entry.id,
        rendered: TEXT,
        destination: core.places[0],
      },
    });
    assert.deepEqual(result, { ok: false, code: 'not-allowed' });
    assert.deepEqual(diaryPublications(core.memory.memoryDb), []);
  });

  test('recheck refuses a queued diary publication whose stored origin became restricted', async () => {
    // Catches treating an earlier standing grant as permanent permission after private content replaces the entry.
    const core = await scene({ mirrors: [{ chatId: 'd1' }], connected: false });
    const entry = await core.record();
    await core.mirrors.queueEntry(entry);
    await restrictStoredEntry(core, RESTRICTED_ENTRY);
    const { memoryDb: coreDb } = core.memory;
    const handle = coreDb.readHandle();
    assert.ok(handle);
    const publication = mirrorDbOf(core.memory.memoryDb)
      .prepare("SELECT id FROM publications WHERE row_kind = 'diary'")
      .all()[0];
    assert.ok(publication && typeof publication.id === 'string');
    const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => MIRROR_NOW });
    assert.deepEqual(recheck(handle, publication.id, context), { ok: false, code: 'not-allowed' });
  });

  test('a stored restriction refuses publication when its destination has no native route', async () => {
    // Catches interpreting a missing native destination as an unrestricted mirror.
    const core = await scene({ mirrors: [{ chatId: 'd1' }] });
    const entry = await core.record();
    await restrictStoredEntry(core, { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'd1' } });
    mirrorDbOf(core.memory.memoryDb).prepare('UPDATE places SET native_id = NULL WHERE id = ?').run(core.places[0]);
    const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => MIRROR_NOW });
    const { memoryDb: coreDb } = core.memory;
    const result = await coreDb.memoryWrite({
      kind: 'publication',
      op: 'prepare',
      input: {
        context,
        rowKind: 'diary',
        rowId: entry.id,
        rendered: TEXT,
        destination: core.places[0],
      },
    });
    assert.deepEqual(result, { ok: false, code: 'not-allowed' });
    assert.deepEqual(diaryPublications(core.memory.memoryDb), []);
  });
});

// The other order of one send: the record line lands before the interface's echo of the same message. The two must
// still be one `sources` row, and that row must read as the one the echo-first order leaves. Synthetic data only.

const FIRST_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = FIRST_NOW - 60_000;
const IFACE = 'synthetic';
const FIRST_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, FIRST_ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'τα κλειδιά στο συρτάρι';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function observeLine(
  memory: Memory,
  {
    id = 'sent-1',
    author = SELF_ID,
    at = SENT,
    replyToId,
  }: { id?: string; author?: string; at?: number; replyToId?: string } = {}
): Promise<string> {
  const event = {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: FIRST_ROOT },
    addressing: { mentionedAccountIds: [] },
    message: {
      id,
      at,
      content: WORDS,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
  const envelope = observationOf(event, { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

async function recordSent(memory: Memory): Promise<void> {
  const line = toRecordLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds: [] },
    { kind: 'said', now: () => FIRST_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => FIRST_NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

const saidRows = (db: Db): Array<Row> => db.prepare("SELECT * FROM sources WHERE kind = 'said' ORDER BY rowid").all();

function publishTo(db: Db, id: string, place: unknown): void {
  db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, status, idempotency_key, receipts, created_at, destination_place_id)
     VALUES (?, 'diary', 'entry-1', 'sent', ?, ?, ?, ?)`
  ).run(
    id,
    id,
    JSON.stringify([{ authority: `${IFACE}/global`, kind: 'message', key: 'sent-1' }]),
    new Date(SENT).toISOString(),
    place
  );
}

const publicationEdges = (db: Db): Array<unknown> =>
  db
    .prepare("SELECT evidence_id FROM graph_edges WHERE predicate = 'publication_source' AND retired_at IS NULL")
    .all()
    .map((row) => row.evidence_id);

test("a publication sent before the persona's line reaches the line that holds the family key", async () => {
  // Bug: the receipt names the protocol id, the stored line the family key, so the edge never forms.
  const memory = await openTestMemory({ now: () => FIRST_NOW, iface: () => IFACE });
  try {
    const db = database(memory);
    await observeLine(memory, { id: 'member-1', author: MEMBER, at: SENT - 1000 });
    const place = db.prepare("SELECT place_id FROM sources WHERE kind = 'seen'").get()?.place_id;
    publishTo(db, 'pub-1', place);
    await observeLine(memory);
    await recordSent(memory);
    assert.deepEqual(publicationEdges(db), [saidRows(db)[0]?.id]);
  } finally {
    await memory.close();
  }
});
