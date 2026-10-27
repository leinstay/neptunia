// Her diary in memory is the truth of what she posted (the owner, 2026-10-27): an entry is a post of N messages with
// their attachments, and memory holds it whole. The diary media job (src/memory/db/diary-media.js) reads an entry's
// messages through the interface, keeps each attachment's id on the entry's media row (`native_ref.attachmentId`) with
// the description memory already holds for that attachment (the `media` row of kind `attachment` and the same id),
// fills an entry's missing text, and completes an older media row that holds only `{ url, messageId }`, once. A fake
// adapter and a fake image fetcher; synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { insertRows } from '../src/memory/db/rows.js';
import { applyDiaryUpdate, createDiaryMedia } from '../src/memory/db/diary-media.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { tempDir } from './fixtures/tmp.js';

const AT = '2026-10-27T12:00:00.000Z';
const PLACE = 'fake:channel:d1';
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { run(...params: Array<unknown>): unknown; all(...params: Array<unknown>): Array<Row> };
};

/** The handles a test opened, closed when the file is done. */
const OPEN: Array<{ close(): void }> = [];
after(() => {
  for (const handle of OPEN.splice(0)) handle.close();
});

/**
 * A memory database with the diary's mirror on `d1` of the fake interface, the diary rows `entries` (each with the
 * message ids it was posted as) and the describer's cache rows `described` (attachment id -> what she saw), the fake
 * interface holding her messages `messages`, and the diary media job over both.
 */
function scene({
  entries,
  described = {},
  messages,
  media = [],
}: {
  entries: Array<{ id: string; text: string | null; messageIds: Array<string> }>;
  described?: Record<string, string>;
  messages: Array<{ id: string; text: string; attachment?: { id?: string; name: string } }>;
  media?: Array<{ id: string; owner: string; nativeRef: object }>;
}) {
  const dataDir = tempDir('nep-entry-media-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  OPEN.push(handle);
  const db = handle.db as Db; // open.js is untyped JS; `db` is its node:sqlite connection
  const group = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
  insertRows(
    db,
    {
      places: [
        {
          id: PLACE,
          iface: 'fake',
          kind: 'channel',
          native_id: 'd1',
          parent_id: null,
          scope_kind: 'group',
          name: 'journal',
        },
      ],
      diary: entries.map((entry, position) => ({
        id: entry.id,
        at_ms: Date.parse(AT) - (entries.length - position) * 86_400_000,
        kind: 'status',
        gist: entry.text ?? 'a post',
        text: entry.text,
        ...group,
        owner_file: 'guilds/g1/diary.json',
        position,
      })),
      diary_mirrors: entries.map((entry) => ({
        id: `mirror:${entry.id}`,
        diary_id: entry.id,
        iface: 'fake',
        place_id: PLACE,
        native_ids: JSON.stringify(entry.messageIds),
        posted_at: AT,
        owner_file: 'guilds/g1/diary.json',
      })),
      media: [
        ...Object.entries(described).map(([attachmentId, description]) => ({
          id: `media:attachment:${attachmentId}`,
          kind: 'attachment',
          owner: null,
          path: null,
          native_ref: attachmentId,
          description,
          ...group,
        })),
        ...media.map((item) => ({
          id: item.id,
          kind: 'diary',
          owner: item.owner,
          path: `media/diary/${item.id}.png`,
          native_ref: JSON.stringify(item.nativeRef),
          description: null,
          mime: 'image/png',
          ...group,
        })),
      ],
    },
    { log: SILENT, at: AT }
  );
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'diary', ?, 1, ?, 'owner', NULL)"
  ).run(PLACE, AT);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  const pictures = new Map<string, Buffer>();
  for (const message of messages) {
    const ref = port.seed('d1', { authorId: 'self', text: message.text, messageId: message.id });
    const stored = port.messages.get(`d1/${ref.messageId}`);
    if (stored && message.attachment) {
      const url = `https://cdn.example/${message.attachment.name}`;
      pictures.set(url, Buffer.from(`png-${message.attachment.name}`));
      // The adapter's read of a message names each attachment by the platform's id, when the platform gives one.
      const named = message.attachment.id ? { id: message.attachment.id } : {};
      stored.attachments = [
        { ...named, name: message.attachment.name, url, contentType: 'image/png', size: 64 },
      ] as typeof stored.attachments;
    }
  }
  const fetcher = {
    fetchAsDataUrl: (url: string) => {
      const bytes = pictures.get(url);
      return Promise.resolve(
        bytes
          ? {
              dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
              bytes: bytes.byteLength,
              contentType: 'image/png',
            }
          : null
      );
    },
  };
  const job = () =>
    createDiaryMedia({
      db: () => handle.db,
      apply: (update: unknown) => applyDiaryUpdate(handle, update),
      port: () => port,
      imageFetcher: () => fetcher,
      config: () => ({ image: { referenceMaxBytes: 100_000 }, context: { vision: { fetchTimeoutMs: 1000 } } }),
      dataDir,
      log: SILENT,
      sleep: () => Promise.resolve(),
    });
  /** The diary media rows of `owner`: their id, the attachment id their native ref names, and their description. */
  const mediaOf = (owner: string) =>
    db
      .prepare("SELECT id, native_ref, description FROM media WHERE kind = 'diary' AND owner = ? ORDER BY id")
      .all(owner)
      .map((row) => ({
        id: String(row.id),
        attachmentId: (JSON.parse(String(row.native_ref)) as { attachmentId?: unknown }).attachmentId ?? null,
        description: row.description ?? null,
      }));
  const textOf = (id: string) => db.prepare('SELECT text FROM diary WHERE id = ?').all(id)[0]?.text ?? null;
  const fetches = () => port.calls.filter((call) => call.op === 'fetchMessages').length;
  const dump = () =>
    db.prepare("SELECT id, native_ref, description, sha1 FROM media WHERE kind = 'diary' ORDER BY id").all();
  return { job, mediaOf, textOf, fetches, dump, dataDir };
}

test("an entry's picture row keeps the attachment id and the description memory holds for it", async () => {
  const s = scene({
    entries: [{ id: 'd-1', text: null, messageIds: ['m1', 'm2'] }],
    described: { 'att-1': 'a wooden pier at dusk' },
    messages: [
      { id: 'm1', text: 'βόλτα στο λιμάνι' },
      { id: 'm2', text: '', attachment: { id: 'att-1', name: 'pier.png' } },
    ],
  });
  await s.job().run();
  assert.deepEqual(s.mediaOf('d-1'), [
    { id: 'media:diary:d-1-1', attachmentId: 'att-1', description: 'a wooden pier at dusk' },
  ]);
});

test('an entry without text gets its text filled from its messages', async () => {
  const s = scene({
    entries: [{ id: 'd-1', text: null, messageIds: ['m1'] }],
    messages: [{ id: 'm1', text: 'ήσυχη μέρα' }],
  });
  await s.job().run();
  assert.equal(s.textOf('d-1'), 'ήσυχη μέρα');
});

test('an older picture row with only its url and message is completed once, and a second start changes nothing', async () => {
  const s = scene({
    entries: [{ id: 'd-2', text: 'παλιό', messageIds: ['m3'] }],
    described: { 'att-2': 'two boats in fog' },
    messages: [{ id: 'm3', text: 'παλιό', attachment: { id: 'att-2', name: 'boats.png' } }],
    media: [
      { id: 'media:diary:d-2-1', owner: 'd-2', nativeRef: { url: 'https://cdn.example/boats.png', messageId: 'm3' } },
    ],
  });
  await s.job().run();
  assert.deepEqual(s.mediaOf('d-2'), [
    { id: 'media:diary:d-2-1', attachmentId: 'att-2', description: 'two boats in fog' },
  ]);
  const settled = s.dump();
  const asked = s.fetches();
  assert.equal(asked, 1, 'the older entry was read once');
  await s.job().run();
  assert.equal(s.fetches(), asked, 'a second start asks the interface for nothing');
  assert.deepEqual(s.dump(), settled);
  assert.ok(fs.existsSync(s.dataDir));
});

test('an older picture row the read cannot name is still read exactly once across two starts', async () => {
  const s = scene({
    entries: [{ id: 'd-3', text: 'παλιό', messageIds: ['m4'] }],
    messages: [{ id: 'm4', text: 'παλιό', attachment: { name: 'harbour.png' } }],
    media: [
      { id: 'media:diary:d-3-1', owner: 'd-3', nativeRef: { url: 'https://cdn.example/harbour.png', messageId: 'm4' } },
    ],
  });
  await s.job().run();
  await s.job().run();
  assert.equal(s.fetches(), 1, 'the interface is asked for the older entry once');
});
