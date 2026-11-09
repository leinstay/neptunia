// The media backfill (src/memory/db/media-backfill.ts) for an old line that holds no item for an embed picture of its
// message: the line links nothing, and an unlinked `image` row of the describer names its message by the reference
// `<message id>#e<N>`. Such a line is listed, read through the interface's history and written through the one writer like
// the other old lines, and the report counts it in `linked` under its own class. Its message is a GIF posted as an address,
// the embed the platform unfurled after the message was stored. A fake interface; synthetic content on a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMediaBackfill, backfillMedia } from '../src/memory/db/media-backfill.ts';
import { lineMedia } from '../src/memory/db/media-store.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { ALICE, AT, GENERAL, NOW, channelRow, fixture, heldItem } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import type { Row } from '../src/memory/db/types.ts';

const CHAT = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';
const SPUN = 'a grey cat spinning on a kitchen table';

/** An old line as the record stored it before its embed arrived: the address as its text, no media link at all. */
function bareLine(env: Env, native: string): string {
  const id = env.say({
    native,
    at: AT,
    text: POSTED,
    place: GENERAL,
    author: ALICE,
    extra: JSON.stringify({ v: 1, id: `rec-${native}`, participants: [], sourceMessageIds: [native] }),
  });
  env.db
    .prepare(
      `UPDATE sources SET mentions = '[]', origin = 'import', authority_id = 'discord/global', author_kind = 'account',
       observed_at = occurred_at, seen_at = occurred_at, native_kind = 'message', generation = 1 WHERE id = ?`
    )
    .run(id);
  return id;
}

/** The message of an old line as the interface reads it today: the address, and the GIF embed unfurled from it. */
function unfurledEvent(native: string): Row {
  const gif = {
    id: `${native}#e0`,
    kind: 'gif',
    site: 'Tenor',
    title: '',
    text: '',
    url: POSTED,
    thumbnailUrl: `https://media.example.invalid/${native}.png`,
    animationUrl: `https://media.example.invalid/${native}.mp4`,
  };
  return {
    iface: 'discord',
    at: AT,
    chat: CHAT,
    message: {
      id: native,
      at: AT,
      content: POSTED,
      author: { id: ALICE, name: 'Alice' },
      attachments: [],
      links: [gif],
      stickers: [],
    },
  };
}

/** An interface whose history of each chat is `events`, whatever the query; it notes each read. */
function fakeInterface(events: Array<Row>) {
  const reads: Array<{ chatId: string; query: HistoryQuery }> = [];
  const read = (chatId: string, query: HistoryQuery) => {
    reads.push({ chatId, query });
    const page = events.filter((event) => (event.chat as Row).id === chatId);
    return Promise.resolve({ status: 'ok' as const, events: page, complete: true });
  };
  return { read, reads };
}

function run(env: Env, read: ReturnType<typeof fakeInterface>['read']) {
  return backfillMedia({
    db: env.db,
    read,
    write: (update: Row) => Promise.resolve(applyMediaBackfill(env.handle, update)),
    describe: () => Promise.resolve(),
    now: NOW,
    pageSize: 100,
  });
}

const itemsOf = (env: Env, source: string) =>
  lineMedia(env.db, [source], internalContext(), 'source').get(source) ?? [];

const rowsNaming = (env: Env, ref: string) =>
  env.db.prepare('SELECT id, description FROM media WHERE native_ref = ?').all(ref);

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  // The rows of the places the lines name, as every stored line's place has one: a line is read through its row's native id.
  channelRow(env, GENERAL, 'c1');
  try {
    await body(env);
  } finally {
    env.done();
  }
}

// Bug: a line stored before its embed arrived links nothing and no run lists it, so its described picture stays apart.
test('an old line with no items whose message has an unlinked embed picture is read, linked to that row and counted', () =>
  withEnv(async (env) => {
    const source = bareLine(env, '2301');
    heldItem(env, '2301#e0', SPUN, 'image');
    const report = await run(env, fakeInterface([unfurledEvent('2301')]).read);
    assert.deepEqual([report.linked, report.gone, report.classes['embed-picture']], [1, 0, 1]);
    assert.deepEqual(
      itemsOf(env, source).map(({ nativeRef, description }) => [nativeRef, description]),
      [['2301#e0', SPUN]]
    );
    assert.equal(rowsNaming(env, '2301#e0').length, 1, 'the described row is adopted, not doubled');
  }));

// Bug: a second run reads the same line again because the listing does not see that the row is now linked.
test('a line linked to its embed picture is not listed again', () =>
  withEnv(async (env) => {
    bareLine(env, '2302');
    heldItem(env, '2302#e0', SPUN, 'image');
    const { read, reads } = fakeInterface([unfurledEvent('2302')]);
    await run(env, read);
    assert.equal(reads.length, 1, 'the first run read the message');
    reads.length = 0;
    const report = await run(env, read);
    assert.deepEqual([report.linked, report.reads], [0, 0]);
  }));

// Bug: a message gone from the platform still gets the row linked, or the row loses the description it held.
test('a line whose message the platform no longer returns is gone and left as it is', () =>
  withEnv(async (env) => {
    const source = bareLine(env, '2303');
    heldItem(env, '2303#e0', SPUN, 'image');
    const report = await run(env, fakeInterface([]).read);
    assert.deepEqual([report.linked, report.gone], [0, 1]);
    assert.deepEqual(itemsOf(env, source), []);
    assert.deepEqual(
      rowsNaming(env, '2303#e0').map((row) => row.description),
      [SPUN]
    );
  }));

// Bug: the listing matches a message id as a bare prefix, so message 23 is read for a picture of message 2304.
test("a line is not listed for an embed row of another message whose id begins with the line's", () =>
  withEnv(async (env) => {
    bareLine(env, '23');
    heldItem(env, '2304#e0', SPUN, 'image');
    const report = await run(env, fakeInterface([]).read);
    assert.deepEqual([report.reads, report.linked, report.gone], [0, 0, 0]);
  }));
