// Tests for src/turn/request/my-day.ts#myDayOf: what she did today, read from the journal under the turn's context, one
// dated line per action with the place by name, capped at `context.myDay.lines`. Each test writes its actions through
// the journal a turn uses, over the real service and database. Plan 2026-11-06-turn-frame, slice 2 (e).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { myDayOf } from '../src/turn/request/my-day.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const TZ = 'UTC';

const CAFE = 'discord:channel:room-1';
const SALON = 'discord:channel:room-2';
const DM = 'discord:dm:n1';
const PARTNER_PERSON = 'person:discord:n1';
const NAMES: Record<string, string> = { [CAFE]: 'café', [SALON]: 'salon', [DM]: 'Zoé' };
const placeNames = (id: string): string | null => NAMES[id] ?? null;

/** The native chat id a turn writes its journal lines with. */
const CHAT: Record<string, string> = { [CAFE]: 'room-1', [SALON]: 'room-2', [DM]: 'dm-chat-n1' };

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A database with two group places and one DM, and the journal a turn writes through, on a clock the test moves. */
function world() {
  const dataDir = tempDir('nep-my-day-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  addAccount(db, {
    id: 'discord:n1',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n1',
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n1',
    person: PARTNER_PERSON,
  });
  addGroupPlace(db, CAFE, 'discord', 'discord/global');
  addGroupPlace(db, SALON, 'discord', 'discord/global');
  // The DM is stored under its chat's key, so a call that names the chat finds the DM place.
  db.prepare('UPDATE places SET native_key = ? WHERE id = ?').run(`channel:${CHAT[DM]}`, DM);
  // The group places hold their chats' ids and keys, as the observation stores a channel.
  for (const place of [CAFE, SALON])
    db.prepare('UPDATE places SET native_id = ?, native_key = ? WHERE id = ?').run(
      CHAT[place],
      `channel:${CHAT[place]}`,
      place
    );
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const clock = { at: NOW };
  const journal = createJournal({ dataDir, memoryDb, now: () => clock.at, log: quiet });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  /** One action of hers at `at` in `place` that started and succeeded, as a turn writes it. */
  async function act(place: string, name: string, at: number, skill: string | null = null) {
    clock.at = at;
    const op = journal.op(place, {
      placeId: CHAT[place],
      turnId: `t-${at}`,
      name,
      by: 'persona',
      ...(skill ? { input: { skill } } : {}),
      intent: { replyTo: null, text: 'λόγια' },
    });
    await op.started();
    await op.succeeded({ messageId: `m-${at}` });
    await settled();
  }
  /** A skill call of hers at `at` from a turn in `place` that acted in the chat `target` names, as a turn writes it. */
  async function callInto(place: string, skill: string, target: string, at: number) {
    clock.at = at;
    const op = journal.op(place, {
      placeId: CHAT[place],
      turnId: `t-${at}`,
      name: 'skill',
      by: 'persona',
      input: { skill },
    });
    await op.started({ target: { channel: target } });
    await op.succeeded({ messageId: `m-${at}` });
    await settled();
  }
  return { read, act, callInto };
}

test('lists one line per action of today, a post, a skill call, a GIF and a reaction, and none of yesterday', async () => {
  // Bug: the started and the closing line of one action both list, or yesterday's evening reads as today.
  const w = world();
  await w.act(SALON, 'post', NOW - 14 * 60 * MIN);
  await w.act(CAFE, 'post', NOW - 50 * MIN);
  await w.act(CAFE, 'skill', NOW - 40 * MIN, 'memory.search');
  await w.act(CAFE, 'gif', NOW - 30 * MIN);
  await w.act(CAFE, 'react', NOW - 20 * MIN);
  const lines = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 12 });
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.ok(
    lines.every((one) => one.includes('café')),
    lines.join('\n')
  );
  assert.ok(!lines.some((one) => one.includes('salon')), lines.join('\n'));
});

test('lists no more lines than `context.myDay.lines`', async () => {
  // Bug: a busy day fills the request with every action she took.
  const w = world();
  for (let i = 0; i < 5; i += 1) await w.act(CAFE, 'post', NOW - (50 - i) * MIN);
  const lines = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 2 });
  assert.equal(lines.length, 2, lines.join('\n'));
});

test('a group turn lists no action she took in a DM today', async () => {
  // Bug: the journal is read without the turn's context, so a group learns what she did in a private chat.
  const w = world();
  await w.act(CAFE, 'post', NOW - 30 * MIN);
  await w.act(DM, 'react', NOW - 20 * MIN);
  const inside = myDayOf(w.read(), internalContext(), placeNames, NOW, TZ, { lines: 12 });
  assert.ok(
    inside.some((one) => one.includes('Zoé')),
    'the DM action is in the journal and listable'
  );
  const lines = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 12 });
  assert.ok(
    lines.some((one) => one.includes('café')),
    lines.join('\n')
  );
  assert.ok(!lines.some((one) => one.includes('Zoé')), lines.join('\n'));
});

test('names the place a call acted in, not the chat its turn ran in', async () => {
  // Bug: a post she made from the café into the salon is listed under the café, so she looks for it in the wrong place.
  const w = world();
  await w.callInto(CAFE, 'message.create', CHAT[SALON], NOW - 10 * MIN);
  const [line] = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 12 });
  assert.ok(line?.includes('salon') && !line.includes('café'), line);
});

test("names the turn's chat for a call into a place the group turn may not read", async () => {
  // Bug: a group turn's line names the DM her call reached, and the group learns of a private chat.
  const w = world();
  await w.callInto(CAFE, 'message.create', CHAT[DM], NOW - 10 * MIN);
  const [line] = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 12 });
  assert.ok(line?.includes('café') && !line.includes('Zoé'), line);
});

test('lists a board call of hers under its own name, not an errand tool that once had it', async () => {
  // Bug: `task.status` is read as the old errand name `errand.list`, so her board check reads as an errand list.
  const w = world();
  await w.act(CAFE, 'skill', NOW - 10 * MIN, 'task.status');
  const [line] = myDayOf(w.read(), groupContext('discord'), placeNames, NOW, TZ, { lines: 12 });
  assert.ok(line?.includes('task.status') && !line.includes('errand'), line);
});
