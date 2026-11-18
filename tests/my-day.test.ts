// Tests for src/turn/request/my-day.ts#dayOf: her day as events for `<my_day>` and her calls of today for `<calls>`,
// read from the engine's records under the turn's context. The calls come from the journal a turn writes, over the real
// service and database; her lines, the turn starts, the wake runs, the intentions, the archive of requests and the
// diary are seeded into the same database before the service opens it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { handleOf } from '../src/behavior/handles.ts';
import { finishRun, startRun } from '../src/memory/db/wakes.ts';
import { writeIntentions } from '../src/memory/db/intentions-write.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dmContext, groupContext, internalContext } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { apiNameOf } from '../src/tools/definitions.ts';
import { dayOf } from '../src/turn/request/my-day.ts';
import type { Day } from '../src/turn/request/my-day.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const TZ = 'UTC';
const iso = (at: number): string => new Date(at).toISOString();
/** The moment `hh:mm` of the test's day. */
const at = (hh: number, mm: number): number => Date.UTC(2026, 10, 5, hh, mm, 0);

const CAFE = 'discord:channel:room-1';
const SALON = 'discord:channel:room-2';
const DM = 'discord:dm:n1';
const ZOE = 'person:discord:n1';
const ARIS = 'person:discord:n2';
const NAMES: Record<string, string> = { [CAFE]: 'café', [SALON]: 'salon', [DM]: 'Zoé' };
const placeNames = (id: string): string | null => NAMES[id] ?? null;
const handle = (person: string): string => `@${handleOf(person)}`;

/** The native chat id a turn writes its journal lines with. */
const CHAT: Record<string, string> = { [CAFE]: 'room-1', [SALON]: 'room-2', [DM]: 'dm-chat-n1' };

const LABELS = { myDay: labels.myDay, calls: labels.calls, locale: labels.locale };
const OPTIONS = { events: 12, calls: 12, sinceLastEntry: false, labels: LABELS };

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const scopeOf = (place: string): Record<string, string | null> =>
  place === DM
    ? { scope_kind: 'dm', scope_iface: 'discord', scope_dm: ZOE, audience_id: `aud:dm:${DM}` }
    : { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };

/** What a test seeds before the service opens the database: rows written straight into it. */
type Seed = {
  db: Db;
  handle: Parameters<typeof startRun>[0];
  /** A line of hers in `place` at `when`, written by `turn`, answering the message `replyTo`. */
  herLine(place: string, when: number, turn?: string | null, replyTo?: string | null): void;
  /** A line of `account` in `place` with the message id `id`. */
  theirLine(place: string, id: string, account: string, when: number): void;
  /** The journal's start row of `turn` in `place`, started by the member `author` or by a wake (null). */
  turnStart(place: string, turn: string, author: string | null, when: number): void;
  /** An intention of hers with `purpose`. */
  intention(id: string, purpose: string): void;
  /** A finished wake run of `kind` at `when` that carried `intentions`. */
  wakeRun(id: string, kind: string, when: number, intentions?: ReadonlyArray<string>): void;
  /** The `inner` row of an inner turn's end with its actions. */
  innerEnd(turn: string, when: number, actions: ReadonlyArray<Record<string, unknown>>): void;
  /** One archived model request of `turn` whose answer called `calls`, each a skill and its arguments. */
  request(turn: string, when: number, calls: ReadonlyArray<[string, Record<string, unknown>]>): void;
  /** A stored diary entry of `kind` at `when`. */
  entry(id: string, kind: string, when: number): void;
};

let lineIds = 0;

/** A database with two group places and one DM, seeded by `seed`, and the journal a turn writes through. */
function world(seed: (s: Seed) => void = () => {}) {
  const dataDir = tempDir('nep-my-day-');
  const opened0 = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(opened0);
  addAccount(db, { id: 'discord:n1', iface: 'discord', authority: 'discord/global', native: 'n1', person: ZOE });
  addAccount(db, { id: 'discord:n2', iface: 'discord', authority: 'discord/global', native: 'n2', person: ARIS });
  addDmPlace(db, { id: DM, iface: 'discord', authority: 'discord/global', account: 'discord:n1', person: ZOE });
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
  const source = (row: Record<string, unknown>) => insertRows(db, { sources: [row] });
  seed({
    db,
    handle: opened0,
    herLine(place, when, turn = null, replyTo = null) {
      lineIds += 1;
      source({
        id: `src:discord:own-${lineIds}:1`,
        kind: 'said',
        iface: 'discord',
        native_id: `own-${lineIds}`,
        native_kind: 'message',
        place_id: place,
        occurred_at: iso(when),
        recorded_at: iso(when),
        text: 'λόγια',
        turn_id: turn,
        reply_to: replyTo,
        ...scopeOf(place),
      });
    },
    theirLine(place, id, account, when) {
      source({
        id: `src:discord:${id}:1`,
        kind: 'seen',
        iface: 'discord',
        native_id: id,
        native_kind: 'message',
        place_id: place,
        author_account: account,
        author_person: account === 'discord:n1' ? ZOE : ARIS,
        occurred_at: iso(when),
        recorded_at: iso(when),
        text: 'λόγια',
        ...scopeOf(place),
      });
    },
    turnStart(place, turn, author, when) {
      const trigger = author ? { kind: 'mention', messageId: 'm0', authorId: author } : { kind: 'inner' };
      insertRows(db, {
        day: [
          {
            id: `ts-${turn}`,
            at: iso(when),
            what: 'turn.start',
            turn_id: turn,
            place_id: place,
            extra: JSON.stringify({ trigger }),
            ...scopeOf(place),
          },
        ],
      });
    },
    intention(id, purpose) {
      writeIntentions(
        db,
        {
          op: 'value',
          intentions: [
            {
              id,
              purpose,
              status: 'done',
              createdAt: NOW - HOUR * 5,
              updatedAt: NOW - HOUR * 5,
              provenance: { kind: 'self', turnId: null, scope: 'group' },
            },
          ],
        },
        iso(NOW)
      );
    },
    wakeRun(id, kind, when, intentions = []) {
      startRun(opened0, {
        id,
        kind,
        startedAt: when,
        inputs: {
          wakes: [],
          intentions: intentions.map((one) => ({ id: one, updatedAt: null })),
          facts: [],
          placeId: null,
        },
      });
      finishRun(opened0, { id, status: 'succeeded', outcome: 'spoke', finishedAt: when + MIN });
    },
    innerEnd(turn, when, actions) {
      insertRows(db, {
        day: [
          {
            id: `inner-${turn}`,
            at: iso(when),
            what: 'inner',
            turn_id: turn,
            place_id: null,
            extra: JSON.stringify({ event: 'turn', turnId: turn, actions }),
            scope_kind: 'none',
          },
        ],
      });
    },
    request(turn, when, calls) {
      db.prepare(
        `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, status, started_at, messages, tool_calls)
         VALUES (?, 1, ?, '1', ?, 'ok', ?, '[]', ?)`
      ).run(
        `req-${turn}-${when}`,
        turn,
        when,
        iso(when),
        JSON.stringify(
          calls.map(([skill, parsed], index) => ({
            id: `c${index}`,
            name: apiNameOf(skill),
            arguments: JSON.stringify(parsed),
            parsed,
            parseError: null,
          }))
        )
      );
    },
    entry(id, kind, when) {
      insertRows(db, {
        diary: [
          { id, at_ms: when, kind, gist: id, text: id, scope_kind: 'group', scope_iface: 'discord', position: when },
        ],
      });
    },
  });
  opened0.close();
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
  /** One action of hers at `when` in `place` that started and succeeded, as a turn writes it. */
  async function act(place: string, name: string, when: number, skill: string | null = null, turn = `t-${when}`) {
    clock.at = when;
    const op = journal.op(place, {
      placeId: CHAT[place],
      turnId: turn,
      name,
      by: 'persona',
      ...(skill ? { input: { skill } } : {}),
      intent: { replyTo: null, text: 'λόγια' },
    });
    await op.started();
    await op.succeeded({ messageId: `m-${when}` });
    await settled();
  }
  /** A skill call of hers at `when` from a turn in `place` that acted in the chat `target` names. */
  async function callInto(place: string, skill: string, target: string, when: number, turn = `t-${when}`) {
    clock.at = when;
    const op = journal.op(place, {
      placeId: CHAT[place],
      turnId: turn,
      name: 'skill',
      by: 'persona',
      input: { skill },
    });
    await op.started({ target: { channel: target } });
    await op.succeeded({ messageId: `m-${when}` });
    await settled();
  }
  const day = (ctx: unknown = groupContext('discord'), options: Partial<typeof OPTIONS> = {}): Day =>
    dayOf(read(), ctx, placeNames, NOW, TZ, { ...OPTIONS, ...options });
  return { act, callInto, day };
}

/** The event lines of `<my_day>`, its header left out. */
const events = (day: Day): Array<string> => day.events.slice(1);
/** The call lines of `<calls>`, its header left out. */
const calls = (day: Day): Array<string> => day.calls.slice(1);

// <calls>: her calls of today, as the journal holds them.

test('lists one call line per action of today, a post, a skill call, a GIF and a reaction, and none of yesterday', async () => {
  // Bug: the started and the closing line of one action both list, or yesterday's evening reads as today.
  const w = world();
  await w.act(SALON, 'post', NOW - 14 * 60 * MIN);
  await w.act(CAFE, 'post', NOW - 50 * MIN);
  await w.act(CAFE, 'skill', NOW - 40 * MIN, 'memory.search');
  await w.act(CAFE, 'gif', NOW - 30 * MIN);
  await w.act(CAFE, 'react', NOW - 20 * MIN);
  const lines = calls(w.day());
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.ok(
    lines.every((one) => one.includes('café')),
    lines.join('\n')
  );
});

test('lists no more call lines than its setting', async () => {
  // Bug: a busy day fills the request with every action she took.
  const w = world();
  for (let i = 0; i < 5; i += 1) await w.act(CAFE, 'post', NOW - (50 - i) * MIN);
  assert.equal(calls(w.day(groupContext('discord'), { calls: 2 })).length, 2);
});

test('a group turn lists no call she made in a DM today', async () => {
  // Bug: the journal is read without the turn's context, so a group learns what she did in a private chat.
  const w = world();
  await w.act(CAFE, 'post', NOW - 30 * MIN);
  await w.act(DM, 'react', NOW - 20 * MIN);
  assert.ok(
    calls(w.day(internalContext())).some((one) => one.includes('Zoé')),
    'the DM action is in the journal'
  );
  const lines = calls(w.day());
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
  const [line] = calls(w.day());
  assert.ok(line?.includes('salon') && !line.includes('café'), line);
});

test("names the turn's chat for a call into a place the group turn may not read", async () => {
  // Bug: a group turn's line names the DM her call reached, and the group learns of a private chat.
  const w = world();
  await w.callInto(CAFE, 'message.create', CHAT[DM], NOW - 10 * MIN);
  const [line] = calls(w.day());
  assert.ok(line?.includes('café') && !line.includes('Zoé'), line);
});

test('lists a board call of hers under its own name, not an errand tool that once had it', async () => {
  // Bug: `task.status` is read as the old errand name `errand.list`, so her board check reads as an errand list.
  const w = world();
  await w.act(CAFE, 'skill', NOW - 10 * MIN, 'task.status');
  const [line] = calls(w.day());
  assert.ok(line?.includes('task.status') && !line.includes('errand'), line);
});

test('<my_day> holds no call line of the journal that <calls> lists', async () => {
  // Bug: the log of calls stays in `<my_day>` beside the events, so the day reads as a list of tool names again.
  const w = world();
  await w.act(CAFE, 'post', NOW - 50 * MIN);
  await w.act(CAFE, 'skill', NOW - 40 * MIN, 'memory.search');
  await w.act(CAFE, 'react', NOW - 20 * MIN);
  const day = w.day();
  assert.equal(calls(day).length, 3, day.calls.join('\n'));
  assert.ok(!events(day).some((line) => calls(day).includes(line)), day.events.join('\n'));
  assert.ok(!events(day).some((line) => line.includes('memory.search')), day.events.join('\n'));
});

// <my_day>: her day as events.

test('nine lines of hers in one place within an hour are one conversation with its clock range, count and people', () => {
  // Bug: every line of hers is its own event, or the people she answered by a reply or by their message are lost.
  const w = world((s) => {
    s.turnStart(CAFE, 't-a', 'n1', at(10, 0));
    s.theirLine(CAFE, 'their-1', 'discord:n2', at(10, 20));
    for (let i = 0; i < 9; i += 1) s.herLine(CAFE, at(10, i * 7), i < 4 ? 't-a' : 't-b', i === 5 ? 'their-1' : null);
  });
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  const [line = ''] = lines;
  for (const part of ['10:00', '10:56', 'café', '9', handle(ZOE), handle(ARIS)]) assert.ok(line.includes(part), line);
});

test('a silence of hers of 31 minutes in one place ends a conversation and one of 29 does not', () => {
  // Bug: the cut is not the half hour, so two talks read as one or one talk as two.
  const apart = world((s) => {
    s.herLine(CAFE, at(9, 0));
    s.herLine(CAFE, at(9, 31));
  });
  assert.equal(events(apart.day()).length, 2, apart.day().events.join('\n'));
  const close = world((s) => {
    s.herLine(CAFE, at(9, 0));
    s.herLine(CAFE, at(9, 29));
  });
  assert.equal(events(close.day()).length, 1, close.day().events.join('\n'));
});

test('a line of hers in a direct chat is no event in a group turn and is one in a turn of that chat', () => {
  // Bug: the lines are read without the turn's context, so a group learns that she talked in a private chat.
  const w = world((s) => s.herLine(DM, at(9, 0)));
  assert.deepEqual(events(w.day()), []);
  const own = events(w.day(dmContext(ZOE, 'discord', DM)));
  assert.equal(own.length, 1, own.join('\n'));
  assert.ok(own[0]?.includes('Zoé'), own[0]);
});

test('a picture made for a person inside a conversation is its own line, names the person and keeps the talk one line', async () => {
  // Bug: the picture splits the talk in two, is folded into it, or loses whom it was made for.
  const w = world((s) => {
    s.turnStart(CAFE, 't-c', 'n1', at(10, 0));
    for (const mm of [0, 20, 40]) s.herLine(CAFE, at(10, mm), 't-c');
  });
  await w.act(CAFE, 'skill', at(10, 21), 'draw.create', 't-c');
  const lines = events(w.day());
  assert.equal(lines.length, 2, lines.join('\n'));
  const made = lines.find((line) => line.includes('10:21')) ?? '';
  assert.ok(made.includes(handle(ZOE)), made);
  assert.ok(
    lines.some((line) => line.includes('10:00') && line.includes('10:40')),
    lines.join('\n')
  );
});

test('a picture made in an inner turn names no person', async () => {
  // Bug: a picture of her own accord is put down to the last person who wrote to her.
  const w = world((s) => s.turnStart(CAFE, 't-own', null, at(9, 0)));
  await w.act(CAFE, 'skill', at(9, 1), 'draw.create', 't-own');
  const [line = ''] = events(w.day());
  assert.ok(line.includes('09:01'), line);
  assert.ok(!line.includes('@'), line);
});

/** A heartbeat at 09:00 that read the café and the salon and searched twice, ended by `actions`. */
async function heartbeatDay(actions: ReadonlyArray<Record<string, unknown>>): Promise<Array<string>> {
  const w = world((s) => {
    s.wakeRun('hb-1', 'heartbeat', at(9, 0));
    s.intention('i-hb', 'ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ');
    s.request('hb-1', at(9, 1), [['web.search', { query: 'ΑΣΤΕΡΙΑ' }]]);
    s.request('hb-1', at(9, 2), [['memory.search', { question: 'ΚΗΠΟΣ' }]]);
    if (actions.length > 0) s.innerEnd('hb-1', at(9, 5), actions);
  });
  await w.callInto(CAFE, 'conversation.read', CHAT[CAFE], at(9, 1), 'hb-1');
  await w.callInto(CAFE, 'conversation.read', CHAT[SALON], at(9, 2), 'hb-1');
  return events(w.day());
}

test('a heartbeat that read two places, searched twice and set an intention is one line with all of it', async () => {
  // Bug: her own time is left out, told as six calls, or loses what she searched for or what she decided.
  const lines = await heartbeatDay([
    { skill: 'intention.set', status: 'executed', result: 'ok', createdId: 'i-hb', target: {} },
  ]);
  assert.equal(lines.length, 1, lines.join('\n'));
  const [line = ''] = lines;
  for (const part of ['09:00', 'café', 'salon', 'ΑΣΤΕΡΙΑ', 'ΚΗΠΟΣ', 'ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ'])
    assert.ok(line.includes(part), line);
});

test('a heartbeat that set nothing says it ended with nothing', async () => {
  // Bug: a heartbeat with no decision reads as one that made one, or its ending is left out.
  const [line = ''] = await heartbeatDay([]);
  assert.ok(line.includes('ΑΣΤΕΡΙΑ') && !line.includes('ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ'), line);
  assert.ok(line.includes(String(labels.myDay.heartbeatNothing)), line);
});

test('an intention carried out says its purpose and place, and its line is not told again as a conversation', () => {
  // Bug: the act is told twice, once as the intention and once as a talk in the same place, or loses its purpose.
  const w = world((s) => {
    s.intention('i-1', 'ΣΚΟΠΟΣ-ΕΝΑ');
    s.wakeRun('w-int', 'intention_due', at(11, 0), ['i-1']);
    s.herLine(SALON, at(11, 1), 'w-int');
  });
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('ΣΚΟΠΟΣ-ΕΝΑ') && lines[0].includes('salon'), lines[0]);
});

test('a diary entry is a line with its clock and kind', () => {
  // Bug: her diary entries are left out of her day.
  const w = world((s) => s.entry('diary:1', 'status', at(8, 0)));
  const [line = ''] = events(w.day());
  assert.ok(line.includes('08:00') && line.includes('status'), line);
});

test('with more events than the setting the oldest are dropped and the header says how many', () => {
  // Bug: a long day fills the request, or drops the newest, or drops events without saying so.
  const w = world((s) => {
    for (let i = 0; i < 5; i += 1) s.herLine(CAFE, at(6 + i, 0));
  });
  const day = w.day(groupContext('discord'), { events: 2 });
  const shown = day.events.filter((line) => line.startsWith('['));
  assert.equal(shown.length, 2, day.events.join('\n'));
  assert.ok(shown[0]?.includes('09:00') && shown[1]?.includes('10:00'), shown.join('\n'));
  assert.ok(day.events.slice(0, -2).join('\n').includes('3'), day.events.join('\n'));
});

test('since her last entry the day reaches across midnight to the first event after that entry', () => {
  // Bug: the diary reads today alone, so an evening after her last entry never reaches the next entry.
  const w = world((s) => {
    s.entry('diary:last', 'status', NOW - 20 * HOUR);
    s.herLine(CAFE, NOW - 15 * HOUR);
    s.herLine(CAFE, NOW - 22 * HOUR);
  });
  const since = events(w.day(groupContext('discord'), { sinceLastEntry: true }));
  assert.equal(since.length, 1, since.join('\n'));
  assert.ok(since[0]?.includes('21:00'), since[0]);
  assert.deepEqual(events(w.day()), []);
});
