// Tests for src/pipeline/private-gate.ts. The owner's command line stays open while `dm.enabled` is false (docs/cli.md
// under Access): the gate lets the owner's lines through, and the missed-answer recovery of a line in that chat follows
// the same rule. A direct chat of another interface stays closed. Synthetic ids, no provider.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateGate } from '../../../src/pipeline/private-gate.ts';
import type { PrivateLine } from '../../../src/pipeline/private-gate.ts';
import type { ChatInfo, MessageEvent } from '../../../src/protocol/adapter.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import {
  directIn,
  mentionIn,
  postedIn,
  readsOf,
  seedDm,
  seedPerson,
  seedRoom,
  waitFor,
  withFakes,
} from '../../fixtures/two-fakes.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  noticesOf,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { deepMerge } from '../../../src/config.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { freshWorld, refTo, seedExisting, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ANSWER, channelInfo, lineEvent } from '../../fixtures/core-over-fake.ts';
import {
  query,
  runCli,
  settle as identityOwnerRawInstallSettle,
  spawnCli,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from '../../fixtures/core-units.ts';
import type { Dirs, Rig, Unit } from '../../fixtures/core-units.ts';

type Recovery = { allow: (channel: ChatInfo, trigger: PrivateLine) => Promise<boolean> };

/** The recovery the gate hands the missed-answer registry, built over a config with direct chats off. */
function recoveryWithDmOff(): Recovery {
  let recovery: Recovery | null = null;
  createPrivateGate(
    wrongly<Parameters<typeof createPrivateGate>[0]>({
      hot: { config: { dm: { enabled: false } } },
      store: { getUser: () => null },
      rootsOf: () => [],
      missed: {
        setPrivateRecovery: (given: Recovery) => {
          recovery = given;
        },
      },
    })
  );
  assert.ok(recovery, 'the gate hands over a recovery');
  return recovery;
}

const chatOf = (iface: string, id: string): ChatInfo =>
  wrongly<ChatInfo>({ id, kind: 'dm', rootId: null, iface, name: 'x', partnerId: 'owner' });

const line: PrivateLine = { id: 'm1', placeId: 'cli:dm:owner', authorId: 'owner', ts: 0 };

test("allows a recovery turn in the owner's command line while direct chats are off", async () => {
  // Bug: a line of the owner's that the pipeline missed was never recovered, though the gate had let it through.
  assert.equal(await recoveryWithDmOff().allow(chatOf('cli', 'cli:dm:owner'), line), true);
});

test('refuses a recovery turn in a direct chat of another interface while direct chats are off', async () => {
  assert.equal(
    await recoveryWithDmOff().allow(chatOf('fake', 'd1'), { ...line, placeId: 'd1', authorId: 'u1' }),
    false
  );
});

// A DM from ingestion to the model's request on an interface that serves no root, through the real link. Fake
// interfaces, a scripted model and temporary folders. The gate stays closed for a stranger: having no root to check
// membership in is no reason to answer anyone.

test('a stranger on an interface with no root is not answered, while the owner is', async () => {
  // Bug: the fix for a missing root opens the gate to everyone who finds the account.
  await withFakes({ owners: ['u1'], names: ['solo'] }, async ({ connect, requests }) => {
    const solo = await connect('solo', []);
    seedDm(solo, 'd1', 'u1');
    await directIn(solo, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(solo, 'd1').length > 0, 'the answer to the owner');
    seedDm(solo, 'd2', 'stranger');
    await directIn(solo, 'd2', 'stranger', 'm2');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(postedIn(solo, 'd2'), []);
    assert.equal(requests.length, 1);
  });
});

test('a DM on an interface with no root asks nothing of the interface that has one', async () => {
  // Bug: the DM borrows the first interface's home root for its gate and its reads.
  await withFakes({ owners: ['u1'], names: ['first', 'second'] }, async ({ connect, rows }) => {
    // The DM's interface says hello first: it is the home interface, where the owner's account is bound.
    const second = await connect('second', []);
    const first = await connect('first', [{ id: 'g1', name: 'Alpha' }]);
    seedPerson(first, 'g1', 'u1', 'Eleni');
    seedDm(second, 'd1', 'u1');
    const before = readsOf(first, 'g1').length;
    await directIn(second, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(second, 'd1').length > 0, 'the answer on the second interface');
    assert.equal(readsOf(first, 'g1').length, before);
    assert.deepEqual(rows("SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'"), [
      { audience_id: 'aud:dm:second:dm:u1' },
    ]);
    assert.deepEqual(postedIn(first, 'd1'), []);
  });
});

test('a group of the root an interface declares is answered and kept with no configured home root', async () => {
  // Bug: the core refuses to start without `bot.placeId`, or a group line loses its root beside a DM-only interface.
  await withFakes({ owners: [], names: ['first', 'second'] }, async ({ connect, rows }) => {
    const first = await connect('first', [{ id: 'g1', name: 'Alpha' }]);
    const second = await connect('second', []);
    seedRoom(first, 'c1', 'g1');
    await mentionIn(first, 'c1', 'g1', 'm1');
    await waitFor(() => postedIn(first, 'c1').length > 0, 'the answer in the room');
    seedDm(second, 'd1', 'stranger');
    await directIn(second, 'd1', 'stranger', 'm2');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(postedIn(second, 'd1'), []);
    assert.deepEqual(rows("SELECT iface FROM sources WHERE kind = 'seen' AND scope_kind != 'dm' ORDER BY iface"), [
      { iface: 'first' },
    ]);
  });
});

// The alias gate of the door: a line that names the persona by one of the card's aliases, with no ping, goes to the
// address classifier, and only its verdict starts a turn. The engine holds no name list.
// Contract:
//   a third gate beside the flags and attention: the line's text holds one of the persona's aliases, the names given to `person:self`
//   person record (`selfNames`, read at the moment of use)
//   a word matches when its stem equals an alias's stem under `stemmer()` (createMessageHandler's dependency, the
//   memory's learned stemmer, read at the moment of use), else by a case-folded whole-word match
//   the gate that sent a line is logged as `gate: 'alias'`, with no text of the line

const NOW = Date.parse('2026-11-05T12:00:00Z');
const SELF = 'self-id';
// Aliases live in the persona's person record: they come from `selfNames`, the names given to `person:self`.
const NAMES = ['Ζεφύρα', 'Zefira', 'Ilo'];
/** A stemmer that drops a few Greek endings, as a learned one would. */
const GREEK_STEMS = { stem: (word: string) => word.toLowerCase().replace(/(ας|ου|α|ς)$/u, '') };

type Spot = { iface: string; place: Record<string, unknown> & { id: string } };
const GROUP: Spot = { iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } };
const DM: Spot = { iface: 'alpha', place: { id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1' } };

function door(
  options: {
    answer?: string;
    names?: Array<string>;
    stemmer?: { stem: (word: string) => string } | null;
    maxTurnsPerAuthor?: number;
  } = {}
) {
  const fake = createFakeAdapter({ iface: 'alpha', selfId: SELF });
  for (const spot of [GROUP, DM]) fake.seedChat(channelOf(spot.place.id, { iface: spot.iface, ...spot.place }));
  const reads = createReads(fake, { info() {}, warn() {}, error() {} });
  const calls: Array<{ purpose?: string }> = [];
  const started: Array<{ triggerKind: string | null }> = [];
  const handler = createMessageHandler(
    wrongly<Parameters<typeof createMessageHandler>[0]>({
      hot: {
        config: baseConfig({
          bot: { timezone: 'UTC', nameTriggers: [] },
          dm: { enabled: true },
          private: { minAffinity: 0 },
          address: { attentionMinutes: 30, maxTurnsPerAuthor: options.maxTurnsPerAuthor ?? 100 },
        }),
        prompts: { 'classify/address': 'Is it said to {{name}}?', labels },
      },
      store: { state: { data: {}, markDirty() {} }, getUser: () => ({ names: ['Member'], affinity: { score: 0 } }) },
      reads,
      selfId: () => SELF,
      getSelfName: () => 'Nova',
      turns: {
        notePost() {},
        isBusy: () => false,
        isAnyBusy: () => false,
        spokeAfterSeeing: () => false,
        lastPostAt: () => 0,
        runTurn: (asked: { triggerKind: string | null }) => {
          started.push(asked);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      memory: { observe() {} },
      tagHistory: createTagHistory(),
      isServedRoot: () => true,
      rootsOf: () => [],
      llm: {
        complete: (_messages: unknown, request: { purpose?: string }) => {
          calls.push(request);
          // The lead: the address classifier answers in strict JSON; a scene's verdict word is sent as the object.
          return Promise.resolve({
            text: JSON.stringify({ answer: options.answer ?? 'yes' }),
            usage: {},
            estimated: 1,
          });
        },
      },
      stemmer: () => (options.stemmer === undefined ? GREEK_STEMS : options.stemmer),
      selfNames: () => options.names ?? NAMES,
      rng: () => {
        throw new Error('the door rolls no chance');
      },
      now: () => NOW,
      missed: { noteFact() {}, noteActivity() {}, noteNotAddressed() {} },
      port: fake,
    })
  );
  let serial = 0;
  async function say(spot: Spot, text: string): Promise<void> {
    serial += 1;
    const id = `m${serial}`;
    const event = {
      kind: 'message.received',
      iface: spot.iface,
      at: NOW,
      id: `${spot.iface}:message:${id}`,
      // Type fix (plan B1 amendment, approved): the place carries its own `id`, so it is not written twice.
      chat: { kind: 'channel', name: spot.place.id, ...spot.place },
      message: {
        id,
        author: { id: 'u1', name: 'Eleni', self: false, bot: false },
        content: text,
        sourceText: text,
        system: false,
        at: NOW,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    };
    await handler(wrongly<MessageReceived>(event));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { say, calls, started };
}

test('an alias in a DM never calls the classifier', async () => {
  // Bug: the gate runs before the DM branch and pays for a line that is already addressed.
  const scene = door();
  await scene.say(DM, 'Zefira, are you there?');
  assert.equal(scene.calls.length, 0);
  assert.equal(scene.started.length, 1);
});

// The door: on every interface the address classifier (prompts/classify/address.md) decides each line of a group place, DMs and
// the core CLI never ask it, and two neutral rails bound its cost and the turns one author starts.
// Contract, plan 2026-11-04-cli-and-memory B1:
//   settings `address.attentionMinutes` and `address.maxTurnsPerAuthor`, read at the moment of use
//   a line with `addressing.mentioned` or `addressing.replyToSelf` goes to the classifier at once, any other line only
//   while the persona wrote in that place within `address.attentionMinutes`; the verdict `yes` starts a turn of kind
//   `mention`, `reply` or `followUp` by what the line carried, `overheard` an overheard turn, `no` nothing
//   past `address.maxTurnsPerAuthor` started turns of one author in one place within `address.attentionMinutes`, a
//   `yes` starts no turn and logs `address: refused` with `{ turns, limit }`
//   the names come from the persona's person record (`selfNames`, the names given to `person:self`) and reach the request
//   as an `<aliases>` block; `bot.nameTriggers` opens nothing
//   `missed.noteFact` carries `iface`

const DOOR_ADDRESS_NOW = Date.parse('2026-11-05T12:00:00Z');
const DOOR_ADDRESS_SELF = 'self-id';
const ADDRESS_PROMPT = 'Is the candidate said to {{name}}?';

type Shape = { label: string; iface: string; place: Partial<ChatInfo> & { id: string } };

// A server's channel, a group that is its own root place, and a group outside any root.
const GROUP_SHAPES: Array<Shape> = [
  { label: 'a channel under a root place', iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } },
  { label: 'a group that is its own root', iface: 'beta', place: { id: 'r1', kind: 'channel', rootId: 'r1' } },
  {
    label: 'a group outside any root',
    iface: 'gamma',
    place: { id: 'r2', kind: 'channel', chatType: 'group_dm', rootId: null },
  },
];

type LlmCall = { system: string; user: string; options: { purpose?: string; role?: string } };
type TurnAsked = { triggerKind: string | null; trigger: { id: string; authorId: string }; chat: object };

type DoorOptions = {
  shapes?: Array<Shape>;
  answer?: string | ((call: LlmCall) => string);
  fails?: boolean;
  attentionMinutes?: number;
  maxTurnsPerAuthor?: number;
  prompts?: Record<string, unknown>;
  busy?: boolean;
  rng?: () => number;
  storeState?: { data: Record<string, unknown>; markDirty(): void };
  nameTriggers?: Array<string>;
  selfNames?: Array<string>;
};

/** One handler over a fake adapter per interface, a fake model and a fake turn runner. */
function doorAddressDoor(options: DoorOptions = {}) {
  const shapes = options.shapes ?? GROUP_SHAPES;
  const clock = { at: DOOR_ADDRESS_NOW };
  const fakes = new Map<string, ReturnType<typeof createFakeAdapter>>();
  const quiet = { info() {}, warn() {}, error() {} };
  const readsOf = new Map<string, ReturnType<typeof createReads>>();
  const adapterOf = (iface: string) => {
    let fake = fakes.get(iface);
    if (!fake) {
      fake = createFakeAdapter({ iface, selfId: DOOR_ADDRESS_SELF });
      fakes.set(iface, fake);
      readsOf.set(iface, createReads(fake, quiet));
    }
    return fake;
  };
  const infoOf = ({ iface, place }: Shape): ChatInfo => channelOf(place.id, { iface, name: place.id, ...place });
  for (const shape of shapes) adapterOf(shape.iface).seedChat(infoOf(shape));
  // The core's reads name their interface in the first argument.
  const reads = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (first: { iface?: string }, ...rest: Array<unknown>) => {
          adapterOf(first?.iface ?? shapes[0].iface);
          const target = readsOf.get(first?.iface ?? shapes[0].iface) as unknown as Record<
            string,
            (...args: Array<unknown>) => unknown
          >;
          return target[name]?.(first, ...rest);
        },
    }
  );
  const calls: Array<LlmCall> = [];
  const llm = {
    complete: (messages: Array<{ content: unknown }>, requestOptions: LlmCall['options']) => {
      const call = {
        system: String(messages[0]?.content),
        user: JSON.stringify(messages[1]?.content),
        options: requestOptions,
      };
      calls.push(call);
      if (options.fails) return Promise.reject(new Error('provider down'));
      const answer = typeof options.answer === 'function' ? options.answer(call) : (options.answer ?? 'yes');
      // The lead: the address classifier answers in strict JSON; a scene's verdict word is sent as the object.
      return Promise.resolve({ text: JSON.stringify({ answer }), usage: {}, estimated: 1 });
    },
  };
  const started: Array<TurnAsked> = [];
  const facts: Array<Record<string, unknown>> = [];
  const hot = {
    config: baseConfig({
      bot: { timezone: 'UTC', nameTriggers: options.nameTriggers ?? [] },
      dm: { enabled: true },
      private: { minAffinity: 0 },
      address: {
        attentionMinutes: options.attentionMinutes ?? 30,
        maxTurnsPerAuthor: options.maxTurnsPerAuthor ?? 100,
      },
    }),
    prompts: { 'classify/address': ADDRESS_PROMPT, labels, ...options.prompts },
  };
  const handler = createMessageHandler(
    wrongly<Parameters<typeof createMessageHandler>[0]>({
      hot,
      store: {
        state: options.storeState ?? { data: {}, markDirty() {} },
        getUser: () => ({ names: ['Member'], affinity: { score: 0 } }),
      },
      reads,
      selfId: () => DOOR_ADDRESS_SELF,
      getSelfName: () => 'Nova',
      turns: {
        notePost() {},
        isBusy: () => options.busy === true,
        isAnyBusy: () => options.busy === true,
        spokeAfterSeeing: () => false,
        lastPostAt: () => 0,
        runTurn: (asked: TurnAsked) => {
          started.push(asked);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      memory: { observe() {} },
      tagHistory: createTagHistory(),
      isServedRoot: () => true,
      rootsOf: () => [],
      llm,
      rng:
        options.rng ??
        (() => {
          throw new Error('the door rolls no chance');
        }),
      now: () => clock.at,
      missed: {
        noteFact: (fact: Record<string, unknown>) => facts.push(fact),
        noteActivity() {},
        noteNotAddressed() {},
      },
      selfNames: () => options.selfNames ?? [],
      port: adapterOf(shapes[0].iface),
    })
  );
  let serial = 0;
  type Line = {
    author?: string;
    text?: string;
    mentioned?: boolean;
    replyToSelf?: boolean;
    alsoMentions?: Array<string>;
  };
  /** Delivers one line of a member (or, with `author: SELF`, of the persona) in `shape`. */
  async function say(shape: Shape, line: Line = {}): Promise<void> {
    serial += 1;
    const id = `m${serial}`;
    const author = line.author ?? 'u1';
    const event = {
      kind: 'message.received',
      iface: shape.iface,
      at: clock.at,
      id: `${shape.iface}:message:${id}`,
      // Type fix (plan B1 amendment, approved): the place carries its own `id`, so it is not written twice.
      chat: { kind: 'channel', name: shape.place.id, ...shape.place },
      message: {
        id,
        author: {
          id: author,
          name: author === DOOR_ADDRESS_SELF ? 'Nova' : 'Eleni',
          self: author === DOOR_ADDRESS_SELF,
          bot: false,
        },
        content: line.text ?? 'καλημέρα σε όλους',
        sourceText: line.text ?? 'καλημέρα σε όλους',
        system: false,
        at: clock.at,
        replyToId: line.replyToSelf ? 'm0' : null,
        replyPingAccountId: line.replyToSelf ? DOOR_ADDRESS_SELF : null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: {
        mentioned: line.mentioned === true,
        replyToSelf: line.replyToSelf === true,
        mentionedAccountIds: [...(line.mentioned ? [DOOR_ADDRESS_SELF] : []), ...(line.alsoMentions ?? [])],
        mentionedChatIds: [],
      },
    };
    await handler(wrongly<MessageReceived>(event));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { say, calls, started, facts, hot, clock, handler };
}

const shapeOfDm = (iface: string): Shape => ({
  label: `a DM on ${iface}`,
  iface,
  place: { id: `d-${iface}`, kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1' },
});

for (const iface of ['alpha', 'beta', 'cli']) {
  test(`a DM line on ${iface} starts a private turn of the persona with no classifier call`, async () => {
    // Bug: moving the classifier into the door catches direct chats too, and pays for what is already addressed.
    const scene = doorAddressDoor({ shapes: [shapeOfDm(iface)] });
    await scene.say(shapeOfDm(iface));
    assert.equal(scene.calls.length, 0);
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['private']
    );
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Private chat (features.privateMessages): a DM from a member of the served
// guild runs through privateGate (src/behavior/private.ts) and, when it
// passes, a reply turn with the pinned placeId. Limit notices: a triggered
// turn refused by a rail gets one plain line naming the limit.

const TODAY = '2026-09-29';
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

function privateConfig(overrides: Record<string, Untyped> = {}) {
  return baseConfig(
    deepMerge(
      // PR 7d: features.privateMessages is the key dm.enabled, and the daily reply caps are gone.
      { bot: { ownerPerson: OWNER_PERSON }, dm: { enabled: true } },
      overrides
    )
  );
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides: Record<string, Untyped> = {}) {
  const sent: Array<Untyped> = [];
  world().channel({ id, dm: true, partnerId: recipientId ?? null }, { keep: true });
  seedExisting(id, 'dm-m1');
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload: Record<string, Untyped>) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

function fakeDmMessage(overrides: Record<string, Untyped> = {}) {
  const channel = overrides.channel ?? fakeDmChannel();
  return fakeMessage({
    id: 'dm-m1',
    guild: null,
    member: null,
    channel,
    placeId: channel.id,
    cleanContent: 'γεια σου',
    ...overrides,
  });
}

/** A client of a served root the interface knows `members` and `fetchable` ones of; `fetchCalls` lists each member read. */
function fakeDmClient({
  members = ['u1', 'owner1'],
  fetchable = [],
}: { members?: Untyped; fetchable?: Array<Untyped> } = {}) {
  const fetchCalls: Array<Untyped> = [];
  return { user: { id: 'self1', username: 'Neptunia' }, fetchCalls, knows: [...members, ...fetchable] };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({
  profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } },
  privates = {},
}: { profiles?: Untyped; privates?: Record<string, Untyped> } = {}) {
  return {
    state: { data: {} },
    getUser: (accountId: string) => profiles[accountId] ?? null,
    getPrivate: (accountId: string) => privates[accountId] ?? null,
    // PR 7d: memory is code, so the real turn reads these of the store.
    getPlace: () => ({}),
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => Object.keys(profiles).length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}

function makeDmHandler({
  config,
  store,
  client,
  turns,
  memory,
  ...rest
}: { config?: Untyped; store?: Untyped; client?: Untyped; turns?: Untyped; memory?: Untyped; rest?: Untyped } = {}) {
  return makeHandler({
    config: config ?? privateConfig(),
    store: store ?? fakePrivateStore(),
    client: client ?? fakeDmClient(),
    turns: turns ?? recordingTurns(),
    memory: memory ?? fakeMemory(),
    prompts: { labels },
    now: () => TODAY_MS,
    ...rest,
  });
}

/** A DM queued while busy elsewhere; `change` runs before the drain. Returns what the drain did. */
async function drainAfter(change: Untyped, { privates = {} }: { privates?: Record<string, Untyped> } = {}) {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const profiles = { u1: { affinity: { score: 10 } } };
  const store = fakePrivateStore({ profiles, privates });
  const config = privateConfig();
  const channel = fakeDmChannel();
  const handler = makeDmHandler(wrongly({ turns, store, config, sleep: async () => {} }));
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.equal(turns.calls.length, 0, 'queued, not answered');

  change({ profiles, privates, config });
  busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  return { turns, store, channel, logs, handler };
}
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('private: every gate reason drops the DM without a turn or an observe', async () => {
    const cases = [
      { reason: 'off', config: baseConfig({ bot: { ownerPerson: OWNER_PERSON } }) },
      { reason: 'not-member', client: fakeDmClient({ members: [] }) },
      { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
      { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
    ];
    for (const { reason, ...deps } of cases) {
      freshWorld();
      const turns = recordingTurns();
      const memory = fakeMemory();
      const spontaneous = fakeSpontaneous();
      const handler = makeDmHandler(wrongly({ turns, memory, spontaneous, ...deps }));
      const message = fakeDmMessage();
      await handler(message);
      await settle();
      assert.equal(turns.calls.length, 0, `${reason}: no turn`);
      assert.equal(memory.observeCalls.length, 0, `${reason}: no observe`);
      assert.equal(spontaneous.onMessageCalls.length, 0, `${reason}: no eavesdrop`);
      assert.deepEqual(noticesOf(handler, 'dm1'), [], `${reason}: nothing sent`);
    }
  });

  test('private: a member missing from the cache is fetched; a fetched member passes', async () => {
    const client = fakeDmClient({ members: [], fetchable: ['u1'] });
    const turns = recordingTurns();
    const handler = makeDmHandler({ client, turns });
    await handler(fakeDmMessage());
    await settle();
    assert.deepEqual(client.fetchCalls, ['u1']);
    assert.equal(turns.calls.length, 1);
  });

  test('private: an unknown author or one below minAffinity never triggers a member fetch', async () => {
    const cases = [
      { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
      { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
    ];
    for (const { reason, store } of cases) {
      const client = fakeDmClient({ members: [], fetchable: ['u1'] });
      const turns = recordingTurns();
      const handler = makeDmHandler({ client, turns, store });
      const { logs } = await withCapturedLogs(async () => {
        await handler(fakeDmMessage());
        await settle();
      });
      assert.deepEqual(client.fetchCalls, [], `${reason}: no REST call`);
      assert.equal(turns.calls.length, 0, `${reason}: no turn`);
      assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, reason);
    }
  });

  test('private: an owner below minAffinity is still answered (owners bypass the threshold)', async () => {
    const turns = recordingTurns();
    const handler = makeDmHandler({ turns });
    await handler(fakeDmMessage({ author: { id: 'owner1', bot: false, globalName: 'Owner', username: 'owner' } }));
    await settle();
    assert.equal(turns.calls.length, 1);
  });

  test('private: a DM that passes is observed privately and answered with the pinned placeId', async () => {
    const store = fakePrivateStore();
    const turns = recordingTurns();
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const channel = fakeDmChannel();
    const handler = makeDmHandler(wrongly({ store, turns, memory, spontaneous }));

    await handler(fakeDmMessage({ channel }));
    await settle();

    assert.equal(memory.observeCalls.length, 1);
    // A DM has no root: it is observed under its own place.
    const firstObserveCall = memory.observeCalls[0];
    assert.notEqual(firstObserveCall[0], 'g1');
    assert.equal(firstObserveCall[1].content, 'γεια σου');
    assert.deepEqual(firstObserveCall[2], { direct: true, private: 'u1' });
    assert.equal(turns.calls.length, 1);
    const args = turns.calls[0];
    assert.deepEqual(args.chat, refTo(channel));
    // A private chat's turn names its chat alone: no home place is pinned on it.
    assert.equal('placeId' in args, false);
    assert.equal(args.mode, 'reply');
    assert.equal(args.triggerKind, 'private');
    assert.equal(args.trigger.id, 'dm-m1');
    assert.equal(spontaneous.onMessageCalls.length, 0);
    assert.deepEqual(noticesOf(handler, channel.id), []);
  });

  test('private: while busy elsewhere the DM is pending as "private"; the drain passes placeId', async () => {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const store = fakePrivateStore();
    const memory = fakeMemory();
    const channel = fakeDmChannel();
    // A private ping is never rolled for the ignore chance: an rng that would ignore any ping.
    const handler = makeDmHandler(wrongly({ turns, store, memory, sleep: async () => {}, rng: () => 0 }));

    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeDmMessage({ channel }));
      await settle();
    });
    const deferred = logs.find((l) => l.msg === 'mention: deferred');
    assert.ok(deferred);
    assert.equal(deferred.kind, 'private');
    assert.equal(turns.calls.length, 0);
    assert.equal(memory.observeCalls.length, 1, 'observed on arrival');

    busy = false;
    await handler.drainPending();

    assert.equal(turns.calls.length, 1);
    // A DM's turn names no root.
    assert.equal('placeId' in turns.calls[0], false);
    const firstCall = turns.calls[0];
    assert.equal(firstCall.triggerKind, 'private');
    assert.deepEqual(firstCall.chat, refTo(channel));
  });

  test('private: a queued DM whose author was forgotten meanwhile is dropped at drain time', async () => {
    const { turns, channel, logs, handler } = await drainAfter(({ profiles }: Record<string, Untyped>) => {
      delete profiles.u1; // /nep memory forget
    });
    assert.equal(turns.calls.length, 0);
    assert.deepEqual(noticesOf(handler, channel.id), []);
    assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'private: dropped')?.reason, 'unknown');
  });

  test('private: a queued DM is dropped at drain time when dm.enabled was switched off', async () => {
    const { turns, channel, logs, handler } = await drainAfter(({ config }: Record<string, Untyped>) => {
      config.dm.enabled = false;
    });
    assert.equal(turns.calls.length, 0);
    assert.deepEqual(noticesOf(handler, channel.id), []);
    assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'private: dropped')?.reason, 'off');
  });

  test('private: another bot in a DM is ignored', async () => {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const handler = makeDmHandler({ turns, memory });
    await handler(fakeDmMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } }));
    await settle();
    assert.equal(turns.calls.length, 0);
    assert.equal(memory.observeCalls.length, 0);
    assert.equal(turns.notePostCalls.length, 0);
  });
});

// On a raw install the first line of the owner's command line writes `bot.ownerPerson`, and the command line's account
// is the owner's first account. The retired `bot.owners` binds nobody and gives nobody the owner rights: another
// account becomes the owner's only by `/memory bind`. A stranger's direct message is a line like any other, never
// answered with a pairing phrase. The real core and the real `neptunia` command over fresh folders; synthetic ids only.

const configOf = (dirs: Dirs): { bot: { ownerPerson?: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson?: string };
  };

async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
  await until(() => typeof configOf(dirs).bot.ownerPerson === 'string', 'bot.ownerPerson written');
}

/** A direct message of `author` to the persona on the fake interface, in the chat `dm-<author>`. */
async function direct(unit: Unit, author: string, id: string, text: string): Promise<void> {
  const chat = `dm-${author}`;
  await unit.ask({ op: 'seed-chat', info: channelInfo(chat, { kind: 'dm', rootId: null, partnerId: author }) }, 'done');
  const line = lineEvent({ chatId: chat, id, text, at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    chat: { id: chat, kind: 'dm', rootId: null, partnerId: author, name: author },
  };
  await unit.emit(event);
}

test("a stranger's direct message is never answered with a pairing phrase, and no command opens pairing", async () => {
  // Pairing is gone. Catches: a direct message still screened for pairing and answered
  // with a phrase, or a pairing command still taken by the command line. Whether the persona answers a stranger at all is the
  // private gate's and the turn's matter (src/pipeline/private-gate.ts), so only the persona's own reply may reach that chat.
  await withRig({ config: { dm: { enabled: true } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await firstLine({ dirs, clis });
    for (const args of [
      ['-p', '/interfaces fake pair'],
      ['interfaces', 'fake', 'pair'],
      ['-p', '/interfaces pair open fake'],
    ])
      assert.equal((await runCli(dirs, args)).code, 2, args.join(' '));
    const member = {
      id: 'u9',
      name: 'Stranger',
      bot: false,
      groupIds: [],
      avatar: { hash: null, url: null, largeUrl: null },
    };
    await unit.ask({ op: 'seed-member', rootId: 'g1', member }, 'done');
    await direct(unit, 'u9', 'm1', 'hello, it is me');
    await identityOwnerRawInstallSettle(1000);
    const posted = await unit.posted('dm-u9');
    for (const text of posted) assert.equal(text, ANSWER, 'nothing but the reply of the persona reaches the chat');
  });
});

// The private gate and the pending queue with no root question in them (src/pipeline/private-gate.ts, drain.ts). A DM
// is checked by its author on its interface, and a queued DM runs in the chat it came from.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   createDrain's `checkPrivateGate(config, authorId, iface)`, `afterPrivateTurn(channel, trigger, result)`; no `getRootId`,
//   no `dmRootOf`
//   createPrivateGate returns `{ afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage }`
// Appendix entries: src/pipeline/drain.ts, src/pipeline/private-gate.ts, src/pipeline/types.ts.

test('the private gate offers no root question', () => {
  // Bug: `dmRootOf` survives beside the neutral path, so a caller reintroduces the owner's home-root fallback.
  const gate = createPrivateGate(
    wrongly<Parameters<typeof createPrivateGate>[0]>({
      hot: { config: { dm: { enabled: true } } },
      store: {},
    })
  );
  assert.equal('dmRootOf' in gate, false);
});
