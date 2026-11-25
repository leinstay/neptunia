// Tests for src/turn/request/my-day.ts#dayOf: the persona's day as events for `<my_day>` and their calls of today for
// `<calls>`, read from the engine's records under the turn's context. The calls come from the journal a turn writes,
// over the real service and database; the persona's lines, the turn starts, the wake runs, the intentions, the archive
// of requests and the diary are seeded into the same database before the service opens it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { finishRun, startRun } from '../../../../src/memory/db/wakes.ts';
import { writeIntentions } from '../../../../src/memory/db/intentions-write.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { PERSONA_ID } from '../../../../src/memory/db/ids.ts';
import { dmContext, groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { apiNameOf } from '../../../../src/tools/definitions.ts';
import { fill } from '../../../../src/format.ts';
import { dayOf } from '../../../../src/turn/request/my-day.ts';
import type { Day } from '../../../../src/turn/request/my-day.ts';
import { labels } from '../../../fixtures/labels.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { addLine, type World } from '../../../fixtures/memory-db/mind-world.ts';
import {
  blockOf,
  ELENI,
  replyRun,
  type ReplyStep,
  serviceTurn,
  type ServiceTurnSpec,
  serviceWake,
  serviceWorld,
  TURN_NOW,
} from '../../../fixtures/service-turn.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

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
const BOT = 'person:discord:n3';
const NAMES: Record<string, string> = { [CAFE]: 'café', [SALON]: 'salon', [DM]: 'Zoé' };
const placeNames = (id: string): string | null => NAMES[id] ?? null;
const handle = (person: string): string => `@${handleOf(person)}`;

/** The native chat id a turn writes its journal lines with. */
const CHAT: Record<string, string> = { [CAFE]: 'room-1', [SALON]: 'room-2', [DM]: 'dm-chat-n1' };

const { things, thingsMany, acts } = labels.myDay;
const PICTURE = things['draw.create'];
const PICTURES = thingsMany['draw.create'];
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
  /** A line of the persona's in `place` at `when`, written by `turn`, answering the message `replyTo`. */
  personaLine(place: string, when: number, turn?: string | null, replyTo?: string | null): void;
  /** A line of `account` in `place` with the message id `id`. */
  theirLine(place: string, id: string, account: string, when: number): void;
  /** The journal's start row of `turn` in `place`, started by the member `author` or by a wake (null), in `mode`. */
  turnStart(place: string, turn: string, author: string | null, when: number, mode?: string): void;
  /** Makes the account `id` a bot's. */
  bot(id: string): void;
  /** Makes `place` an enabled diary mirror. */
  mirror(place: string): void;
  /** Makes the intention `id` one of the direct chat with Zoé. */
  private(id: string): void;
  /** An intention of the persona's with `purpose`. */
  intention(id: string, purpose: string): void;
  /** A finished wake run of `kind` at `when` that carried `intentions`. */
  wakeRun(id: string, kind: string, when: number, intentions?: ReadonlyArray<string>): void;
  /** The `inner` row of an inner turn's end with its actions. */
  innerEnd(turn: string, when: number, actions: ReadonlyArray<Record<string, unknown>>): void;
  /** One archived model request of `turn` whose answer called `calls`, each a skill and its arguments. */
  request(turn: string, when: number, calls: ReadonlyArray<[string, Record<string, unknown>]>): void;
  /** A stored diary entry of `kind` at `when`, written by `turn`. */
  entry(id: string, kind: string, when: number, turn?: string): void;
  /** The memory session's sentence `what` of a stretch from `from` to `to` held by the place or the run `holder`. */
  sentence(holder: string, from: number, to: number, what: string): void;
};

let lineIds = 0;

/** A database with two group places and one DM, seeded by `seed`, and the journal a turn writes through. */
function world(seed: (s: Seed) => void = () => {}) {
  const dataDir = tempDir('nep-my-day-');
  const opened0 = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(opened0);
  addAccount(db, { id: 'discord:n1', iface: 'discord', authority: 'discord/global', native: 'n1', person: ZOE });
  addAccount(db, { id: 'discord:n2', iface: 'discord', authority: 'discord/global', native: 'n2', person: ARIS });
  addAccount(db, { id: 'discord:n3', iface: 'discord', authority: 'discord/global', native: 'n3', person: BOT });
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
  const intentions: Array<Record<string, unknown>> = [];
  seed({
    db,
    handle: opened0,
    personaLine(place, when, turn = null, replyTo = null) {
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
    bot(id) {
      db.prepare("UPDATE accounts SET kind = 'bot' WHERE id = ?").run(id);
    },
    mirror(place) {
      db.prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES (?, 'diary', ?, 1, ?, 'owner')"
      ).run(`mirror:${place}`, place, iso(NOW - 24 * HOUR));
    },
    private(id) {
      db.prepare("UPDATE intentions SET scope_kind = 'dm', scope_iface = 'discord', scope_dm = ? WHERE id = ?").run(
        ZOE,
        id
      );
    },
    turnStart(place, turn, author, when, mode = 'reply') {
      const trigger = author ? { kind: 'mention', messageId: 'm0', authorId: author } : { kind: 'inner' };
      insertRows(db, {
        day: [
          {
            id: `ts-${turn}`,
            at: iso(when),
            what: 'turn.start',
            turn_id: turn,
            place_id: place,
            extra: JSON.stringify({ mode, trigger }),
            ...scopeOf(place),
          },
        ],
      });
    },
    intention(id, purpose) {
      // The write holds the whole list, so a second intention is written beside the ones before it.
      intentions.push({
        id,
        purpose,
        status: 'done',
        createdAt: NOW - HOUR * 5,
        updatedAt: NOW - HOUR * 5,
        provenance: { kind: 'self', turnId: null, scope: 'group' },
      });
      writeIntentions(db, { op: 'value', intentions: [...intentions] }, iso(NOW));
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
    sentence(holder, from, to, what) {
      const place = holder in CHAT ? holder : null;
      insertRows(db, {
        episodes: [
          {
            id: `stretch:${holder}:${from}`,
            kind: 'stretch',
            writer: 'stretch',
            holder_id: holder,
            place_id: place,
            start_ms: from,
            last_ms: to,
            what,
            ...(place ? scopeOf(place) : { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }),
          },
        ],
      });
    },
    entry(id, kind, when, turn) {
      insertRows(db, {
        diary: [
          {
            ...{
              id,
              at_ms: when,
              kind,
              gist: id,
              text: id,
              scope_kind: 'group',
              scope_iface: 'discord',
              position: when,
            },
            ...(turn ? { extra: JSON.stringify({ turnId: turn }) } : {}),
          },
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
  /** One action of the persona's at `when` in `place` that started and succeeded, as a turn writes it. */
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
  /** A skill call of the persona's at `when` from a turn in `place` that acted in the chat `target` names. */
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

// <calls>: the persona's calls of today, as the journal holds them.

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
  // Bug: a busy day fills the request with every action the persona took.
  const w = world();
  for (let i = 0; i < 5; i += 1) await w.act(CAFE, 'post', NOW - (50 - i) * MIN);
  assert.equal(calls(w.day(groupContext('discord'), { calls: 2 })).length, 2);
});

test('a group turn lists no call the persona made in a DM today', async () => {
  // Bug: the journal is read without the turn's context, so a group learns what the persona did in a private chat.
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
  // Bug: a post the persona made from the café into the salon is listed under the café, so they look for it in the
  // wrong place.
  const w = world();
  await w.callInto(CAFE, 'message.create', CHAT[SALON], NOW - 10 * MIN);
  const [line] = calls(w.day());
  assert.ok(line?.includes('salon') && !line.includes('café'), line);
});

test("names the turn's chat for a call into a place the group turn may not read", async () => {
  // Bug: a group turn's line names the DM the persona's call reached, and the group learns of a private chat.
  const w = world();
  await w.callInto(CAFE, 'message.create', CHAT[DM], NOW - 10 * MIN);
  const [line] = calls(w.day());
  assert.ok(line?.includes('café') && !line.includes('Zoé'), line);
});

test("lists a board call of the persona's under its own name, not an errand tool that once had it", async () => {
  // Bug: `task.status` is read as the old errand name `errand.list`, so the persona's board check reads as an errand
  // list.
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

// <my_day>: the persona's day as events.

test("nine lines of the persona's in one place within an hour are one conversation with its clock range, count and people", () => {
  // Bug: every line of the persona's is its own event, or the people they answered by a reply or by their message are
  // lost.
  const w = world((s) => {
    s.turnStart(CAFE, 't-a', 'n1', at(10, 0));
    s.theirLine(CAFE, 'their-1', 'discord:n2', at(10, 20));
    for (let i = 0; i < 9; i += 1)
      s.personaLine(CAFE, at(10, i * 7), i < 4 ? 't-a' : 't-b', i === 5 ? 'their-1' : null);
  });
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  const [line = ''] = lines;
  for (const part of ['10:00', '10:56', 'café', '9', handle(ZOE), handle(ARIS)]) assert.ok(line.includes(part), line);
});

test("a silence of the persona's of 31 minutes in one place ends a conversation and one of 29 does not", () => {
  // Bug: the cut is not the half hour, so two talks read as one or one talk as two.
  const apart = world((s) => {
    s.personaLine(CAFE, at(9, 0));
    s.personaLine(CAFE, at(9, 31));
  });
  assert.equal(events(apart.day()).length, 2, apart.day().events.join('\n'));
  const close = world((s) => {
    s.personaLine(CAFE, at(9, 0));
    s.personaLine(CAFE, at(9, 29));
  });
  assert.equal(events(close.day()).length, 1, close.day().events.join('\n'));
});

test("a line of the persona's in a direct chat is no event in a group turn and is one in a turn of that chat", () => {
  // Bug: the lines are read without the turn's context, so a group learns that the persona talked in a private chat.
  const w = world((s) => s.personaLine(DM, at(9, 0)));
  assert.deepEqual(events(w.day()), []);
  const own = events(w.day(dmContext(ZOE, 'discord', DM)));
  assert.equal(own.length, 1, own.join('\n'));
  assert.ok(own[0]?.includes('Zoé'), own[0]);
});

test('a picture made for a person inside a conversation is its own line, names the person and keeps the talk one line', async () => {
  // Bug: the picture splits the talk in two, is folded into it, or loses whom it was made for.
  const w = world((s) => {
    s.turnStart(CAFE, 't-c', 'n1', at(10, 0));
    for (const mm of [0, 20, 40]) s.personaLine(CAFE, at(10, mm), 't-c');
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
  // Bug: a picture of the persona's own accord is put down to the last person who wrote to them.
  const w = world((s) => s.turnStart(CAFE, 't-own', null, at(9, 0)));
  await w.act(CAFE, 'skill', at(9, 1), 'draw.create', 't-own');
  const [line = ''] = events(w.day());
  assert.ok(line.includes('09:01'), line);
  assert.ok(!line.includes('@'), line);
});

const SET_HB = [{ skill: 'intention.set', status: 'executed', result: 'ok', createdId: 'i-hb', target: {} }];

/**
 * A heartbeat at 09:00 whose rows sit in the persona's own place, as a heartbeat's do: it read the café by its chat's
 * native id and the salon by its place id, looked into the persona's memory once and searched the web once, ended by
 * `actions`, and its intention `i-hb` is one of the direct chat when `privateSet`. Its day as `ctx` reads it.
 */
async function heartbeatDay(
  actions: ReadonlyArray<Record<string, unknown>>,
  { ctx = groupContext('discord'), privateSet = false } = {}
): Promise<Array<string>> {
  const w = world((s) => {
    s.wakeRun('hb-1', 'heartbeat', at(9, 0));
    s.intention('i-hb', 'ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ');
    s.intention('i-hb2', 'ΣΚΟΠΟΣ-ΤΡΑΓΟΥΔΙΟΥ');
    if (privateSet) s.private('i-hb');
    s.request('hb-1', at(9, 1), [['web.search', { query: 'ΑΣΤΕΡΙΑ' }]]);
    s.request('hb-1', at(9, 2), [['memory.search', { question: 'ΚΗΠΟΣ' }]]);
    if (actions.length > 0) s.innerEnd('hb-1', at(9, 5), actions);
  });
  await w.callInto(PERSONA_ID, 'conversation.read', CHAT[CAFE], at(9, 1), 'hb-1');
  await w.callInto(PERSONA_ID, 'conversation.read', SALON, at(9, 2), 'hb-1');
  return events(w.day(ctx));
}

test('a heartbeat that read two places, searched twice and set an intention is one line with all of it', async () => {
  // Bug: the persona's own time is left out, told as six calls, or loses what they searched for or what they decided.
  const lines = await heartbeatDay(SET_HB);
  assert.equal(lines.length, 1, lines.join('\n'));
  const [line = ''] = lines;
  for (const part of ['09:00', 'café', 'salon', 'ΑΣΤΕΡΙΑ', 'ΚΗΠΟΣ', 'ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ'])
    assert.ok(line.includes(part), line);
});

// Bug caught: a heartbeat that set two intentions tells the first alone, so the persona forgets the second wish.
test('a heartbeat that set two intentions tells both, and never nothing', async () => {
  const two = [...SET_HB, { ...SET_HB[0], createdId: 'i-hb2' }];
  const [line = ''] = await heartbeatDay(two);
  assert.ok(line.includes('ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ') && line.includes('ΣΚΟΠΟΣ-ΤΡΑΓΟΥΔΙΟΥ'), line);
  assert.ok(!line.includes(String(labels.myDay.heartbeatNothing)), line);
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
    s.personaLine(SALON, at(11, 1), 'w-int');
  });
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('ΣΚΟΠΟΣ-ΕΝΑ') && lines[0].includes('salon'), lines[0]);
});

test('a diary entry is a line with its clock and kind', () => {
  // Bug: the persona's diary entries are left out of their day.
  const w = world((s) => s.entry('diary:1', 'thought', at(8, 0)));
  const [line = ''] = events(w.day());
  assert.ok(line.includes('08:00') && line.includes('thought'), line);
});

test('with more events than the setting the oldest are dropped and the header says how many', () => {
  // Bug: a long day fills the request, or drops the newest, or drops events without saying so.
  const w = world((s) => {
    for (let i = 0; i < 5; i += 1) s.personaLine(CAFE, at(6 + i, 0));
  });
  const day = w.day(groupContext('discord'), { events: 2 });
  const shown = day.events.filter((line) => line.startsWith('['));
  assert.equal(shown.length, 2, day.events.join('\n'));
  assert.ok(shown[0]?.includes('09:00') && shown[1]?.includes('10:00'), shown.join('\n'));
  assert.ok(day.events.slice(0, -2).join('\n').includes('3'), day.events.join('\n'));
});

test("since the persona's last entry the day reaches across midnight to the first event after that entry", () => {
  // Bug: the diary reads today alone, so an evening after the persona's last entry never reaches the next entry.
  const w = world((s) => {
    s.entry('diary:last', 'thought', NOW - 20 * HOUR);
    s.personaLine(CAFE, NOW - 15 * HOUR);
    s.personaLine(CAFE, NOW - 22 * HOUR);
  });
  const since = events(w.day(groupContext('discord'), { sinceLastEntry: true }));
  assert.equal(since.length, 1, since.join('\n'));
  assert.ok(since[0]?.includes('21:00'), since[0]);
  assert.deepEqual(events(w.day()), []);
});

test('a heartbeat whose intention the context may not read says it set one, with no purpose and never nothing', async () => {
  // Bug: the purpose is filtered by another rule than the intention's own line, and a hidden purpose reads as an
  // ending with nothing set.
  const [inside = ''] = await heartbeatDay(SET_HB, { ctx: internalContext(), privateSet: true });
  assert.ok(inside.includes('ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ'), inside);
  const [line = ''] = await heartbeatDay(SET_HB, { privateSet: true });
  assert.ok(!line.includes('ΣΚΟΠΟΣ-ΚΑΡΔΙΑΣ'), line);
  assert.ok(line.includes(String(labels.myDay.heartbeatSetHidden)), line);
  assert.ok(!line.includes(String(labels.myDay.heartbeatNothing)), line);
});

test("the persona's memory lookups and web searches are told apart, each under its own words", async () => {
  // Bug: a question to the persona's own memory reads as a web search.
  const [line = ''] = await heartbeatDay([]);
  assert.ok(line.includes(fill(String(labels.myDay.heartbeatSearched), { queries: '"ΑΣΤΕΡΙΑ"' })), line);
  assert.ok(line.includes(fill(String(labels.myDay.heartbeatRecalled), { queries: '"ΚΗΠΟΣ"' })), line);
});

test("the persona's lines in an enabled diary mirror are no conversation, since the diary entry's line tells them", () => {
  // Bug: the mirror's copy of an entry reads as a talk in the mirror's place beside the entry's own line.
  const w = world((s) => {
    s.mirror(SALON);
    s.entry('diary:m', 'thought', at(3, 46));
    s.personaLine(SALON, at(3, 46));
    s.personaLine(SALON, at(3, 47));
  });
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('thought'), lines[0]);
});

test("what a diary turn made is counted on the entry's line and no line of its own", async () => {
  // Bug: a photoset entry is followed by one line per picture, each of the persona's own accord.
  const w = world((s) => {
    s.turnStart(PERSONA_ID, 't-diary', null, at(8, 0), 'diary');
    // The entry stands at its turn's start, 08:00, before the pictures its turn makes.
    s.entry('diary:p', 'photoset', at(8, 0));
  });
  for (const mm of [1, 2, 3]) await w.act(CAFE, 'skill', at(8, mm), 'draw.create', 't-diary');
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('photoset') && lines[0].includes('3'), lines[0]);
});

test("what an intention's turn made is counted on the intention's line and no line of its own", async () => {
  // Bug: the intention carried out stands beside a line of a picture made of the persona's own accord at the same
  // minute.
  const w = world((s) => {
    s.intention('i-2', 'ΣΚΟΠΟΣ-ΔΥΟ');
    s.wakeRun('w-pic', 'intention_due', at(11, 22), ['i-2']);
    s.personaLine(SALON, at(11, 22), 'w-pic');
  });
  await w.act(SALON, 'skill', at(11, 22), 'draw.create', 'w-pic');
  const lines = events(w.day(groupContext('discord')));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('ΣΚΟΠΟΣ-ΔΥΟ') && lines[0].includes(PICTURE), lines[0]);
});

test("a heartbeat names the places it read when its rows sit in the persona's own place, by place id and by native id", async () => {
  // Bug: a heartbeat's rows give no interface, so neither shape of target resolves and "you read" never appears.
  const [line = ''] = await heartbeatDay([], { ctx: internalContext() });
  assert.ok(line.includes('café') && line.includes('salon'), line);
});

test("a bot that started the persona's turn is not among the people they answered", () => {
  // Bug: a bot's message reads as a person the persona talked with.
  const w = world((s) => {
    s.bot('discord:n3');
    s.turnStart(CAFE, 't-bot', 'n3', at(9, 0));
    s.personaLine(CAFE, at(9, 0), 't-bot');
  });
  const [line = ''] = events(w.day());
  assert.ok(!line.includes(handle(BOT)), line);
});

test('a conversation of one message gives one clock and words one message', () => {
  // Bug: a single line reads as a range from a minute to the same minute and as "1 of your messages".
  const w = world((s) => s.personaLine(CAFE, at(1, 3)));
  const [line = ''] = events(w.day());
  assert.equal(line.split('01:03').length, 2, line);
  assert.ok(line.includes(String(labels.myDay.oneMessage)), line);
});

test("a diary turn's pictures go to its own entry, not to the next entry of the day", async () => {
  // Bug: an entry's moment is its turn's start, so the pictures made after it are put on the next entry.
  const w = world((s) => {
    s.turnStart(PERSONA_ID, 't-d1', null, at(8, 0), 'diary');
    s.entry('diary:a', 'photoset', at(8, 0));
    s.turnStart(PERSONA_ID, 't-d2', null, at(11, 0), 'diary');
    s.entry('diary:b', 'thought', at(11, 0));
  });
  for (const mm of [1, 1, 2]) await w.act(CAFE, 'skill', at(8, mm), 'draw.create', 't-d1');
  const lines = events(w.day());
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(lines[0]?.includes('photoset') && lines[0].includes('3'), lines[0]);
  assert.ok(!lines[1]?.includes(PICTURES), lines[1]);
});

test("an intention's turn that made a thing and sent no line says it came due and what it made", async () => {
  // Bug: the line says nothing went out and that the persona made a picture, two halves the reader cannot both believe.
  const w = world((s) => {
    s.intention('i-3', 'ΣΚΟΠΟΣ-ΤΡΙΑ');
    s.wakeRun('w-made', 'intention_due', at(11, 30), ['i-3']);
  });
  await w.act(SALON, 'skill', at(11, 31), 'draw.create', 'w-made');
  const [line = ''] = events(w.day());
  assert.ok(line.includes('ΣΚΟΠΟΣ-ΤΡΙΑ') && line.includes(PICTURE), line);
  assert.ok(
    !line.includes(fill(String(labels.myDay.intentionSilent), { time: '11:30', purpose: 'ΣΚΟΠΟΣ-ΤΡΙΑ' })),
    line
  );
});

test("an intention's turn that only edited a message says it edited one and not that nothing went out", async () => {
  // Bug: an edit sends no new line, so the turn that corrected the persona's message reads as one that did nothing.
  const w = world((s) => {
    s.intention('i-4', 'ΣΚΟΠΟΣ-ΤΕΣΣΕΡΑ');
    s.wakeRun('w-edit', 'intention_due', at(11, 30), ['i-4']);
    s.wakeRun('w-idle', 'intention_due', at(10, 30), ['i-4']);
  });
  await w.act(SALON, 'skill', at(11, 31), 'message.edit', 'w-edit');
  const [idle = '', edited = ''] = events(w.day());
  const silent = (time: string, purpose: string): string =>
    fill(String(labels.myDay.intentionSilent), { time, purpose });
  assert.ok(edited.includes(acts['message.edit']), edited);
  assert.ok(!edited.includes(silent('11:30', 'ΣΚΟΠΟΣ-ΤΕΣΣΕΡΑ')), edited);
  assert.ok(idle.includes(silent('10:30', 'ΣΚΟΠΟΣ-ΤΕΣΣΕΡΑ')), idle);
});

test('a thing made by the turn an entry names goes to that entry, however long after its moment', async () => {
  // Bug: only the time ties a picture to its entry, so a slow diary turn's picture reads as made of the persona's own
  // accord.
  const w = world((s) => s.entry('diary:t', 'selfie', at(8, 0), 't-slow'));
  await w.act(CAFE, 'skill', at(8, 45), 'draw.create', 't-slow');
  const lines = events(w.day());
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0]?.includes('selfie') && lines[0].includes(PICTURE), lines[0]);
});

test("a conversation's line and an own-time line end with the stored sentence, and a conversation with none reads as before", () => {
  // Bug: the day reads as a timetable although memory holds what a stretch was about, or a sentence lands on another
  // event.
  const about = (what: string): string => fill(String(labels.myDay.about), { what });
  const plain = world((s) => {
    s.personaLine(SALON, at(11, 0));
  });
  const [salonBefore = ''] = events(plain.day());
  const w = world((s) => {
    s.personaLine(CAFE, at(10, 0));
    s.personaLine(CAFE, at(10, 20));
    s.personaLine(SALON, at(11, 0));
    s.sentence(CAFE, at(9, 50), at(10, 20), 'ΓΙΑ-ΤΟΝ-ΚΑΦΕ');
    s.sentence(SALON, at(9, 30), at(9, 40), 'ΠΑΛΙΑ');
    s.wakeRun('hb-1', 'heartbeat', at(9, 0));
    s.sentence('hb-1', at(9, 0), at(9, 0), 'ΒΡΗΚΑ-ΑΣΤΕΡΙΑ');
  });
  const lines = events(w.day());
  const cafe = lines.find((line) => line.includes('café')) ?? '';
  const salon = lines.find((line) => line.includes('salon')) ?? '';
  const own = lines.find((line) => line.includes('09:00')) ?? '';
  assert.ok(cafe.endsWith(about('ΓΙΑ-ΤΟΝ-ΚΑΦΕ')), cafe);
  assert.ok(own.endsWith(about('ΒΡΗΚΑ-ΑΣΤΕΡΙΑ')), own);
  assert.equal(salon, salonBefore, 'a sentence of an earlier stretch of the place is not this one');
});

test("an intention's line ends with the sentence of the stretch that holds the lines its turn sent, and one that sent none has none", () => {
  // Bug: the intention's lines are left out of the conversations, so the sentence stored for them is told nowhere.
  const about = fill(String(labels.myDay.about), { what: 'ΓΙΑ-ΤΗΝ-ΠΡΟΘΕΣΗ' });
  const w = world((s) => {
    s.intention('i-1', 'ΣΚΟΠΟΣ-ΕΝΑ');
    s.wakeRun('w-int', 'intention_due', at(10, 42), ['i-1']);
    s.personaLine(CAFE, at(10, 42), 'w-int');
    s.personaLine(CAFE, at(10, 44));
    s.sentence(CAFE, at(10, 42), at(10, 44), 'ΓΙΑ-ΤΗΝ-ΠΡΟΘΕΣΗ');
    s.wakeRun('w-quiet', 'intention_due', at(10, 50), ['i-1']);
  });
  const lines = events(w.day());
  const sent = lines.find((line) => line.includes('[10:42]')) ?? '';
  const quiet = lines.find((line) => line.includes('[10:50]')) ?? '';
  assert.ok(sent.endsWith(about), lines.join('\n'));
  assert.ok(!quiet.includes('ΓΙΑ-ΤΗΝ-ΠΡΟΘΕΣΗ'), quiet);
});

const REPLY_TURN_TAIL_LINES_MIN = 60_000;

const REPLY_TURN_TAIL_LINES_HOUR = 60 * REPLY_TURN_TAIL_LINES_MIN;

const SAY = '<think>STEP 4. So: answer.</think><msg>γεια</msg>';

const GARDEN = 'fake:channel:c2';

const EMOJI = '🌿';

const replyTurnTailLinesIso = (at: number): string => new Date(at).toISOString();

const SCOPE = { place_id: 'fake:channel:c1', scope_kind: 'group', scope_iface: 'fake' };

const turn = (id: string, ago: number): ReplyStep => ({
  trigger: { id, text: 'καλημέρα', at: TURN_NOW - ago * REPLY_TURN_TAIL_LINES_MIN },
  answers: [SAY],
});

/** The service world with the garden named `🌿κήπος`, a name whose emoji the rest of the request leaves out. */
function worldWithEmojiGarden(): World {
  const world = serviceWorld();
  world.db.prepare('UPDATE places SET name = ? WHERE id = ?').run(`${EMOJI}κήπος`, GARDEN);
  return world;
}

/** One post the persona made in the garden at `at`, as the two lines of the journal's rows that an action leaves. */
function postInGarden(at: number): Array<Record<string, unknown>> {
  const started = { opId: 'o1', name: 'post', phase: 'started', target: { channel: 'c2' } };
  const done = { opId: 'o1', name: 'post', phase: 'succeeded' };
  return [
    {
      id: 's1',
      at: replyTurnTailLinesIso(at),
      what: 'action',
      turn_id: 't-a',
      extra: JSON.stringify(started),
      ...SCOPE,
    },
    {
      id: 'e1',
      at: replyTurnTailLinesIso(at + 1000),
      what: 'action',
      turn_id: 't-a',
      extra: JSON.stringify(done),
      ...SCOPE,
    },
  ];
}

/** The `#c…` handle of the garden's entry of `<places>`: the entry whose heading holds its name. */
function gardenHandle(request: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(blockOf(request, 'memory'))?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes('κήπος')) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

const bodyOf = (request: string, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1] ?? '';

/** The request of one reply turn in `c1` after a post in the emoji garden, and the garden's handle in that request. */
async function afterPostInGarden(
  steps: ReadonlyArray<ReplyStep>,
  seed?: ServiceTurnSpec['seed']
): Promise<Array<string>> {
  const world = worldWithEmojiGarden();
  try {
    insertRows(world.db, { day: postInGarden(TURN_NOW - 30 * REPLY_TURN_TAIL_LINES_MIN) });
    const run = await replyRun({
      world,
      context: { myDay: { lines: 12 }, calls: { lines: 12 } },
      steps,
      ...(seed === undefined ? {} : { seed }),
    });
    return run.requests.map((requests) => requests[0] ?? '');
  } finally {
    world.close();
  }
}

/** The service world with the garden renamed and one post of the persona's in it today, as the day's rows hold it. */
function dayWorld(): World {
  const world = worldWithEmojiGarden();
  insertRows(world.db, { day: postInGarden(TURN_NOW - 30 * REPLY_TURN_TAIL_LINES_MIN) });
  return world;
}

/** A line of the persona's in the garden at `at`. */
const addOwnLine = (world: World, id: string, at: number): void => {
  addLine(world.db, {
    id,
    iface: 'fake',
    place: GARDEN,
    author: 'self',
    text: 'ΓΡΑΜΜΗ-ΤΗΣ',
    at: replyTurnTailLinesIso(at),
  });
};

/** The heartbeat `hb-0` of an hour ago that read Ελένη's direct chat, its read written in the persona's own place as one is. */
function readOfDm(world: World): void {
  const at = TURN_NOW - REPLY_TURN_TAIL_LINES_HOUR;
  startRun(world.handle, {
    id: 'hb-0',
    kind: 'heartbeat',
    startedAt: at,
    inputs: { wakes: [], intentions: [], facts: [] },
  });
  finishRun(world.handle, {
    id: 'hb-0',
    status: 'succeeded',
    outcome: 'skip',
    finishedAt: at + 2 * REPLY_TURN_TAIL_LINES_MIN,
  });
  const own = { place_id: 'persona:local', scope_kind: 'none' };
  const started = { opId: 'o-dm', name: 'skill', phase: 'started', input: { skill: 'conversation.read' } };
  insertRows(world.db, {
    day: [
      {
        id: 'hb-0-s',
        at: replyTurnTailLinesIso(at + REPLY_TURN_TAIL_LINES_MIN),
        what: 'action',
        turn_id: 'hb-0',
        extra: JSON.stringify({ ...started, target: { channel: 'fake:dm:111' } }),
        ...own,
      },
      {
        id: 'hb-0-e',
        at: replyTurnTailLinesIso(at + REPLY_TURN_TAIL_LINES_MIN + 1000),
        what: 'action',
        turn_id: 'hb-0',
        extra: JSON.stringify({ opId: 'o-dm', name: 'skill', phase: 'succeeded' }),
        ...own,
      },
    ],
  });
}

describe('the tail lines of a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a line of <my_day> names the garden by the handle its entry of <places> opens with, not by its name', async () => {
    // Bug: the line names the place by its stored name, emoji and all, so one place has a handle in <places> and a
    // name in <my_day> and the persona cannot tie the two.
    const [request = ''] = await afterPostInGarden([turn('r2', 1)]);
    const handle = gardenHandle(request);
    assert.match(handle, /^#c[0-9a-z]+$/, 'the garden has an entry of <places> with a handle');
    // Changed: the journal's post line stands in `<calls>`, the block of the persona's calls, since `<my_day>` holds their day as
    // events (maintainer, 2026-11-18); the place in it reads the same way.
    const lines = bodyOf(request, 'calls').split('\n');
    const line = lines.find((one) => one.startsWith('[')) ?? '';
    assert.ok(line.includes(handle), line);
    assert.ok(!line.includes(EMOJI) && !line.includes('κήπος'), line);
  });

  test("a reply turn holds the persona's day of today in <my_day> and no evening of yesterday, with <calls> right after it", async () => {
    // Bug: a reply turn reads the diary's window across midnight, or the calls stand apart from the persona's day.
    const world = dayWorld();
    try {
      addOwnLine(world, 'y1', TURN_NOW - 14 * REPLY_TURN_TAIL_LINES_HOUR);
      const run = await replyRun({
        world,
        context: { myDay: { lines: 12 }, calls: { lines: 12 } },
        steps: [turn('r2', 1)],
      });
      const [[request = ''] = []] = run.requests;
      const day = bodyOf(request, 'my_day');
      assert.ok(day.includes('11:10'), day);
      assert.ok(!day.includes('22:00'), day);
      assert.ok(request.includes('</my_day>\n<calls>\n'), blockOf(request, 'inner'));
    } finally {
      world.close();
    }
  });

  test('a heartbeat names a direct chat it read by the handle its <places> gives it, in <my_day> and in <calls>', async () => {
    // Bug: the namer knows only places with a stored name, so a direct chat reads as a place with no name in <my_day>
    // and as no place in <calls>, while <places> of the same request lists it under a handle.
    const world = dayWorld();
    try {
      readOfDm(world);
      const run = await serviceTurn({
        world,
        wake: serviceWake('heartbeat'),
        answers: ['<skip/>'],
        chat: null,
        context: { myDay: { lines: 12 }, calls: { lines: 12 } },
      });
      const request = run.requests[0] ?? '';
      const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(blockOf(request, 'memory'))?.[1] ?? '';
      const entry = places.split('\n').find((one) => one.includes(`@${handleOf(ELENI)}`)) ?? '';
      const dm = /^#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
      assert.match(dm, /^#c[0-9a-z]+$/, places);
      const day = bodyOf(request, 'my_day');
      const calls = bodyOf(request, 'calls');
      assert.ok(
        day.split('\n').some((line) => line.includes(dm)),
        day
      );
      assert.ok(
        calls.split('\n').some((line) => line.includes(dm)),
        calls
      );
    } finally {
      world.close();
    }
  });
});
