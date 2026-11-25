// Tests for src/turn/request/spatial.ts: the `<spatial_awareness>` body, where and when the persona is, and the
// whereabouts a turn reads off its frame. The labels are the fixture's markers, so a test checks
// which lines were built and in what order, never their wording. Synthetic names only.
//
// Signatures these tests hold the code to:
//   export type PlaceLink = { id: string; kind: string | null; name: string | null };
//   export type Whereabouts =
//     | { kind: 'cli'; chain?: ReadonlyArray<PlaceLink> }
//     | { kind: 'server' }
//     | { kind: 'place'; iface: string; private: boolean; chain: ReadonlyArray<PlaceLink> };
//   export function spatialAwarenessText(input: {
//     whereabouts: Whereabouts; now: number; timezone: string; labels: Labels; notes: unknown;
//   }): string;
//   export function whereaboutsOfFrame(frame: Frame, nouns?: Readonly<Record<string, string>>): Whereabouts;
// `chain` runs from the place itself up to the top of its tree. `notes` is `config.spatial.notes`: stored place id ->
// its note. A wake with no chat place says the persona is at the command line of their own server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNow, fill, formatClock, formatDate, formatDuration } from '../../../../src/format.ts';
import { frameOf } from '../../../../src/turn/request/frame.ts';
import type { FrameParty } from '../../../../src/turn/request/frame.ts';
import { spatialAwarenessText, whereaboutsOfFrame } from '../../../../src/turn/request/spatial.ts';
import type { PlaceLink } from '../../../../src/turn/request/spatial.ts';
import { frameInput, wakeInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { labels } from '../../../fixtures/labels.ts';
import { frameTurn } from '../../../fixtures/diary-frame.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import type { Lookup } from '../../../../src/turn/calls.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import type { Built } from '../../../fixtures/built-request.ts';
import { line, meanwhileReads } from '../../../fixtures/meanwhile-reads.ts';
import type { FakePlace } from '../../../fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../../fixtures/mind-entries.ts';
import { MIN, NOW as RIG_NOW, baseInput, fakeConfig, fakePrompts, makeMessage } from '../../../fixtures/prompt-rig.ts';
import { NOW as HARNESS_NOW, coreTurn, fakeStore, requestText } from '../../../fixtures/turn-harness.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { WAKE_NOW, requestText as wakeRequestText, wakeOfKind, wakeTurn } from '../../../fixtures/wake-turn.ts';

const NOW = Date.parse('2026-11-06T14:05:00Z');
const WHEN = formatNow(NOW, 'UTC', labels.locale);

const SERVER: PlaceLink = { id: 'p-server', kind: 'server', name: 'Example Server' };
const CHANNEL: PlaceLink = { id: 'p-channel', kind: 'channel', name: 'general' };
const BARE_CHANNEL: PlaceLink = { id: 'p-bare', kind: 'channel', name: 'off-topic' };
const THREAD: PlaceLink = { id: 'p-thread', kind: 'thread', name: 'weekend plans' };
const DM: PlaceLink = { id: 'p-dm', kind: 'dm', name: 'Robin' };
const CLI_DM: PlaceLink = { id: 'cli:dm:owner', kind: 'dm', name: 'owner' };

function textOf(chain: ReadonlyArray<PlaceLink>, notes: unknown = {}, isDm = false): string {
  return spatialAwarenessText({
    whereabouts: { kind: 'place', iface: 'discord', private: isDm, chain },
    now: NOW,
    timezone: 'UTC',
    labels,
    notes,
  });
}

// A category is no place, so no chain holds one. The labels hold no word for a server, a channel or a thread; each
// reads `spatial.kind` with its native kind as the noun (the fixture's `{noun} {name}`), so a channel carries no `#`.
test('a channel names the channel and its server, then the interface and the time', () => {
  // Bug: the path is read root first, or a level of the nesting is dropped, and the persona places themselves in the
  // server.
  assert.equal(
    textOf([CHANNEL, SERVER]),
    [`SPATIAL-PLACE channel general < server Example Server ON discord AT ${WHEN}`, 'SPATIAL-GROUP'].join('\n')
  );
});

test('a channel with no category goes straight to its server', () => {
  assert.equal(
    textOf([BARE_CHANNEL, SERVER]).split('\n')[0],
    `SPATIAL-PLACE channel off-topic < server Example Server ON discord AT ${WHEN}`
  );
});

test('a thread names itself, then the channel it sits in, up to the server', () => {
  // Bug: a thread is shown as its channel, so the persona answers the channel's topic inside a thread.
  assert.equal(
    textOf([THREAD, CHANNEL, SERVER]).split('\n')[0],
    `SPATIAL-PLACE thread weekend plans < channel general < server Example Server ON discord AT ${WHEN}`
  );
});

test('a direct chat is a private place, never a group one', () => {
  // Bug: a private chat reads as a group place and the persona talks to their partner as if others were
  // listening.
  const lines = textOf([DM], {}, true).split('\n');
  assert.equal(lines[0], `SPATIAL-PLACE dm Robin ON discord AT ${WHEN}`);
  assert.ok(lines.includes('SPATIAL-PRIVATE'));
  assert.ok(!lines.includes('SPATIAL-GROUP'));
});

// The command line is a direct chat, so it carries the private line and the note of its place as a direct chat on
// another interface does.
test('the command line says the persona is on the command line, with the time, in a private place', () => {
  // Bug: the command line chat read as a place others might hear, and the persona spoke there as to a room.
  assert.equal(
    spatialAwarenessText({
      whereabouts: { kind: 'cli', chain: [CLI_DM] },
      now: NOW,
      timezone: 'UTC',
      labels,
      notes: {},
    }),
    [`SPATIAL-CLI AT ${WHEN}`, 'SPATIAL-PRIVATE'].join('\n')
  );
});

test('the command line carries the note on its place', () => {
  // Bug: a note set on the command line chat never reached the persona there.
  const text = spatialAwarenessText({
    whereabouts: { kind: 'cli', chain: [CLI_DM] },
    now: NOW,
    timezone: 'UTC',
    labels,
    notes: { 'cli:dm:owner': 'speak plainly' },
  });
  assert.equal(text.split('\n').at(-1), 'SPATIAL-NOTE speak plainly');
});

test("a turn with no chat place is on the persona's own server, with the time", () => {
  // Bug: a heartbeat names the last channel the persona heard of as the place they are in.
  assert.equal(
    spatialAwarenessText({ whereabouts: { kind: 'server' }, now: NOW, timezone: 'UTC', labels, notes: {} }),
    `SPATIAL-SERVER AT ${WHEN}`
  );
});

test("a server's note reaches every channel under it", () => {
  // Bug: a note written once on the server shows in no channel.
  const lines = textOf([CHANNEL, SERVER], { 'p-server': 'adults only' }).split('\n');
  assert.equal(lines.at(-1), 'SPATIAL-NOTE adults only');
});

test("a channel's own note wins over the note of the places above it", () => {
  const notes = { 'p-server': 'adults only', 'p-channel': 'memes welcome' };
  const lines = textOf([CHANNEL, SERVER], notes).split('\n');
  assert.deepEqual(
    lines.filter((line) => line.startsWith('SPATIAL-NOTE')),
    ['SPATIAL-NOTE memes welcome']
  );
});

test('a blank note is no note, and the note of a place outside the chain is never shown', () => {
  // Bug: a cleared note leaves an empty line, or a sibling channel's note leaks into this one.
  const text = textOf([CHANNEL, SERVER], { 'p-channel': '   ', 'p-bare': 'not here' });
  assert.ok(!text.includes('SPATIAL-NOTE'), text);
});

test('no notes setting at all gives no note line and no failure', () => {
  // Bug: a deployment without `spatial.notes` throws in the middle of every turn.
  for (const notes of [undefined, null, 'adults only', ['adults only']]) {
    const text = textOf([CHANNEL, SERVER], notes);
    assert.ok(text.startsWith('SPATIAL-PLACE channel general'), text);
    assert.ok(!text.includes('SPATIAL-NOTE'), text);
  }
});

// The command line's place takes its note (above), and the persona's own server takes none.
test("the persona's server carries no note, whatever the notes hold", () => {
  const notes = { cli: 'x', server: 'y', 'p-server': 'adults only' };
  const text = spatialAwarenessText({ whereabouts: { kind: 'server' }, now: NOW, timezone: 'UTC', labels, notes });
  assert.ok(!text.includes('SPATIAL-NOTE'), text);
});

// A native kind the labels do not name reads `spatial.kind` with the kind itself as the noun
// (docs/prompt-contract.md), so only a place with no kind falls back to `kinds.place`.
test('a place with no kind and no name reads through the fallback labels, an unnamed kind through its own word', () => {
  // Bug: a place the store has not named yet renders `undefined` or a raw `{name}` to the model.
  const text = textOf([
    { id: 'p-x', kind: null, name: null },
    { id: 'p-y', kind: 'board', name: 'Notices' },
  ]);
  assert.equal(text.split('\n')[0], `SPATIAL-PLACE place UNNAMED < board Notices ON discord AT ${WHEN}`);
});

// Every turn states its whereabouts through its frame (whereaboutsOfFrame), and a place the tree does not hold yet is
// a chain of itself before the frame is built (src/turn/phases/request/build.ts). The command line keeps its chain, so
// the note on it can be found.
test('whereaboutsOfFrame: the command line is the command line, with the chain of its place', () => {
  const frame = frameOf(
    frameInput({ interface: 'cli', chain: [CLI_DM], dm: { word: 'dm', nativeId: 'owner', partner: null } })
  );
  assert.deepEqual(whereaboutsOfFrame(frame), { kind: 'cli', chain: [CLI_DM] });
});

test("whereaboutsOfFrame: a turn with no place or no interface is on the persona's own server", () => {
  assert.deepEqual(whereaboutsOfFrame(frameOf(wakeInput('heartbeat', { interface: 'discord' }))), { kind: 'server' });
  assert.deepEqual(whereaboutsOfFrame(frameOf(frameInput({ interface: '', chain: [CHANNEL] }))), { kind: 'server' });
});

test('whereaboutsOfFrame: a place takes its chain from the frame and its privacy from the scope', () => {
  const group = frameOf(frameInput({ interface: 'discord', chain: [CHANNEL, SERVER] }));
  assert.deepEqual(whereaboutsOfFrame(group), {
    kind: 'place',
    iface: 'discord',
    private: false,
    chain: [CHANNEL, SERVER],
    nouns: {},
  });
  const direct = frameOf(
    frameInput({ interface: 'discord', chain: [DM], dm: { word: 'dm', nativeId: '1', partner: null } })
  );
  assert.deepEqual(whereaboutsOfFrame(direct), {
    kind: 'place',
    iface: 'discord',
    private: true,
    chain: [DM],
    nouns: {},
  });
});

// A place reads in words and every chat has a handle. A direct chat's row holds no name, so the block names its
// counterpart by the handle the request gives, and `whereaboutsOfFrame` carries it. Signature:
//   Whereabouts place variant gains `partner?: string | null` (the handle, `@` included), present only when given;
//   whereaboutsOfFrame(frame, nouns?, partner?: string | null).
const UNNAMED_DM: PlaceLink = { id: 'p-dm', kind: 'dm', name: null };

test('the block of a direct chat names the counterpart by the handle and never reads as unnamed', () => {
  // Bug: the chat's row holds no name, so the block said the persona was in a direct chat with
  // `(unnamed)`.
  const text = spatialAwarenessText({
    whereabouts: { kind: 'place', iface: 'discord', private: true, chain: [UNNAMED_DM], partner: '@uzoe1' },
    now: NOW,
    timezone: 'UTC',
    labels,
    notes: {},
  });
  assert.ok(text.includes('@uzoe1'), text);
  assert.ok(!text.includes(labels.spatial.unnamed), text);
});

test('whereaboutsOfFrame carries the partner handle of a direct chat, and a group has none', () => {
  const direct = frameOf(
    frameInput({ interface: 'discord', chain: [UNNAMED_DM], dm: { word: 'dm', nativeId: '1', partner: null } })
  );
  assert.deepEqual(whereaboutsOfFrame(direct, {}, '@uzoe1'), {
    kind: 'place',
    iface: 'discord',
    private: true,
    chain: [UNNAMED_DM],
    nouns: {},
    partner: '@uzoe1',
  });
});

// The day the persona joined the root. A link of the chain may carry `joinedAt?: number | null` (`PlaceLink`, set by
// the chain read for a root with a known moment). `<spatial_awareness>` of a place whose chain holds one says it as a
// line of its own, `labels.spatial.joined` filled with `{root}` (the root's link in words as `places.link` gives it:
// the interface's noun from `whereaboutsOfFrame(frame, nouns)` and the quoted name) and `{day}` (`YYYY-MM-DD` in the
// turn's timezone). A chain with no moment says nothing of it.
test('a place under a root with a known moment says the day the persona joined, in the turn timezone', () => {
  // Bug: the day is cut in UTC, not in the persona's zone, or the moment never reaches the text and the persona cannot
  // say since when they are here.
  const joinedAt = Date.parse('2026-10-03T23:30:00Z');
  // 23:30 UTC on the 3rd is already the 4th in Tokyo.
  const frame = frameOf(frameInput({ interface: 'discord', chain: [CHANNEL, { ...SERVER, joinedAt }] }));
  const text = spatialAwarenessText({
    whereabouts: whereaboutsOfFrame(frame, { server: 'guild' }),
    now: NOW,
    timezone: 'Asia/Tokyo',
    labels,
    notes: {},
  });
  assert.ok(text.split('\n').includes('SPATIAL-JOINED guild "Example Server" 2026-10-04'), text);
});

test('a place under a root with no known moment says nothing of a day', () => {
  // Bug: a root the store has no moment for prints an invalid or empty day line.
  for (const joinedAt of [null, undefined]) {
    const root: PlaceLink = joinedAt === undefined ? SERVER : { ...SERVER, joinedAt };
    assert.equal(textOf([CHANNEL, root]).includes('SPATIAL-JOINED'), false, String(joinedAt));
  }
  const withMoment = textOf([CHANNEL, { ...SERVER, joinedAt: Date.parse('2026-10-03T10:00:00Z') }]);
  assert.ok(withMoment.includes('SPATIAL-JOINED'), withMoment);
});

useIface('fake');

// `world.md` and the virtual world are deleted and get no new home. The label is the test's.
test('the diary turn does not tell the persona they are in a virtual world of their own', async () => {
  // Bug: `<spatial_awareness>` of the diary's request says the persona is in their own virtual world, a removed concept.
  const labels = { ...shippedLabels, spatial: { ...shippedLabels.spatial, world: 'MARK-OWN-WORLD {when}' } };
  const run = await frameTurn({ prompts: { labels } });
  assert.ok(run.writer.length > 0, 'the request ran');
  for (const text of run.writer) assert.ok(!text.includes('MARK-OWN-WORLD'), text.slice(-600));
});

const TIMEZONE = 'Europe/Moscow';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const FRAME = frameOf(
  frameInput({ now: RIG_NOW, timezone: TIMEZONE, author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const HISTORY = [makeMessage('m1', RIG_NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const LOOKUP: Lookup = {
  turnId: 'turn:7',
  at: RIG_NOW - 2 * MIN,
  tool: 'memory.search',
  args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' },
  place: { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] },
  status: 'ok',
  extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  sourceIds: ['src:fake:m50:1:seen'],
  anchorMessageIds: ['m1'],
};

/** The club with a line of the persona's among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    line('place:club', 'c1', RIG_NOW - 40 * MIN, '111', 'πρώτη'),
    line('place:club', 'c2', RIG_NOW - 39 * MIN, '111', 'δεύτερη'),
    line('place:club', 'c3', RIG_NOW - 38 * MIN, null, 'δική της'),
    line('place:club', 'c4', RIG_NOW - 37 * MIN, '111', 'τρίτη'),
  ],
};

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: WHEREABOUTS,
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI], places: [CLUB] }),
      lookups: [LOOKUP],
      myDay: ['09:00 έγραψα στη λέσχη'],
      meanwhileReads: meanwhileReads([CLUB_LINES]),
      ...over,
    })
  );
}

const userOf = ({ messages }: Built): string => contentText(messages[1].content);

/** The body of the root block `<tag>`, '' when absent. */
function block(built: Built, tag: string): string {
  return new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(userOf(built))?.[1] ?? '';
}

test('<spatial_awareness> names the place <surroundings> names, and holds the clock', () => {
  // Bug: the two blocks name the place differently, or the clock stays in a block of its own.
  const built = request();
  assert.match(block(built, 'surroundings'), /γενικά/);
  const spatial = block(built, 'spatial_awareness');
  assert.match(spatial, /γενικά/);
  assert.match(spatial, /13:00/);
  assert.equal(block(built, 'now'), '');
});

// ---- the persona's recent time away, inside <now> ----

// Slice 7: every request is built on its frame, where `<now>` folds into `<spatial_awareness>` (the lead's decision 6):
// the present moment is its first line and the persona's recent time away follows it.
function nowBlockOf(request: Built) {
  const messages = request.messages;
  const user = contentText(messages[1].content);
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(user);
  return match ? match[1] : null;
}

/** `{from}` / `{to}` as the request writes a moment: the date and the clock in the bot's zone. */
const momentOf = (ts: number) => `${formatDate(ts, 'Europe/Moscow')}, ${formatClock(ts, 'Europe/Moscow')}`;

test('buildRequest: an owner pause 10:00-10:20 is one line under the lead inside <spatial_awareness>, in the tail', () => {
  const from = RIG_NOW - 2 * 60 * MIN;
  const to = from + 20 * MIN;
  const request = buildRequest(baseInput({ offPeriods: [{ kind: 'paused', from, to }] }));
  const lines = nowBlockOf(request)!.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], labels.journal.offLead);
  assert.equal(
    lines[2],
    fill(labels.journal.offPaused, {
      from: momentOf(from),
      to: momentOf(to),
      length: formatDuration(20 * MIN, labels.units),
    })
  );
  assert.ok(lines[2].includes('20 '));
  // Per-turn: never inside a cached part of the user message.
  const requestMessage = request.messages[1];
  const parts = requestMessage.content.filter((part) => part.type === 'text');
  const holder = parts.find((part) => part.text.includes(labels.journal.offLead));
  assert.equal(holder!.cacheSegment, undefined);
});

test('buildRequest: a stopped period reads offStopped; none leaves <spatial_awareness> with the moment alone', () => {
  const from = RIG_NOW - 3 * 60 * MIN;
  const to = from + 5 * MIN;
  const stopped = nowBlockOf(buildRequest(baseInput({ offPeriods: [{ kind: 'stopped', from, to }] })));
  assert.ok(
    stopped!.endsWith(
      fill(labels.journal.offStopped, {
        from: momentOf(from),
        to: momentOf(to),
        length: formatDuration(5 * MIN, labels.units),
      })
    )
  );
  const bare = nowBlockOf(buildRequest(baseInput()));
  assert.equal(bare!.split('\n').length, 1);
  assert.equal(nowBlockOf(buildRequest(baseInput({ offPeriods: [] }))), bare);
});

const REQUEST_WHEN = formatNow(RIG_NOW, 'Europe/Moscow', labels.locale);

const placeIn = (channelName: string) => ({
  kind: 'place',
  iface: 'discord',
  private: false,
  chain: [
    { id: `p-${channelName}`, kind: 'channel', name: channelName },
    { id: 'p-server', kind: 'server', name: 'Example Server' },
  ],
});

/** The parts of the user message. */
function partsOf(request: Built): Built['messages'][1]['content'] {
  const [, user] = request.messages;
  return user.content;
}

/** The body of `<spatial_awareness>` in a request, null when it has none. */
function spatialOf(request: Built): string | null {
  const text = partsOf(request)
    .map((part) => part.text)
    .join('');
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(text);
  return match ? (match[1] ?? null) : null;
}

test('a reply turn names its place, the interface and the time', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: placeIn('general') })));
  // Slice 7: a native kind reads `spatial.kind` with its noun, so the channel has no `#` of the old `kinds.channel`.
  assert.equal(
    body?.split('\n')[0],
    `SPATIAL-PLACE channel general < server Example Server ON discord AT ${REQUEST_WHEN}`
  );
});

// The lead's word of 2026-11-08: the command line is a private place, as a direct chat is, so its body gains the
// private line after the command line's own.
test('the command line says the command line, then that it is private', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: { kind: 'cli' } })));
  assert.equal(body, [`SPATIAL-CLI AT ${REQUEST_WHEN}`, 'SPATIAL-PRIVATE'].join('\n'));
});

for (const wakeKind of ['heartbeat']) {
  test(`a ${wakeKind} wake is on the persona's own server, even when the turn rode in on a channel`, () => {
    // Bug: the transport anchor of the persona's own time is named as the place they are in.
    const request = buildRequest(
      baseInput({
        mode: 'inner',
        wakeKind,
        prompts: fakePrompts({ 'turn/inner': 'INNER_TASK', 'heartbeat/task': 'HEARTBEAT_TASK' }),
        whereabouts: placeIn('general'),
      })
    );
    assert.equal(spatialOf(request), `SPATIAL-SERVER AT ${REQUEST_WHEN}`);
  });
}

// `world.md` and the virtual world are deleted and get no new home.
test('a diary post never tells the persona they are in a virtual world of their own', () => {
  // Bug: the diary request says the persona is in a world of their own making, a removed concept.
  const worldLabels = { ...labels, spatial: { ...labels.spatial, world: 'MARK-OWN-WORLD {when}' } };
  const request = buildRequest(
    baseInput({
      mode: 'diary',
      prompts: fakePrompts({ 'diary/task': 'DIARY_TASK', labels: worldLabels }),
      whereabouts: placeIn('general'),
    })
  );
  const spatial = spatialOf(request) ?? '';
  assert.ok(!spatial.includes('MARK-OWN-WORLD'), spatial);
});

test('an inner turn of another kind keeps the place it runs in', () => {
  const request = buildRequest(
    baseInput({
      mode: 'inner',
      wakeKind: 'intention_due',
      prompts: fakePrompts({ 'turn/inner': 'INNER_TASK' }),
      whereabouts: placeIn('general'),
    })
  );
  assert.ok(spatialOf(request)?.startsWith('SPATIAL-PLACE channel general'), String(spatialOf(request)));
});

test('the note of config.spatial.notes reaches the channel through its server', () => {
  const config = { ...fakeConfig(), spatial: { notes: { 'p-server': 'adults only' } } };
  const body = spatialOf(buildRequest(baseInput({ config, whereabouts: placeIn('general') })));
  assert.equal(body?.split('\n').at(-1), 'SPATIAL-NOTE adults only');
});

test('with no note set there is no note line', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: placeIn('general') })));
  assert.ok(body !== null && !body.includes('SPATIAL-NOTE'), String(body));
});

const CHAIN = [
  { id: 'p-channel', kind: 'channel', name: 'general' },
  { id: 'p-server', kind: 'server', name: 'Example Server' },
];

/** The harness's store, which also answers the chain of any place it is asked about. */
function storeWithTree(asked: Array<string>) {
  return {
    ...fakeStore(),
    placeChainOf: (placeId: string) => {
      asked.push(placeId);
      return CHAIN;
    },
  };
}

/** The body of `<spatial_awareness>` in a request text, null when it has none. */
function turnSpatialOf(text: string): string | null {
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(text);
  return match ? (match[1] ?? null) : null;
}

// A category is no place, so no chain holds one.
test('a reply in a channel names the channel, its server, the interface, the time and the note', async () => {
  // Bug: the turn builds its request without asking where it is, so the persona never sees the block on a live reply.
  const asked: Array<string> = [];
  const run = await coreTurn({
    answers: ['<skip/>'],
    store: storeWithTree(asked),
    config: { spatial: { notes: { 'p-server': 'adults only' } } },
  });
  const body = turnSpatialOf(requestText(run.llm, 0));
  assert.ok(asked.length > 0, 'the turn asked the store for its chain');
  assert.deepEqual(body?.split('\n'), [
    // Slice 7: a native kind reads `spatial.kind` with its noun, so the channel has no `#` of the old `kinds.channel`.
    `SPATIAL-PLACE channel general < server Example Server ON fake AT ${formatNow(HARNESS_NOW, 'UTC', labels.locale)}`,
    'SPATIAL-GROUP',
    'SPATIAL-NOTE adults only',
  ]);
});

test('an inner turn that runs in a channel names that place', async () => {
  const run = await coreTurn({
    answers: ['<skip/>'],
    store: storeWithTree([]),
    inner: {
      kind: 'intention_due',
      items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
      intentions: [{ id: 'i1', purpose: 'say hello', dueAt: HARNESS_NOW - 60_000 }],
      now: HARNESS_NOW,
      timezone: 'UTC',
      channels: [],
      budgets: { chain: { used: 0, cap: 3, left: 3 } },
    },
    config: { wakes: { mode: 'live', chatMessages: 2 } },
    prompts: { 'turn/inner': 'Do what the wake says.' },
  });
  const body = turnSpatialOf(requestText(run.llm, 0));
  assert.ok(body?.startsWith('SPATIAL-PLACE channel general < server'), String(body));
});

for (const kind of ['heartbeat']) {
  test(`a ${kind} wake says the persona is on their own server, with the time`, async () => {
    // Bug: the persona's own time carries no block at all, or names the anchor channel the wake rode in on.
    // A wake with no chat place is at the command line of the persona's server.
    const run = await wakeTurn({ wake: wakeOfKind(kind, `${kind}:1`), answers: ['<skip/>'] });
    const body = turnSpatialOf(wakeRequestText(run.requests[0] ?? []));
    // A service's whereabouts add the wake kind as the reason the persona is awake, after the place and the clock.
    const [where, ...rest] = String(body).split('\n');
    assert.equal(where, `SPATIAL-SERVER AT ${formatNow(WAKE_NOW, 'UTC', labels.locale)}`);
    assert.ok(rest.join('\n').includes(kind), String(body));
  });
}
