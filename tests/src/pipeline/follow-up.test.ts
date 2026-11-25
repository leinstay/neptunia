import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannelWithHistory,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeStore,
  fakeTurns,
  makeHandler,
  mutableNow,
  openFollowUpWindow,
  scripted,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly, table, present } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { PermissionFlagsBits } from 'discord.js';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { refTo, seedExisting, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

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

const NOW = Date.parse('2026-11-05T12:00:00Z');
const SELF = 'self-id';
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
const [CHANNEL] = GROUP_SHAPES as [Shape, Shape, Shape];

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
function door(options: DoorOptions = {}) {
  const shapes = options.shapes ?? GROUP_SHAPES;
  const clock = { at: NOW };
  const fakes = new Map<string, ReturnType<typeof createFakeAdapter>>();
  const quiet = { info() {}, warn() {}, error() {} };
  const readsOf = new Map<string, ReturnType<typeof createReads>>();
  const adapterOf = (iface: string) => {
    let fake = fakes.get(iface);
    if (!fake) {
      fake = createFakeAdapter({ iface, selfId: SELF });
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
      selfId: () => SELF,
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
        author: { id: author, name: author === SELF ? 'Nova' : 'Eleni', self: author === SELF, bot: false },
        content: line.text ?? 'καλημέρα σε όλους',
        sourceText: line.text ?? 'καλημέρα σε όλους',
        system: false,
        at: clock.at,
        replyToId: line.replyToSelf ? 'm0' : null,
        replyPingAccountId: line.replyToSelf ? SELF : null,
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
        mentionedAccountIds: [...(line.mentioned ? [SELF] : []), ...(line.alsoMentions ?? [])],
        mentionedChatIds: [],
      },
    };
    await handler(wrongly<MessageReceived>(event));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { say, calls, started, facts, hot, clock, handler };
}

for (const shape of GROUP_SHAPES) {
  test(`a mention goes to the classifier at once and its yes starts a mention turn, in ${shape.label}`, async () => {
    // Bug: a flagged line skips the verdict and always opens a turn on one platform.
    const scene = door();
    await scene.say(shape, { mentioned: true });
    assert.equal(scene.calls.length, 1);
    const firstCall = scene.calls[0];
    assert.equal(firstCall?.options.purpose, 'address');
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['mention']
    );
  });
}

test('a reply to the persona goes to the classifier and its yes starts a reply turn', async () => {
  // Bug: the reply flag bypasses the verdict.
  const scene = door();
  await scene.say(CHANNEL, { replyToSelf: true });
  assert.equal(scene.calls.length, 1);
  assert.deepEqual(
    scene.started.map((turn) => turn.triggerKind),
    ['reply']
  );
});

test('a flagged line the classifier answers no to starts no turn', async () => {
  // Bug: a mention still forces a turn over the verdict.
  const scene = door({ answer: 'no' });
  await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.started.length, 0);
});

test('a flagged line the classifier answers overheard to starts an overheard turn', async () => {
  // Bug: the third verdict is dropped on the flagged path.
  const scene = door({ answer: 'overheard' });
  await scene.say(CHANNEL, { replyToSelf: true });
  assert.deepEqual(
    scene.started.map((turn) => turn.triggerKind),
    ['overheard']
  );
});

test('a mention of the persona that also mentions another member still reaches the classifier', async () => {
  // Bug: the pre-filter for other members' mentions answers no before the flagged line is asked about.
  const scene = door();
  await scene.say(CHANNEL, { mentioned: true, alsoMentions: ['u2'] });
  assert.equal(scene.calls.length, 1);
});

test('sixty calls of one member all get their verdict and their turn, and nothing is rolled', async () => {
  // Bug: the spam silence or the mention chance stays in front of the classifier.
  const scene = door({ maxTurnsPerAuthor: 1000 });
  for (let i = 0; i < 60; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 60);
  assert.equal(scene.started.length, 60);
});

// Plan 2026-11-04-cli-and-memory B1: `address.attentionMinutes` of the config these tests run under, and a run of `no`
// verdicts for the tests that show it no longer closes anything.
const FOLLOW_UP_MINUTES = 15;

/** A plain untagged message in channel c1 from `authorId`. */
function plainFollowUpMessage({
  id,
  guild,
  channel,
  content,
  authorId = 'u2',
  authorName = 'Bob',
  ts = Date.now(),
}: Record<string, Untyped>) {
  return fakeMessage({
    id,
    guild,
    channel,
    placeId: channel.id,
    cleanContent: content,
    createdTimestamp: ts,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName.toLowerCase() },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

// ---------------------------------------------------------------------------
// A follow-up "yes" that found the attention taken waits in the pending
// queue like a direct call, and is picked up when the running turn ends.

/**
 * Turns whose attention is taken in `busyIn` while `.busy` is true: runTurn records every call and
 * answers 'spoke'; busyChannels names the running turn's channel.
 */
function attentionTurns(busyIn = 'c9') {
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    isBusy: (id: string) => turns.busy && id === busyIn,
    isAnyBusy: () => turns.busy,
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return { outcome: 'spoke' };
    },
  });
  turns.busy = false;
  turns.busyChannels = () => (turns.busy ? [busyIn] : []);
  turns.calls = calls;
  return turns;
}

const FOLLOW_UP_T0 = 1_000_000;

/** The running turn ends and the drain runs (onIdle): resolves the drain's log lines. */
async function endTurnAndDrain(scene: Record<string, Untyped>) {
  scene.turns.busy = false;
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());
  return logs;
}

// ---------------------------------------------------------------------------
// The address classifier's third answer: "overheard", a line about the
// persona said to someone else or to the room (mention.followUpOverheard).

/** Opens a follow-up window in c1 and returns the pieces an overheard test needs. */
async function overheardScene({
  config,
  turns = recordingTurns(),
  tagHistory,
  channelOverrides,
  store,
  now,
}: {
  config?: Untyped;
  turns?: Untyped;
  tagHistory?: Untyped;
  channelOverrides?: Untyped;
  store?: Untyped;
  now?: Untyped;
} = {}) {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({
    config,
    turns,
    spontaneous,
    tagHistory,
    llm,
    store,
    now,
    prompts: fakeAddressPrompts(),
  });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, [], channelOverrides);
  await openFollowUpWindow(handler, { guild, channel, ts: (now ?? Date.now)() });
  return { llm, spontaneous, handler, guild, channel, turns };
}

/**
 * m1 is classified; m2 arrives meanwhile and is held (`held`: its content, every other key spread
 * onto the message). `beforeAnswer` runs right before m1's answer `first` comes back; the rest of
 * the options go to overheardScene. Resolves once that answer was settled.
 */
async function overheardWithHeld({
  first = 'overheard',
  held = { content: 'and you, what do you say?' },
  beforeAnswer,
  ...sceneOptions
}: { first?: string; held?: Untyped; beforeAnswer?: Untyped; [option: string]: Untyped } = {}) {
  const scene = await overheardScene(sceneOptions);
  const { llm, handler, guild, channel } = scene;
  const ts = (sceneOptions.now ?? Date.now)();
  const { content, ...heldExtra } = held;
  const captured = await withCapturedLogs(async () => {
    const p1 = handler(
      plainFollowUpMessage({
        id: 'm1',
        guild,
        channel,
        content: 'she always says that',
        authorId: 'u1',
        authorName: 'Élodie',
        ts,
      })
    );
    await tick();
    await handler({ ...plainFollowUpMessage({ id: 'm2', guild, channel, content, ts }), ...heldExtra });
    beforeAnswer?.();
    llm.respond(first);
    await p1;
    await tick();
  });
  return { ...scene, logs: captured.logs };
}

/** overheardWithHeld, then m3 arrives while m2's call is pending and is held in its turn. */
async function overheardChain(options = {}) {
  const scene = await overheardWithHeld(options);
  const { llm, handler, guild, channel } = scene;
  assert.equal(llm.calls.length, 2, 'm2 is being classified');
  const { logs } = await withCapturedLogs(() =>
    handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'μάλλον', authorId: 'u3', authorName: 'Chloé' }))
  );
  assert.deepEqual(heldLines(logs), ['m3'], 'm3 is held behind m2');
  return { ...scene, logs: [...scene.logs, ...logs] };
}

/** Answers every classifier call in flight with `text`, then lets the held messages move: the log lines it caused. */
async function answerFollowUp(llm: Record<string, Untyped>, text: string) {
  const { logs } = await withCapturedLogs(async () => {
    llm.respond(text);
    await tick();
  });
  return logs;
}

const heldLines = (logs: Array<Record<string, Untyped>>) =>
  logs.filter((l) => l.msg === 'follow-up: held while a classifier call is in flight').map((l) => l.message);
const heldDropped = (logs: Array<Record<string, Untyped>>) =>
  logs.filter((l) => l.msg === 'follow-up: held message dropped').map((l) => [l.message, l.reason]);
const followUpDropped = (logs: Array<Record<string, Untyped>>) =>
  logs.filter((l) => l.msg === 'follow-up: dropped').map((l) => [l.message, l.reason]);
const startedTurns = (turns: Record<string, Untyped>) =>
  turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]);

// The waiting overheard line starts after at least one more classifier call: the
// gate's checks that do not depend on the window are read again at that moment.
// [what the test calls it, the logged reason, () => ({ options for the scene, block() })]
const WAITING_LINE_BLOCKERS = table([
  [
    'the bot is paused',
    'paused',
    () => {
      const store = fakeStateStore();
      return {
        options: { store },
        block: (): boolean => {
          const { data } = store.state;
          return (data.paused = true);
        },
      };
    },
  ],
  [
    'the bot lost Send Messages',
    'cannot-send',
    () => {
      let sendAllowed = true;
      const permissionsFor = () => ({
        has: (flag: bigint) => sendAllowed || flag !== PermissionFlagsBits.SendMessages,
      });
      return {
        options: { channelOverrides: { permissionsFor } },
        block: () => {
          sendAllowed = false;
          world().channel({ id: 'c1', placeId: 'g1', name: null, permissions: { send: false } }, { keep: true });
        },
      };
    },
  ],
]);

// ---------------------------------------------------------------------------
// A follow-up candidate that arrives while a turn is already running is still
// classified (mention.classifyWhileBusy); a "yes" waits in the pending queue.

/**
 * A follow-up window opened in c1 at FOLLOW_UP_T0, then a turn already running in `busyIn` before
 * any candidate arrives. `send(id, content)` hands one plain line by u1 to the handler, a second
 * after the previous one, and returns the handler's promise.
 */
async function busyFollowUpScene({ busyIn = 'c9', config = baseConfig() }: { busyIn?: string; config?: Untyped } = {}) {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const turns = attentionTurns(busyIn);
  const handler = makeHandler({
    config,
    turns,
    llm,
    spontaneous,
    now: clock,
    sleep: async () => {},
    rng: () => 0.5,
    prompts: fakeAddressPrompts(),
  });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  turns.busy = true;
  let sent = 0;
  const send = (id: string, content = 'and then?') => {
    sent += 1;
    const ts = FOLLOW_UP_T0 + sent * 1000;
    clock.set(ts);
    seedExisting(channel.id, id);
    return handler(plainFollowUpMessage({ id, guild, channel, content, authorId: 'u1', authorName: 'Élodie', ts }));
  };
  return { clock, llm, spontaneous, turns, handler, guild, channel, send };
}

/** Sends `id` into a busy scene and answers its classifier call with `answer`: resolves the logs. */
async function busyCandidate(scene: Record<string, Untyped>, id: string, answer: Untyped) {
  const { logs } = await withCapturedLogs(async () => {
    const p = scene.send(id);
    await tick();
    scene.llm.respond(answer);
    await p;
    await tick();
  });
  return logs;
}

const deferredOf = (logs: Array<Record<string, Untyped>>) =>
  logs
    .filter((l) => l.msg === 'follow-up: deferred')
    .map(({ channel, message, runningIn, sameChannel }) => [channel, message, runningIn, sameChannel]);
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

  test('follow-up: a "yes" verdict runs a reply turn with the candidate as the target', async () => {
    const llm = fakeFollowUpLlm();
    let seenArgs: Untyped = null;
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        seenArgs = args;
        return { outcome: 'spoke' };
      },
    });
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg = fakeMessage({ id: 'm-candidate', guild, channel, placeId: 'c1', cleanContent: 'so what do you think' });
    const p = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('yes');
    await p;

    assert.ok(seenArgs, 'expected the reply turn to run');
    assert.equal(seenArgs.mode, 'reply');
    assert.equal(seenArgs.triggerKind, 'followUp');
    assert.equal(seenArgs.trigger.id, 'm-candidate', 'the candidate is the target, so replyTo works');
    assert.equal(seenArgs.trigger.content, 'so what do you think');
    assert.deepEqual(seenArgs.chat, refTo(channel));
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  // Plan 2026-11-04-cli-and-memory B1: a flagged line goes through the classifier too, so the expectation turned over.
  test('follow-up: a message that carries a trigger goes to the classifier, and its yes runs a turn of its own kind', async () => {
    const llm = fakeFollowUpLlm();
    let seenArgs: Untyped = null;
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        seenArgs = args;
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts(), rng: scripted([0.99]) });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'γεια',
      mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    });
    const pending = handler(msg);
    await tick();
    assert.equal(llm.calls.length, 1, 'the flagged line reaches the classifier');
    llm.respond('yes');
    await pending;
    assert.ok(seenArgs, 'the normal mention path still runs a turn');
    assert.equal(seenArgs.triggerKind, 'mention');
  });

  test('follow-up: at most one classifier call in flight per channel', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg1 = fakeMessage({
      id: 'm1',
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'first',
      author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    });
    const p1 = handler(msg1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(llm.calls.length, 1);

    const msg2 = fakeMessage({
      id: 'm2',
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'second',
      author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
    });
    await handler(msg2); // must not start a second classifier call while the first is in flight

    assert.equal(llm.calls.length, 1, 'the second message found a call already in flight for this channel');
    assert.equal(spontaneous.onMessageCalls.length, 0, 'left alone entirely, not handed to spontaneous either');

    llm.respond('no');
    await p1;
  });

  test('follow-up: a message arriving while a call is in flight is classified after a "no"', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const { logs } = await withCapturedLogs(async () => {
      const p1 = handler(
        plainFollowUpMessage({
          id: 'm1',
          guild,
          channel,
          content: 'forwarded picture',
          authorId: 'u1',
          authorName: 'Alice',
        })
      );
      await tick();
      assert.equal(llm.calls.length, 1);

      const handled = await handler(
        plainFollowUpMessage({ id: 'm2', guild, channel, content: 'what do you make of this' })
      );
      assert.equal(handled, undefined, 'onMessage itself returns nothing');
      assert.equal(llm.calls.length, 1, 'no second call while the first is in flight');

      llm.respond('no');
      await p1;
      await tick();

      assert.equal(llm.calls.length, 2, 'the held message is classified once the "no" came back');
      const secondCall = llm.calls[1];
      const secondMessage = secondCall.messages[1];
      const user = String(secondMessage.content);
      assert.match(user, /<candidate>[\s\S]*what do you make of this[\s\S]*<\/candidate>/);

      llm.respond('no');
      await tick();
    });

    assert.equal(spontaneous.onMessageCalls.length, 0, 'neither message is handed to the spontaneous scheduler');
    const verdicts = logs.filter((e) => e.msg === 'follow-up: verdict');
    assert.deepEqual(
      verdicts.map((e) => e.author),
      ['u1', 'u2'],
      'each classified message logs its own verdict'
    );
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes('what do you make of this'), 'no message content in the logs');
    assert.ok(!serialized.includes('forwarded picture'), 'no message content in the logs');
  });
});

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

  test('follow-up: a message held during the call is discarded after a "yes" (the turn reads it in the history)', async () => {
    const llm = fakeFollowUpLlm();
    const turnTargets: Array<Untyped> = [];
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        turnTargets.push(args.trigger.id);
        return { outcome: 'spoke' };
      },
    });
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p1 = handler(
      plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' })
    );
    await tick();
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));

    llm.respond('yes');
    await p1;
    await tick();

    assert.equal(llm.calls.length, 1, 'the held message is not classified after a "yes"');
    assert.deepEqual(turnTargets, ['m1'], 'one turn, for the message that got the "yes"');
    assert.equal(spontaneous.onMessageCalls.length, 0);

    // The slot is free again: the next plain message is classified as usual.
    const p3 = handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third' }));
    await tick();
    assert.equal(llm.calls.length, 2);
    llm.respond('no');
    await p3;
  });

  test('follow-up: only the latest of several messages held during one call is classified', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p1 = handler(
      plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' })
    );
    await tick();
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
    await handler(
      plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third', authorId: 'u3', authorName: 'Chloé' })
    );
    assert.equal(llm.calls.length, 1);

    llm.respond('no');
    await p1;
    await tick();

    assert.equal(llm.calls.length, 2, 'one follow-up call, not one per held message');
    const secondCall = llm.calls[1];
    const secondMessage = secondCall.messages[1];
    const user = String(secondMessage.content);
    assert.match(user, /<candidate>[\s\S]*third[\s\S]*<\/candidate>/);
    assert.doesNotMatch(user, /<candidate>[\s\S]*second[\s\S]*<\/candidate>/);

    llm.respond('no');
    await tick();
    await tick();
    assert.equal(llm.calls.length, 2, 'the replaced message is never classified');
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  test('follow-up: a held message is dropped when the window expired by the time the call ends', async () => {
    const clock = mutableNow(0);
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: clock() });

    const p1 = handler(
      plainFollowUpMessage({
        id: 'm1',
        guild,
        channel,
        content: 'first',
        authorId: 'u1',
        authorName: 'Alice',
        ts: clock(),
      })
    );
    await tick();
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second', ts: clock() }));

    clock.set((FOLLOW_UP_MINUTES + 1) * 60_000); // past the window
    llm.respond('no');
    await p1;
    await tick();

    assert.equal(llm.calls.length, 1, 'the window closed meanwhile: the held message is not classified');
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  test('follow-up: a held message is dropped when the bot was paused meanwhile, nothing marked dirty', async () => {
    const store = fakeStateStore();
    const llm = fakeFollowUpLlm();
    const handler = makeHandler({ store, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p1 = handler(
      plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' })
    );
    await tick();
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
    llm.respond('no');
    const { data } = store.state;
    data.paused = true;
    const dirtyBefore = store.dirtyCount;
    await p1;
    await tick();

    assert.equal(llm.calls.length, 1, 'paused: the held message is not classified');
    // Plan 2026-11-04-cli-and-memory B1: no verdict writes to the state any more.
    assert.equal(store.dirtyCount - dirtyBefore, 0, 'neither the in-flight "no" nor the held line wrote anything');
  });

  // ---------------------------------------------------------------------------
  // Audit fixes: the follow-up gate and one attention, the drain under a pause,
  // forwards, classifier failures, the drain re-checking switches, embed text.

  test('follow-up: with mention.oneAtATime off, a turn in another channel does not block the classifier', async () => {
    const llm = fakeFollowUpLlm();
    const config = baseConfig({ mention: { oneAtATime: false } });
    const turns = fakeTurns({ isBusy: () => false, isAnyBusy: () => true });
    const handler = makeHandler({ config, turns, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
    await tick();
    assert.equal(llm.calls.length, 1);
    llm.respond('no');
    await p;
  });
});

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

  test('follow-up: an "overheard" answer runs a reply turn with triggerKind overheard on the candidate', async () => {
    const { llm, spontaneous, handler, guild, channel, turns } = await overheardScene();

    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that' }));
    await tick();
    llm.respond('Overheard.');
    await p;

    assert.equal(turns.calls.length, 1);
    const firstCall = turns.calls[0];
    assert.equal(firstCall.mode, 'reply');
    assert.equal(firstCall.triggerKind, 'overheard');
    assert.equal(firstCall.trigger.id, 'm1');
    assert.deepEqual(firstCall.chat, refTo(channel));
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  test('follow-up: verdict logs the answer (yes, overheard, no) next to the two-way verdict', async () => {
    for (const [text, answer, verdict] of table([
      ['yes', 'yes', 'yes'],
      ['overheard', 'overheard', 'yes'],
      ['no', 'no', 'no'],
      ['about', 'no', 'no'],
    ])) {
      const { llm, handler, guild, channel } = await overheardScene();
      const { logs } = await withCapturedLogs(async () => {
        const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'λοιπόν' }));
        await tick();
        llm.respond(text);
        await p;
      });
      const line = logs.find((l) => l.msg === 'follow-up: verdict');
      assert.equal(present(line).answer, answer, text);
      assert.equal(present(line).verdict, verdict, text);
    }
  });

  test('follow-up: a pre-filtered or prompt-less "no" logs answer no too', async () => {
    const { handler, guild, channel } = await overheardScene();
    const { logs } = await withCapturedLogs(() =>
      handler(
        fakeMessage({
          guild,
          channel,
          placeId: 'c1',
          cleanContent: '@Bob look',
          mentions: { users: new Map([['u2', { id: 'u2' }]]) },
        })
      )
    );
    assert.equal(present(logs.find((l) => l.msg === 'follow-up: verdict')).answer, 'no');

    const spontaneous = fakeSpontaneous();
    const missing = makeHandler({
      spontaneous,
      llm: fakeFollowUpLlm(),
      prompts: { ...fakeAddressPrompts(), 'classify/address': undefined },
    });
    await openFollowUpWindow(missing, { guild, channel, ts: Date.now() });
    const second = await withCapturedLogs(() =>
      missing(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'λοιπόν' }))
    );
    assert.equal(present(second.logs.find((l) => l.msg === 'follow-up: verdict')).answer, 'no');
  });

  test('follow-up: a message held during an "overheard" call is classified before any turn; a "yes" on it starts the follow-up turn for it', async () => {
    const { llm, turns, logs } = await overheardWithHeld();

    assert.equal(turns.calls.length, 0, 'no turn before the held message is classified');
    assert.equal(llm.calls.length, 2);
    const secondCall = llm.calls[1];
    const secondMessage = secondCall.messages[1];
    assert.match(String(secondMessage.content), /<candidate>[\s\S]*and you, what do you say\?[\s\S]*<\/candidate>/);
    assert.equal(
      logs.some((l) => l.msg === 'follow-up: held message dropped'),
      false
    );

    const { logs: after } = await withCapturedLogs(async () => {
      llm.respond('yes');
      await tick();
    });
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]),
      [['m2', 'followUp']]
    );
    const dropped = after.find((l) => l.msg === 'follow-up: dropped');
    assert.deepEqual(
      [dropped?.message, dropped?.reason],
      ['m1', 'newer'],
      'the overheard line gives way to the newer one'
    );
  });

  test('follow-up: an "overheard" answer on the held message starts the overheard turn for that newer line', async () => {
    const { llm, turns } = await overheardWithHeld({ held: { content: 'yes, she does that' } });
    assert.equal(turns.calls.length, 0);
    llm.respond('overheard');
    await tick();
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]),
      [['m2', 'overheard']]
    );
  });

  test('follow-up: a "no" on the held message starts the overheard turn for the original candidate', async () => {
    const { llm, turns } = await overheardWithHeld({ held: { content: 'anyway, lunch?' } });
    assert.equal(turns.calls.length, 0);
    llm.respond('no');
    await tick();
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]),
      [['m1', 'overheard']]
    );
  });

  test('follow-up: a message the pre-filter answers "no" on arrival is never held: the overheard turn starts right away', async () => {
    const { llm, turns, logs } = await overheardWithHeld(
      wrongly({
        held: { content: '@Carol look', mentions: { users: new Map([['u3', { id: 'u3' }]]) } },
      })
    );
    assert.equal(llm.calls.length, 1, 'the pre-filter answers without the model');
    assert.deepEqual(heldLines(logs), [], 'answered before the in-flight check, nothing is held');
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]),
      [['m1', 'overheard']]
    );
  });

  for (const [when, reason, makeBlocker] of WAITING_LINE_BLOCKERS) {
    test(`follow-up: an overheard line waiting on a held message is dropped as ${reason} when ${when} meanwhile`, async () => {
      const { options, block } = makeBlocker();
      const { llm, turns } = await overheardWithHeld(options);
      assert.equal(llm.calls.length, 2, 'the held message is being classified');

      block();
      const logs = await answerFollowUp(llm, 'no');
      assert.equal(turns.calls.length, 0, 'no turn starts');
      assert.deepEqual(followUpDropped(logs), [['m1', reason]]);
    });

    test(`follow-up: when ${when}, the held message and the overheard line waiting on it are both dropped as ${reason}`, async () => {
      const { options, block } = makeBlocker();
      const { llm, turns, logs } = await overheardWithHeld({ ...options, beforeAnswer: block });
      assert.equal(llm.calls.length, 1, 'the held message is not classified');
      assert.equal(turns.calls.length, 0, 'no turn starts');
      assert.deepEqual(heldDropped(logs), [['m2', reason]]);
      assert.deepEqual(followUpDropped(logs), [['m1', reason]]);
    });
  }
});

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

  test('follow-up: a held message dropped because the window expired lets the overheard line waiting on it start', async () => {
    const clock = mutableNow(0);
    const { llm, turns, logs } = await overheardWithHeld(
      wrongly({ now: clock, beforeAnswer: () => clock.set(16 * 60_000) })
    );
    assert.equal(llm.calls.length, 1, 'the held message is not classified');
    assert.deepEqual(heldDropped(logs), [['m2', 'closed']]);
    assert.deepEqual(followUpDropped(logs), []);
    assert.deepEqual(
      startedTurns(turns),
      [['m1', 'overheard']],
      'classified while the window was open, it still gets its turn'
    );
  });

  test('follow-up: a message held while the held one is classified is classified too before the waiting overheard line starts', async () => {
    const { llm, turns, handler, guild, channel } = await overheardChain();

    await answerFollowUp(llm, 'no');
    assert.equal(llm.calls.length, 3, 'm3 is classified next');
    const thirdCall = llm.calls[2];
    const secondMessage = thirdCall.messages[1];
    assert.match(String(secondMessage.content), /<candidate>[\s\S]*μάλλον[\s\S]*<\/candidate>/);
    assert.equal(turns.calls.length, 0, 'm1 still waits');

    const logs = await answerFollowUp(llm, 'no');
    assert.deepEqual(startedTurns(turns), [['m1', 'overheard']]);
    assert.deepEqual(followUpDropped(logs), []);

    // The slot is free again: the next plain message is classified as usual.
    await withCapturedLogs(async () => {
      const p4 = handler(plainFollowUpMessage({ id: 'm4', guild, channel, content: 'λοιπόν' }));
      await tick();
      assert.equal(llm.calls.length, 4);
      llm.respond('no');
      await p4;
    });
  });

  for (const [answer, expected] of table([
    ['yes', [['m3', 'followUp']]],
    ['overheard', [['m3', 'overheard']]],
  ])) {
    test(`follow-up: a "${answer}" on the second held message drops the waiting overheard line as newer and starts that message's turn`, async () => {
      const { llm, turns } = await overheardChain();
      await answerFollowUp(llm, 'no');
      assert.equal(llm.calls.length, 3);

      const logs = await answerFollowUp(llm, answer);
      assert.deepEqual(startedTurns(turns), expected);
      assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
    });
  }

  test('follow-up: an "overheard" on a held message with a newer one held makes it the waiting line in place of the original', async () => {
    const { llm, turns } = await overheardChain();

    const logs = await answerFollowUp(llm, 'overheard');
    assert.equal(turns.calls.length, 0, 'm2 waits on m3');
    assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
    assert.equal(llm.calls.length, 3, 'm3 is classified next');

    await answerFollowUp(llm, 'no');
    assert.deepEqual(startedTurns(turns), [['m2', 'overheard']]);
  });

  test('follow-up: a candidate arriving during a turn in another channel is classified; a "yes" is deferred, then answered when the turn ends', async () => {
    const scene = await busyFollowUpScene();
    const logs = await busyCandidate(scene, 'm1', 'yes');
    const { calls } = scene.llm;
    assert.equal(calls.length, 1, 'the classifier is asked while the turn runs');
    const { calls: callsValue } = scene.turns;
    assert.equal(callsValue.length, 0, 'no turn while the attention is taken');
    const { onMessageCalls } = scene.spontaneous;
    assert.equal(onMessageCalls.length, 0, 'handled by the follow-up path');
    assert.deepEqual(deferredOf(logs), [['c1', 'm1', 'c9', false]]);

    const drain = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(drain), []);
    assert.deepEqual(
      drain.filter((l) => l.msg === 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]),
      [['followUp', 'respond', true]],
      'rolled once, when picked up'
    );
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
  });

  test('follow-up: a "no" on a candidate classified during a busy turn defers nothing and starts nothing', async () => {
    const scene = await busyFollowUpScene();
    const logs = await busyCandidate(scene, 'm1', 'no');
    assert.deepEqual(deferredOf(logs), []);
    assert.deepEqual(followUpDropped(logs), []);
    assert.deepEqual(
      logs.filter((l) => l.msg === 'follow-up: verdict').map((l) => [l.author, l.answer]),
      [['u1', 'no']]
    );
    const { onMessageCalls } = scene.spontaneous;
    assert.equal(onMessageCalls.length, 0);
    await endTurnAndDrain(scene);
    const { calls } = scene.turns;
    assert.equal(calls.length, 0);
  });

  test('follow-up: a burst of three candidates during one busy turn costs one classifier call at a time; the newest held one wins', async () => {
    const scene = await busyFollowUpScene();
    const { logs } = await withCapturedLogs(async () => {
      const p1 = scene.send('m1', 'first');
      await tick();
      await scene.send('m2', 'second');
      await scene.send('m3', 'third');
      const { calls } = scene.llm;
      assert.equal(calls.length, 1, 'the two later lines are held, not classified');

      scene.llm.respond('yes');
      await p1;
      await tick();
      const { calls: callsValue } = scene.llm;
      assert.equal(callsValue.length, 2, 'the newest held line is classified next');
      const { messages } = callsValue[1];
      assert.match(messages[1].content, /<candidate>[\s\S]*third[\s\S]*<\/candidate>/);

      scene.llm.respond('yes');
      await tick();
      await tick();
    });
    const { calls } = scene.llm;
    assert.equal(calls.length, 2, 'the replaced line is never classified');
    assert.deepEqual(
      logs
        .filter((l) => l.msg === 'follow-up: held while a classifier call is in flight')
        .map((l) => [l.message, l.replaced]),
      [
        ['m2', false],
        ['m3', true],
      ]
    );
    assert.deepEqual(
      deferredOf(logs).map((row) => row[1]),
      ['m1', 'm3']
    );
    assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
    const { calls: callsValue } = scene.turns;
    assert.equal(callsValue.length, 0);

    await endTurnAndDrain(scene);
    assert.deepEqual(startedTurns(scene.turns), [['m3', 'followUp']]);
  });
});
