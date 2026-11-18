// The service turns on the template of the turn frame (plan 2026-11-06-turn-frame, slice 5, "The services as one
// template" and "The service trees"): a heartbeat runs with `chat: null`, its
// request holds the service list (no `<chat>`, no `<surroundings>`), `<meanwhile>` holds her last
// `context.memory.serviceMessages` lines over the rooms of every group of every interface and no direct chat, and
// `<memory>` reads as herself. tests/inner-turn.test.ts is near the file length limit, so these live here.
// The shapes the specifier chose:
//   runTurn({ chat: null, mode: 'inner', triggerKind: 'inner', inner: { wake, currentChannel, shadow, mayAct } })
//     is a service turn nowhere.
//   The persona's journal is read at `journal.read(PERSONA_ID, { day, kind: 'turn' })`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { seedExisting, useIface } from './fixtures/turn-world.ts';
import { addLine } from './fixtures/memory-db/mind-world.ts';
import {
  ELENI,
  HEARTBEAT_TEXT,
  MARK,
  NIKOS,
  SEED_FAMILIES,
  TEXT,
  TURN_NOW,
  YARD,
  ZOE,
  blockOf,
  heartbeatWorld,
  rootTags,
  seedLines,
  serviceTurn,
  serviceWake,
} from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';
import { fill } from '../src/format.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { affinityBand } from '../src/memory/affinity.ts';

useIface('fake');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const THINK = '<think>STEP 4. So: nothing.</think>';

/** The service list without `persona`, which is the system message and no root tag of the user text. */
const SERVICE_TAGS = blocksOf('heartbeat', null).filter((name) => name !== 'persona');

/**
 * The tags a heartbeat request may not omit. Changed: `meanwhile` was among them; a heartbeat lists the people and
 * places memory holds in `<memory>` and holds no `<meanwhile>` (spec 2026-11-17-heartbeat-own-request).
 */
const ALWAYS = ['self', 'memory', 'spatial_awareness', 'task'];

/** A seeded random source in [0, 1) (mulberry32), so two runs with one seed draw alike. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The heartbeat's first request over the heartbeat world. */
async function heartbeatRequest(spec: { rng?: () => number; extraPeople?: number } = {}): Promise<string> {
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: ['<skip/>'],
    chat: null,
    world: heartbeatWorld({ extraPeople: spec.extraPeople ?? 0 }),
    ...(spec.rng ? { rng: spec.rng } : {}),
  });
  return run.requests[0] ?? '';
}

/** The lines of a subtag of `<memory>`. */
const subtagLines = (text: string, tag: string): Array<string> =>
  (new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(blockOf(text, 'memory'))?.[1] ?? '').split('\n');

/** The line of a subtag that holds `marker`, '' with none. */
const lineWith = (text: string, tag: string, marker: string): string =>
  subtagLines(text, tag).find((line) => line.includes(marker)) ?? '';

/** The words of the bands of her attitude. */
const BANDS: Record<string, string> = shippedLabels.affinity?.bands ?? {};

/** The words of a heartbeat's labels. */
const HB = (shippedLabels as unknown as { heartbeat: Record<string, string> }).heartbeat;

/** Whether `tags` keep the order of `list` and hold nothing else. */
function inOrderOf(tags: ReadonlyArray<string>, list: ReadonlyArray<string>): boolean {
  let at = -1;
  for (const tag of tags) {
    const next = list.indexOf(tag, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

test('a heartbeat request holds the service list in its order, with no <chat> and no <surroundings>', async () => {
  // Bug: the heartbeat keeps the old `<wake>` emission, or the chat and surroundings of a stand-in chat.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const text = run.requests[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, SERVICE_TAGS), tags.join(' '));
  for (const tag of ALWAYS) assert.ok(tags.includes(tag), `holds <${tag}>`);
  assert.ok(text.includes(MARK.heartbeat), 'its own task');
});

test('<meanwhile> of a turn with no place holds her lines from the groups of two interfaces and none from a direct chat', async () => {
  // Bug: a service reads `context.meanwhile.messages` (8 by default, 1 here) instead of serviceMessages, reads one
  // interface, or lets a private chat into a turn that needs none.
  // Changed: the wake was a heartbeat, which holds no `<meanwhile>` any more; an intention with no place keeps it.
  const run = await serviceTurn({ wake: serviceWake('intention_due'), answers: ['<skip/>'], chat: null });
  const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
  assert.ok(meanwhile.includes(TEXT.ownGarden), 'the room of the first interface');
  assert.ok(meanwhile.includes(TEXT.ownHarbour), 'the room of the second interface');
  assert.ok(!meanwhile.includes(TEXT.ownPrivate), 'no direct chat');
});

test('<meanwhile> of a service is cut at context.memory.serviceMessages', async () => {
  // Bug: the new setting is not read and a service shows every line of hers it can find.
  // Changed: the wake was a heartbeat, which holds no `<meanwhile>` any more; an intention with no place keeps it.
  const run = await serviceTurn({
    wake: serviceWake('intention_due'),
    answers: ['<skip/>'],
    chat: null,
    settings: { serviceMessages: 1 },
  });
  const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
  assert.ok(meanwhile.includes(TEXT.ownHarbour), 'her newest group line');
  assert.ok(!meanwhile.includes(TEXT.ownGarden), 'the older one is past the cut');
});

test('<memory> of a turn with no place raised from a group line holds that person private fact, under an origin', async () => {
  // Bug: the service reads memory under a group scope and loses what she knows from a direct chat, or seeds the
  // reader from a chat window it does not have, so the person who wrote beside her line never enters.
  // Changed: the wake was a heartbeat, whose `<memory>` lists people and places instead of what her lines raise.
  const run = await serviceTurn({ wake: serviceWake('intention_due'), answers: ['<skip/>'], chat: null });
  const memory = blockOf(run.requests[0] ?? '', 'memory');
  assert.ok(memory.includes(TEXT.eleniSecret), memory);
  const entry = memory.split('\n\n').find((part) => part.includes(TEXT.eleniSecret)) ?? '';
  const origins = Object.values(shippedLabels.memory?.origin ?? {}).filter((value) => typeof value === 'string');
  assert.ok(
    origins.some((origin) => entry.includes(origin)),
    entry
  );
});

test('a heartbeat with no chat reads no history and journals its turn under herself', async () => {
  // Bug: the turn reads the history of a stand-in or a recent room, or its turn record lands in a place's journal.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const { port } = run;
  const reads = port.calls.filter((one: { op: string }) => one.op === 'history' || one.op === 'fetchMessages');
  assert.deepEqual(reads, []);
  assert.ok(!(run.requests[0] ?? '').includes(TEXT.roomLine), 'no line of a room as a chat');
  const turns = await run.journal.read(PERSONA_ID, { day: '2026-11-02', kind: 'turn', n: 10 });
  assert.equal(turns.length, 1);
});

test('a tool that takes a place is refused in a heartbeat with no chat when she names none', async () => {
  // Bug: the call falls back to a chat the turn does not have and reads a room nobody named.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [toolAnswer(THINK, [call('conversation.read', {})]), '<skip/>'],
    chat: null,
  });
  const [action = ''] = run.actions;
  const [skill, status, code] = action.split(':');
  assert.equal(skill, 'conversation.read');
  assert.notEqual(status, 'executed', action);
  assert.ok(code !== undefined && code !== '' && code !== 'ok', action);
});

test('a heartbeat reads the direct chat of a person she names by handle', async () => {
  // Bug: the read with `person` counts as naming no place and is refused PLACE_REQUIRED in a turn with no place,
  // though the same chat read by its place handle passes.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [toolAnswer(THINK, [call('conversation.read', { person: `@${handleOf(ZOE)}`, last: 5 })]), '<skip/>'],
    chat: null,
  });
  assert.equal(run.actions[0], 'conversation.read:executed:ok');
  assert.ok((run.requests[1] ?? '').includes(TEXT.ownPrivate), 'the line of her direct chat');
});

test('a heartbeat read of a person with no direct chat answers PLACE_NOT_FOUND', async () => {
  // Bug: the person read is refused PLACE_REQUIRED before it looks for the person's direct chat.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [toolAnswer(THINK, [call('conversation.read', { person: `@${handleOf(NIKOS)}`, last: 5 })]), '<skip/>'],
    chat: null,
    world: heartbeatWorld(),
  });
  const [action = ''] = run.actions;
  assert.equal(action.split(':')[2], 'PLACE_NOT_FOUND', action);
});

test('a <msg> in a heartbeat carries heartbeat-only', async () => {
  // Bug: a message with no destination goes to a stand-in or to the room the wake rode on.
  // Changed: the expectation was destination-required. The heartbeat's own limit answers before a tag's refusal, so a
  // <msg> of a heartbeat is refused as any post of a heartbeat is, and its refusal wakes no feedback turn that could
  // post it. The bug above stays caught: nothing is sent.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [`${THINK}<msg>γεια σας</msg>`, '<skip/>'],
    chat: null,
  });
  const post = run.actions.find((action) => action.startsWith('message.create:')) ?? '';
  assert.equal(post.split(':')[2], 'heartbeat-only', post);
  const { port } = run;
  assert.equal(port.calls.filter((one: { op: string }) => one.op === 'send').length, 0);
});

test('two intention calls in one step of a heartbeat with no chat are both saved', async () => {
  // Changed: the second call was refused heartbeat-only. A heartbeat takes several intention changes, so both are made.
  // Bug: a heartbeat nowhere plans its calls by a chat it has not, and the second wish of a step is lost.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      toolAnswer(THINK, [
        call('intention.set', { due: '1h', text: 'πρώτο' }),
        call('intention.set', { due: '2h', text: 'δεύτερο' }),
      ]),
      '<skip/>',
    ],
    chat: null,
  });
  assert.deepEqual(run.actions, ['intention.set:executed:ok', 'intention.set:executed:ok']);
  assert.equal(run.intentions.list({ all: true }).length, 2);
});

test("a heartbeat orders its blocks with what repeats first and the turn's own last: <memory> before <inner>", async () => {
  // Bug: the owner's decision of 2026-11-11 (cache layout, item 29 of plan 2026-11-10 tools-and-reads) puts the turn's
  // own blocks last, and a list keeps `<inner>` with her day and intentions before `<memory>`.
  // Changed: the order held `meanwhile`, `recall` and `found`; a heartbeat holds none of them and holds `<fragments>`
  // after `<inner>` (spec 2026-11-17-heartbeat-own-request).
  const order = ['self', 'memory', 'inner', 'fragments', 'spatial_awareness', 'task'];
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: ['<skip/>'],
    chat: null,
    seed: (service) => service.set({ purpose: 'ΚΑΠΟΤΕ-ΑΡΓΟΤΕΡΑ', dueAt: TURN_NOW + DAY, by: 'persona' }),
  });
  const tags = rootTags(run.requests[0] ?? '');
  for (const tag of ['memory', 'inner', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), tags.join(' '));
  assert.deepEqual(
    tags,
    order.filter((tag) => tags.includes(tag))
  );
});

test('a heartbeat lists a person she has no line near and a place she never wrote in, and holds no <meanwhile>', async () => {
  // Bug: the heartbeat still sees only what her own last lines raise, the same few places and people every time.
  const text = await heartbeatRequest();
  assert.ok(!rootTags(text).includes('meanwhile'), rootTags(text).join(' '));
  const nikos = lineWith(text, 'people', `@${handleOf(NIKOS)}`);
  assert.ok(nikos.includes('Νίκος'), nikos);
  assert.ok(nikos.includes(HEARTBEAT_TEXT.nikosRelation), nikos);
  assert.ok(!nikos.includes(HEARTBEAT_TEXT.nikosRelationRest), 'one sentence of the description');
  assert.ok(nikos.includes(fill(HB.attitude ?? '', { band: BANDS[affinityBand(40)] ?? '' })), nikos);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(HEARTBEAT_TEXT.yardPurpose), yard);
  assert.ok(!text.includes(HEARTBEAT_TEXT.yardLine), 'no line of a place');
});

test('a heartbeat leaves a diary mirror out of <places> and lists a direct chat with none of its lines', async () => {
  // Bug: she is offered the mirror of her diary as a place to write in, or reads a private chat in her own time.
  const text = await heartbeatRequest();
  const places = subtagLines(text, 'places');
  assert.ok(
    places.some((line) => line.includes('αυλή')),
    places.join('\n')
  );
  assert.ok(!places.some((line) => line.includes('ημερολόγιο')), places.join('\n'));
  assert.ok(!text.includes(HEARTBEAT_TEXT.mirrorLine));
  assert.ok(
    places.some((line) => line.includes(`@${handleOf(ZOE)}`)),
    places.join('\n')
  );
  assert.ok(!text.includes(TEXT.ownPrivate), 'no line of the direct chat');
});

test('a heartbeat says how her last approach to a person and her last line in a place ended, and no line of a direct chat', async () => {
  // Bug: the lists show what is open and nothing of whether anyone answered her, so she approaches a silent person
  // again; or the approach quotes the direct chat it read.
  const world = heartbeatWorld();
  const line = (id: string, place: string, author: string, ago: number, replyTo: string | null = null) => {
    addLine(world.db, {
      id,
      iface: 'fake',
      place,
      author,
      text: `ΓΡΑΜΜΗ-${id}`,
      at: new Date(TURN_NOW - ago).toISOString(),
      turn: author === 'self' ? `turn:${id}` : null,
    });
    world.db.prepare('UPDATE sources SET reply_to = ? WHERE id = ?').run(replyTo, id);
  };
  line('q1', 'fake:dm:111', 'self', 6 * HOUR);
  line('q2', 'fake:dm:111', 'fake:111', 2 * HOUR);
  line('q3', YARD, 'self', 20 * HOUR, 'y2');
  line('q4', YARD, 'fake:111', 10 * HOUR, 'q3');
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
  const text = run.requests[0] ?? '';
  const dmLine = lineWith(text, 'places', `@${handleOf(ELENI)}`);
  const dm = dmLine.slice(0, dmLine.indexOf(':'));
  const eleni = lineWith(text, 'people', `@${handleOf(ELENI)}`);
  assert.ok(eleni.includes(fill(HB.approach ?? '', { date: '2026-11-02', place: dm })), eleni);
  // Changed: a later line of theirs in their direct chat reads `approachWrote`; `approachAnswered` is for a reply.
  assert.ok(eleni.includes(fill(HB.approachWrote ?? '', { date: '2026-11-02' })), eleni);
  const nikos = lineWith(text, 'people', `@${handleOf(NIKOS)}`);
  assert.ok(nikos.includes(HB.approachNone ?? 'none'), nikos);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(fill(HB.ownAnswers ?? '', { count: 1 })), yard);
  for (const id of ['q1', 'q2']) assert.ok(!text.includes(`ΓΡΑΜΜΗ-${id}`), 'no line of the direct chat');
});

test("a heartbeat counts people's lines of the last seven days in a place and not her own", async () => {
  // Bug: her own lines count as life in a place, or a line older than the week counts.
  const text = await heartbeatRequest();
  const garden = lineWith(text, 'places', 'κήπος');
  assert.ok(garden.includes(fill(HB.activity ?? '', { days: 7, lines: 1, people: 1 })), garden);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(fill(HB.activity ?? '', { days: 7, lines: 3, people: 2 })), yard);
  // A place nobody wrote in says so, with no count of zero: Ζωή's direct chat holds her own line alone.
  const quiet = lineWith(text, 'places', `@${handleOf(ZOE)}`);
  assert.ok(quiet.includes(fill(HB.quiet ?? '', { days: 7 })), quiet);
  assert.ok(!quiet.includes(fill(HB.activity ?? '', { days: 7, lines: 0, people: 0 })), quiet);
});

test('a heartbeat draws its lists and fragments with the turn rng: one seed one order, no family name', async () => {
  // Bug: the lists come in a fixed rank she reads as an order of preference, or the draw ignores the injected rng.
  const first = await heartbeatRequest({ rng: seeded(7), extraPeople: 8 });
  const again = await heartbeatRequest({ rng: seeded(7), extraPeople: 8 });
  const other = await heartbeatRequest({ rng: seeded(8), extraPeople: 8 });
  assert.equal(blockOf(first, 'memory'), blockOf(again, 'memory'));
  assert.equal(blockOf(first, 'fragments'), blockOf(again, 'fragments'));
  assert.notEqual(subtagLines(first, 'people').join('\n'), subtagLines(other, 'people').join('\n'));
  const all = SEED_FAMILIES.flatMap((_, family) => seedLines(family));
  const drawn = all.filter((line) => blockOf(first, 'fragments').includes(line));
  assert.equal(drawn.length, 4, blockOf(first, 'fragments'));
  const families = new Set(drawn.map((line) => line.split('-')[1]));
  assert.equal(families.size, 2, drawn.join(' '));
  for (const name of SEED_FAMILIES) assert.ok(!first.includes(name), name);
});

test('a heartbeat with more people than the cap lists the cap and says how many are left out', async () => {
  // Bug: every person memory holds goes into the request whatever their number.
  const text = await heartbeatRequest({ extraPeople: 55 });
  const people = subtagLines(text, 'people');
  assert.equal(people.filter((line) => line.startsWith('@')).length, 50);
  // Ελένη, Νίκος and the 55 more: 57 known, 7 left out.
  assert.equal(people.at(-1), fill(shippedLabels.memory?.leftOut ?? '', { count: 7 }));
});

test('a turn with no place that is no heartbeat draws nothing from the rng and lists nothing', async () => {
  // Bug: the heartbeat's lists or fragments leak into another kind of turn, or its draw moves another request's bytes.
  const one = await serviceTurn({
    wake: serviceWake('intention_due'),
    answers: ['<skip/>'],
    chat: null,
    world: heartbeatWorld(),
    rng: seeded(1),
  });
  const two = await serviceTurn({
    wake: serviceWake('intention_due'),
    answers: ['<skip/>'],
    chat: null,
    world: heartbeatWorld(),
    rng: seeded(2),
  });
  assert.equal(one.requests[0], two.requests[0]);
  assert.ok(rootTags(one.requests[0] ?? '').includes('meanwhile'));
  assert.ok(!rootTags(one.requests[0] ?? '').includes('fragments'));
});

/** The `#N` numbers the last tool result of a request put before its lines, in order. */
const shownNumbers = (request: string): Array<number> =>
  [...request.slice(request.lastIndexOf('Call succeeded')).matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));

/** The texts of the lines the last tool result of a request showed. */
const shownTexts = (request: string): Array<string> =>
  [...request.slice(request.lastIndexOf('Call ')).matchAll(/ΠΑΛΙΑ-(\d+)/g)].map((match) => match[0]);

/** The handle of the room `γενικά` in a heartbeat request. */
const roomHandle = (request: string): string => /#c[0-9a-z]+(?=: "γενικά")/.exec(request)?.[0] ?? '';

/**
 * A heartbeat over the heartbeat world whose room `γενικά` holds `long` more stored lines `ΠΑΛΙΑ-0` to `ΠΑΛΙΑ-<long-1>`,
 * an hour apart and before Ελένη's line there; each step calls conversation.read with the arguments `steps` give, a
 * function of the request it answers.
 */
const LONG = 90;
async function readingHeartbeat(steps: ReadonlyArray<(request: string) => Record<string, unknown>>, long = LONG) {
  const world = heartbeatWorld();
  for (let i = 0; i < long; i += 1)
    addLine(world.db, {
      id: `p${i}`,
      iface: 'fake',
      place: 'fake:channel:c1',
      author: 'fake:111',
      text: `ΠΑΛΙΑ-${i}`,
      at: new Date(TURN_NOW - (long - i) * HOUR).toISOString(),
    });
  return serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      ...steps.map((args) => (request: string) => toolAnswer(THINK, [call('conversation.read', args(request))])),
      '<skip/>',
    ],
    chat: null,
    world,
  });
}

test('a heartbeat reads on after the last line a read showed when the chat holds newer lines', async () => {
  // Bug: the read of the room gave its last line a number and said to read on after it, and `after` of that number was
  // refused unknown-message: a stored place was read from its newest lines only, so a line older than those was no anchor.
  const run = await readingHeartbeat([
    (request) => ({ place: roomHandle(request), since: '2026-10-30' }),
    (request) => ({ place: roomHandle(request), after: `#${shownNumbers(request).at(-1)}` }),
  ]);
  assert.deepEqual(run.actions.slice(0, 2), ['conversation.read:executed:ok', 'conversation.read:executed:ok']);
  assert.equal(shownTexts(run.requests[1] ?? '').at(-1), 'ΠΑΛΙΑ-25');
  assert.equal(shownTexts(run.requests[2] ?? '')[0], 'ΠΑΛΙΑ-26');
});

test('a heartbeat reads on before the first line a read showed', async () => {
  // Bug: `before` of the first number a read of a stored place gave was refused when that line was older than its newest lines.
  const run = await readingHeartbeat([
    (request) => ({ place: roomHandle(request), since: '2026-10-30' }),
    (request) => ({ place: roomHandle(request), before: `#${shownNumbers(request)[0]}` }),
  ]);
  assert.equal(run.actions[1], 'conversation.read:executed:ok');
  assert.equal(shownTexts(run.requests[1] ?? '')[0], 'ΠΑΛΙΑ-6');
  assert.deepEqual(shownTexts(run.requests[2] ?? ''), [
    'ΠΑΛΙΑ-0',
    'ΠΑΛΙΑ-1',
    'ΠΑΛΙΑ-2',
    'ΠΑΛΙΑ-3',
    'ΠΑΛΙΑ-4',
    'ΠΑΛΙΑ-5',
  ]);
});

test('two reads of the same lines in one heartbeat show each line under one number', async () => {
  // Bug: every read numbered its lines on from the next free number, so a line read again took a new number.
  const run = await readingHeartbeat([
    (request) => ({ place: roomHandle(request), last: 3 }),
    (request) => ({ place: roomHandle(request), last: 2 }),
  ]);
  const first = shownNumbers(run.requests[1] ?? '');
  assert.equal(first.length, 3);
  assert.deepEqual(shownNumbers(run.requests[2] ?? ''), first.slice(1));
});

test('a heartbeat read after the newest line of a chat succeeds and shows no line', async () => {
  // Bug: `after` of the number of the chat's newest line was refused as an invalid call when the interface gave that line
  // and the record does not hold it yet: the interface has nothing after it and the record has no such anchor.
  const run = await readingHeartbeat(
    [
      (request) => {
        seedExisting('c1', 'r2', { authorId: '111', ts: TURN_NOW - MIN });
        return { place: roomHandle(request), last: 5 };
      },
      (request) => ({ place: roomHandle(request), after: `#${shownNumbers(request).at(-1)}` }),
    ],
    0
  );
  assert.equal(shownNumbers(run.requests[1] ?? '').length, 2, 'the stored line and the one only the interface gave');
  assert.deepEqual(run.actions.slice(0, 2), ['conversation.read:executed:ok', 'conversation.read:executed:ok']);
  assert.deepEqual(shownNumbers(run.requests[2] ?? ''), []);
});
