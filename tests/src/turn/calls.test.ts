import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../../../src/behavior/handles.ts';
import { resolveCall } from '../../../src/tools/executors.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { callViewOf, createLookupRing, searchHandles, type Lookup, type SearchRefs } from '../../../src/turn/calls.ts';
import { memorySearchText } from '../../../src/tools/tools.ts';
import { labels } from '../../fixtures/labels.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { placeRefOf } from '../../../src/memory/db/frame-reads.ts';
import { placeChainInDb } from '../../../src/memory/db/place-tree.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import '../../../src/tools/operations/index.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { channel, privateChannel } from '../../fixtures/reads-rig.ts';
import { blockOf, SERVICE_CONTEXT, serviceWorld, TURN_NOW } from '../../fixtures/service-turn.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { onWorld, useIface, world } from '../../fixtures/turn-world.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const first = { sourceId: 'opaque-source-one', placeId: 'place-one', iface: 'other' };
const second = { sourceId: 'opaque-source-two', placeId: 'place-two', iface: 'foreign' };

function quote(stored: typeof first, text: string) {
  return {
    placeId: 'same-room',
    channelName: 'stored room',
    startTs: NOW,
    lines: text,
    entries: [{ id: 'same-native', text, stored, message: { id: 'same-native', content: text } }],
  };
}

function view(draft: { searchRefs?: SearchRefs }) {
  return callViewOf({
    channel: { id: 'current-room', rootId: 'g1' },
    currentIface: 'primary',
    idByIndex: new Map([[1, 'transcript-one']]),
    lines: [{ id: 'transcript-one', authorId: 'reader' }],
    searchRefs: draft.searchRefs,
  });
}

test('quoted handles retain distinct stored identities when native IDs collide across calls', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  memorySearchText([quote(first, 'first-evidence')], { labels, refs });
  memorySearchText([quote(second, 'second-evidence')], { labels, refs });
  const current = view(draft);
  assert.deepEqual(current.messageAt?.(base)?.stored, first);
  assert.deepEqual(current.messageAt?.(base + 1)?.stored, second);
  const bySource = draft.searchRefs?.bySourceId;
  assert.deepEqual(bySource?.get(first.sourceId)?.message, {
    id: 'same-native',
    content: 'first-evidence',
  });
  assert.deepEqual(bySource?.get(second.sourceId)?.message, {
    id: 'same-native',
    content: 'second-evidence',
  });
});

test('registering the same stored source again preserves earlier handles and the other colliding source', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  memorySearchText([quote(first, 'first-evidence'), quote(second, 'second-evidence')], { labels, refs });
  memorySearchText([quote(first, 'first-evidence')], { labels, refs });
  const current = view(draft);
  assert.deepEqual(
    [current.messageAt?.(base)?.stored, current.messageAt?.(base + 1)?.stored, current.messageAt?.(base + 2)?.stored],
    [first, second, first]
  );
  const bySource = draft.searchRefs?.bySourceId;
  assert.deepEqual([...(bySource?.keys() ?? [])].sort(), [first.sourceId, second.sourceId].sort());
});

test('a cut stored quote creates no resolvable handle while transcript numbers retain native identity', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  const one = quote(first, 'short');
  one.entries.push({
    id: 'same-native',
    text: 'x'.repeat(100),
    stored: second,
    message: { id: 'same-native', content: 'cut-evidence' },
  });
  memorySearchText([one], { labels, refs, windowChars: 30 });
  const current = view(draft);
  assert.deepEqual(current.messageAt?.(base)?.stored, first);
  assert.equal(current.messageAt?.(base + 1), null);
  assert.deepEqual(current.messageAt?.(1)?.native, {
    iface: 'primary',
    chatId: 'current-room',
    messageId: 'transcript-one',
  });
});

test('a #handle and an @handle the persona carries from an earlier request resolve in a call when the place and member are known', () => {
  // Bug: a handle of a channel or member this request did not show was refused as unknown in a tool argument.
  const known = callViewOf({
    channel: { id: 'current-room', rootId: 'g1' },
    placeId: 'g1',
    memoryOn: true,
    store: {
      listChannels: () => [{ id: 'kitchen-room', name: 'kitchen' }],
      listUserProfiles: () => [{ id: 'member-7', names: ['Zoe'] }],
    },
    skills: skillRegistry(),
    channelHandles: new Map(),
    memberHandles: new Map(),
  });
  const read = resolveCall(
    {
      skill: 'memory.channel.read',
      args: { place: `#${handleOf('kitchen-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}` },
    },
    known
  ) as { args?: Record<string, unknown> };
  assert.equal(read.args?.place, 'kitchen-room');
  const set = resolveCall(
    { skill: 'intention.set', args: { text: 'ask', due: '1h', people: `@${handleOf('member-7')}` } },
    known
  ) as { args?: Record<string, unknown> };
  assert.equal(set.args?.people, 'member-7');
});

// Two native ids whose four-digit handles collide (the pair of tests/src/behavior/handles.test.ts).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

/**
 * The view of a turn on the command line: a private chat with no root, no snapshot, the memory's places known.
 * Each place of `knownPlaces` carries its stored native id, since no id is worked out from the text of another, so the
 * cases below give it.
 */
function commandLineView(knownPlaces: ReadonlyArray<{ id: string; nativeId: string | null }>) {
  return callViewOf({
    channel: { id: 'owner', rootId: null },
    currentIface: 'cli',
    placeId: 'cli:dm:owner',
    skills: skillRegistry(),
    channelHandles: new Map(),
    knownPlaces,
  });
}

const placeOf = (resolved: unknown): unknown => (resolved as { args?: Record<string, unknown> }).args?.place;

test("a channel's #handle the persona carries from another interface resolves to that place's id on the command line", () => {
  // Bug: a handle carried from a turn on another interface resolved only over the turn's own channels, so the call
  // read the command line chat itself and answered unsupported.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = commandLineView([
    { id: 'other:channel:far-room', nativeId: 'far-room' },
    { id: 'cli:dm:owner', nativeId: null },
  ]);
  for (const skill of ['conversation.read', 'memory.channel.read'])
    assert.equal(placeOf(resolveCall({ skill, args: { place: `#${handle}` } }, view)), 'other:channel:far-room');
});

test('a known channel whose place id spells no native id resolves its #handle to that place from its stored native id', () => {
  // Bug: the handles were widened over the native id parsed out of each place id, so a channel with an opaque place id
  // had no handle and the persona's call read the command line chat instead.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = commandLineView([{ id: 'place:far', nativeId: 'far-room' }]);
  assert.equal(
    placeOf(resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view)),
    'place:far'
  );
});

test('a handle two known places of different interfaces share stays unresolved', () => {
  const view = commandLineView([
    { id: 'other:channel:' + OLDER, nativeId: OLDER },
    { id: 'foreign:channel:' + NEWER, nativeId: NEWER },
  ]);
  const shared = handleOf(OLDER, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${shared}` } }, view);
  assert.equal(placeOf(read), undefined, 'neither place is guessed');
  const longer = handleOf(NEWER, HANDLE_DIGITS + 1, CHANNEL_HANDLE_PREFIX);
  const one = resolveCall({ skill: 'memory.channel.read', args: { place: `#${longer}` } }, view);
  assert.equal(placeOf(one), `foreign:channel:${NEWER}`, 'the lengthened handle names one place');
});

test("a direct chat's place gives no channel handle", () => {
  // Bug: a partner's id hashed as a channel would let a #handle name a private chat. A stored DM place holds no native
  // id of its own, so the partner's id in its place id reaches no handle.
  const view = commandLineView([{ id: 'other:dm:partner-3', nativeId: null }]);
  const handle = handleOf('partner-3', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  assert.equal(placeOf(resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view)), undefined);
});

test("a handle the request showed for another interface's channel resolves to that place's id", () => {
  // Bug: the command line request shows a channel of another interface by its native id, which the call then read as
  // a chat of the command line.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = callViewOf({
    channel: { id: 'owner', rootId: null },
    currentIface: 'cli',
    placeId: 'cli:dm:owner',
    skills: skillRegistry(),
    channelHandles: new Map([[handle, 'far-room']]),
    knownPlaces: [{ id: 'other:channel:far-room', nativeId: 'far-room' }],
  });
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view);
  assert.equal(placeOf(read), 'other:channel:far-room');
});

test("a handle of the turn's own channel keeps its native id when the memory knows the place too", () => {
  const handle = handleOf('kitchen-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = callViewOf({
    channel: { id: 'current-room', rootId: 'g1' },
    currentIface: 'primary',
    placeId: 'g1',
    store: { listChannels: () => [{ id: 'kitchen-room', name: 'kitchen' }], listUserProfiles: () => [] },
    skills: skillRegistry(),
    channelHandles: new Map(),
    knownPlaces: [{ id: 'primary:channel:kitchen-room', nativeId: 'kitchen-room' }],
  });
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view);
  assert.equal(placeOf(read), 'kitchen-room');
});

// ---- the ring of lookups ----------------------------------------------------------------------------------------

// What the persona looked up in the last turns of a place, kept until its anchor messages leave the window. One entry
// per place, tool and args whatever the order of the args' keys: a repeated lookup replaces the earlier one. `forPlace`
// keeps an entry while one of its anchors is in the window, and a line of the window that replies to an anchor adds its
// own id to the anchors. Contract:
//   Lookup = { turnId; at: number; tool; args: Record<string, unknown>; place: { id; path: Array<string> }; status;
//     extract; sourceIds: Array<string>; anchorMessageIds: Array<string> }
//   createLookupRing(seed: Array<Lookup>) -> { note(lookup, settings: { maxItems; extractChars }),
//     forPlace(placeId, window: Array<{ id; replyTo: string | null }>, now): Array<Lookup>, drop(placeId, tool, args) }

const RING_NOW = Date.parse('2026-11-07T12:00:00.000Z');
const RING_MIN = 60_000;
/** Values for `context.recall`. */
const RING_SETTINGS = { maxItems: 6, extractChars: 1200 };
const RING_ROOM = { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] };

function lookup(over: Partial<Lookup> = {}): Lookup {
  return {
    turnId: 'turn:7',
    at: RING_NOW - 10 * RING_MIN,
    tool: 'memory.search',
    args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ', place: 'λέσχη' },
    place: RING_ROOM,
    status: 'ok',
    extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
    sourceIds: ['src:fake:m50:1:seen'],
    anchorMessageIds: ['m10'],
    ...over,
  };
}

const lines = (...ids: Array<string>) => ids.map((id) => ({ id, replyTo: null }));

// No text the persona reads is cut silently.
test('the ring keeps an extract longer than extractChars whole, with no ellipsis', () => {
  const extract = 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ με τριαντάφυλλα και λεμονιές. '.repeat(40).trim();
  const ring = createLookupRing([]);
  ring.note(lookup({ extract }), RING_SETTINGS);
  const [kept] = ring.forPlace('place:room', lines('m10'), RING_NOW);
  assert.equal(kept?.extract, extract);
});

test('a lookup leaves the ring when its anchor leaves the window', () => {
  // Bug: lookups pile up for ever, a hundred turns giving a hundred extracts.
  const ring = createLookupRing([]);
  ring.note(lookup(), RING_SETTINGS);
  assert.deepEqual(ring.forPlace('place:room', lines('m11', 'm12'), RING_NOW), []);
});

test('a lookup made in one place is not read back in another', () => {
  // Bug: a lookup made in a one-to-one chat surfaces in a group.
  const ring = createLookupRing([]);
  ring.note(lookup({ place: { id: 'fake:dm:1234', path: ['fake', 'private', '1234'] } }), RING_SETTINGS);
  assert.deepEqual(ring.forPlace('place:room', lines('m10'), RING_NOW), []);
});

test('a repeated lookup replaces the earlier one and takes its newer anchor, whatever the order of the arguments', () => {
  // Bug: the same search twice fills two entries, or the replacement keeps the old anchor and leaves too early.
  const ring = createLookupRing([]);
  ring.note(lookup(), RING_SETTINGS);
  ring.note(
    lookup({ turnId: 'turn:9', args: { place: 'λέσχη', query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' }, anchorMessageIds: ['m20'] }),
    RING_SETTINGS
  );
  const kept = ring.forPlace('place:room', lines('m10', 'm20'), RING_NOW);
  assert.deepEqual(
    kept.map((one) => one.turnId),
    ['turn:9']
  );
  assert.deepEqual(
    ring.forPlace('place:room', lines('m20'), RING_NOW).map((one) => one.turnId),
    ['turn:9']
  );
});

test('a place keeps at most maxItems lookups, the oldest anchor dropped first', () => {
  // Bug: the cap is not applied, or it drops the newest lookup the persona just made.
  const ring = createLookupRing([]);
  const ids = ['m1', 'm2', 'm3', 'm4'];
  for (const [i, id] of ids.entries()) {
    ring.note(lookup({ turnId: `turn:${i}`, args: { query: `q${i}` }, anchorMessageIds: [id] }), {
      ...RING_SETTINGS,
      maxItems: 3,
    });
  }
  const kept = ring.forPlace('place:room', lines(...ids), RING_NOW).map((one) => one.turnId);
  assert.deepEqual(kept.sort(), ['turn:1', 'turn:2', 'turn:3']);
});

test('a ring seeded from the journal returns the seeded lookup, so a restart keeps it', () => {
  // Bug: the seed is ignored and every restart forgets what the persona looked up.
  const ring = createLookupRing([lookup()]);
  assert.deepEqual(
    ring.forPlace('place:room', lines('m10'), RING_NOW).map((one) => one.turnId),
    ['turn:7']
  );
});

test("a reply to the line of the persona's lookup keeps the entry after that line left the window", () => {
  // Bug: the follow-up "and what about the other one?" arrives just as the lookup is forgotten.
  const ring = createLookupRing([]);
  ring.note(lookup({ anchorMessageIds: ['m10'] }), RING_SETTINGS);
  const reply = [{ id: 'm60', replyTo: 'm10' }];
  assert.equal(ring.forPlace('place:room', reply, RING_NOW).length, 1);
  // The reply became an anchor of its own: it holds the entry with no parent in sight.
  assert.equal(ring.forPlace('place:room', lines('m60'), RING_NOW).length, 1);
});

test('drop removes the one lookup it names and keeps the others of the place', () => {
  // Bug: drop empties the whole place, or removes nothing.
  const ring = createLookupRing([]);
  ring.note(lookup(), RING_SETTINGS);
  ring.note(lookup({ turnId: 'turn:8', args: { query: 'ΑΛΛΟ' } }), RING_SETTINGS);
  ring.drop('place:room', 'memory.search', { place: 'λέσχη', query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' });
  assert.deepEqual(
    ring.forPlace('place:room', lines('m10'), RING_NOW).map((one) => one.turnId),
    ['turn:8']
  );
});

const OWNER = 'u-owner';

const OTHER = 'u-other';

const CONFIG = { context: { pull: { sameAudience: true } } };

const general = channel('c1', { name: '💬 general' });

const herbs = channel('c2', { name: '🌿 herbs' });

const staff = privateChannel('c3', ['u-mod']);

const blind = channel('c4', { name: 'blind', permissions: { read: false, send: false, attach: false, react: false } });

const named = (info: ChatInfo, name: string): ChatInfo => ({ ...info, name });

/** A private chat of `partner`, the shape of the destination of a DM turn. */
function dmOf(partner: string): ChatInfo {
  return channel('d1', { kind: 'dm', rootId: null, chatType: 'dm', name: 'dm', partnerId: partner, audience: null });
}

/** The same listing seen by `viewer`: `viewers` says which channel the viewer can open. */
function listing(viewer: string): ReadonlyArray<ChatInfo> {
  return [
    { ...general, viewers: { [viewer]: true } },
    { ...herbs, viewers: { [viewer]: true } },
    { ...named(staff, 'staff room'), viewers: { [viewer]: false } },
    { ...blind, viewers: { [viewer]: true } },
    // Another person's private chat, which the persona has open and the viewer does not.
    {
      ...dmOf(OTHER),
      id: 'd2',
      name: 'dm with someone else',
      viewers: { [viewer]: false, [OTHER]: true },
    },
  ];
}

const namesOf = (places: ReadonlyArray<{ name: string }>): Array<string> => places.map((place) => place.name).sort();

// ---- the view of a call ---------------------------------------------------------------------------------------

test('the view of a call in a group carries the readable places and keeps the chats it had', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const view = callViewOf({ channel: general, snapshot, config: CONFIG });
  assert.deepEqual(namesOf(view.places ?? []), ['🌿 herbs', '💬 general']);
  assert.ok(
    view.chats?.some((entry) => entry.name === 'staff room'),
    'the posting path still sees every chat'
  );
});

test('the view of a call in a private chat carries the places its partner can view', () => {
  const snapshot = snapshotOf('g1', { chats: listing(OWNER), groups: [] });
  const view = callViewOf({ channel: dmOf(OWNER), snapshot, partnerId: OWNER, config: CONFIG });
  assert.deepEqual(namesOf(view.places ?? []), ['🌿 herbs', '💬 general']);
});

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

const MIN = 60_000;

const DAY = 24 * 60 * MIN;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>γεια</msg>`;

const GRANTED = ['conversation.read', 'memory.search', 'message.create'];

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A line of `c1` the persona answers, by Ελένη unless another author is named. */
type Line = { id: string; text: string; at: number; authorId?: string; authorName?: string };

/** One reply turn: the line the persona answers and the model's answers to its requests, each a text or a function of the request. */
type Step = { trigger: Line; answers: ReadonlyArray<unknown> };

/** A line of `c1` as the platform hands it over. */
const rawLine = ({ id, text, at, authorId = '111', authorName = 'Ελένη' }: Line): Record<string, unknown> => ({
  id,
  placeId: 'c1',
  author: { id: authorId, bot: false, globalName: authorName, username: authorName },
  member: { displayName: authorName },
  cleanContent: text,
  createdTimestamp: at,
  reference: null,
  attachments: new Map(),
  stickers: new Map(),
});

/** The person an account of the world belongs to, null for an account no row holds. */
function personOfAccountIn(mind: World, account: string): string | null {
  const row: unknown = mind.db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account);
  const person: unknown = row && typeof row === 'object' ? Reflect.get(row, 'person_id') : null;
  return typeof person === 'string' ? person : null;
}

/**
 * Reply turns in `c1` over `mind`, one runner per life: with `restartBefore` a step runs on a new runner over the same
 * journal, memory, store and interface, seeded from the journal as src/core.ts seeds one at start. Returns the user
 * texts of every request, one list per step.
 */
async function replyLives(spec: {
  mind: World;
  steps: ReadonlyArray<Step>;
  restartBefore?: number | null;
  settings?: Record<string, number>;
}): Promise<Array<Array<string>>> {
  const { mind, steps } = spec;
  const hot: Record<string, unknown> = {
    config: {
      bot: {
        timezone: 'UTC',
        ownerPerson: OWNER_PERSON,
        access: Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: { ...SERVICE_CONTEXT, memory: { ...SERVICE_CONTEXT.memory, ...spec.settings } },
      dm: { enabled: true },
      llm: { maxRequestTokens: 60000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'live' },
    },
    prompts: {
      main: 'You are a regular member of this chat.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      labels: shippedLabels,
    },
  };
  world().channel({ id: 'c1', name: 'γενικά', placeId: 'g1', historyMessages: [] });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  const reads = world().adopt(port);
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
    placeRefOf: (id: string) => placeRefOf(mind.db, id),
    placeOfChat: (given: { id?: unknown; iface?: unknown }) =>
      `${typeof given.iface === 'string' ? given.iface : 'fake'}:channel:${String(given.id)}`,
    accountOf: (native: string, iface?: string) => `${iface ?? 'fake'}:${native}`,
    personOfAccount: (account: string) => personOfAccountIn(mind, account),
    placeChainOf: (placeId: string) => placeChainInDb(mind.db, placeId),
  };
  const admin = createAdmin({
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    now: () => TURN_NOW,
  });
  const memory = openTestMemorySync({ now: () => TURN_NOW });
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => TURN_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  const requests: Array<string> = [];
  let step = 0;
  let firstOfStep = 1;
  const llm = {
    complete: (messages: Array<{ content: unknown }>) => {
      const text = messages.map((message) => userText(message.content)).join('\n');
      requests.push(text);
      const answers = steps[step]?.answers ?? ['<skip/>'];
      const value: unknown = answers[Math.min(requests.length - firstOfStep, answers.length - 1)];
      const answer: unknown = typeof value === 'function' ? Reflect.apply(value, undefined, [text]) : value;
      return Promise.resolve(completionOf(answer));
    },
  };
  let contexts = 0;
  const runner = () =>
    createTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (value: unknown) => value, observe: () => {} },
      now: () => TURN_NOW,
      port,
      skills: skillRegistry(),
      journal,
      journalDb: () => mind.db,
      memoryContext: (given: Parameters<typeof issueContext>[0]) =>
        issueContext({ iface: 'fake', ...given, now: () => TURN_NOW, newId: () => `ctx:restart:${(contexts += 1)}` }),
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
      runInitiativeOp: admin.runInitiativeSkillOp,
    });
  /** A runner after a restart: seeded from the journal of yesterday and today for every place it may hold records of. */
  async function restarted() {
    const fresh = runner() as unknown as {
      seedTriggerLinks: (pairs: unknown) => void;
      seedCallMarks: (marks: unknown) => void;
    };
    const days = [utcDay(TURN_NOW - DAY), utcDay(TURN_NOW)];
    for (const placeId of ['g1', 'c1']) {
      fresh.seedTriggerLinks(await journal.triggerLinks(placeId, { days }));
      fresh.seedCallMarks({ ...(await journal.callMarks(placeId, { days })), placeId });
    }
    // The seeding of the lookups and the thinks reads the journal on its own (src/behavior/turn.ts#seedCallMarks).
    await new Promise((resolve) => setTimeout(resolve, 50));
    return fresh as unknown as ReturnType<typeof runner>;
  }
  let turns = runner();
  const out: Array<Array<string>> = [];
  for (const [index, one] of steps.entries()) {
    if (index === spec.restartBefore) {
      await journal.flush?.();
      turns = await restarted();
    }
    step = index;
    firstOfStep = requests.length + 1;
    const { id, text, at, authorId = '111', authorName = 'Ελένη' } = one.trigger;
    world().seed('c1', [rawLine(one.trigger)]);
    const trigger = { id, placeId: 'c1', authorId, authorName, self: false, bot: false, content: text, ts: at };
    await withCapturedLogs(() =>
      turns.runTurn({ chat: { iface: 'fake', chatId: 'c1' }, mode: 'reply', trigger, triggerKind: 'mention' })
    );
    await new Promise((resolve) => setImmediate(resolve));
    out.push(requests.slice(firstOfStep - 1));
  }
  await memory.close();
  return out;
}

// `<recall>` across a restart. The first turn reads the garden `c2` of the service world, Ελένη's line and the persona's after it.

const GARDEN = { eleni: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', persona: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ' } as const;

const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The `#N` that opens the line of `text` holding `marker`, null when the line opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(lineWith(text, marker))?.[0] ?? null;

/** What follows the `<task>` of a request: the persona's answers and the results of their calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;

/** The persona's answer that reads the garden around the number that opens the line of `marker` in `<recall>`, that line alone. */
const aroundRecalled =
  (marker: string) =>
  (request: string): unknown =>
    toolAnswer(THINK, [
      call('conversation.read', {
        place: 'κήπος',
        around: numberOf(blockOf(request, 'recall'), marker) ?? '#0',
        before: '0',
        after: '0',
      }),
    ]);

/** The garden read, then a turn that answers `second`, with or without a restart between them. */
async function gardenThenAsk(second: ReadonlyArray<unknown>, restart: boolean): Promise<Array<Array<string>>> {
  const mind = serviceWorld();
  try {
    return await replyLives({
      mind,
      restartBefore: restart ? 1 : null,
      steps: [
        { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
        { trigger: { id: 'r3', text: 'τι είπε η Ελένη;', at: TURN_NOW - MIN }, answers: second },
      ],
    });
  } finally {
    mind.close();
  }
}

describe('a reply turn after a restart', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the first request after a restart shows <recall> as it would have without the restart, numbers included', async () => {
    // Bug: the journal restores the persona's lookup without the lines its numbers named, so after a restart the extract shows no
    // number until they read again, and the request differs from the one they would have had.
    const [, kept = []] = await gardenThenAsk([SAY], false);
    const [, restarted = []] = await gardenThenAsk([SAY], true);
    const before = blockOf(kept[0] ?? '', 'recall');
    assert.match(
      numberOf(before, GARDEN.eleni) ?? '',
      /^#\d+$/,
      'without a restart the line of the persona has a number'
    );
    assert.equal(blockOf(restarted[0] ?? '', 'recall'), before);
  });

  test('a number of <recall> after a restart reads that line in a call', async () => {
    // Bug: a number <recall> shows after a restart must name the line it named before it, in the turn's registry.
    const [, second = []] = await gardenThenAsk([aroundRecalled(GARDEN.eleni), SAY], true);
    assert.match(
      numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '',
      /^#\d+$/,
      'the line of the persona has a number'
    );
    const result = afterTask(second[1] ?? '');
    assert.equal(countOf(result, GARDEN.eleni), 1, result);
    assert.equal(countOf(result, GARDEN.persona), 0, 'the call read the line the number names and no other');
  });
});
