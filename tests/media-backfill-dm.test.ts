// The media backfill's DM lines and its refused reads. A DM line that stored no chat is read through the chat
// the interface opens for its partner (`dmChatOf`), which the place keeps; a partner the platform refuses is `gone`. A
// read the platform refuses is told apart from one that failed by a code in `classes`, and gets no second read. Fake platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMediaBackfill, backfillMedia, mediaBackfillDesk } from '../src/memory/db/media-backfill.ts';
import { lineMedia } from '../src/memory/db/media-store.ts';
import { dmPlaceId } from '../src/memory/db/ids.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { notOk } from '../src/interface/port.ts';
import { createReads } from '../src/interface/reads.ts';
import {
  ALICE,
  AT,
  BOB,
  BOB_SCOPE,
  GENERAL,
  GROUP_SCOPE,
  KINDS,
  NOW,
  channelRow,
  eventOf,
  fixture,
} from './fixtures/media-memory.ts';
import type { Env, Scope } from './fixtures/media-memory.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import { asText } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';

const IMAGE = KINDS[0];
const DM = dmPlaceId('discord', BOB);
const OPENED = 'dm-opened';
const IN_DM = { id: OPENED, kind: 'dm', chatType: 'dm', partnerId: BOB };
const OK_OPEN = { status: 'ok', chatId: OPENED };

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  // The rows of the places the lines name, as every stored line's place has one: a line is read through its row's native id, a DM's partner through its account.
  channelRow(env, GENERAL, 'c1');
  dmPlaceRow(env, DM);
  try {
    await body(env);
  } finally {
    env.done();
  }
}

function bareLine(
  env: Env,
  {
    native,
    place = DM,
    author = BOB,
    scope = BOB_SCOPE,
    kinds = ['image'],
  }: { native: string; place?: string; author?: string; scope?: Scope; kinds?: Array<string> }
): string {
  const id = env.say({ native, at: AT, text: '', place, author, scope, extra: JSON.stringify({ subtype: 'seen' }) });
  env.db
    .prepare(
      `UPDATE sources SET mentions = '[]', origin = 'observation', authority_id = 'discord/global', author_kind = 'account',
       observed_at = occurred_at, seen_at = occurred_at, native_kind = 'message', generation = 1 WHERE id = ?`
    )
    .run(id);
  kinds.forEach((kind, position) => {
    const mediaId = `media:bare:${native}:${position}`;
    env.db
      .prepare(
        `INSERT INTO media (id, kind, availability, scope_kind, scope_iface, scope_dm) VALUES (?, ?, 'unknown', ?, ?, ?)`
      )
      .run(mediaId, kind, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    env.db
      .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, ?, ?)")
      .run(id, position, mediaId);
  });
  return id;
}

/** A platform holding `events`, noting each read. */
function platform(events: Array<Row>) {
  const reads: Array<{ chatId: string; query: HistoryQuery }> = [];
  const read = (chatId: string, query: HistoryQuery) => {
    reads.push({ chatId, query });
    const page = events.filter((event) => (event.chat as Row).id === chatId);
    return Promise.resolve({ status: 'ok', events: page, complete: true });
  };
  return { read, reads };
}

/** A `dmChatOf` answering `answers` in turn, the last one for good, noting who was asked. */
function opener(...answers: Array<Row>) {
  const asked: Array<string> = [];
  const open = (accountId: string) => {
    asked.push(accountId);
    return Promise.resolve((answers[Math.min(asked.length, answers.length) - 1] ?? OK_OPEN) as never);
  };
  return { open, asked };
}

function run(env: Env, read: Parameters<typeof backfillMedia>[0]['read'], over: Row = {}) {
  return backfillMedia({
    db: env.db,
    read,
    write: (update: Row) => Promise.resolve(applyMediaBackfill(env.handle, update)),
    describe: () => Promise.resolve(),
    now: NOW,
    pageSize: 100,
    ...over,
  });
}

const dmEvent = (id: string) => eventOf(IMAGE, id, [true, true], { chat: IN_DM });
const firstRef = (env: Env, source: string) =>
  lineMedia(env.db, [source], internalContext(), 'source').get(source)?.[0]?.nativeRef;
const stateOf = (env: Env, source: string) =>
  env.db
    .prepare(
      `SELECT m.availability AS state FROM media m JOIN media_links l ON l.media_id = m.id
       WHERE l.owner_kind = 'source' AND l.owner_id = ?`
    )
    .get(source)?.state;
const BOB_ACCOUNT = 'account:bob';
/** The stored row of a DM place and of its partner's account, which a line alone does not make. */
function dmPlaceRow(env: Env, place: string, account: string | null = BOB_ACCOUNT): void {
  env.db
    .prepare("INSERT OR IGNORE INTO accounts (id, iface, native_id) VALUES (?, 'discord', ?)")
    .run(BOB_ACCOUNT, BOB);
  env.db
    .prepare(
      "INSERT OR IGNORE INTO places (id, iface, kind, chat, partner_account) VALUES (?, 'discord', 'dm', 'dm', ?)"
    )
    .run(place, account);
}
const placeExtra = (env: Env, place: string) =>
  JSON.parse(asText(env.db.prepare('SELECT extra FROM places WHERE id = ?').get(place)?.extra ?? '{}')) as Row;

// ---------- the chat of a DM's partner ----------

test('a DM line with no stored chat is read through the one opened for its partner, and the place keeps it', () =>
  withEnv(async (env) => {
    dmPlaceRow(env, DM);
    const source = bareLine(env, { native: '2101' });
    const { read, reads } = platform([dmEvent('2101')]);
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, read, { dmChatOf: open });
    assert.deepEqual(asked, [BOB]);
    assert.deepEqual(
      reads.map((one) => one.chatId),
      [OPENED]
    );
    assert.deepEqual([report.linked, report.bare, report.gone], [1, 0, 0]);
    assert.equal(firstRef(env, source), '2101-a');
    assert.equal(placeExtra(env, DM).dmConversation, OPENED);
  }));

test('two lines of one DM open its chat once', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2102' });
    bareLine(env, { native: '2103' });
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, platform([dmEvent('2102'), dmEvent('2103')]).read, { dmChatOf: open });
    assert.deepEqual(asked, [BOB]);
    assert.equal(report.linked, 2);
  }));

test('a later run reads through the chat the place keeps and opens nothing', () =>
  withEnv(async (env) => {
    dmPlaceRow(env, DM);
    bareLine(env, { native: '2104' });
    await run(env, platform([dmEvent('2104')]).read, { dmChatOf: opener(OK_OPEN).open });
    const later = bareLine(env, { native: '2105' });
    const { read, reads } = platform([dmEvent('2105')]);
    const { open, asked } = opener(OK_OPEN);
    await run(env, read, { dmChatOf: open });
    assert.deepEqual(asked, []);
    assert.equal(reads[0].chatId, OPENED);
    assert.equal(firstRef(env, later), '2105-a');
  }));

test('the partner of a place whose id does not spell him is its partner account', () =>
  withEnv(async (env) => {
    const place = dmPlaceId('discord', 'family-key');
    env.db
      .prepare("INSERT INTO accounts (id, iface, native_id) VALUES ('account:opaque', 'discord', 'native-of-bob')")
      .run();
    dmPlaceRow(env, place, 'account:opaque');
    bareLine(env, { native: '2106', place });
    const { open, asked } = opener({ status: 'forbidden', code: 'http-403' });
    await run(env, platform([]).read, { dmChatOf: open });
    assert.deepEqual(asked, ['native-of-bob']);
  }));

// The expectation changed with the ids-by-links plan (slice 6): no id is worked out from the text of another, so a DM
// place no row holds names no partner. Production holds a row for every DM place with lines.
test('a DM place no row holds names no partner: its line stays bare, nobody is asked, and the run goes on', () =>
  withEnv(async (env) => {
    const unstored = dmPlaceId('discord', 'u-nobody');
    bareLine(env, { native: '2113', place: unstored });
    const kept = bareLine(env, { native: '2114' });
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, platform([dmEvent('2114')]).read, { dmChatOf: open });
    assert.deepEqual(asked, [BOB]);
    assert.deepEqual([report.bare, report.linked], [1, 1]);
    assert.equal(firstRef(env, kept), '2114-a');
  }));

test('a line of a channel stored under an opaque id is read through the native id of its row', () =>
  withEnv(async (env) => {
    env.db
      .prepare(
        "INSERT INTO places (id, iface, kind, native_id, chat, scope_kind) VALUES ('place:opaque-room', 'discord', 'channel', 'c7', 'group', 'group')"
      )
      .run();
    const source = bareLine(env, { native: '2115', place: 'place:opaque-room', author: ALICE, scope: GROUP_SCOPE });
    const room = { id: 'c7', kind: 'channel', rootId: 'g1', name: 'garden' };
    const { read, reads } = platform([eventOf(IMAGE, '2115', [true, true], { chat: room })]);
    const report = await run(env, read);
    assert.deepEqual([reads.map((one) => one.chatId), report.linked], [['c7'], 1]);
    assert.equal(firstRef(env, source), '2115-a');
  }));

test('a line of a place with no partner stays bare and nobody is asked', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2107', place: 'discord:nowhere' });
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, platform([]).read, { dmChatOf: open });
    assert.deepEqual(asked, []);
    assert.deepEqual([report.bare, report.classes['no-chat']], [1, 1]);
  }));

for (const [name, answer] of [
  ['forbids', { status: 'forbidden', code: 'http-403' }],
  ['does not know', { status: 'failed', code: 'http-404', retryable: false }],
] as const) {
  test(`a partner the platform ${name} counts as gone, once, and no later run asks again`, () =>
    withEnv(async (env) => {
      const source = bareLine(env, { native: '2108' });
      const first = opener(answer);
      const report = await run(env, platform([]).read, { dmChatOf: first.open });
      assert.deepEqual(first.asked, [BOB]);
      assert.deepEqual([report.gone, report.bare, report.failedPlaces, report.linesLeft], [1, 0, 0, 0]);
      assert.equal(report.classes['partner-refused'], 1);
      assert.equal(stateOf(env, source), 'missing');
      const second = opener(answer);
      await run(env, platform([]).read, { dmChatOf: second.open });
      assert.deepEqual(second.asked, []);
    }));
}

test('an opening that fails gets one more try, then leaves its lines for the next run', () =>
  withEnv(async (env) => {
    const source = bareLine(env, { native: '2109' });
    const failing = opener({ status: 'failed', code: 'http-500', retryable: true });
    const report = await run(env, platform([]).read, { dmChatOf: failing.open });
    assert.equal(failing.asked.length, 2);
    assert.deepEqual([report.gone, report.bare, report.failedPlaces, report.linesLeft], [0, 0, 1, 1]);
    assert.equal(stateOf(env, source), 'unknown');
    const again = await run(env, platform([dmEvent('2109')]).read, { dmChatOf: opener(OK_OPEN).open });
    assert.deepEqual([again.linked, again.linesLeft], [1, 0]);
  }));

test('an interface with no such read leaves the line bare, as nothing was refused', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2110' });
    const { open } = opener({ status: 'unsupported', code: 'not-offered' });
    const report = await run(env, platform([]).read, { dmChatOf: open });
    assert.deepEqual([report.bare, report.gone], [1, 0]);
  }));

test('a dry run opens nothing and counts the lines waiting on an opening', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2111' });
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, platform([]).read, { dmChatOf: open, dryRun: true });
    assert.deepEqual(asked, []);
    assert.deepEqual([report.classes.toOpen, report.bare], [1, 0]);
  }));

test('a stop before an opening stops the run and asks nobody', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2112' });
    const { open, asked } = opener(OK_OPEN);
    const report = await run(env, platform([]).read, { dmChatOf: open, signal: AbortSignal.abort() });
    assert.deepEqual(asked, []);
    assert.equal(report.stopped, true);
  }));

// ---------- a refused read ----------

for (const [name, answer] of [
  ['forbidden', { status: 'forbidden', code: 'http-403' }],
  ['not retryable', { status: 'failed', code: 'http-404', retryable: false }],
] as const) {
  test(`a read answered ${name} is refused: no second read, its code in the classes, its lines left`, () =>
    withEnv(async (env) => {
      bareLine(env, { native: '2201', place: GENERAL, author: ALICE, scope: GROUP_SCOPE });
      let reads = 0;
      const refusing = () => {
        reads += 1;
        return Promise.resolve(answer);
      };
      const report = await run(env, refusing);
      assert.equal(reads, 1);
      assert.deepEqual([report.failedPlaces, report.linesLeft], [1, 1]);
      assert.equal(report.classes['read-refused'], 1);
      assert.equal(report.classes[`read-refused:${answer.code}`], 1);
      assert.equal(report.classes['read-failed'], undefined);
    }));
}

test('a read that keeps failing names its code beside the class', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2202', place: GENERAL, author: ALICE, scope: GROUP_SCOPE });
    const report = await run(env, () => Promise.resolve({ status: 'failed', code: 'timeout', retryable: true }));
    assert.deepEqual([report.classes['read-failed'], report.classes['read-failed:timeout']], [1, 1]);
    assert.equal(report.classes['read-refused'], undefined);
  }));

/** The desk over `createReads` and the fake interface, run to its end. */
async function deskRun(env: Env, adapter: ReturnType<typeof createFakeAdapter>) {
  const quiet = { warn: () => undefined, info: () => undefined, error: () => undefined };
  const desk = mediaBackfillDesk({
    memoryDb: {
      database: () => env.db,
      memoryWrite: (update) => Promise.resolve(applyMediaBackfill(env.handle, update as Row)),
    },
    reads: createReads(adapter, quiet),
    iface: () => 'discord',
    describer: { describeMany: () => Promise.resolve() },
    now: () => NOW,
    log: quiet,
  });
  await desk.start({ dryRun: false });
  while (desk.status().state === 'running') await new Promise((resolve) => setImmediate(resolve));
  return desk.status().report;
}

test('the desk over the interface reads carries the code of a refused read to the report', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2203', place: GENERAL, author: ALICE, scope: GROUP_SCOPE });
    const adapter = createFakeAdapter({ iface: 'discord', selfId: 'self' });
    adapter.failNext('history', notOk('forbidden', 'http-403'));
    const report = await deskRun(env, adapter);
    assert.equal(report?.classes['read-refused:http-403'], 1);
  }));

test('the desk asks the interface for the chat of a DM partner and counts his refusal as gone', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '2204' });
    const adapter = createFakeAdapter({ iface: 'discord', selfId: 'self' });
    adapter.failNext('dmChatOf', notOk('forbidden', 'http-403'));
    const report = await deskRun(env, adapter);
    assert.deepEqual([report?.gone, report?.classes['partner-refused']], [1, 1]);
    assert.deepEqual(
      adapter.calls.filter((call) => call.op === 'dmChatOf').map((call) => call.args[0]),
      [{ iface: 'discord', accountId: BOB }]
    );
  }));
