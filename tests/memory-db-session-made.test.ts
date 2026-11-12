// The memory session's `<people>` entry of a person she made things for holds what she made for them while the lines of
// the batch were written, by kind, and how many of her turns a line of theirs started in that span, and the same for
// the day of the batch's last line when the day holds more (src/memory/db/session.ts#buildSessionRequest over
// src/memory/db/made-and-given.ts#madeInSpanOf). Spec 2026-11-12 made-and-given, slice 2. The lines' labels are this
// file's own, so the tests read the counts and the kinds' words, not the shipped wording. A real memory service with
// the journal a turn writes through, and made-up ids.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { batchOf, buildSessionRequest, scopesOf } from '../src/memory/db/session.ts';
import { labels } from './fixtures/labels.ts';
import {
  ANNA,
  BORIS,
  CAFE,
  DAY,
  DM,
  HOUR,
  MIN,
  NATIVE,
  NOW,
  closeMadeWorlds,
  madeWorld,
} from './fixtures/made-and-given-world.ts';
import type { MadeWorld } from './fixtures/made-and-given-world.ts';
import { baseConfig, textOf } from './fixtures/memory-db/session-rig.ts';

after(closeMadeWorlds);

const sessionLabels = {
  ...labels,
  memory: { ...labels.memory, sessionMade: 'MADE {made}; TURNS {turns}', sessionMadeDay: 'DAY {made}' },
};
const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  rules: '- RULES',
  format: 'FORMAT',
  'memory-session': 'SESSION {{name}}',
  labels: sessionLabels,
};

/** The session request over the lines of the world named by `ids`, as the sweep of the group scope builds it. */
function requestOf(w: MadeWorld, ids: ReadonlyArray<string>, now = NOW) {
  const db = w.read();
  const scope = scopesOf(db).find((entry) => entry.key === 'group:discord');
  if (!scope) throw new Error('the world has no group session scope');
  const { scope: swept } = scope;
  const all = batchOf(db, swept, { cursor: 0, since: null, maxMessages: 50, settleBefore: NOW });
  const batch = all.filter((line) => ids.includes(String(line.id)));
  return buildSessionRequest({ db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now });
}

/** The lines of one person's entry of `<people>`, found by the id line the entry holds. */
function entryOf(request: ReturnType<typeof requestOf>, native: string): Array<string> {
  const user = request.messages[1];
  const text = textOf(user?.content);
  const people = /<people>\n([\s\S]*?)\n<\/people>/.exec(text)?.[1] ?? '';
  const entries = people.split('\n\n');
  const entry = entries.find((one) => one.split('\n').includes(`id: <@${native}>`));
  if (!entry) throw new Error(`no entry for ${native} in <people>`);
  return entry.split('\n');
}

const SPAN_LINES = ['a-d1', 'a-dr'];

test('names each kind made for a person in the span and the turns their lines started, under the affinity line', async () => {
  // Bug: the kinds are summed or dropped, one person's counts land in another's entry, the turns count a person's
  // lines instead of the turns they started, or the line stands elsewhere than under `affinity`.
  const w = madeWorld({ affinity: { [ANNA]: 4, [BORIS]: 2 } });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR + MIN, by: NATIVE[ANNA], attempt: 2 });
  await w.calls(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR, count: 3 });
  await w.turn(CAFE, { id: 't2', at: NOW - 3 * HOUR - 30 * MIN, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 't2', skill: 'media.find', at: NOW - 3 * HOUR - 30 * MIN, count: 2 });
  await w.call(CAFE, { turn: 't2', skill: 'voice.say', at: NOW - 3 * HOUR - 20 * MIN });
  await w.turn(CAFE, { id: 'tb', at: NOW - 2 * HOUR - 30 * MIN, by: NATIVE[BORIS] });
  await w.call(CAFE, { turn: 'tb', skill: 'voice.say', at: NOW - 2 * HOUR - 30 * MIN });
  const request = requestOf(w, ['a-d1', 'a-dr', 'b-d1']);
  const anna = entryOf(request, NATIVE[ANNA]);
  const affinity = anna.indexOf('affinity: 4');
  assert.ok(affinity >= 0);
  assert.equal(anna[affinity + 1], 'MADE 3 pictures, 2 GIF searches, 1 voice line; TURNS 2');
  assert.equal(
    anna.some((line) => line.startsWith('DAY ')),
    false
  );
  const boris = entryOf(request, NATIVE[BORIS]);
  assert.equal(boris[boris.indexOf('affinity: 2') + 1], 'MADE 1 voice line; TURNS 1');
});

test('gives a person she made nothing for no line, though they started turns', async () => {
  // Bug: a turn started or a failed call opens the line, so a person she only talked to reads as someone she made for.
  const w = madeWorld({ affinity: { [ANNA]: 4, [BORIS]: 2 } });
  await w.turn(CAFE, { id: 'ta', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(CAFE, { id: 'tb', at: NOW - 2 * HOUR - 30 * MIN, by: NATIVE[BORIS] });
  await w.call(CAFE, { turn: 'tb', skill: 'draw.create', at: NOW - 2 * HOUR - 29 * MIN, end: 'failed' });
  await w.call(CAFE, { turn: 'tb', skill: 'memory.search', at: NOW - 2 * HOUR - 28 * MIN });
  const request = requestOf(w, ['a-d1', 'b-d1']);
  assert.ok(entryOf(request, NATIVE[ANNA]).some((line) => line.startsWith('MADE ')));
  const boris = entryOf(request, NATIVE[BORIS]);
  assert.deepEqual(
    boris.filter((line) => line.startsWith('MADE ') || line.startsWith('DAY ')),
    []
  );
});

test('leaves a thing made in a direct chat out of the entry of a group session', async () => {
  // Bug: the counts are read without the scope's context, so the group's session learns what she made in private.
  const w = madeWorld({ affinity: { [ANNA]: 4, [BORIS]: 2 } });
  await w.turn(CAFE, { id: 'ta', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'ta', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(DM, { id: 'tb', at: NOW - 2 * HOUR - 30 * MIN, by: NATIVE[BORIS] });
  await w.calls(DM, { turn: 'tb', skill: 'draw.create', at: NOW - 2 * HOUR - 30 * MIN, count: 3 });
  const request = requestOf(w, ['a-d1', 'b-d1']);
  assert.ok(entryOf(request, NATIVE[ANNA]).some((line) => line.startsWith('MADE ')));
  assert.equal(
    entryOf(request, NATIVE[BORIS]).some((line) => line.startsWith('MADE ') || line.startsWith('DAY ')),
    false
  );
});

test('adds the day line with the larger count when more was made earlier that day', async () => {
  // Bug: the day line counts from the span's start, from the clock's `now`, over the last twenty-four hours or past the
  // batch's last line, so the tenth request of an evening reads as the first, or yesterday's and later pictures add up.
  const w = madeWorld({ affinity: { [ANNA]: 4 } });
  await w.turn(CAFE, { id: 'tm', at: NOW - 9 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'tm', skill: 'draw.create', at: NOW - 9 * HOUR, count: 4 });
  await w.turn(CAFE, { id: 'ty', at: NOW - 20 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ty', skill: 'voice.say', at: NOW - 20 * HOUR, count: 2 });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(CAFE, { id: 'tz', at: NOW - HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'tz', skill: 'media.find', at: NOW - HOUR + MIN });
  const anna = entryOf(requestOf(w, SPAN_LINES), NATIVE[ANNA]);
  const affinity = anna.indexOf('affinity: 4');
  assert.deepEqual(anna.slice(affinity + 1, affinity + 3), ['MADE 1 picture; TURNS 1', 'DAY 5 pictures']);
});

test('gives the span line alone when nothing was made that day before the batch', async () => {
  // Bug: the day line shows whenever the person has a span line, repeating the span, or it counts what was made
  // yesterday and after the batch's last line.
  const w = madeWorld({ affinity: { [ANNA]: 4 } });
  await w.turn(CAFE, { id: 'ty', at: NOW - 20 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'ty', skill: 'voice.say', at: NOW - 20 * HOUR, count: 2 });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'draw.create', at: NOW - 4 * HOUR + MIN });
  await w.turn(CAFE, { id: 'tz', at: NOW - HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 'tz', skill: 'media.find', at: NOW - HOUR + MIN });
  const anna = entryOf(requestOf(w, SPAN_LINES), NATIVE[ANNA]);
  assert.ok(anna.includes('MADE 1 picture; TURNS 1'));
  assert.equal(
    anna.some((line) => line.startsWith('DAY ')),
    false
  );
});

test('builds the same bytes twice for a batch, though a later call arrived and the clock moved', async () => {
  // Bug: the span or the day reads to `now` and not to the batch's last line, so a retry of the same batch after more
  // was made sends another request and the stable part of the request misses its cache.
  const w = madeWorld({ affinity: { [ANNA]: 4 } });
  await w.turn(CAFE, { id: 'tm', at: NOW - 9 * HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'tm', skill: 'draw.create', at: NOW - 9 * HOUR, count: 2 });
  await w.turn(CAFE, { id: 't1', at: NOW - 4 * HOUR, by: NATIVE[ANNA] });
  await w.call(CAFE, { turn: 't1', skill: 'voice.say', at: NOW - 4 * HOUR + MIN });
  const first = requestOf(w, SPAN_LINES);
  assert.ok(entryOf(first, NATIVE[ANNA]).some((line) => line.startsWith('MADE ')));
  await w.turn(CAFE, { id: 'tz', at: NOW - HOUR, by: NATIVE[ANNA] });
  await w.calls(CAFE, { turn: 'tz', skill: 'draw.create', at: NOW - HOUR, count: 3 });
  const second = requestOf(w, SPAN_LINES, NOW + DAY / 24);
  assert.equal(JSON.stringify(second.messages), JSON.stringify(first.messages));
});
