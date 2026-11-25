// The people and the places the service collector lists (src/memory/db/service-lists.ts), read on a memory database built with
// the real schema (tests/fixtures/memory-db/mind-world.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceListsOf } from '../../../../src/memory/db/service-lists.ts';
import {
  ELENI,
  MIRROR,
  NIKOS,
  TURN_NOW,
  YARD,
  ZOE,
  addInterest,
  describeSubject,
  heartbeatWorld,
} from '../../../fixtures/service-turn.ts';
import { addAttitude, addClaim, addLine } from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import { groupContext, internalContext } from '../../../../src/memory/db/scope.ts';
import { writeIntentions } from '../../../../src/memory/db/intentions-write.ts';
import { finishRun, startRun } from '../../../../src/memory/db/wakes.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { HEARTBEAT_TEXT, TEXT, blockOf, rootTags, serviceTurn, serviceWake } from '../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { fill } from '../../../../src/format.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { affinityBand } from '../../../../src/memory/affinity.ts';

test('reads every live chat, a group room and a direct chat, on the real schema of places', () => {
  // Bug: a scope clause names columns `places` does not have (`scope_iface`) and the read throws on a real database.
  const world = heartbeatWorld();
  try {
    const { people, places } = serviceListsOf(world.db, TURN_NOW, internalContext(), {
      firstLineDays: 30,
      episodes: 3,
    });
    const ids = places.map((one) => one.placeId);
    assert.ok(ids.includes(YARD), ids.join(' '));
    assert.ok(ids.includes('fake:dm:5678'), ids.join(' '));
    assert.ok(!ids.includes(MIRROR), ids.join(' '));
    assert.ok(
      people.some((one) => one.personId === NIKOS),
      people.map((one) => one.personId).join(' ')
    );
  } finally {
    world.close();
  }
});

test('under a group context no direct chat is listed and nothing of a direct chat reaches a person', () => {
  // Bug: a diary entry with private memory closed reads the collector as the persona, so a direct chat, a claim made
  // there or a person's direct chat reach an entry its mirrors publish.
  const world = heartbeatWorld();
  addClaim(world.db, {
    id: 'alias:z1',
    person: ZOE,
    kind: 'alias',
    text: 'ΚΡΥΦΟ-ΨΕΥΔΩΝΥΜΟ',
    audience: { dm: 'fake:dm:5678', iface: 'fake', person: ZOE },
  });
  addClaim(world.db, { id: 'alias:n9', person: NIKOS, kind: 'alias', text: 'Νικ', audience: { group: 'fake' } });
  try {
    const { people, places } = serviceListsOf(world.db, TURN_NOW, groupContext('fake'), {
      firstLineDays: 30,
      episodes: 3,
    });
    const ids = places.map((one) => one.placeId);
    assert.ok(ids.includes(YARD), ids.join(' '));
    assert.ok(!ids.includes('fake:dm:5678'), ids.join(' '));
    const texts = people.flatMap((one) => one.claims.map((claim) => claim.text));
    assert.ok(texts.includes('Νικ'), texts.join(' '));
    assert.ok(!texts.includes('ΚΡΥΦΟ-ΨΕΥΔΩΝΥΜΟ'), texts.join(' '));
    assert.ok(people.every((one) => one.dm === null && one.approach?.direct !== true));
  } finally {
    world.close();
  }
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROOM = 'fake:channel:c1';
const ELENI_DM = 'fake:dm:111';
const iso = (ago: number): string => new Date(TURN_NOW - ago).toISOString();

/** A line in `place`, the persona's when `author` is `self` (written by a turn), with its reply and its mentions. */
function lineOf(world: World, { id, place, author, ago, replyTo = null, mentions = null }: LineSpec): void {
  addLine(world.db, {
    id,
    iface: 'fake',
    place,
    author,
    text: `T-${id}`,
    at: iso(ago),
    turn: author === 'self' ? `turn:${id}` : null,
  });
  world.db
    .prepare('UPDATE sources SET reply_to = ?, mentions = ? WHERE id = ?')
    .run(replyTo, mentions === null ? null : JSON.stringify(mentions), id);
}
type LineSpec = {
  id: string;
  place: string;
  author: string;
  ago: number;
  replyTo?: string | null;
  mentions?: Array<string> | null;
};

/** The lists of `world` at the turn's moment, the world closed after. */
function listsOf(world: World): ReturnType<typeof serviceListsOf> {
  try {
    return serviceListsOf(world.db, TURN_NOW, internalContext(), { firstLineDays: 30, episodes: 3 });
  } finally {
    world.close();
  }
}

const personOf = (lists: ReturnType<typeof serviceListsOf>, id: string) =>
  lists.people.find((one) => one.personId === id);

test('a person the persona answered by a reply who answered back reads as answered with the date', () => {
  // Bug: the approach reads nothing of what followed, or misses an answer that names the persona's line by reply_to.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 10 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // The approach says whether their first line after the persona's answers it by reply and whether the persona's line
  // stands in their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, {
    placeId: YARD,
    at: TURN_NOW - 20 * HOUR,
    direct: false,
    after: { at: TURN_NOW - 10 * HOUR, reply: true },
  });
});

test("a person who wrote nothing after the persona's reply to them reads as no line recorded after it", () => {
  // Bug: a line of someone else after the persona's, or their own line before it, counts as their answer.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:111', ago: 10 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // The approach says whether their first line after the persona's answers it by reply and whether the persona's line
  // stands in their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, { placeId: YARD, at: TURN_NOW - 20 * HOUR, direct: false, after: null });
});

test('a person the persona only mentioned, who answered by a reply in a room they never wrote in, is found', () => {
  // Bug: only a reply of the persona's counts as addressing someone, so a mention is never read.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 5 * HOUR, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: 4 * HOUR, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  // The approach says whether their first line after the persona's answers it by reply and whether the persona's line
  // stands in their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(nikos?.approach, {
    placeId: ROOM,
    at: TURN_NOW - 5 * HOUR,
    direct: false,
    after: { at: TURN_NOW - 4 * HOUR, reply: true },
  });
});

test('a person the persona never addressed has no approach', () => {
  // Bug: the persona's newest line anywhere, or one in a room they wrote in, counts as addressed to them.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.equal(nikos?.approach, null);
});

test("a line of the persona's in their direct chat followed by a line of theirs reads as answered", () => {
  // Bug: a line in their direct chat is not read as addressed to them, or their later line there is not what followed.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ELENI_DM, author: 'self', ago: 6 * HOUR });
  lineOf(world, { id: 'a2', place: ELENI_DM, author: 'fake:111', ago: 2 * HOUR });
  const eleni = personOf(listsOf(world), ELENI);
  // The approach says whether their first line after the persona's answers it by reply and whether the persona's line
  // stands in their direct chat, so a line of theirs without a reply target reads apart from an answer.
  assert.deepEqual(eleni?.approach, {
    placeId: ELENI_DM,
    at: TURN_NOW - 6 * HOUR,
    direct: true,
    after: { at: TURN_NOW - 2 * HOUR, reply: false },
  });
});

test('a person who wrote in the same group place ten minutes later with no reply target wrote there after it', () => {
  // Bug: only a reply counts as what followed, so a person who answered in plain lines reads as silent.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR, replyTo: 'y2' });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 20 * HOUR - 10 * MINUTE });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.deepEqual(nikos?.approach?.after, { at: TURN_NOW - 20 * HOUR + 10 * MINUTE, reply: false });
});

test("a person whose only later line in the group place came two days after the persona's has none within a day", () => {
  // Bug: any later line of theirs in a busy room counts as what followed the persona's line, however late.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 3 * DAY, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: DAY });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.equal(nikos?.approach?.after, null);
});

test("a person who answered the persona's line by reply three days later answered it", () => {
  // Bug: the day's window cuts off a reply that names the persona's line, which answers it whenever it came.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a1', place: ROOM, author: 'self', ago: 4 * DAY, mentions: ['222'] });
  lineOf(world, { id: 'a2', place: ROOM, author: 'fake:222', ago: DAY, replyTo: 'a1' });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.deepEqual(nikos?.approach?.after, { at: TURN_NOW - DAY, reply: true });
});

test("a group place counts the lines that answer the persona's last line there", () => {
  // Bug: the place reads that the persona wrote and nothing of whether anyone answered it.
  const world = heartbeatWorld();
  lineOf(world, { id: 'a0', place: YARD, author: 'self', ago: 30 * HOUR });
  lineOf(world, { id: 'a1', place: YARD, author: 'self', ago: 20 * HOUR });
  lineOf(world, { id: 'a2', place: YARD, author: 'fake:222', ago: 10 * HOUR, replyTo: 'a1' });
  lineOf(world, { id: 'a3', place: YARD, author: 'fake:111', ago: 9 * HOUR, replyTo: 'a0' });
  const yard = listsOf(world).places.find((one) => one.placeId === YARD);
  assert.equal(yard?.ownAnswers, 1);
});

test('a person with more than five interests lists the five of best rank and no sixth', () => {
  // Bug: the line lists every interest a person has, or the first five stored instead of the five of best rank.
  const world = heartbeatWorld();
  addInterest(world, 'i1', NIKOS, 'ΘΕΜΑ-ΑΣΘΕΝΕΣ', 0.1, 2 * DAY);
  for (const n of [2, 3, 4, 5, 6]) addInterest(world, `i${n}`, NIKOS, `ΘΕΜΑ-${n}`, n, 2 * DAY);
  const nikos = personOf(listsOf(world), NIKOS);
  assert.deepEqual([...(nikos?.interests ?? [])].sort(), ['ΘΕΜΑ-2', 'ΘΕΜΑ-3', 'ΘΕΜΑ-4', 'ΘΕΜΑ-5', 'ΘΕΜΑ-6']);
});

test('a person with no stored interest lists none', () => {
  // Bug: a person without interests is given another person's, or the read throws.
  const world = heartbeatWorld();
  addInterest(world, 'i1', NIKOS, 'ΘΕΜΑ-ΝΙΚΟΥ', 1, DAY);
  assert.deepEqual(personOf(listsOf(world), ELENI)?.interests, []);
});

test('a group place with a line in the window carries its stored topics', () => {
  // Bug: the topics of a place are never read, so the persona sees only its purpose.
  const world = heartbeatWorld();
  describeSubject(world, 'desc:t1', 'place', YARD, 'topics', 'ΘΕΜΑΤΑ-ΤΗΣ-ΑΥΛΗΣ');
  const yard = listsOf(world).places.find((one) => one.placeId === YARD);
  assert.equal(yard?.topics, 'ΘΕΜΑΤΑ-ΤΗΣ-ΑΥΛΗΣ');
});

test('a quiet group place and a direct chat carry no topics', () => {
  // Bug: a place nobody wrote in during the window, or a private chat, lists what people talk about there.
  const world = heartbeatWorld();
  const quiet = 'tele:channel:k1';
  describeSubject(world, 'desc:t1', 'place', quiet, 'topics', 'ΘΕΜΑΤΑ-ΤΟΥ-ΛΙΜΑΝΙΟΥ');
  describeSubject(world, 'desc:t2', 'place', ELENI_DM, 'topics', 'ΘΕΜΑΤΑ-ΤΗΣ-ΕΛΕΝΗΣ');
  lineOf(world, { id: 'd1', place: ELENI_DM, author: 'fake:111', ago: HOUR });
  const { places } = listsOf(world);
  assert.equal(places.find((one) => one.placeId === quiet)?.topics, null);
  const dm = places.find((one) => one.placeId === ELENI_DM);
  assert.equal(dm?.lines, 1);
  assert.equal(dm?.topics, null);
});

test('a person carries the real name, the aliases, the account names and the attitude with its two latest changes', () => {
  // Bug: the service collector reads only the band of the attitude and the first account, so a heartbeat knows less of
  // a person than a reply turn does and words it differently.
  const world = heartbeatWorld();
  world.db.prepare('UPDATE people SET real_name = ? WHERE id = ?').run(JSON.stringify(['Νικόλαος']), NIKOS);
  addClaim(world.db, { id: 'alias:n1', person: NIKOS, kind: 'alias', text: 'Νικ', audience: { group: 'fake' } });
  for (const [id, ago, applied, reason] of [
    ['aff:n2', 3, 5, 'ΛΟΓΟΣ-ΔΥΟ'],
    ['aff:n3', 1, -2, 'ΛΟΓΟΣ-ΤΡΙΑ'],
  ] as const)
    addAttitude(world.db, {
      id,
      person: NIKOS,
      at: iso(ago * DAY),
      applied,
      score: 40 + applied,
      reason,
      audience: { group: 'fake' },
    });
  const nikos = personOf(listsOf(world), NIKOS);
  assert.equal(nikos?.realName, 'Νικόλαος');
  assert.deepEqual(
    nikos?.claims.map((one) => one.text),
    ['Νικ']
  );
  assert.deepEqual(
    nikos?.profileAccounts.map((one) => one.platformId),
    ['222']
  );
  const attitude = nikos?.attitude;
  assert.equal(attitude?.reason, 'ΛΟΓΟΣ-ΤΡΙΑ');
  assert.equal(attitude?.score, 38);
  assert.deepEqual(
    attitude?.moves.map((one) => one.reason),
    ['ΛΟΓΟΣ-ΤΡΙΑ', 'ΛΟΓΟΣ-ΔΥΟ']
  );
});

test('a person carries the stored character and manner of speech, and null where none is stored', () => {
  // Bug: the collector never reads them, so none of the people a heartbeat draws carries them.
  const world = heartbeatWorld();
  describeSubject(world, 'desc:n-char', 'person', NIKOS, 'character', 'ΧΑΡΑΚΤΗΡΑΣ-ΝΙΚΟΥ');
  describeSubject(world, 'desc:n-style', 'person', NIKOS, 'style', 'ΤΡΟΠΟΣ-ΝΙΚΟΥ');
  const lists = listsOf(world);
  assert.equal(personOf(lists, NIKOS)?.character, 'ΧΑΡΑΚΤΗΡΑΣ-ΝΙΚΟΥ');
  assert.equal(personOf(lists, NIKOS)?.style, 'ΤΡΟΠΟΣ-ΝΙΚΟΥ');
  assert.equal(personOf(lists, ELENI)?.character, null);
});

test('a person with lines in their direct chat carries the times the persona wrote first there, and an empty one carries none', () => {
  // Bug: the first lines of a direct chat land on another person, or a person with an empty direct chat reads as never written to first.
  const world = heartbeatWorld();
  addClaim(world.db, { id: 'alias:z2', person: ZOE, kind: 'alias', text: 'Ζ', audience: { group: 'fake' } });
  addClaim(world.db, { id: 'alias:e2', person: ELENI, kind: 'alias', text: 'Ε', audience: { group: 'fake' } });
  const record = { id: 'h1', purpose: 'ΣΚΟΠΟΣ-h1', status: 'done', createdAt: TURN_NOW - 3 * DAY, origin: 'heartbeat' };
  writeIntentions(world.db, { op: 'archive', records: [record] }, iso(0));
  startRun(world.handle, {
    id: 'turn:h1',
    kind: 'intention_due',
    startedAt: TURN_NOW - 2 * DAY,
    inputs: { wakes: [], intentions: [{ id: 'h1', updatedAt: null }], facts: [], placeId: null },
  });
  finishRun(world.handle, { id: 'turn:h1', status: 'succeeded', outcome: 'spoke', finishedAt: TURN_NOW - 2 * DAY });
  lineOf(world, { id: 'h1-line', place: 'fake:dm:5678', author: 'self', ago: 2 * DAY });
  world.db.prepare("UPDATE sources SET turn_id = 'turn:h1' WHERE id = 'h1-line'").run();
  const lists = listsOf(world);
  assert.deepEqual(personOf(lists, ZOE)?.firstLines, {
    days: 30,
    written: { count: 1, lastAt: TURN_NOW - 2 * DAY, lineAts: [TURN_NOW - 2 * DAY], after: 0 },
  });
  assert.equal(personOf(lists, ELENI)?.firstLines, null, 'listed with an empty direct chat');
});

test('a person carries the newest of their episodes up to the count, newest first, and how many they hold', () => {
  // Bug: the collector reads no episode, so a heartbeat lists a person with none of the moments a reply entry holds.
  const world = heartbeatWorld();
  const episode = (id: string, date: string) => ({
    id,
    kind: 'episode',
    subject_id: NIKOS,
    date,
    what: `ΣΤΙΓΜΗ-${id}`,
    created_at: iso(DAY),
    scope_kind: 'group',
    scope_iface: 'fake',
  });
  insertRows(world.db, {
    episodes: [episode('e1', '2026-10-01'), episode('e3', '2026-10-30'), episode('e2', '2026-10-20')],
  });
  try {
    const nikos = serviceListsOf(world.db, TURN_NOW, internalContext(), { firstLineDays: 30, episodes: 2 }).people.find(
      (one) => one.personId === NIKOS
    );
    assert.deepEqual(
      nikos?.episodes.map((one) => one.what),
      ['ΣΤΙΓΜΗ-e3', 'ΣΤΙΓΜΗ-e2']
    );
    assert.equal(nikos?.episodesHeld, 3);
  } finally {
    world.close();
  }
});

// The service turns on the template of the turn frame: a heartbeat runs with `chat: null`, its request holds the
// service list (no `<chat>`, no `<surroundings>`), `<meanwhile>` holds the persona's last
// `context.memory.serviceMessages` lines over the rooms of every group of every interface and no direct chat, and
// `<memory>` reads as the persona themselves.
// The shapes the specifier chose:
//   runTurn({ chat: null, mode: 'inner', triggerKind: 'inner', inner: { wake, currentChannel, shadow, mayAct } })
//     is a service turn nowhere.
//   The persona's journal is read at `journal.read(PERSONA_ID, { day, kind: 'turn' })`.

useIface('fake');

const INNER_TURN_SERVICE_DAY = 86_400_000;
const INNER_TURN_SERVICE_HOUR = 3_600_000;

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

/** The words of the bands of the persona's attitude. */
const BANDS: Record<string, string> = shippedLabels.affinity?.bands ?? {};

/** The entries of `<people>`, each with all its lines. */
const peopleEntries = (text: string): Array<string> =>
  (new RegExp('<people>\\n([\\s\\S]*?)\\n</people>').exec(blockOf(text, 'memory'))?.[1] ?? '').split('\n\n');

/** The entry of `<people>` that opens with `marker`, '' with none. */
const entryWith = (text: string, marker: string): string =>
  peopleEntries(text).find((entry) => entry.startsWith(marker)) ?? '';

/** The words of the entry of a reply turn. */
const MEM = (shippedLabels.memory ?? {}) as Record<string, string>;

/** The words of the service collector's labels. */
const SV = (shippedLabels as unknown as { service: Record<string, string> }).service;

test('a heartbeat lists a person the persona has no line near and a place they never wrote in, and holds no <meanwhile>', async () => {
  // Bug: the heartbeat still sees only what the persona's own last lines raise, the same few places and people every time.
  const text = await heartbeatRequest();
  assert.ok(!rootTags(text).includes('meanwhile'), rootTags(text).join(' '));
  // A person's entry has the lines of a reply entry, and the attitude reads as it reads there, with
  // its number; the entry is found by its first line and read whole.
  const nikos = entryWith(text, `@${handleOf(NIKOS)}`);
  assert.ok(nikos.includes('Νίκος'), nikos);
  assert.ok(nikos.includes(HEARTBEAT_TEXT.nikosRelation), nikos);
  assert.ok(!nikos.includes(HEARTBEAT_TEXT.nikosRelationRest), 'one sentence of the description');
  const band = BANDS[affinityBand(40)] ?? '';
  assert.ok(nikos.split('\n').includes(fill(MEM.attitudeNoReason ?? '', { score: 40, band })), nikos);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(HEARTBEAT_TEXT.yardPurpose), yard);
  assert.ok(!text.includes(HEARTBEAT_TEXT.yardLine), 'no line of a place');
});

test('a heartbeat leaves a diary mirror out of <places> and lists a direct chat with none of its lines', async () => {
  // Bug: the persona is offered the mirror of their diary as a place to write in, or reads a private chat in their own time.
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

test('a heartbeat says how the persona’s last approach to a person and their last line in a place ended, and no line of a direct chat', async () => {
  // Bug: the lists show what is open and nothing of whether anyone answered the persona, so they approach a silent person
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
  line('q1', 'fake:dm:111', 'self', 6 * INNER_TURN_SERVICE_HOUR);
  line('q2', 'fake:dm:111', 'fake:111', 2 * INNER_TURN_SERVICE_HOUR);
  line('q3', YARD, 'self', 20 * INNER_TURN_SERVICE_HOUR, 'y2');
  line('q4', YARD, 'fake:111', 10 * INNER_TURN_SERVICE_HOUR, 'q3');
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
  const text = run.requests[0] ?? '';
  const dmLine = lineWith(text, 'places', `@${handleOf(ELENI)}`);
  const dm = dmLine.slice(0, dmLine.indexOf(':'));
  // A person's entry spans several lines, so it is found by its first line and read whole.
  const eleni = entryWith(text, `@${handleOf(ELENI)}`);
  assert.ok(eleni.includes(fill(SV.approach ?? '', { date: '2026-11-02', place: dm })), eleni);
  // A later line of theirs in their direct chat reads `approachWrote`; `approachAnswered` is for a reply.
  assert.ok(eleni.includes(fill(SV.approachWrote ?? '', { date: '2026-11-02' })), eleni);
  const nikos = entryWith(text, `@${handleOf(NIKOS)}`);
  assert.ok(nikos.includes(SV.approachNone ?? 'none'), nikos);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(fill(SV.ownAnswers ?? '', { count: 1 })), yard);
  for (const id of ['q1', 'q2']) assert.ok(!text.includes(`ΓΡΑΜΜΗ-${id}`), 'no line of the direct chat');
});

/**
 * Eleni's entry of a heartbeat whose wake run wrote in her direct chat six hours before the turn, carrying an intention
 * of `origin`, and a line of hers two hours before it.
 */
async function firstLineEntry(origin: string | null): Promise<string> {
  const world = heartbeatWorld();
  const record = {
    id: 'h1',
    purpose: 'ΣΚΟΠΟΣ-h1',
    status: 'done',
    createdAt: TURN_NOW - INNER_TURN_SERVICE_DAY,
    ...(origin ? { origin } : {}),
  };
  writeIntentions(world.db, { op: 'archive', records: [record] }, new Date(TURN_NOW).toISOString());
  const inputs = { wakes: [], intentions: [{ id: 'h1', updatedAt: null }], facts: [], placeId: null };
  startRun(world.handle, {
    id: 'turn:h1',
    kind: 'intention_due',
    startedAt: TURN_NOW - 6 * INNER_TURN_SERVICE_HOUR,
    inputs,
  });
  finishRun(world.handle, {
    id: 'turn:h1',
    status: 'succeeded',
    outcome: 'spoke',
    finishedAt: TURN_NOW - 6 * INNER_TURN_SERVICE_HOUR,
  });
  for (const [id, author, ago] of [
    ['f1', 'self', 6 * INNER_TURN_SERVICE_HOUR],
    ['f2', 'fake:111', 2 * INNER_TURN_SERVICE_HOUR],
  ] as const)
    addLine(world.db, {
      id,
      iface: 'fake',
      place: 'fake:dm:111',
      author,
      text: `ΓΡΑΜΜΗ-${id}`,
      at: new Date(TURN_NOW - ago).toISOString(),
      turn: author === 'self' ? 'turn:h1' : null,
    });
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
  return entryWith(run.requests[0] ?? '', `@${handleOf(ELENI)}`);
}

test('a heartbeat says how often the persona wrote first in a direct chat and what followed, in place of their last line there', async () => {
  // Bug: the persona cannot see that they wrote first and how much the others wrote back, so they write first again into silence; or
  // the entry tells the same line twice.
  const eleni = await firstLineEntry('heartbeat');
  const first = [
    fill(SV.firstLines ?? '', { days: 30, count: 1, date: '2026-11-02' }),
    fill(SV.firstLinesSince ?? '', { lines: 1 }),
  ].join('; ');
  assert.ok(eleni.split('\n').includes(first), eleni);
  assert.ok(!eleni.includes(fill(SV.approach ?? '', { date: '2026-11-02', place: '' }).trim()), eleni);
});

test('a heartbeat says the persona did not write first in a direct chat whose run carried an intention set on request', async () => {
  // Bug: a line written because a person asked for it counts as writing first.
  const eleni = await firstLineEntry(null);
  assert.ok(eleni.split('\n').includes(fill(SV.firstLinesNone ?? '', { days: 30 })), eleni);
});

test("a heartbeat shows a listed person's interests on their line and a place's topics on its line, and none elsewhere", async () => {
  // Bug: the lists read the interests and the topics and the request drops them, or puts them on another line.
  const world = heartbeatWorld();
  addInterest(world, 'int:n1', NIKOS, 'ΕΝΔΙΑΦΕΡΟΝ-ΕΝΑ', 2, INNER_TURN_SERVICE_DAY);
  addInterest(world, 'int:n2', NIKOS, 'ΕΝΔΙΑΦΕΡΟΝ-ΔΥΟ', 1, INNER_TURN_SERVICE_DAY);
  describeSubject(world, 'desc:yard-topics', 'place', YARD, 'topics', 'ΘΕΜΑΤΑ-ΤΗΣ-ΑΥΛΗΣ');
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null, world });
  const text = run.requests[0] ?? '';
  // A person's entry spans several lines, so it is found by its first line and read whole.
  const nikos = entryWith(text, `@${handleOf(NIKOS)}`);
  for (const topic of ['ΕΝΔΙΑΦΕΡΟΝ-ΕΝΑ', 'ΕΝΔΙΑΦΕΡΟΝ-ΔΥΟ']) assert.ok(nikos.includes(topic), nikos);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes('ΘΕΜΑΤΑ-ΤΗΣ-ΑΥΛΗΣ'), yard);
  const eleni = entryWith(text, `@${handleOf(ELENI)}`);
  const garden = lineWith(text, 'places', 'κήπος');
  for (const other of [eleni, garden]) {
    assert.ok(!/ΕΝΔΙΑΦΕΡΟΝ|ΘΕΜΑΤΑ/.test(other), other);
  }
  assert.equal(eleni, entryWith(await heartbeatRequest(), `@${handleOf(ELENI)}`));
  assert.equal(garden, lineWith(await heartbeatRequest(), 'places', 'κήπος'));
});

test("a heartbeat counts people's lines of the last seven days in a place and not the persona's own", async () => {
  // Bug: the persona's own lines count as life in a place, or a line older than the week counts.
  const text = await heartbeatRequest();
  const garden = lineWith(text, 'places', 'κήπος');
  assert.ok(garden.includes(fill(SV.activity ?? '', { days: 7, lines: 1, people: 1 })), garden);
  const yard = lineWith(text, 'places', 'αυλή');
  assert.ok(yard.includes(fill(SV.activity ?? '', { days: 7, lines: 3, people: 2 })), yard);
  // A place nobody wrote in says so, with no count of zero: Ζωή's direct chat holds her own line alone.
  const quiet = lineWith(text, 'places', `@${handleOf(ZOE)}`);
  assert.ok(quiet.includes(fill(SV.quiet ?? '', { days: 7 })), quiet);
  assert.ok(!quiet.includes(fill(SV.activity ?? '', { days: 7, lines: 0, people: 0 })), quiet);
});
