// The media backfill (src/memory/db/media-backfill.ts): for each old source row with media rows lacking their reference, read
// its message through the interface's history, match it by message id, and write the one format (`source_media`) through the
// one writer, stamp stems and queue vectors. A deleted message stays bare and is counted; a run is idempotent and resumable;
// no model call for a text form already held. Tested over a fake interface: a pure core and an interface read. Synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMediaBackfill, BACKFILL_FIELDS, backfillMedia } from '../src/memory/db/media-backfill.ts';
import { search } from '../src/memory/db/recall.ts';
import { channelPlaceId, dmPlaceId } from '../src/memory/db/ids.ts';
import { dmContext, internalContext } from '../src/memory/db/scope.ts';
import { sourceMedia, tellSourceMedia } from '../src/memory/db/source-media.ts';
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
  kindNamed,
  neutralRows,
  observeLine,
  storeDescription,
} from './fixtures/media-memory.ts';
import { byMeaning, embedLines } from './fixtures/media-memory-embed.ts';
import type { Env, Scope } from './fixtures/media-memory.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import type { Row } from '../src/memory/db/types.ts';

const IMAGE = KINDS[0];
const MINUTE = 60_000;
const OTHER = channelPlaceId('discord', 'c2');
const CONVERSATION = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const IN_OTHER = { id: 'c2', kind: 'channel', rootId: 'g1' };

/**
 * A source row as the migration left an old one: the kinds as `source_media` rows with no reference, the columns production's
 * old rows hold, no locator.
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
  const row = env.db.prepare(
    "INSERT INTO source_media (source_id, position, kind, availability) VALUES (?, ?, ?, 'unread')"
  );
  kinds.forEach((kind, position) => row.run(id, position, kind));
  return id;
}

/** An interface whose history holds these events: reads by `around`, `after`, `before` and `since`, and notes each read. */
function fakeInterface(events: Array<Row>) {
  const reads: Array<{ conversationId: string; query: HistoryQuery }> = [];
  const order = (id: unknown) => BigInt(String(id).replace(/\D/g, '') || '0');
  const read = (conversationId: string, query: HistoryQuery) => {
    reads.push({ conversationId, query });
    const held = events
      .filter((event) => (event.conversation as Row).id === conversationId)
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
const imageEvent = (native: string, at = AT, conversation: Row = CONVERSATION) =>
  eventOf(IMAGE, native, [true, true], { at, conversation });

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

const finds = (env: Env, form: string, ctx: unknown = group) =>
  search(env.db, {
    ctx,
    plan: { forms: [form], who: [], from: null, to: null },
    now: NOW,
    settings: SETTINGS,
  }).hits.map((hit) => hit.messageId);

const rowsOf = (env: Env, source: string) => sourceMedia(env.db, [source], internalContext()).get(source) ?? [];

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
    storeDescription(env, '1001-a', 'a lighthouse on a cliff');
    fillStems(env.db);
    assert.deepEqual(finds(env, 'lighthouse'), [], 'before: the description has nothing to name it');
    const { read } = fakeInterface([imageEvent('1001')]);
    const { report } = await run(env, read);
    assert.deepEqual([report.linked, report.bare], [1, 0]);
    const [first, second] = rowsOf(env, source);
    assert.deepEqual(
      [first.nativeRef, first.name, first.text, first.textOrigin, first.availability],
      ['1001-a', 'p.png', 'a lighthouse on a cliff', 'retelling', 'told']
    );
    assert.deepEqual([second.nativeRef, second.availability], ['1001-b', 'unread']);
    fillStems(env.db);
    assert.deepEqual(finds(env, 'lighthouse'), ['1001']);
  }));

for (const kind of KINDS.filter((one) => !one.self)) {
  test(`an old ${kind.name} line ends with the same rows as a new one`, () =>
    withEnv(async (env) => {
      const fresh = observeLine(env, kind, 'absent', { native: '1000' });
      const held = rowsOf(env, fresh);
      assert.ok(held.length > 0);
      const source = oldRow(env, { native: '1002', kinds: held.map((row) => String(row.kind)) });
      const event = eventOf(kind, '1002', [false, false], { conversation: CONVERSATION });
      const { read } = fakeInterface([event]);
      await run(env, read);
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

test("a message is matched by its id in the line's own conversation, never by the same id in another", () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1201', kinds: ['image', 'image'] });
    const other = oldRow(env, { native: '1202', place: OTHER, at: AT + MINUTE, kinds: ['image', 'image'] });
    const { read, reads } = fakeInterface([
      imageEvent('1201'),
      eventOf(IMAGE, '1201', [true, true], { conversation: IN_OTHER }),
    ]);
    const { report } = await run(env, read);
    assert.deepEqual([...new Set(reads.map((one) => one.conversationId))].sort(), ['c1', 'c2']);
    assert.deepEqual([report.linked, report.bare], [1, 1], 'the other id in c2 is not 1202');
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
      rowsOf(env, source).map(({ kind, nativeRef, text }) => [kind, nativeRef, text]),
      [
        ['image', '1203-a', null],
        ['link', 'l1', 'words'],
      ]
    );
  }));

test('only the writer changes a row: a run whose writes are dropped leaves the database as it was', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1301', kinds: ['image', 'image'] });
    const before = [
      env.db.prepare('SELECT * FROM sources WHERE native_id = ?').get('1301'),
      JSON.stringify(rowsOf(env, source)),
    ];
    const { read } = fakeInterface([imageEvent('1301')]);
    const writes: Array<unknown> = [];
    await run(env, read, {
      write: (update: Row) => {
        writes.push(update);
        return Promise.resolve();
      },
    });
    assert.ok(writes.length > 0);
    assert.deepEqual(
      [env.db.prepare('SELECT * FROM sources WHERE native_id = ?').get('1301'), JSON.stringify(rowsOf(env, source))],
      before
    );
  }));

// ---------- a deleted message ----------

test('a deleted message stays bare and is counted, with its row marked gone and its address kept', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1401' });
    const { report } = await run(env, fakeInterface([]).read);
    assert.deepEqual([report.linked, report.bare], [0, 1]);
    assert.deepEqual(
      rowsOf(env, source).map(({ kind, nativeRef, availability }) => [kind, nativeRef, availability]),
      [['image', null, 'gone']]
    );
    const extra = env.db.prepare('SELECT extra FROM sources WHERE native_id = ?').get('1401')?.extra;
    assert.ok(String(extra).includes('$messageLocator'), 'its address needs no read');
  }));

test('a GIF library row that names a deleted message still gives it a text form', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1403', kinds: ['gif'] });
    env.db
      .prepare(
        `INSERT INTO media (id, kind, native_ref, description, extra, scope_kind, scope_iface, scope_dm)
         VALUES ('media:gif:k', 'gif', '1403', 'name', ?, 'group', 'discord', NULL)`
      )
      .run(JSON.stringify({ itemId: 'item-1' }));
    storeDescription(env, 'item-1', 'a pirouette on ice');
    const { report } = await run(env, fakeInterface([]).read);
    assert.equal(report.bare, 0, 'told through the library row');
    fillStems(env.db);
    assert.deepEqual(finds(env, 'pirouette'), ['1403']);
  }));

// ---------- idempotent and resumable ----------

test('a second run reads nothing, writes nothing and counts nothing, a deleted message included', () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '1501', kinds: ['image', 'image'] });
    oldRow(env, { native: '1502', at: AT + MINUTE });
    const { read, reads } = fakeInterface([imageEvent('1501')]);
    await run(env, read);
    const rows = JSON.stringify(rowsOf(env, source));
    reads.length = 0;
    const { report, applied } = await run(env, read);
    assert.deepEqual([report.linked, report.bare, report.reads, report.reembedded], [0, 0, 0, 0]);
    assert.deepEqual(reads, []);
    assert.deepEqual(applied, []);
    assert.equal(JSON.stringify(rowsOf(env, source)), rows);
  }));

test('a failed read of one place is counted and the next run finishes it without reading the first again', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1601', kinds: ['image', 'image'] });
    const later = oldRow(env, { native: '1602', place: OTHER, at: AT + MINUTE, kinds: ['image', 'image'] });
    const healthy = fakeInterface([
      imageEvent('1601'),
      eventOf(IMAGE, '1602', [true, true], { conversation: IN_OTHER }),
    ]);
    const flaky = (conversationId: string, query: HistoryQuery) =>
      conversationId === 'c2'
        ? Promise.resolve({ status: 'failed' as const, events: [], complete: false })
        : healthy.read(conversationId, query);
    const first = await run(env, flaky as typeof healthy.read);
    assert.deepEqual([first.report.linked, first.report.failedPlaces, first.report.bare], [1, 1, 0]);
    assert.equal(rowsOf(env, later)[0].availability, 'unread', 'a failed read is no deleted message');
    healthy.reads.length = 0;
    const second = await run(env, healthy.read);
    assert.deepEqual([second.report.linked, second.report.failedPlaces], [1, 0]);
    assert.deepEqual(
      healthy.reads.map((one) => one.conversationId),
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
      eventOf(IMAGE, '1702', [true, true], { at: AT - far, conversation: IN_OTHER }),
    ]);
    const controller = new AbortController();
    const stopping = ((conversationId: string, query: HistoryQuery) => {
      controller.abort();
      return read(conversationId, query);
    }) as typeof read;
    const first = await run(env, stopping, { signal: controller.signal });
    assert.deepEqual([first.report.linked, first.report.stopped], [1, true]);
    const second = await run(env, read);
    assert.deepEqual([second.report.linked, second.report.stopped], [1, false]);
  }));

// ---------- the describe path ----------

test('no model call for a text form we hold, in the cache', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1801', kinds: ['image', 'image'] });
    storeDescription(env, '1801-a', 'one');
    storeDescription(env, '1801-b', 'two');
    const { described } = await run(env, fakeInterface([imageEvent('1801')]).read);
    assert.deepEqual(described, []);
  }));

test('a missing text form goes through the describe path once, with the fresh address the read gave', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1802', kinds: ['image', 'image'] });
    storeDescription(env, '1802-a', 'held');
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
    const event = eventOf(IMAGE, '1807', [false, false], { conversation: CONVERSATION });
    (event.message as Row).attachments = [{ id: 'z1', kind: 'file', name: 'n.zip', url: 'https://x.invalid/n' }];
    const { described } = await run(env, fakeInterface([event]).read);
    assert.deepEqual(described, []);
  }));

for (const name of ['voice received', 'audio']) {
  test(`an old ${name} goes through the describe path, and its transcript then finds the line`, () =>
    withEnv(async (env) => {
      const kind = kindNamed(name);
      const event = eventOf(kind, '1803', [false, false], { conversation: CONVERSATION });
      const attachments = (event.message as { attachments: Array<Row> }).attachments;
      attachments.length = 1;
      oldRow(env, { native: '1803', kinds: [String(attachments[0].kind)] });
      await run(env, fakeInterface([event]).read, {
        describe: (_placeId: string, items: Array<Row>) => {
          for (const item of items)
            tellSourceMedia(env.handle, {
              iface: 'discord',
              nativeRef: String(item.itemId),
              text: `heard: a ${kind.first.word}`,
              origin: 'transcript',
              scope: GROUP_SCOPE,
            });
          return Promise.resolve();
        },
      });
      assert.deepEqual(finds(env, kind.first.word), ['1803']);
    }));
}

test('her own old voice message goes through the describe path, since its words are stored nowhere', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1804', kinds: ['voice'], author: HER });
    const event = eventOf(kindNamed('voice said'), '1804', [false, false], { conversation: CONVERSATION });
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

test('the report counts the lines queued for embedding: a linked line and the two after it', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1901', kinds: ['image', 'image'] });
    storeDescription(env, '1901-a', 'a lighthouse');
    env.say({ native: '1902', at: AT + MINUTE, text: 'ναι', place: GENERAL });
    env.say({ native: '1903', at: AT + 2 * MINUTE, text: 'όχι', place: GENERAL });
    env.say({ native: '1904', at: AT + 3 * MINUTE, text: 'ίσως', place: GENERAL });
    const { report } = await run(env, fakeInterface([imageEvent('1901')]).read);
    assert.equal(report.reembedded, 3);
    const { asked } = await embedLines(env);
    assert.equal(asked.length, 3);
    assert.ok(asked.every((chunk) => chunk.includes('lighthouse')));
  }));

test('after the backfill a Russian query reaches an old line by its English text form, and only there', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1905', kinds: ['image', 'image'] });
    storeDescription(env, '1905-a', 'a lighthouse on a cliff');
    await run(env, fakeInterface([imageEvent('1905')]).read);
    fillStems(env.db);
    await embedLines(env);
    assert.deepEqual(
      search(env.db, { ctx: group, ...byMeaning('маяк') }).hits.map((hit) => hit.messageId),
      ['1905']
    );
    assert.deepEqual(search(env.db, { ctx: group, ...byMeaning('лавина') }).hits, []);
  }));

test('a line with no text form is queued for nothing and costs no embedding', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '1906' });
    const { report } = await run(env, fakeInterface([]).read);
    assert.equal(report.reembedded, 0);
    assert.deepEqual((await embedLines(env)).asked, []);
  }));

// ---------- audience ----------

test("a DM's old picture, read through its stored conversation, stays in the DM on every stream", () =>
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
    storeDescription(env, '2001-a', 'a lighthouse only he saw', BOB_SCOPE);
    const conversation = { id: 'dm-bob', kind: 'dm', chatType: 'dm', partnerId: BOB };
    await run(env, fakeInterface([imageEvent('2001', AT, conversation)]).read);
    fillStems(env.db);
    await embedLines(env);
    assert.deepEqual(finds(env, 'lighthouse', dmContext(BOB_PERSON, 'discord')), ['2001']);
    assert.deepEqual(finds(env, 'lighthouse'), []);
    assert.deepEqual(finds(env, 'ighthou'), []);
    assert.deepEqual(search(env.db, { ctx: group, ...byMeaning('маяк') }).hits, []);
  }));

test('a DM line whose conversation is not stored stays bare, counted, and is not read by its partner id', () =>
  withEnv(async (env) => {
    oldRow(env, { native: '2002', place: dmPlaceId('discord', BOB), author: BOB, scope: BOB_SCOPE });
    const { read, reads } = fakeInterface([]);
    const { report } = await run(env, read);
    assert.equal(report.bare, 1);
    assert.deepEqual(reads, []);
  }));

test("a group line's description only a DM may read gives the row its reference and no text", () =>
  withEnv(async (env) => {
    const source = oldRow(env, { native: '2003', kinds: ['image', 'image'] });
    storeDescription(env, '2003-a', 'a lighthouse only he saw', BOB_SCOPE);
    await run(env, fakeInterface([imageEvent('2003')]).read);
    assert.deepEqual(
      [rowsOf(env, source)[0].nativeRef, rowsOf(env, source)[0].text, rowsOf(env, source)[0].availability],
      ['2003-a', null, 'unread']
    );
    fillStems(env.db);
    assert.deepEqual(finds(env, 'lighthouse'), []);
    assert.deepEqual(finds(env, 'ighthou'), []);
  }));

// ---------- the audit: every field of a new row, on an old one ----------

/** Every field a line carries: its columns with a value, the keys of its `extra`, and each media row's filled fields. */
function fieldsOf(env: Env, id: string): Array<string> {
  const row = env.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Row;
  const extra = JSON.parse(String(row.extra ?? '{}')) as Row;
  const media = env.db.prepare('SELECT * FROM source_media WHERE source_id = ?').all(id);
  return [
    ...Object.entries(row)
      .filter(([key, value]) => value !== null && key !== 'extra' && key !== 'rowid')
      .map(([key]) => `sources.${key}`),
    ...Object.keys(extra).map((key) => `sources.extra.${key}`),
    ...media.flatMap((one) =>
      Object.entries(one)
        .filter(([, value]) => value !== null)
        .map(([key]) => `source_media.${key}`)
    ),
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
      'sources.stems',
      'sources.reply_to',
      'sources.mentions',
      'sources.author_kind',
      'source_media.native_ref',
      'source_media.name',
      'source_media.duration_sec',
      'source_media.title',
      'source_media.site',
      'source_media.url',
      'source_media.text',
      'source_media.text_origin',
      'source_media.availability',
    ]) {
      assert.ok(field in BACKFILL_FIELDS, `the audit names ${field}`);
    }
  }));

test('an old line carries every field a new line does after the backfill, but for what the audit says cannot be had', () =>
  withEnv(async (env) => {
    const wanted = newRowFields(env);
    const source = oldRow(env, { native: '2101', kinds: ['image', 'image'] });
    storeDescription(env, '2101-a', 'told');
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
