// The media backfill (src/memory/db/media-backfill.ts): for each old line whose linked items lack their reference, read its
// message through the interface's history, match it by message id, and write the one format (`media`, `media_links`) through
// the one writer, with stems and vectors filled once per item. A message the platform no longer returns is `gone`, a line that
// cannot be read is `bare`, each counted with its reason; a run is idempotent and resumable; no model call for a text form
// already held. Tested over a fake interface: a pure core and an interface read. Synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMediaBackfill, BACKFILL_FIELDS, backfillMedia } from '../src/memory/db/media-backfill.ts';
import { lineMedia, tellMedia } from '../src/memory/db/media-store.ts';
import { search } from '../src/memory/db/recall.ts';
import { channelPlaceId, dmPlaceId } from '../src/memory/db/ids.ts';
import { dmContext, internalContext } from '../src/memory/db/scope.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import {
  ALICE,
  AT,
  BOB,
  BOB_PERSON,
  BOB_SCOPE,
  GENERAL,
  GROUP_SCOPE,
  HER,
  KINDS,
  NOW,
  SETTINGS,
  eventOf,
  fixture,
  group,
  heldItem,
  neutralRows,
  observeLine,
} from './fixtures/media-memory.ts';
import { byMeaning, embedLines } from './fixtures/media-memory-embed.ts';
import type { Env, Kind, Scope } from './fixtures/media-memory.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import type { Row } from '../src/memory/db/types.ts';

const IMAGE = KINDS[0];
const MINUTE = 60_000;
const OTHER = channelPlaceId('discord', 'c2');
const CHAT = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const IN_OTHER = { id: 'c2', kind: 'channel', rootId: 'g1' };
const named = (name: string) => KINDS.find((kind) => kind.name === name) as Kind;

/**
 * A source row as the migration left an old one: a bare item per kind with no reference, linked; the columns production's old
 * rows hold; no locator.
 */
function oldRow(
  env: Env,
  {
    native,
    kinds = ['image'],
    at = AT,
    text = '',
    place = GENERAL,
    author = ALICE,
    scope = GROUP_SCOPE,
    extra = {},
  }: {
    native: string;
    kinds?: Array<string>;
    at?: number;
    text?: string;
    place?: string;
    author?: string;
    scope?: Scope;
    extra?: Row;
  }
): string {
  const id = env.say({
    native,
    at,
    text,
    place,
    author,
    scope,
    extra: JSON.stringify({ v: 1, id: `rec-${native}`, participants: [], sourceMessageIds: [native], ...extra }),
  });
  env.db
    .prepare(
      `UPDATE sources SET mentions = '[]', origin = 'import', authority_id = 'discord/global', author_kind = 'account',
       observed_at = occurred_at, seen_at = occurred_at, native_kind = 'message', generation = 1 WHERE id = ?`
    )
    .run(id);
  const item = env.db.prepare(
    `INSERT INTO media (id, kind, availability, scope_kind, scope_iface, scope_dm) VALUES (?, ?, 'unknown', ?, ?, ?)`
  );
  const link = env.db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, ?, ?)"
  );
  kinds.forEach((kind, position) => {
    const mediaId = `media:bare:${native}:${position}`;
    item.run(mediaId, kind, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    link.run(id, position, mediaId);
  });
  return id;
}

/** An interface whose history holds these events: reads by `around`, `after`, `before` and `since`, and notes each read. */
function fakeInterface(events: Array<Row>) {
  const reads: Array<{ chatId: string; query: HistoryQuery }> = [];
  const order = (id: unknown) => BigInt(String(id).replace(/\D/g, '') || '0');
  const read = (chatId: string, query: HistoryQuery) => {
    reads.push({ chatId, query });
    const held = events
      .filter((event) => (event.chat as Row).id === chatId)
      .sort((a, b) => Number(order((a.message as Row).id) - order((b.message as Row).id)));
    const idOf = (event: Row) => order((event.message as Row).id);
    let page = held;
    if (query.around !== undefined) {
      const at = held.findIndex((event) => idOf(event) >= order(query.around));
      const start = Math.max(0, (at < 0 ? held.length : at) - Math.floor(query.limit / 2));
      page = held.slice(start, start + query.limit);
    } else if (query.after !== undefined) {
      page = held.filter((event) => idOf(event) > order(query.after)).slice(0, query.limit);
    } else if (query.before !== undefined) {
      page = held.filter((event) => idOf(event) < order(query.before)).slice(-query.limit);
    } else {
      page = held.slice(-query.limit);
    }
    if (query.since !== undefined) page = page.filter((event) => Number(event.at) >= Number(query.since));
    return Promise.resolve({ status: 'ok' as const, events: page, complete: page.length < query.limit });
  };
  return { read, reads };
}

/** The message of an old row as the interface reads it today. */
const imageEvent = (native: string, at = AT, chat: Row = CHAT) => eventOf(IMAGE, native, [true, true], { at, chat });

function run(env: Env, read: ReturnType<typeof fakeInterface>['read'], over: Row = {}) {
  const described: Array<Row> = [];
  const applied: Array<Row> = [];
  return backfillMedia({
    db: env.db,
    read,
    write: (update: Row) => {
      applied.push(update);
      return Promise.resolve(applyMediaBackfill(env.handle, update));
    },
    describe: (_placeId: string, items: Array<Row>) => {
      described.push(...items);
      return Promise.resolve();
    },
    now: NOW,
    pageSize: 100,
    ...over,
  }).then((report) => ({ report, described, applied }));
}

const mediaFinds = (env: Env, form: string, ctx: unknown = group) =>
  search(env.db, {
    ctx,
    plan: { forms: [form], who: [], from: null, to: null },
    now: NOW,
    settings: SETTINGS,
  }).mediaHits.map((hit) => hit.latest.messageId);

const rowsOf = (env: Env, source: string) => lineMedia(env.db, [source], internalContext(), 'source').get(source) ?? [];

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    await body(env);
  } finally {
    env.done();
  }
}

// ---------- linking ----------

test('an old row gets its references through its message, and a word of a held description then finds it', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1001', kinds: ['image', 'image'] });
    heldItem(env, '1001-a', 'a lighthouse on a cliff');
    fillStems(env.db);
    assert.deepEqual(mediaFinds(env, 'lighthouse'), [], 'before: nothing links the description');
    const { report } = await run(env, fakeInterface([imageEvent('1001')]).read);
    assert.deepEqual([report.linked, report.bare, report.gone], [1, 0, 0]);
    const [first, second] = rowsOf(env, source);
    assert.deepEqual(
      [first.nativeRef, first.extra.fileName, first.description, first.availability],
      ['1001-a', 'p.png', 'a lighthouse on a cliff', 'present']
    );
    assert.deepEqual([second.nativeRef, second.availability], ['1001-b', 'unknown']);
    fillStems(env.db);
    assert.deepEqual(mediaFinds(env, 'lighthouse'), ['1001']);
  }));

test('no bare item is left behind once its line is linked to the held one', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1006', kinds: ['image', 'image'] });
    heldItem(env, '1006-a', 'held');
    await run(env, fakeInterface([imageEvent('1006')]).read);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM media WHERE id LIKE 'media:bare:%'").get()?.n, 0);
  }));

test('two old lines showing the same file become one item with two uses', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1007' });
    oldRow(env, { native: '1008', at: AT + MINUTE });
    heldItem(env, 'same', 'a lighthouse');
    const event = (native: string, at: number) => {
      const made = imageEvent(native, at);
      (made.message as { attachments: Array<Row> }).attachments = [
        { id: 'same', kind: 'image', name: 'p.png', url: 'https://x.invalid/p.png' },
      ];
      return made;
    };
    await run(env, fakeInterface([event('1007', AT), event('1008', AT + MINUTE)]).read);
    fillStems(env.db);
    const [hit] = search(env.db, {
      ctx: group,
      plan: { forms: ['lighthouse'], who: [], from: null, to: null },
      now: NOW,
      settings: SETTINGS,
    }).mediaHits;
    assert.deepEqual([hit.uses, hit.latest.messageId], [2, '1008']);
  }));

for (const kind of KINDS.filter((one) => !one.self)) {
  test(`an old ${kind.name} line ends with the same rows as a new one`, () =>
    withEnv(async (env) => {
      const held = rowsOf(env, observeLine(env, kind, 'absent', { native: '1000' }));
      assert.ok(held.length > 0);
      const source = oldRow(env, { native: '1002', kinds: held.map((row) => String(row.kind)) });
      await run(env, fakeInterface([eventOf(kind, '1002', [false, false], { chat: CHAT })]).read);
      assert.deepEqual(neutralRows(rowsOf(env, source)), neutralRows(held));
    }));
}

test('messages read in one go: five lines close together take one read of the history', () =>
  withEnv(async (env) => {
    const natives = ['1101', '1102', '1103', '1104', '1105'];
    natives.forEach((native, i) => oldRow(env, { native, at: AT + i * MINUTE, kinds: ['image', 'image'] }));
    const { read, reads } = fakeInterface(natives.map((native, i) => imageEvent(native, AT + i * MINUTE)));
    const { report } = await run(env, read);
    assert.equal(report.linked, 5);
    assert.equal(reads.length, 1);
    assert.equal(report.reads, 1);
  }));

test("a message is matched by its id in the line's own chat, never by the same id in another", () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1201', kinds: ['image', 'image'] });
    const other = oldRow(env, { native: '1202', place: OTHER, at: AT + MINUTE, kinds: ['image', 'image'] });
    const { read, reads } = fakeInterface([
      imageEvent('1201'),
      eventOf(IMAGE, '1201', [true, true], { chat: IN_OTHER }),
    ]);
    const { report } = await run(env, read);
    assert.deepEqual([...new Set(reads.map((one) => one.chatId))].sort(), ['c1', 'c2']);
    assert.deepEqual([report.linked, report.gone], [1, 1], 'the other id in c2 is not 1202');
    assert.equal(rowsOf(env, other)[0].nativeRef, null);
  }));

test('a message whose media differ from the kinds stored keeps every kind it has now, position by position', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1203', kinds: ['image', 'link'] });
    const event = imageEvent('1203');
    (event.message as Row).links = [
      { id: 'l1', kind: 'link', url: 'https://x.invalid/a', title: 'page', text: 'words', site: 'x' },
    ];
    (event.message as { attachments: Array<Row> }).attachments.length = 1;
    await run(env, fakeInterface([event]).read);
    assert.deepEqual(
      rowsOf(env, source).map(({ kind, nativeRef, description }) => [kind, nativeRef, description]),
      [
        ['image', '1203-a', null],
        ['link', 'l1', 'words'],
      ]
    );
  }));

test('only the writer changes a row: a run whose writes are dropped leaves the database as it was', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1301', kinds: ['image', 'image'] });
    const snapshot = () => [
      env.db.prepare('SELECT * FROM sources WHERE native_id = ?').get('1301'),
      JSON.stringify(rowsOf(env, source)),
    ];
    const before = snapshot();
    const writes: Array<unknown> = [];
    await run(env, fakeInterface([imageEvent('1301')]).read, {
      write: (update: Row) => {
        writes.push(update);
        return Promise.resolve();
      },
    });
    assert.ok(writes.length > 0);
    assert.deepEqual(snapshot(), before);
  }));

// ---------- a message the platform no longer returns ----------

test('a deleted message is gone and counted with its reason, its item marked and its address kept', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1401' });
    const { report } = await run(env, fakeInterface([]).read);
    assert.deepEqual([report.linked, report.gone, report.classes.deleted], [0, 1, 1]);
    assert.deepEqual(
      rowsOf(env, source).map(({ kind, nativeRef, availability }) => [kind, nativeRef, availability]),
      [['image', null, 'missing']]
    );
    const extra = env.db.prepare('SELECT extra FROM sources WHERE native_id = ?').get('1401')?.extra;
    assert.ok(String(extra).includes('$messageLocator'), 'its address needs no read');
  }));

test('a GIF library row that names a gone message still gives it its text form', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1403', kinds: ['gif'] });
    env.db
      .prepare(
        `INSERT INTO media (id, kind, native_ref, description, availability, extra, scope_kind, scope_iface)
         VALUES ('media:gif:k', 'gif', '1403', 'a pirouette on ice', 'present', ?, 'group', 'discord')`
      )
      .run(JSON.stringify({ itemId: 'item-1' }));
    const { report } = await run(env, fakeInterface([]).read);
    assert.deepEqual([report.gone, report.linked], [0, 1], 'linked through the library row');
    fillStems(env.db);
    assert.deepEqual(mediaFinds(env, 'pirouette'), ['1403']);
  }));

// ---------- idempotent and resumable ----------

test('a second run reads nothing, writes nothing and counts nothing, a gone message included', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1501', kinds: ['image', 'image'] });
    oldRow(env, { native: '1502', at: AT + MINUTE });
    const { read, reads } = fakeInterface([imageEvent('1501')]);
    await run(env, read);
    const rows = JSON.stringify(rowsOf(env, source));
    reads.length = 0;
    const { report, applied } = await run(env, read);
    assert.deepEqual([report.linked, report.gone, report.bare, report.reads, report.reembedded], [0, 0, 0, 0, 0]);
    assert.deepEqual(reads, []);
    assert.deepEqual(applied, []);
    assert.equal(JSON.stringify(rowsOf(env, source)), rows);
  }));

test('a failed read of one place is counted and the next run finishes it without reading the first again', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1601', kinds: ['image', 'image'] });
    const later = oldRow(env, { native: '1602', place: OTHER, at: AT + MINUTE, kinds: ['image', 'image'] });
    const healthy = fakeInterface([imageEvent('1601'), eventOf(IMAGE, '1602', [true, true], { chat: IN_OTHER })]);
    const flaky = (chatId: string, query: HistoryQuery) =>
      chatId === 'c2'
        ? Promise.resolve({ status: 'failed' as const, events: [], complete: false })
        : healthy.read(chatId, query);
    const first = await run(env, flaky as typeof healthy.read);
    assert.deepEqual([first.report.linked, first.report.failedPlaces, first.report.gone], [1, 1, 0]);
    assert.equal(rowsOf(env, later)[0].availability, 'unknown', 'a failed read is no deleted message');
    healthy.reads.length = 0;
    const second = await run(env, healthy.read);
    assert.deepEqual([second.report.linked, second.report.failedPlaces], [1, 0]);
    assert.deepEqual(
      healthy.reads.map((one) => one.chatId),
      ['c2']
    );
  }));

test('an aborted run stops between reads and the next run takes up what is left', () =>
  withEnv(async (env) => {
    const far = 365 * 24 * 60 * MINUTE;
    oldRow(env, { native: '1701', kinds: ['image', 'image'] });
    oldRow(env, { native: '1702', place: OTHER, at: AT - far, kinds: ['image', 'image'] });
    const { read } = fakeInterface([
      imageEvent('1701'),
      eventOf(IMAGE, '1702', [true, true], { at: AT - far, chat: IN_OTHER }),
    ]);
    const controller = new AbortController();
    const stopping = ((chatId: string, query: HistoryQuery) => {
      controller.abort();
      return read(chatId, query);
    }) as typeof read;
    const first = await run(env, stopping, { signal: controller.signal });
    assert.deepEqual([first.report.linked, first.report.stopped], [1, true]);
    const second = await run(env, read);
    assert.deepEqual([second.report.linked, second.report.stopped], [1, false]);
  }));

// ---------- the describe path ----------

test('no model call for a text form we hold', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1801', kinds: ['image', 'image'] });
    heldItem(env, '1801-a', 'one');
    heldItem(env, '1801-b', 'two');
    const { described } = await run(env, fakeInterface([imageEvent('1801')]).read);
    assert.deepEqual(described, []);
  }));

test('a missing text form goes through the describe path once, with the fresh address the read gave', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1802', kinds: ['image', 'image'] });
    heldItem(env, '1802-a', 'held');
    const { described, report } = await run(env, fakeInterface([imageEvent('1802')]).read);
    assert.deepEqual(
      described.map(({ itemId, kind, url }) => ({ itemId, kind, url })),
      [{ itemId: '1802-b', kind: 'image', url: 'https://cdn.example.invalid/1802-b/p.png' }]
    );
    assert.equal(report.described, 1);
  }));

test('a kind no model can read costs no describe call', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1807', kinds: ['file'] });
    const event = eventOf(IMAGE, '1807', [false, false], { chat: CHAT });
    (event.message as Row).attachments = [{ id: 'z1', kind: 'file', name: 'n.zip', url: 'https://x.invalid/n' }];
    const { described } = await run(env, fakeInterface([event]).read);
    assert.deepEqual(described, []);
  }));

for (const name of ['voice received', 'audio']) {
  test(`an old ${name} goes through the describe path, and its transcript then finds the line`, () =>
    withEnv(async (env) => {
      const kind = named(name);
      const event = eventOf(kind, '1803', [false, false], { chat: CHAT });
      const attachments = (event.message as { attachments: Array<Row> }).attachments;
      attachments.length = 1;
      oldRow(env, { native: '1803', kinds: [String(attachments[0].kind)] });
      await run(env, fakeInterface([event]).read, {
        describe: (_placeId: string, items: Array<Row>) => {
          for (const item of items)
            tellMedia(env.handle, {
              iface: 'discord',
              nativeRef: String(item.itemId),
              description: `heard: a ${kind.first.word}`,
              origin: 'transcript',
            });
          return Promise.resolve();
        },
      });
      assert.deepEqual(mediaFinds(env, kind.first.word), ['1803']);
    }));
}

test('her own old voice message goes through the describe path, since its words are stored nowhere', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1804', kinds: ['voice'], author: HER });
    const event = eventOf(named('voice said'), '1804', [false, false], { chat: CHAT });
    (event.message as { attachments: Array<Row> }).attachments = [
      { id: 'v9', kind: 'voice', name: 'voice.ogg', durationSec: 9, url: 'https://cdn.example.invalid/v9.ogg' },
    ];
    const { described } = await run(env, fakeInterface([event]).read);
    assert.deepEqual(
      described.map(({ itemId, kind }) => ({ itemId, kind })),
      [{ itemId: 'v9', kind: 'voice' }]
    );
  }));

// ---------- vectors and the report ----------

test('the report counts each told item once for embedding; a neighbouring line is not embedded again', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1901', kinds: ['image', 'image'] });
    heldItem(env, '1901-a', 'a lighthouse');
    env.say({ native: '1902', at: AT + MINUTE, text: 'ναι', place: GENERAL });
    const { report } = await run(env, fakeInterface([imageEvent('1901')]).read);
    assert.equal(report.reembedded, 1);
    assert.deepEqual((await embedLines(env)).asked, ['a lighthouse']);
  }));

test('after the backfill a Russian query reaches an old line by its English text form, and only there', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1905', kinds: ['image', 'image'] });
    heldItem(env, '1905-a', 'a lighthouse on a cliff');
    await run(env, fakeInterface([imageEvent('1905')]).read);
    await embedLines(env);
    assert.deepEqual(
      search(env.db, { ctx: group, ...byMeaning('маяк') }).mediaHits.map((hit) => hit.latest.messageId),
      ['1905']
    );
    assert.deepEqual(search(env.db, { ctx: group, ...byMeaning('лавина') }).mediaHits, []);
  }));

test('a line with no text form queues nothing and costs no embedding', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1906' });
    const { report } = await run(env, fakeInterface([]).read);
    assert.equal(report.reembedded, 0);
    assert.deepEqual((await embedLines(env)).asked, []);
  }));

// ---------- audience ----------

test("a DM's old picture, read through its stored chat, stays in the DM on every stream", () =>
  withEnv(async (env) => {
    const dm = dmPlaceId('discord', BOB);
    oldRow(env, {
      native: '2001',
      kinds: ['image', 'image'],
      place: dm,
      author: BOB,
      scope: BOB_SCOPE,
      extra: { dmChannel: 'dm-bob' },
    });
    heldItem(env, '2001-a', 'a lighthouse only he saw');
    const chat = { id: 'dm-bob', kind: 'dm', chatType: 'dm', partnerId: BOB };
    await run(env, fakeInterface([imageEvent('2001', AT, chat)]).read);
    fillStems(env.db);
    await embedLines(env);
    assert.deepEqual(mediaFinds(env, 'lighthouse', dmContext(BOB_PERSON, 'discord')), ['2001']);
    assert.deepEqual(mediaFinds(env, 'lighthouse'), []);
    assert.deepEqual(mediaFinds(env, 'ighthou'), []);
    assert.deepEqual(search(env.db, { ctx: group, ...byMeaning('маяк') }).mediaHits, []);
  }));

test('a DM line whose chat is not stored stays bare, counted with its reason, and is not read by its partner id', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '2002', place: dmPlaceId('discord', BOB), author: BOB, scope: BOB_SCOPE });
    const { read, reads } = fakeInterface([]);
    const { report } = await run(env, read);
    assert.deepEqual([report.bare, report.gone, report.classes['no-chat']], [1, 0, 1]);
    assert.deepEqual(reads, []);
  }));

// ---------- the audit: every field of a new row, on an old one ----------

/** Every field a line carries: its columns with a value, the keys of its `extra`, and each linked item's filled fields. */
function fieldsOf(env: Env, id: string): Array<string> {
  const row = env.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Row;
  const extra = JSON.parse((row.extra as string | null) ?? '{}') as Row;
  const items = env.db
    .prepare(
      `SELECT m.* FROM media m JOIN media_links l ON l.media_id = m.id WHERE l.owner_kind = 'source' AND l.owner_id = ?`
    )
    .all(id);
  return [
    ...Object.entries(row)
      .filter(([key, value]) => value !== null && key !== 'extra' && key !== 'rowid')
      .map(([key]) => `sources.${key}`),
    ...Object.keys(extra).map((key) => `sources.extra.${key}`),
    ...items.flatMap((one) => {
      const inner = JSON.parse((one.extra as string | null) ?? '{}') as Row;
      return [
        ...Object.entries(one)
          .filter(([key, value]) => value !== null && key !== 'extra' && key !== 'rowid')
          .map(([key]) => `media.${key}`),
        ...Object.keys(inner).map((key) => `media.extra.${key}`),
      ];
    }),
  ]
    .filter((field, i, all) => all.indexOf(field) === i)
    .sort();
}

const newRowFields = (env: Env): Array<string> => {
  const id = observeLine(env, IMAGE, 'full', { native: 'new-1' });
  fillStems(env.db);
  return fieldsOf(env, id);
};

test('the audit names every field a new line carries, and how it is backfilled', () =>
  withEnv((env) => {
    assert.deepEqual(
      newRowFields(env).filter((field) => !(field in BACKFILL_FIELDS)),
      []
    );
    for (const [field, plan] of Object.entries(BACKFILL_FIELDS)) {
      assert.ok(['kept', 'read', 'derived', 'none'].includes(plan.how), `${field}: how`);
      assert.ok(plan.why.length > 0, `${field}: why`);
    }
    for (const field of [
      'sources.extra.$messageLocator',
      'sources.extra.$messageReply',
      'sources.extra.subtype',
      'sources.seen_at',
      'sources.owner_key',
      'sources.reply_to',
      'sources.mentions',
      'sources.author_kind',
      'media.kind',
      'media.native_ref',
      'media.description',
      'media.described_at',
      'media.availability',
      'media.sha1',
      'media.path',
      'media.extra.fileName',
      'media.extra.durationSec',
      'media.extra.url',
      'media.extra.title',
      'media.extra.site',
      'media.extra.textOrigin',
    ]) {
      assert.ok(field in BACKFILL_FIELDS, `the audit names ${field}`);
    }
  }));

test('an old line carries every field a new line does after the backfill, but for what the audit says cannot be had', () =>
  withEnv(async (env) => {
    const wanted = newRowFields(env);
    const source = oldRow(env, { native: '2101', kinds: ['image', 'image'] });
    heldItem(env, '2101-a', 'present');
    fillEnvAudiences(env);
    await run(env, fakeInterface([imageEvent('2101')]).read);
    fillStems(env.db);
    const has = fieldsOf(env, source);
    assert.deepEqual(
      wanted.filter((field) => !has.includes(field) && BACKFILL_FIELDS[field]?.how !== 'none'),
      []
    );
  }));

test("an old row's reply and mentions come from its message, so the reply chain holds as on a new row", () =>
  withEnv(async (env) => {
    oldRow(env, { native: '2201' });
    const event = imageEvent('2201');
    (event.message as Row).replyToId = '2200';
    event.addressing = { mentionedAccountIds: ['u-carol'] };
    await run(env, fakeInterface([event]).read);
    const row = env.db.prepare('SELECT reply_to, mentions, extra FROM sources WHERE native_id = ?').get('2201');
    assert.equal(row?.reply_to, '2200');
    assert.ok(String(row?.mentions).includes('u-carol'));
    assert.ok(String(row?.extra).includes('$messageReply'));
  }));
