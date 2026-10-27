// Schema v15 (stage 3 design, section 5): the `mirrors` table, and a data step that seeds the diary's one mirror from
// the deployment's diary channel. The opener passes that channel's place as `context.diaryPlaceId`, the same context v12
// uses. Opened without it (a tool), the step leaves the meta key `diary_mirror_pending`, and the first open that knows
// the channel seeds the row. A database at v14 here holds the legacy diary and its `diary_mirrors` history from the
// data directory fixture. The same step turns her messages in the mirror place that belong to no entry into entries
// (section 10, "The past"). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { CHANNEL, buildDataDir } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';
import { insertRows } from '../src/memory/db/rows.js';
import { applyUnitWrite } from '../src/memory/db/unit-write.js';
import { applyDiaryUpdate, createDiaryMedia } from '../src/memory/db/diary-media.js';
import { createFakeAdapter } from '../src/interface/fake.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const PLACE = channelPlaceId('discord', CHANNEL);
const PENDING = 'diary_mirror_pending';

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: Array<unknown>): Array<Row> } };

/** The node:sqlite connection of an `openMemoryDb` handle (open.js is untyped JS). */
const dbOf = (handle: { db: unknown }): Db => handle.db as Db;

/** A database file at schema v14 that holds the legacy diary with its `diary_mirrors` history. */
function v14File(): string {
  const data = path.join(tempDir('nep-v15-'), 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(data, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 14) });
  try {
    seedUnits(old, data, { now: () => NOW });
    assert.ok(
      dbOf(old).prepare('SELECT COUNT(*) AS n FROM diary_mirrors').all()[0]?.n !== 0,
      'the fixture holds mirror history'
    );
  } finally {
    old.close();
  }
  return file;
}

/** What one open of `file` leaves: the mirror rows and the pending key. */
function openAndRead(file: string, context: { diaryPlaceId?: string | null } = {}) {
  const handle = openMemoryDb(file, { context });
  try {
    const db = dbOf(handle);
    return {
      mirrors: db
        .prepare('SELECT id, row_kind, place_id, enabled, created_at, created_by, extra FROM mirrors ORDER BY id')
        .all(),
      pending: db.prepare('SELECT value FROM meta WHERE key = ?').all(PENDING).length > 0,
    };
  } finally {
    handle.close();
  }
}

test('on a v14 database with mirror history and a known diary channel the step seeds one mirror the owner made', () => {
  const after = openAndRead(v14File(), { diaryPlaceId: PLACE });
  assert.deepEqual(
    after.mirrors.map((row) => [row.row_kind, row.place_id, row.enabled, row.created_by]),
    [['diary', PLACE, 1, 'owner']]
  );
  assert.equal(after.pending, false);
});

test('a second open with the channel changes no mirror row', () => {
  const file = v14File();
  const first = openAndRead(file, { diaryPlaceId: PLACE });
  const second = openAndRead(file, { diaryPlaceId: PLACE });
  assert.deepEqual(second.mirrors, first.mirrors);
});

test('opened without the channel the step seeds nothing and leaves the pending key', () => {
  const after = openAndRead(v14File());
  assert.deepEqual(after.mirrors, []);
  assert.equal(after.pending, true);
});

test('the first open that knows the channel after a pending one seeds the mirror and clears the key', () => {
  const file = v14File();
  openAndRead(file);
  const after = openAndRead(file, { diaryPlaceId: PLACE });
  assert.deepEqual(
    after.mirrors.map((row) => [row.row_kind, row.place_id, row.enabled, row.created_by]),
    [['diary', PLACE, 1, 'owner']]
  );
  assert.equal(after.pending, false);
});

// ---- her past messages in a mirror place become entries (stage 3 design, section 10, "The past") ----------------

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const MIRROR_CHANNEL = '300000000000000777';
const MIRROR_PLACE = channelPlaceId('discord', MIRROR_CHANNEL);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

type Line = {
  id: string;
  at: number;
  text: string;
  turnId?: string | null;
  image?: boolean;
  channel?: string;
  by?: string;
};

/** Her messages in the mirror place and elsewhere, and one line of someone else's, as the record keeps them. */
const LINES: ReadonlyArray<Line> = [
  // An inner turn's two messages: one entry.
  { id: 'i1', at: T0, text: 'ένα', turnId: 'turn-inner' },
  { id: 'i2', at: T0 + 30 * SECOND, text: 'δύο', turnId: 'turn-inner' },
  // An ordinary turn's message, and a picture with no turn a minute after it: one entry.
  { id: 'r1', at: T0 + HOUR, text: 'απάντηση', turnId: 'turn-reply' },
  { id: 'p1', at: T0 + HOUR + MINUTE, text: '', turnId: null, image: true },
  // A message with no turn and no entry within two minutes: an entry of its own.
  { id: 'l1', at: T0 + 3 * HOUR, text: 'μόνο', turnId: null },
  // The message of the entry the diary already holds, and a picture with no turn a minute after it, which joins it.
  { id: 'e1', at: T0 - 24 * HOUR, text: 'παλιό', turnId: 'turn-old' },
  { id: 'q1', at: T0 - 24 * HOUR + MINUTE, text: '', turnId: null, image: true },
  // Not hers, and hers elsewhere: no part of her diary.
  { id: 'x1', at: T0 + 2 * HOUR, text: 'όχι δικό της', by: '100000000000000009' },
  { id: 'o1', at: T0 + 2 * HOUR, text: 'αλλού', turnId: 'turn-else', channel: '300000000000000888' },
];

/** A record line of `line`: hers (`said`, with its turn) or someone's (`seen`). */
function recordLineOf(line: Line): Record<string, unknown> {
  return {
    v: 1,
    id: `rec-${line.id}`,
    kind: line.by ? 'seen' : 'said',
    messageId: line.id,
    revision: 1,
    occurredAt: new Date(line.at).toISOString(),
    recordedAt: new Date(line.at).toISOString(),
    guildId: 'g1',
    scope: { channel: line.channel ?? MIRROR_CHANNEL },
    ...(line.by ? { by: line.by } : { turnId: line.turnId ?? null, opId: null }),
    replyTo: null,
    text: line.text,
    media: line.image ? ['image'] : [],
    mentions: [],
    participants: [],
    sourceMessageIds: [line.id],
    origin: 'live',
  };
}

type Handle = ReturnType<typeof openMemoryDb>;

/** A database file at schema v14 whose record holds `LINES` and whose diary holds the one entry posted as `e1`. */
function pastFile(): string {
  const file = path.join(tempDir('nep-v15-past-'), 'memory.db');
  const old: Handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 14) });
  try {
    const at = new Date(T0).toISOString();
    insertRows(
      old.db,
      {
        places: [
          {
            id: MIRROR_PLACE,
            iface: 'discord',
            kind: 'channel',
            native_id: MIRROR_CHANNEL,
            parent_id: null,
            scope_kind: 'group',
            name: 'journal',
          },
        ],
      },
      { at }
    );
    for (const line of LINES) {
      const day = new Date(line.at).toISOString().slice(0, 10);
      applyUnitWrite(old, {
        kind: 'unit',
        op: 'lines',
        owner: `guilds/g1/record/${day.slice(0, 7)}/${day}.jsonl`,
        lines: [recordLineOf(line)],
        now: T0,
      });
    }
    applyUnitWrite(old, {
      kind: 'unit',
      op: 'value',
      owner: 'guilds/g1/diary.json',
      value: {
        updatedAt: T0,
        posts: [
          {
            at: T0 - 24 * HOUR,
            kind: 'status',
            gist: 'παλιό',
            picture: null,
            messageIds: ['e1'],
            search: null,
            itemId: 'old-1',
          },
        ],
      },
      now: T0,
    });
  } finally {
    old.close();
  }
  return file;
}

/** What the step's entries are: each live diary row's text, and the message keys and state of its publications. */
function entriesOf(file: string) {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    return db
      .prepare('SELECT id, at_ms, text FROM diary WHERE retired_at IS NULL ORDER BY at_ms, id')
      .all()
      .map((row) => ({
        id: String(row.id),
        text: row.text ?? null,
        publications: db
          .prepare(
            "SELECT status, destination_place_id, receipts FROM publications WHERE row_kind = 'diary' AND row_id = ?"
          )
          .all(row.id)
          .map((publication) => ({
            status: publication.status,
            placeId: publication.destination_place_id,
            keys: (
              JSON.parse(typeof publication.receipts === 'string' ? publication.receipts : '[]') as Array<{
                key: string;
              }>
            )
              .map((receipt) => receipt.key)
              .sort(),
          })),
      }));
  } finally {
    handle.close();
  }
}

/** Every row of the tables the step writes, to compare two opens. */
function dumpOf(file: string): Record<string, Array<Row>> {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      diary: all('diary'),
      publications: all('publications'),
      media: all('media'),
      diary_mirrors: all('diary_mirrors'),
    };
  } finally {
    handle.close();
  }
}

// The lone message (`l1`, three hours from any other) is the case of a turnless message more than two minutes from every
// entry: it becomes an entry of its own.
test("the v15 step turns her mirror place's messages of no entry into entries, one per turn, nothing sent", () => {
  const file = pastFile();
  const before = entriesOf(file).find((entry) => entry.id === 'old-1');
  assert.deepEqual(
    before?.publications.map((publication) => publication.keys),
    [['e1']],
    'the fixture: the held entry is published as e1'
  );
  openMemoryDb(file, { context: { diaryPlaceId: MIRROR_PLACE } }).close();
  const entries = entriesOf(file);
  assert.deepEqual(
    entries.filter((entry) => entry.id !== 'old-1').map(({ text, publications }) => ({ text, publications })),
    [
      { text: 'ένα\nδύο', publications: [{ status: 'sent', placeId: MIRROR_PLACE, keys: ['i1', 'i2'] }] },
      { text: 'απάντηση', publications: [{ status: 'sent', placeId: MIRROR_PLACE, keys: ['p1', 'r1'] }] },
      { text: 'μόνο', publications: [{ status: 'sent', placeId: MIRROR_PLACE, keys: ['l1'] }] },
    ],
    'an inner turn, an ordinary turn with the picture next to it, and the lone message'
  );
  // The coordinator, 2026-10-27: a turnless message within two minutes of a held entry's message joins it. The held
  // entry keeps its text and its receipts; its publication gains the joined message.
  const held = entries.find((entry) => entry.id === 'old-1');
  assert.equal(held?.text, before?.text, 'the held entry keeps its text');
  assert.deepEqual(
    held?.publications.map((publication) => publication.keys),
    before?.publications.map((publication) => [...publication.keys, 'q1'].sort()),
    'its publication keeps its receipts and gains the picture message'
  );
});

test('a second open after the v15 step changes no entry, publication or media row', () => {
  const file = pastFile();
  openMemoryDb(file, { context: { diaryPlaceId: MIRROR_PLACE } }).close();
  const settled = dumpOf(file);
  openMemoryDb(file, { context: { diaryPlaceId: MIRROR_PLACE } }).close();
  assert.deepEqual(dumpOf(file), settled);
});

test("the media job gives a step's entry its picture with the attachment id and the description memory holds", async () => {
  const file = pastFile();
  const handle: Handle = openMemoryDb(file, { context: { diaryPlaceId: MIRROR_PLACE } });
  try {
    // What she saw in the picture, as the describer's cache keeps it by the attachment's id.
    insertRows(
      handle.db,
      {
        media: [
          {
            id: 'media:attachment:att-p1',
            kind: 'attachment',
            owner: null,
            path: null,
            native_ref: 'att-p1',
            description: 'a pier at dusk',
            scope_kind: 'group',
            scope_iface: 'discord',
            scope_dm: null,
          },
        ],
      },
      { at: new Date(T0).toISOString() }
    );
    const port = createFakeAdapter({ iface: 'discord', selfId: 'self' });
    for (const line of LINES.filter((one) => !one.by && !one.channel)) {
      port.seed(MIRROR_CHANNEL, { authorId: 'self', text: line.text, messageId: line.id });
      const stored = port.messages.get(`${MIRROR_CHANNEL}/${line.id}`);
      if (stored && line.image)
        stored.attachments = [
          { id: 'att-p1', name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 64 },
        ] as typeof stored.attachments;
    }
    const png = Buffer.from('png-p1');
    const job = createDiaryMedia({
      db: () => handle.db,
      apply: (update: unknown) => applyDiaryUpdate(handle, update),
      port: () => port,
      imageFetcher: () => ({
        fetchAsDataUrl: () =>
          Promise.resolve({
            dataUrl: `data:image/png;base64,${png.toString('base64')}`,
            bytes: png.byteLength,
            contentType: 'image/png',
          }),
      }),
      config: () => ({ image: { referenceMaxBytes: 100_000 }, context: { vision: { fetchTimeoutMs: 1000 } } }),
      dataDir: path.dirname(file),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      sleep: () => Promise.resolve(),
    });
    await job.run();
    const db = dbOf(handle);
    const owner = db
      .prepare("SELECT row_id FROM publications WHERE row_kind = 'diary' AND receipts LIKE '%\"r1\"%'")
      .all()[0]?.row_id;
    const media = db
      .prepare("SELECT native_ref, description FROM media WHERE kind = 'diary' AND owner = ?")
      .all(owner)
      .map((row) => ({
        attachmentId: (JSON.parse(String(row.native_ref)) as { attachmentId?: unknown }).attachmentId,
        description: row.description,
      }));
    assert.deepEqual(media, [{ attachmentId: 'att-p1', description: 'a pier at dusk' }]);
  } finally {
    handle.close();
  }
});
