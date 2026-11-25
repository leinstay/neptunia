// Tests for src/memory/db/chat-lines.ts: the stored lines of a chat as a session, the command line's chat and an
// errand read them, each numbered by its place in the whole stored chat. Most tests use a memory schema in memory, and
// the later sections the media fixture over a temporary database.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import {
  chatLines,
  errandRecentLines,
  lineNumberOf,
  placeLineNumbers,
  recentPlaceLines,
} from '../../../../src/memory/db/chat-lines.ts';
import { handleOfPerson } from '../../../../src/memory/db/direct-chats.ts';
import { fillStems } from '../../../../src/memory/db/stems.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { EDIT_DELAY_MS, minute, storeProductionEdit, storeRevision } from '../../../fixtures/memory-db/edited-line.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import {
  ALICE,
  GENERAL,
  KINDS,
  LABELS,
  PRESENCES,
  assertForms,
  fixture,
  itemsOf,
  observeLine,
} from '../../../fixtures/media-memory.ts';
import type { Env, Kind, Presence } from '../../../fixtures/media-memory.ts';
import { directChatPlaceOf } from '../../../../src/memory/db/places-read.ts';
import { addDmPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { addLine } from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { CLI_CHAT, C1_CHAT, TURN_NOW, blockOf, replyRun, serviceWorld } from '../../../fixtures/service-turn.ts';
import type { ReplyChat, ReplyLine, ReplyRun, ReplyStep } from '../../../fixtures/service-turn.ts';

type Context = { after: (fn: () => void) => void };

function rig(t: Context) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  const insert = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text) VALUES (?, ?, 'cli', ?, ?, ?, ?, ?)`
  );
  const add = (
    id: string,
    kind: string,
    native: string,
    at: string,
    text: string,
    revision = 1,
    place = 'cli:dm:owner'
  ) => void insert.run(id, kind, native, revision, place, at, text);
  return { db, add };
}

test('lines come oldest first, with who said them and their source and message ids', (t) => {
  // Bug: a resumed chat reads backwards, or the persona's lines show as the other side's.
  const { db, add } = rig(t);
  add('s2', 'said', 'n2', '2026-11-05T00:00:02.000Z', 'answer');
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'question');
  // Each line also carries `number`, its place in the chat's whole stored history, which the command line's chat draws
  // as `#N`.
  assert.deepEqual(chatLines(db, 'cli:dm:owner'), [
    {
      id: 's1',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:01.000Z'),
      who: 'owner',
      text: 'question',
      nativeId: 'n1',
      number: 1,
    },
    {
      id: 's2',
      placeId: 'cli:dm:owner',
      at: Date.parse('2026-11-05T00:00:02.000Z'),
      who: 'her',
      text: 'answer',
      nativeId: 'n2',
      number: 2,
    },
  ]);
});

test('another place, an older revision, a deleted message and an empty line stay out', (t) => {
  // Bug: a session shows another chat's lines, a superseded text or a message that was deleted.
  const { db, add } = rig(t);
  add('o1', 'seen', 'x', '2026-11-05T00:00:01.000Z', 'elsewhere', 1, 'discord:dm:u');
  add('r1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'first text', 1);
  add('r2', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'edited text', 2);
  add('d1', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'deleted later');
  add('d2', 'deleted', 'n2', '2026-11-05T00:00:03.000Z', '');
  add('e1', 'seen', 'n3', '2026-11-05T00:00:04.000Z', '');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => line.text),
    ['edited text']
  );
});

test('a place with no lines gives none', (t) => {
  // Bug: an empty place throws where the picker reads it.
  assert.deepEqual(chatLines(rig(t).db, 'cli:dm:owner'), []);
});

test('each line is numbered by its place in the whole stored chat, the oldest line first, ties by row', (t) => {
  // Bug: the number counts from the oldest line of a read, so the same line shows another number on another page.
  const { db, add } = rig(t);
  add('b', 'said', 'n2', '2026-11-05T00:00:01.000Z', 'second row of the same time');
  add('c', 'seen', 'n3', '2026-11-05T00:00:02.000Z', 'third');
  add('a', 'seen', 'n1', '2026-11-05T00:00:00.000Z', 'first');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => [line.id, line.number]),
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]
  );
});

test('a deleted line leaves the numbers of the lines after it as they were', (t) => {
  // Bug: the count leaves a deleted line out, so a deletion renumbers every later line of the place, in the command
  // line's chat and in the persona's `<chat>`, which shows the same numbers and keeps the deleted line's place while it
  // is in the window.
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'one');
  add('s2', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'deleted later');
  add('s3', 'said', 'n3', '2026-11-05T00:00:03.000Z', 'three');
  add('x2', 'deleted', 'n2', '2026-11-05T00:00:04.000Z', '');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => [line.nativeId, line.number]),
    [
      ['n1', 1],
      ['n3', 3],
    ]
  );
  assert.equal(lineNumberOf(db, 'cli:dm:owner', 'n3'), 3);
});

test('a chat longer than one read keeps the numbers of its whole history on the newest lines', (t) => {
  // Bug: past the bound of one read the oldest line read becomes #1, and every number shifts as the chat grows.
  const { db, add } = rig(t);
  const total = 5003;
  for (let n = 1; n <= total; n += 1)
    add(`s${n}`, 'seen', `n${n}`, new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), `line ${n}`);
  const lines = chatLines(db, 'cli:dm:owner');
  assert.equal(lines.at(-1)?.number, total);
  assert.equal(lines.at(-1)?.id, `s${total}`);
  const oldest = lines[0];
  assert.equal(oldest?.number, Number(oldest?.id.slice(1)));
});

test('a line that replies to another carries the message id and the number of the line it answers', (t) => {
  // Bug: the command line's chat lost which line the persona's reply answered, and their `<chat>` lost it after a
  // restart.
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'question');
  add('s2', 'seen', 'n2', '2026-11-05T00:00:02.000Z', 'another');
  add('s3', 'said', 'n3', '2026-11-05T00:00:03.000Z', 'answer');
  db.prepare("UPDATE sources SET reply_to = 'n1' WHERE id = 's3'").run();
  db.prepare("UPDATE sources SET reply_to = 'gone' WHERE id = 's2'").run();
  const lines = chatLines(db, 'cli:dm:owner');
  assert.deepEqual(
    lines.map((line) => [line.nativeId, line.replyToId ?? null, line.replyNumber ?? null]),
    [
      ['n1', null, null],
      ['n2', 'gone', null],
      ['n3', 'n1', 1],
    ]
  );
});

test("a line's number by its message id is the number the session reads for it", (t) => {
  // Bug: the persona's `#N` in the command line's chat named another line than the one the chat draws with that number.
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'one');
  add('s2', 'said', 'n2', '2026-11-05T00:00:02.000Z', 'two');
  add('o1', 'seen', 'n9', '2026-11-05T00:00:01.500Z', 'elsewhere', 1, 'other:dm:x');
  add('s3', 'seen', 'n3', '2026-11-05T00:00:03.000Z', 'three');
  const numbers = chatLines(db, 'cli:dm:owner').map((line) => [line.nativeId, line.number]);
  assert.deepEqual(
    numbers.map(([native]) => [native, lineNumberOf(db, 'cli:dm:owner', String(native))]),
    numbers
  );
});

test('a message id the place does not hold has no number', (t) => {
  const { db, add } = rig(t);
  add('s1', 'seen', 'n1', '2026-11-05T00:00:01.000Z', 'one');
  assert.equal(lineNumberOf(db, 'cli:dm:owner', 'missing'), null);
  assert.equal(lineNumberOf(db, 'other:dm:x', 'n1'), null);
});

/** Gives the stored line `id` the message route a line written through message families holds, with `reply` its parent. */
function routed(db: Db, id: string, messageId: string, reply: string | null = null): void {
  const route = { v: 1, origin: 'protocol-message', iface: 'cli', chatId: 'cli:dm:owner' };
  const extra = {
    $messageLocator: { ...route, messageId },
    ...(reply === null ? {} : { $messageReply: { iface: 'cli', chatId: 'cli:dm:owner', messageId: reply } }),
  };
  db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run(JSON.stringify(extra), id);
}

test('a line written through message families goes by its platform id and names its parent by the parent platform id', (t) => {
  // Bug: the chat client knew a line by the platform's id and the store by the row's own key, so the line
  // stood twice in the persona's `<chat>` and a reply named a parent no client line held.
  const { db, add } = rig(t);
  add('s1', 'seen', 'key-1', '2026-11-05T00:00:01.000Z', 'question');
  add('s2', 'said', 'key-2', '2026-11-05T00:00:02.000Z', 'answer');
  add('s3', 'seen', 'key-3', '2026-11-05T00:00:03.000Z', 'late reply');
  db.prepare("UPDATE sources SET reply_to = 'key-1' WHERE id = 's2'").run();
  db.prepare("UPDATE sources SET reply_to = 'key-gone' WHERE id = 's3'").run();
  routed(db, 's1', 'cli-1');
  routed(db, 's2', 'cli-2', 'cli-1');
  routed(db, 's3', 'cli-3', 'cli-gone');
  assert.deepEqual(
    chatLines(db, 'cli:dm:owner').map((line) => [line.nativeId, line.replyToId ?? null, line.replyNumber ?? null]),
    [
      ['cli-1', null, null],
      ['cli-2', 'cli-1', 1],
      ['cli-3', 'cli-gone', null],
    ]
  );
});

test("a line's number is found by its platform id when the row keeps a key of its own", (t) => {
  // Bug: the persona's `#N` of a stored line, whose history id is the platform's, drew no number in the command line's
  // chat.
  const { db, add } = rig(t);
  add('s1', 'seen', 'key-1', '2026-11-05T00:00:01.000Z', 'one');
  add('s2', 'said', 'key-2', '2026-11-05T00:00:02.000Z', 'two');
  routed(db, 's2', 'cli-2');
  assert.equal(lineNumberOf(db, 'cli:dm:owner', 'cli-2'), 2);
});

const CLI = { iface: 'cli', place: 'cli:dm:owner' };

// Bug: the persona's edit of a line from an earlier session of the command line was stored with the moment of the edit
// and kind `seen`, so the line moved to the end of the chat, read as the other side's, and every line after its old
// place changed number.
test('a line of the persona edited with the moment of the edit keeps its place, its number and its author, with the new text and its mark', (t) => {
  const { db } = rig(t);
  storeProductionEdit(db, CLI);
  const lines = chatLines(db, CLI.place);
  assert.deepEqual(
    lines.map((line) => [line.nativeId, line.number, line.who]),
    [
      ['owner-1', 1, 'owner'],
      ['hers-1', 2, 'her'],
      ['owner-2', 3, 'owner'],
      ['hers-2', 4, 'her'],
    ]
  );
  const edited = lines[1];
  assert.equal(edited?.text, 'the kettle is on');
  assert.equal(edited?.editedAt, minute(1) + EDIT_DELAY_MS, 'the edited mark stands, dated by the edit');
  assert.equal(edited?.at, minute(1), 'the line keeps the moment it was said');
});

// Bug: the numbers of the request's `<chat>` come from this count, so the moved line shifts every later number there.
test('the numbers of the newest lines by message id are the same after an edit stored with the moment of the edit', (t) => {
  const { db } = rig(t);
  storeProductionEdit(db, CLI);
  const found = placeLineNumbers(db, CLI.place, 10);
  assert.equal(found.count, 4);
  assert.deepEqual(
    ['owner-1', 'hers-1', 'owner-2', 'hers-2'].map((id) => found.numbers.get(id)),
    [1, 2, 3, 4]
  );
  assert.equal(lineNumberOf(db, CLI.place, 'hers-1'), 2, 'a number the persona wrote earlier names the same line');
});

// Bug: the same rule keyed on the author alone would fix the persona's lines and leave an edited line of the other
// side moving.
test('a line of the owner edited with a later moment keeps its place and its author', (t) => {
  const { db } = rig(t);
  storeRevision(db, CLI, { native: 'a', text: 'before', at: minute(0), kind: 'seen', by: 'someone' });
  storeRevision(db, CLI, { native: 'b', text: 'between', at: minute(1), kind: 'said', by: 'her' });
  storeRevision(db, CLI, {
    native: 'a',
    text: 'after',
    at: minute(0),
    recordedAt: minute(90),
    revision: 2,
    kind: 'seen',
    by: 'someone',
  });
  assert.deepEqual(
    chatLines(db, CLI.place).map((line) => [line.nativeId, line.who, line.text]),
    [
      ['a', 'owner', 'after'],
      ['b', 'her', 'between'],
    ]
  );
});

// Guard: an edit that keeps the moment, as a platform reports it, holds its place.
test('an edit of the owner line that keeps its moment stays at its place as the owner line with the new text', (t) => {
  const { db } = rig(t);
  storeRevision(db, CLI, { native: 'a', text: 'before', at: minute(0), kind: 'seen', by: 'someone' });
  storeRevision(db, CLI, { native: 'b', text: 'between', at: minute(1), kind: 'said', by: 'her' });
  storeRevision(db, CLI, { native: 'a', text: 'after', at: minute(0), revision: 2, kind: 'seen', by: 'someone' });
  assert.deepEqual(
    chatLines(db, CLI.place).map((line) => [line.nativeId, line.who, line.text, line.number]),
    [
      ['a', 'owner', 'after', 1],
      ['b', 'her', 'between', 2],
    ]
  );
});

// ---------- the recent lines of an errand ----------

// Bug: an errand's recent lines held `:e23:` with no legend, a sticker's description
// with no name, and every media description joined after the text with a space, with no kind and no boundary.
for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`errand lines: a ${kind.name} shows its marker and its text form, ${presence}`, () => {
      const env = fixture();
      try {
        observeLine(env, kind, presence);
        fillEnvAudiences(env);
        const lines = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels: LABELS });
        assert.equal(lines.length, 1);
        assertForms(lines.map((line) => line.text).join('\n'), kind, presence);
      } finally {
        env.done();
      }
    });
  }
}

test("errand lines: a line of the persona carries the persona's name and a line of a member the name the member wrote under", () => {
  // Bug: a reworked reader loses who said what, and the agent reads the persona's words as a member's.
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'full', { native: 'theirs', at: Date.parse('2026-11-01T10:00:00.000Z') });
    const voiceSaid = KINDS.find((kind) => kind.self);
    assert.ok(voiceSaid);
    observeLine(env, voiceSaid, 'full', { native: 'hers', at: Date.parse('2026-11-01T10:01:00.000Z') });
    fillEnvAudiences(env);
    const lines = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels: LABELS });
    assert.deepEqual(
      lines.map((line) => line.author),
      ['Alice', 'Self']
    );
  } finally {
    env.done();
  }
});

test('errand lines: a picture the persona made shows the made mark and the people it shows by handle', () => {
  // Bug: the agent reads the persona's drawing as anyone's picture and cannot tell who is in it.
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'full');
    const alice = String(env.db.prepare('SELECT person_id FROM accounts WHERE native_id = ?').get(ALICE)?.person_id);
    env.db
      .prepare("UPDATE media SET extra = json_set(extra, '$.made', 'self', '$.depicts', json(?)) WHERE native_ref = ?")
      .run(JSON.stringify(['person:self', alice]), itemsOf(KINDS[0], 'pic')[0].id);
    fillEnvAudiences(env);
    const labels = {
      ...LABELS,
      transcript: {
        ...LABELS.transcript,
        mediaMade: '[MADE]',
        mediaDepicts: '[SHOWS {names}]',
        mediaDepictsSelf: 'HERSELF',
      },
    };
    const text = errandRecentLines(env.db, GENERAL, 5, { selfName: 'Self', labels })
      .map((line) => line.text)
      .join('\n');
    assert.ok(text.includes('[MADE]'), text);
    // A person is written by the handle the persona can pass to a tool, never by a name.
    assert.ok(text.includes(`[SHOWS HERSELF, @${handleOfPerson(alice)}]`), text);
  } finally {
    env.done();
  }
});

// ---------- the media of a stored line ----------

async function withLine(kind: Kind, presence: Presence, body: (env: Env, source: string) => void | Promise<void>) {
  const env = fixture();
  try {
    const source = observeLine(env, kind, presence);
    fillStems(env.db);
    await body(env, source);
  } finally {
    env.done();
  }
}

test('chat lines keep a line with no text, with its text form', () =>
  withLine(KINDS[0], 'full', (env) => {
    const lines = chatLines(env.db, GENERAL) as Array<{ media?: Array<{ description: string | null }> }>;
    assert.equal(lines.length, 1);
    const [kind] = KINDS;
    assert.ok(JSON.stringify(lines[0].media).includes(kind.first.word));
  }));

function linesRig(t: { after: (fn: () => void) => void }) {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.exec("INSERT INTO audiences (id, kind, iface) VALUES ('aud:group:discord', 'group', 'discord')");
  const add = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_kind, scope_iface, audience_id)
     VALUES (?, ?, 'discord', ?, 1, 'discord:channel:c1', ?, ?, ?, ?, ?)`
  );
  return { db, add };
}

test("a channel's recent lines leave out a line that is not the group's", (t) => {
  // Bug: `recentChannelLines` reads by the spelled place alone, so a wake's DM line under that place reaches an errand.
  const { db, add } = linesRig(t);
  const at = '2026-11-05T00:00:00.000Z';
  add.run('s1', 'seen', 'n1', at, 'for the room', 'group', 'discord', 'aud:group:discord');
  add.run('s2', 'said', 'n2', at, 'for one person', 'internal', null, 'aud:internal');
  assert.deepEqual(
    recentPlaceLines(db, 'discord:channel:c1', 10).map((row) => row.text),
    ['for the room']
  );
});

test("a direct chat's recent lines are its own lines, found by its chat id", (t) => {
  // Bug: an errand asked in a direct chat reads the channel place of the chat's id and gets no line.
  const { db, add } = linesRig(t);
  addDmPlace(db, {
    id: 'discord:dm:n1',
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n1',
    person: null,
  });
  db.prepare("UPDATE places SET native_id = 'dm-chat-1' WHERE id = 'discord:dm:n1'").run();
  db.exec(
    "INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:discord:dm:n1', 'dm', 'discord', 'discord:dm:n1')"
  );
  const at = '2026-11-05T00:00:00.000Z';
  add.run('s1', 'seen', 'n1', at, 'for one person', 'dm', 'discord', 'aud:dm:discord:dm:n1');
  db.prepare("UPDATE sources SET place_id = 'discord:dm:n1' WHERE id = 's1'").run();
  const place = directChatPlaceOf(db, 'dm-chat-1');
  assert.equal(place, 'discord:dm:n1');
  assert.deepEqual(
    recentPlaceLines(db, String(place), 10).map((row) => row.text),
    ['for one person']
  );
});

for (const kind of KINDS) {
  for (const presence of PRESENCES) {
    test(`stored lines: a task's recent lines show a ${kind.name}, with its text form, ${presence}`, () =>
      withLine(kind, presence, (env) => {
        fillEnvAudiences(env);
        const lines = recentPlaceLines(env.db, GENERAL, 5) as Array<{ media?: Array<{ description: string | null }> }>;
        assert.equal(lines.length >= 1, true, 'a line with no text is not dropped');
        assert.equal(JSON.stringify(lines[0].media ?? []).includes(kind.first.word), presence !== 'absent');
      }));
  }
}

const MIN = 60_000;
const THINK = '<think>STEP 4. So: answer.</think>';
const SKIP = `${THINK}<skip/>`;
// The head moves with every line in these tests: the step of the head has its own tests below.
const WINDOW = { channelMessages: 3, chatHeadStep: 0 };
const iso = (at: number): string => new Date(at).toISOString();

/** The texts of the lines, each unique so a test finds its line in one block. */
const TEXT = {
  room: 'ΓΡΑΜΜΗ-ΤΟΥ-ΓΕΝΙΚΑ',
  alpha: 'ΑΛΦΑ-ΓΡΑΜΜΗ',
  beta: 'ΒΗΤΑ-ΓΡΑΜΜΗ',
  gamma: 'ΓΑΜΜΑ-ΓΡΑΜΜΗ',
  delta: 'ΔΕΛΤΑ-ΓΡΑΜΜΗ',
  garden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
} as const;

/** The lines that join `c1` after the world's `r1` (five minutes before the turns' clock), one minute apart. */
const ALPHA: ReplyLine = { id: 'a1', text: TEXT.alpha, at: TURN_NOW - 4 * MIN };
const BETA: ReplyLine = { id: 'b1', text: TEXT.beta, at: TURN_NOW - 3 * MIN };
const GAMMA: ReplyLine = { id: 'c1x', text: TEXT.gamma, at: TURN_NOW - 2 * MIN };

/** Writes `lines` to the world's memory as lines of `chat`'s place, by Ελένη, as the memory writer stores them. */
const store = (world: World, chat: ReplyChat, lines: ReadonlyArray<ReplyLine>): void => {
  for (const line of lines)
    addLine(world.db, {
      id: `src:${chat.iface}:${line.id}:1`,
      iface: chat.iface,
      place: chat.place,
      author: `${chat.iface}:${line.authorId ?? '111'}`,
      text: line.text,
      at: iso(line.at),
    });
};

/** A step whose lines and trigger are stored before its turn. */
const storedStep = (world: World, chat: ReplyChat, step: ReplyStep): ReplyStep => ({
  ...step,
  before: () => {
    step.before?.();
    store(world, chat, [...(step.lines ?? []), step.trigger]);
  },
});

/** Reply turns in `c1` with a window of three lines, over a world made for the run. */
async function inRoom(
  steps: (world: World) => ReadonlyArray<ReplyStep>,
  options: { restartBefore?: number; world?: () => World } = {}
): Promise<ReplyRun> {
  const world = (options.world ?? serviceWorld)();
  try {
    return await replyRun({
      world,
      context: WINDOW,
      steps: steps(world).map((step) => storedStep(world, C1_CHAT, step)),
      ...(options.restartBefore === undefined ? {} : { restartBefore: options.restartBefore }),
    });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step = 0): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};
/** The rows of a text. */
const rowsOf = (text: string): Array<string> => text.split('\n');
/** The row of `text` that holds `marker`, '' when none does. */
const rowWith = (text: string, marker: string): string => rowsOf(text).find((row) => row.includes(marker)) ?? '';
/** The `#N` that opens the row of `text` holding `marker`, null when that row opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(rowWith(text, marker))?.[0] ?? null;

/** A line of the owner's command line chat, by the owner's account. */
const ownerLine = (id: string, text: string, at: number): ReplyLine => ({ id, text, at, authorId: 'owner' });
/** Lines of `c1` after `r1`, one per turn after the first two. A gap of half an hour stands before ΓΑΜΜΑ, line #4. */

describe('reply turn chat numbers', () => {
  // The turn world's interface and self id are module state of the fixture: set for these cases only.
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('after a restart a line has the number it had before, and <chat> is what it would have been', async () => {
    // Bug: the numbers live in the process (a counter or an offset), so a restart between two answers numbers the window
    // anew and the persona's context after the restart differs from the one they would have had.
    const steps = (): ReadonlyArray<ReplyStep> => [
      { lines: [ALPHA], trigger: BETA, answers: [SKIP] },
      { trigger: GAMMA, answers: [SKIP] },
    ];
    const kept = await inRoom(steps);
    const restarted = await inRoom(steps, { restartBefore: 1 });
    const before = blockOf(requestOf(restarted, 0), 'chat');
    const after = blockOf(requestOf(restarted, 1), 'chat');
    assert.match(numberOf(before, TEXT.alpha) ?? '', /^#\d+$/, 'the line has a number');
    assert.equal(numberOf(after, TEXT.alpha), numberOf(before, TEXT.alpha));
    assert.equal(after, blockOf(requestOf(kept, 1), 'chat'));
  });

  test("the command line's <chat> shows each line by the number the owner's chat draws for it", async () => {
    // Bug: the owner sees `[#31]` before a line and the persona sees the same line as `#2`, so a number one of them names means
    // another line to the other.
    const world = serviceWorld();
    const older = Array.from({ length: 30 }, (_, i) => ownerLine(`o${i}`, `ΠΑΛΙΑ-${i}`, TURN_NOW - (60 - i) * MIN));
    store(world, CLI_CHAT, older);
    const recent = [ownerLine('n1', TEXT.alpha, TURN_NOW - 4 * MIN), ownerLine('n2', TEXT.beta, TURN_NOW - 3 * MIN)];
    try {
      const run = await replyRun({
        world,
        chat: CLI_CHAT,
        context: WINDOW,
        steps: [
          {
            before: () => store(world, CLI_CHAT, recent),
            lines: recent.slice(0, 1),
            trigger: recent[1] ?? ownerLine('n2', TEXT.beta, TURN_NOW - 3 * MIN),
            answers: [SKIP],
          },
        ],
      });
      const chat = blockOf(requestOf(run, 0), 'chat');
      const drawn = new Map(chatLines(world.db, CLI_CHAT.place).map((line) => [line.text, line.number]));
      assert.equal(drawn.get(TEXT.beta), 32, "the owner's chat draws the newest line as the count of the chat's lines");
      assert.equal(numberOf(chat, TEXT.alpha), `#${String(drawn.get(TEXT.alpha))}`);
      assert.equal(numberOf(chat, TEXT.beta), `#${String(drawn.get(TEXT.beta))}`);
    } finally {
      world.close();
    }
  });
});
