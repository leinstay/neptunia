import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannelWithHistory,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeStore,
  makeHandler,
  mutableNow,
  openFollowUpWindow,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

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

test('a line that names the persona by an alias, with no ping and no recent post, reaches the classifier once', async () => {
  // Bug: without the old trigger list, a call by name never reaches the persona unless the persona wrote there recently.
  const scene = door();
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.deepEqual(
    scene.calls.map((call) => call.purpose),
    ['address']
  );
});

test('a yes to an alias line starts a turn', async () => {
  // Bug: the alias gate asks the classifier and drops its answer.
  const scene = door({ answer: 'yes' });
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.equal(scene.started.length, 1);
});

test('a no to an alias line starts nothing', async () => {
  // Bug: the alias fires the turn by itself, as the old name trigger did, whatever the classifier says.
  const scene = door({ answer: 'no' });
  await scene.say(GROUP, 'Zefira is a nice name for a cat');
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.started.length, 0);
});

test('a line with no alias, no flag and no recent post of the persona never reaches the classifier', async () => {
  // Bug: the gate fires on any line, so every quiet message pays for a classifier call.
  const scene = door();
  await scene.say(GROUP, 'καλημέρα σε όλους');
  assert.equal(scene.calls.length, 0);
});

test('a person record with no names adds no gate', async () => {
  // Bug: a fallback name list stands in when the card has none.
  const scene = door({ names: [] });
  await scene.say(GROUP, 'Zefira, are you there?');
  assert.equal(scene.calls.length, 0);
});

test('the alias gate is logged by its name, without the line', async () => {
  // Bug: nobody can tell which gate pays for the classifier, or the log carries what the persona was called.
  const scene = door({ answer: 'no' });
  const { logs } = await withCapturedLogs(() => scene.say(GROUP, 'Zefira, το μυστικό μας'));
  const gated = logs.filter((entry) => entry.gate === 'alias');
  assert.equal(gated.length, 1);
  assert.equal(JSON.stringify(logs).includes('μυστικό'), false);
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
const MINUTE = 60_000;
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
const [CHANNEL, ROOT_GROUP] = GROUP_SHAPES as [Shape, Shape, Shape];

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

for (const shape of GROUP_SHAPES) {
  test(`a line with no flag and no recent post of the persona never reaches the classifier, in ${shape.label}`, async () => {
    // Bug: a name trigger or the old window opens the door by a word match.
    const scene = doorAddressDoor({ nameTriggers: ['Nova'], rng: () => 0 });
    await scene.say(shape, { text: 'η Nova είπε κάτι χθες' });
    assert.equal(scene.calls.length, 0);
    assert.equal(scene.started.length, 0);
  });

  test(`a line with no flag goes to the classifier while the persona wrote there recently, in ${shape.label}`, async () => {
    // Bug: the attention window is wired for only some kinds of place.
    const scene = doorAddressDoor({ attentionMinutes: 60 });
    await scene.say(shape, { author: DOOR_ADDRESS_SELF });
    scene.clock.at += 45 * MINUTE;
    await scene.say(shape);
    assert.equal(scene.calls.length, 1);
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['followUp']
    );
  });
}

test('a line at the edge of the attention window is outside it', async () => {
  // Bug: an off-by-one opens the classifier for a minute more than the setting says.
  const scene = doorAddressDoor({ attentionMinutes: 5 });
  await scene.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  scene.clock.at += 5 * MINUTE - 1;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
  scene.clock.at += 1;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
});

test('the attention window is read at the moment of use', async () => {
  // Bug: the setting is cached when the handler is built.
  const scene = doorAddressDoor({ attentionMinutes: 5 });
  await scene.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  scene.clock.at += 20 * MINUTE;
  const { config } = scene.hot;
  (config.address as { attentionMinutes: number }).attentionMinutes = 60;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
});

test('a post of the persona opens attention only in its own place', async () => {
  // Bug: attention is global, so one post makes every place pay for the classifier.
  const scene = doorAddressDoor({ shapes: [CHANNEL, ROOT_GROUP] });
  await scene.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  await scene.say(ROOT_GROUP);
  assert.equal(scene.calls.length, 0);
});

test('a post of the persona opens attention only on its own interface when two interfaces share a native id', async () => {
  // Bug: the window is keyed by the native id alone, so a collision opens another interface's place.
  const other: Shape = {
    label: 'the same id elsewhere',
    iface: 'beta',
    place: { id: 'c1', kind: 'channel', rootId: 'g1' },
  };
  const scene = doorAddressDoor({ shapes: [CHANNEL, other] });
  await scene.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  await scene.say(other);
  assert.equal(scene.calls.length, 0);
});

test('a run of no verdicts does not close attention', async () => {
  // Bug: the follow-up window's no-streak survives and silences a place while the persona is still recent there.
  const scene = doorAddressDoor({ answer: 'no' });
  await scene.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  for (let i = 0; i < 8; i += 1) await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 8);
});

test('attention survives a restart of the handler', async () => {
  // Bug: the window lives only in memory, so a restart makes the persona deaf to the talk the persona just joined.
  const storeState = { data: {}, markDirty() {} };
  const before = doorAddressDoor({ storeState });
  await before.say(CHANNEL, { author: DOOR_ADDRESS_SELF });
  const after = doorAddressDoor({ storeState });
  await after.say(CHANNEL);
  assert.equal(after.calls.length, 1);
});

// Plan 2026-11-04-cli-and-memory B1: `address.attentionMinutes` of the config these tests run under, and a run of `no`
// verdicts for the tests that show it no longer closes anything.
const FOLLOW_UP_MINUTES = 15;

// ---------------------------------------------------------------------------
// Follow-up windows survive a restart: mirrored into store.state.data.followUpWindows.

/** A fakeStore with a real-shaped `state` ({ data, markDirty }) that counts markDirty calls. */
/** The follow-up windows a store's state holds, by channel. */
const windowsOf = (store: { state: { data: Record<string, Untyped> } }) => {
  const { data } = store.state;
  return wrongly<Record<string, number>>(data.addressAttention);
};
/** A place's key in the saved attention. */
const attentionKey = (placeId: string) => JSON.stringify(['fake', placeId]);

function fakeStateStore(data: Record<string, Untyped> = {}) {
  const base = fakeStore();
  const store = Object.assign(base, {
    dirtyCount: 0,
    state: {
      data,
      markDirty() {
        store.dirtyCount += 1;
      },
    },
  });
  return store;
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

  test('follow-up: the window opens on send and expires after followUpMinutes', async () => {
    const clock = mutableNow(0);
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: clock() });

    const msg1 = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'plain follow-up',
      createdTimestamp: clock(),
    });
    const p1 = handler(msg1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(llm.calls.length, 1, 'inside the window, a plain message reaches the classifier');
    llm.respond('no');
    await p1;

    clock.set((FOLLOW_UP_MINUTES + 1) * 60_000); // past the window
    const msg2 = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'too late',
      createdTimestamp: clock(),
      author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
    });
    await handler(msg2);

    assert.equal(llm.calls.length, 1, 'once the window expired, the classifier is not consulted again');
  });

  test('follow-up persistence: an open window survives a re-created handler with the same state', async () => {
    const clock = mutableNow(10_000);
    const store = fakeStateStore();
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    const first = makeHandler({ store, now: clock, llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });
    await openFollowUpWindow(first, { guild, channel, ts: clock() });

    // Plan 2026-11-04-cli-and-memory B1: attention keeps one time per place, by interface and native id.
    const { data } = store.state;
    assert.deepEqual(data.addressAttention, { [attentionKey('c1')]: 10_000 });
    assert.ok(store.dirtyCount > 0, 'opening a window marks the state dirty');

    clock.set(40_000); // "restart" half a minute later, well inside followUpMinutes=15
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const second = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
    const msg = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'plain follow-up',
      createdTimestamp: clock(),
    });
    const p = second(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(llm.calls.length, 1, 'the restored window sends the untagged message to the classifier');
    llm.respond('no');
    await p;

    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  test('follow-up persistence: an expired window is dropped on load', async () => {
    const store = fakeStateStore({
      addressAttention: { [attentionKey('old')]: 0, [attentionKey('fresh')]: 950_000 },
    });
    const clock = mutableNow(960_000); // 16 min: past followUpMinutes=15 for "old", 10 s for "fresh"
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

    assert.deepEqual(Object.keys(windowsOf(store)), [attentionKey('fresh')], 'the expired key is deleted from state');
    assert.ok(store.dirtyCount > 0);

    const guild = fakeGuild();
    const oldChannel = fakeChannelWithHistory('old', guild, []);
    await handler(
      fakeMessage({ guild, channel: oldChannel, placeId: 'old', cleanContent: 'plain', createdTimestamp: clock() })
    );
    assert.equal(llm.calls.length, 0, 'the dropped window is not consulted');
  });

  test('follow-up persistence: no message text ever reaches the state', async () => {
    const clock = mutableNow(0);
    const store = fakeStateStore();
    const llm = fakeFollowUpLlm();
    const handler = makeHandler({ store, now: clock, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: clock() });
    const p = handler(
      fakeMessage({ guild, channel, placeId: 'c1', cleanContent: 'ένα μυστικό μήνυμα', createdTimestamp: clock() })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;

    for (const value of Object.values(windowsOf(store))) assert.equal(typeof value, 'number');
    const json = JSON.stringify(store.state.data);
    assert.ok(
      !json.includes('μυστικό') && !json.includes('here you go'),
      "neither the member's nor the persona's text is stored"
    );
  });

  test('follow-up persistence: while paused an expired window stays in state and nothing is marked dirty', () => {
    const store = fakeStateStore({
      paused: true,
      addressAttention: { [attentionKey('old')]: 0, [attentionKey('fresh')]: 950_000 },
    });
    makeHandler({ store, now: mutableNow(960_000), llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });

    assert.deepEqual(Object.keys(windowsOf(store)).sort(), [attentionKey('fresh'), attentionKey('old')]);
    assert.equal(store.dirtyCount, 0);
  });
});
