import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannelWithHistory,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  openFollowUpWindow,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
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

test('the per-author rail still bounds the turns an alias line starts', async () => {
  // Bug: the alias path starts its turn beside the rail.
  const scene = door({ maxTurnsPerAuthor: 1 });
  await scene.say(GROUP, 'Zefira, one');
  await scene.say(GROUP, 'Zefira, two');
  assert.equal(scene.calls.length, 2);
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

test('the per-author rail refuses the turn past its limit, after the verdict', async () => {
  // Bug: the rail counts calls instead of started turns, or a flagged line stops reaching the classifier.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 2 });
  for (let i = 0; i < 3; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 3);
  assert.equal(scene.started.length, 2);
});

test('the per-author refusal is logged by count, without the line', async () => {
  // Bug: the refusal is silent, or the log carries message text.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1 });
  const { logs } = await withCapturedLogs(async () => {
    await scene.say(CHANNEL, { mentioned: true, text: 'πρώτη κλήση' });
    await scene.say(CHANNEL, { mentioned: true, text: 'δεύτερη κλήση' });
  });
  const refused = logs.filter((entry) => entry.msg === 'address: refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.turns, 1);
  assert.equal(refused[0]?.limit, 1);
  assert.equal(JSON.stringify(refused[0]).includes('δεύτερη κλήση'), false);
});

test('a no verdict does not count toward the per-author rail', async () => {
  // Bug: the rail counts verdicts of any kind, so a chatty member is refused after lines the persona never answered.
  const verdicts = ['no', 'no', 'no', 'yes'];
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1, answer: () => verdicts.shift() ?? 'no' });
  for (let i = 0; i < 4; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 1);
});

test('an overheard turn counts toward the per-author rail', async () => {
  // Bug: only yes is counted, so talk about the persona starts turns without a bound.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1, answer: 'overheard' });
  for (let i = 0; i < 2; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 1);
});

test('the per-author rail counts each author on their own', async () => {
  // Bug: the count is per place, so one member's turns silence another.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1 });
  await scene.say(CHANNEL, { mentioned: true, author: 'u1' });
  await scene.say(CHANNEL, { mentioned: true, author: 'u2' });
  assert.equal(scene.started.length, 2);
});

test('the per-author rail counts each place on its own', async () => {
  // Bug: the count is per author across places, so a member's talk elsewhere silences them here.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1, shapes: [CHANNEL, ROOT_GROUP] });
  await scene.say(CHANNEL, { mentioned: true });
  await scene.say(ROOT_GROUP, { mentioned: true });
  assert.equal(scene.started.length, 2);
});

test('the per-author rail forgets a turn once its window has passed', async () => {
  // Bug: the count never decays, so a member is refused for good.
  const scene = doorAddressDoor({ maxTurnsPerAuthor: 1, attentionMinutes: 10 });
  await scene.say(CHANNEL, { mentioned: true });
  scene.clock.at += 10 * MINUTE;
  await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 2);
});

/** tagHistory that counts its hits, to prove a deferred ping is not counted on arrival. */
function countingTagHistory() {
  const inner = createTagHistory();
  const tags = {
    hits: 0,
    count: (...args: Parameters<typeof inner.count>) => inner.count(...args),
    hit: (...args: Parameters<typeof inner.hit>) => ((tags.hits += 1), inner.hit(...args)),
  };
  return tags;
}

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

  // Plan 2026-11-04-cli-and-memory B1: nothing is rolled any more, and an overheard turn passes the per-author rail.
  test('follow-up: an "overheard" answer passes the per-author rail and starts its turn', async () => {
    const config = baseConfig();
    const { llm, handler, guild, channel, turns } = await overheardScene({ config });
    const { logs } = await withCapturedLogs(async () => {
      const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that' }));
      await tick();
      llm.respond('overheard');
      await p;
    });
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => c.triggerKind),
      ['overheard']
    );
    assert.deepEqual(
      logs.filter((l) => l.msg === 'mention: decided').map((l) => [l.kind, l.reason]),
      [['overheard', 'respond']]
    );
  });

  // Plan 2026-11-04-cli-and-memory B1: an overheard turn counts toward the per-author rail like a yes.
  test('follow-up: an "overheard" answer counts toward tagHistory like a "yes"', async () => {
    const tagHistory = countingTagHistory();
    const { llm, handler, guild, channel, turns } = await overheardScene({ tagHistory });

    for (let i = 0; i < 3; i += 1) {
      const p = handler(plainFollowUpMessage({ id: `m${i}`, guild, channel, content: `she ${i}` }));
      await tick();
      llm.respond('overheard');
      await p;
    }
    assert.equal(turns.calls.length, 3);
    assert.equal(tagHistory.hits, 3, 'each started turn is counted');

    const p4 = handler(plainFollowUpMessage({ id: 'm4', guild, channel, content: 'and you?' }));
    await tick();
    assert.equal(llm.calls.length, 4, 'three overheard answers in a row keep the window open');
    llm.respond('yes');
    await p4;
    assert.equal(tagHistory.hits, 4, 'a "yes" is still counted');
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => c.triggerKind),
      ['overheard', 'overheard', 'overheard', 'followUp']
    );
  });
});
