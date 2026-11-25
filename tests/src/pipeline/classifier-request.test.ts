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
  fakeClient,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeStore,
  makeHandler,
  openFollowUpWindow,
  rawHistoryMessage,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { roleModel } from '../../../src/llm/roles.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { MediaName } from '../../../src/memory/store-media-names.ts';
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

// Aliases live in the persona's person record: they come from `selfNames`, the names given to `person:self`.
test('the names of the person record of the persona reach the classifier as an aliases block', async () => {
  // Bug: the engine still holds its own list, so a nickname from the card is unknown to the verdict.
  const scene = door({ selfNames: ['Νόβα', 'Novita'], nameTriggers: ['Ενγκίνε'] });
  await scene.say(CHANNEL, { mentioned: true });
  const firstCall = scene.calls[0];
  const aliases = /<aliases>\n([\s\S]*?)\n<\/aliases>/.exec(JSON.parse(firstCall?.user ?? '""') as string)?.[1];
  assert.deepEqual(aliases?.split('\n'), ['Νόβα', 'Novita']);
});

test('a person record with no names adds no block, and no configured trigger stands in for it', async () => {
  // Bug: `bot.nameTriggers` keeps feeding the request as a hidden name list.
  const scene = door({ selfNames: [], nameTriggers: ['Ενγκίνε'] });
  await scene.say(CHANNEL, { mentioned: true });
  const firstCall = scene.calls[0];
  const user = firstCall?.user ?? '';
  assert.equal(user.includes('<aliases>'), false);
  assert.equal(user.includes('Ενγκίνε'), false);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// The address classifier sees media captions the describer already cached:
// a sticker- or picture-only answer is not a bare `[sticker: name]`.

/** A describer fake with the cache-only accessor; `describeMany` (the prefill) waits on `gate` when given. */
function fakeCachingDescriber(cached = new Map(), { gate }: { gate?: Untyped } = {}) {
  const calls: Array<Untyped> = [];
  const cachedCalls: Array<Untyped> = [];
  return {
    calls,
    cachedCalls,
    describeMany: async (placeId: string, items: Array<Record<string, Untyped>>) => {
      calls.push({ placeId, items });
      if (gate) await gate;
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (placeId: string, items: Array<Record<string, Untyped>>) => {
      cachedCalls.push({ placeId, items });
      return new Map(
        items.filter((item) => cached.has(item.itemId)).map((item) => [item.itemId, cached.get(item.itemId)])
      );
    },
  };
}

function stickerOnlyMessage({ guild, channel, id = 'm-sticker' }: Record<string, Untyped>) {
  return fakeMessage({
    id,
    guild,
    channel,
    placeId: channel.id,
    cleanContent: '',
    stickers: new Map([['s1', { id: 's1', name: 's7', format: 1 }]]),
  });
}

// An emoji's and a sticker's description stands in the legend, the line holds the stable name.
// The candidate's sticker `s7` (platform name `pingo`) is named by the store, and its caption stands in the legend.
const PINGO: MediaName = {
  name: 's7',
  kind: 'sticker',
  iface: 'discord',
  nativeId: 's1',
  platformName: 'pingo',
  animated: false,
};
const namingStore = () => ({
  ...fakeStore(),
  mediaNameOf: (name: string): MediaName | null => (name === 's7' ? PINGO : null),
});
const legendPrompts = (): Record<string, Untyped> => ({
  ...fakeAddressPrompts(),
  labels: {
    ...labels,
    legend: {
      line: '{name} [{platformName}] {text}',
      lineNoText: '{name} [{platformName}] undescribed',
      unreadable: '{name} unseen',
    },
  },
});
// The candidate's transcript opens with its legend, then its one line.
// The block of custom emoji and stickers is <media>.
const CANDIDATE_LINE = /<candidate>\n<media>\n[\s\S]*<\/media>\n[^\n]*\[sticker s7\]\n<\/candidate>/;

// ---------------------------------------------------------------------------
// The address classifier -- the <author> block: who the candidate's author is
// known as (stored aliases, ranked, capped by mention.followUpAliases), so the
// classifier can connect a nickname in the persona's line to the member.

/** A stored profile whose aliases rank in the listed order (equal dates: rank follows weight). */
function profileWithAliases(id: string, names: Record<string, Untyped>) {
  const seen = '2026-01-01T00:00:00.000Z';
  return {
    id,
    names: ['Ελένη'],
    aliases: names.map((name: string, i: number) => ({
      name,
      weight: names.length - i,
      firstSeen: seen,
      lastSeen: seen,
    })),
  };
}

/** The `<author>` line as `labels.address.author` renders it. */
function authorLine(name: string, aliases: string) {
  const { author } = labels.address;
  return author.replace('{name}', name).replace('{aliases}', aliases);
}

/** Runs one candidate from `authorId` through an open window; resolves to the classifier's user message. */
async function classifierUserMessage({
  store,
  config,
  prompts = fakeAddressPrompts(),
  authorId = 'u7',
  authorName = 'Ελένη',
}: Record<string, Untyped>) {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts, store, config });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const history: Array<Untyped> = [
    rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' }),
  ];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });
  const msg = fakeMessage({
    id: 'm-candidate',
    guild,
    channel,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: 'el' },
    member: { displayName: authorName },
    cleanContent: 'and you too',
    createdTimestamp: t0 + 2000,
  });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the classifier was asked');
  const firstCall = llm.calls[0];
  const secondMessage = firstCall.messages[1];
  const user = String(secondMessage.content);
  llm.respond('no');
  await p;
  return user;
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

  // ---------------------------------------------------------------------------
  // The address classifier (features.followUp) -- an untagged follow-up
  // message inside a window the persona opened by answering is checked by
  // classify/address.md before it is (or is not) answered.

  test('follow-up: the classifier request is classify/address.md as system and a <candidate> block in the user message', async () => {
    const llm = fakeFollowUpLlm();
    const config = baseConfig();
    const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild('g1', 'Neptunia');
    const t0 = Date.now();
    const history: Array<Untyped> = [
      rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' }),
    ];
    const channel = fakeChannelWithHistory('c1', guild, history);
    await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

    const msg = fakeMessage({
      id: 'm-candidate',
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'is this for you',
      createdTimestamp: t0 + 2000,
    });
    const p = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(llm.calls.length, 1);
    const [{ messages, options }] = llm.calls;
    assert.equal(messages[0].role, 'system');
    const { content } = messages[0];
    assert.ok(content.includes('Neptunia'), 'the {{name}} placeholder is filled');
    assert.equal(messages[1].role, 'user');
    const { content: contentValue } = messages[1];
    assert.ok(contentValue.includes('<candidate>'));
    const { content: contentValue3 } = messages[1];
    assert.ok(contentValue3.includes('is this for you'));
    const { content: contentValue4 } = messages[1];
    assert.ok(contentValue4.includes('earlier message'), 'the channel context is included');
    assert.equal(options.maxOutputTokens, config.mention.followUpMaxOutputTokens, 'mention.followUpMaxOutputTokens');
    assert.equal(options.model, roleModel(config, 'analyzer'), "the analyzer chain's model");
    assert.equal(options.role, 'analyzer', 'routed as the analyzer');
    assert.equal(options.countAgainstDailyCap, true);
    assert.equal(options.skipCalibration, true);
    assert.equal(
      options.timeoutMs,
      config.llm.analyzerTimeoutMs,
      'llm.analyzerTimeoutMs, never the turn-length llm.timeoutMs'
    );
    assert.equal(options.purpose, 'address', 'named on the usage line');
    assert.equal(options.isRoleRequest, true, 'spelled by roleRequestOptions, so llm.hedge applies');
    assert.equal('long' in options, false, 'a one-word answer: the short hedge limit');

    llm.respond('no');
    await p;
  });

  test('follow-up: the classifier system prompt carries the bare display name, no braces around it', async () => {
    const llm = fakeFollowUpLlm();
    const guild = fakeGuild('g1', 'Nepτune');
    // The served guild's own member name (the default getSelfName reads the client's guild cache).
    const client = { ...fakeClient(), guilds: { cache: new Map([['g1', guild]]) } };
    const handler = makeHandler({ llm, client, prompts: fakeAddressPrompts() });
    const t0 = Date.now();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

    const msg = fakeMessage({
      id: 'm-candidate',
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'is this for you',
      createdTimestamp: t0 + 2000,
    });
    const p = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const firstMessage = firstCall.messages[0];
    const system = firstMessage.content;
    assert.ok(system.startsWith('You are Nepτune. '), 'the {{name}} placeholder is replaced whole');
    assert.ok(!system.includes('{') && !system.includes('}'), 'no brace is left around the name');

    llm.respond('no');
    await p;
  });

  test('follow-up: a missing prompts["classify/address"] is a "no" without calling the model', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const prompts = { ...fakeAddressPrompts(), 'classify/address': undefined };
    const handler = makeHandler({ spontaneous, llm, prompts });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg = fakeMessage({ guild, channel, placeId: 'c1', cleanContent: 'plain follow-up' });
    await handler(msg);

    assert.equal(llm.calls.length, 0);
    assert.equal(spontaneous.onMessageCalls.length, 0, 'still handled (as a no), not handed to spontaneous');
  });

  test('follow-up: a sticker-only candidate with a cached caption reaches the classifier with the caption', async () => {
    const llm = fakeFollowUpLlm();
    const describer = fakeCachingDescriber(new Map([['sticker:s1', 'a penguin waving hello']]));
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, llm, describer, prompts: legendPrompts(), store: namingStore() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p = handler(stickerOnlyMessage({ guild, channel }));
    await tick();

    assert.equal(llm.calls.length, 1, 'only the classifier call; the cache read makes none');
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    const user = String(secondMessage.content);
    assert.match(user, CANDIDATE_LINE);
    assert.ok(user.includes('s7 [pingo] a penguin waving hello'), user);
    assert.equal(describer.cachedCalls.length, 1);
    const firstCachedCall = describer.cachedCalls[0];
    assert.equal(firstCachedCall.placeId, 'g1');
    assert.ok(firstCachedCall.items.some((item: Record<string, Untyped>) => item.itemId === 'sticker:s1'));

    llm.respond('no');
    await p;
  });

  test('follow-up: a sticker-only candidate with no cached caption has the legend line of no description', async () => {
    const llm = fakeFollowUpLlm();
    const describer = fakeCachingDescriber();
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, llm, describer, prompts: legendPrompts(), store: namingStore() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p = handler(stickerOnlyMessage({ guild, channel }));
    await tick();

    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    const user = String(secondMessage.content);
    assert.match(user, CANDIDATE_LINE);
    assert.ok(user.includes('s7 [pingo] undescribed'), user);

    llm.respond('no');
    await p;
  });

  test('follow-up author: the request carries an <author> block with the top-ranked aliases, capped at mention.followUpAliases', async () => {
    const aliases = ['Λένα', 'Ελενάκι', 'Nélé', 'Lèna', 'Hélène', 'Éli', 'Nènè'];
    const store = fakeStore({ u7: profileWithAliases('u7', aliases) });
    const user = await classifierUserMessage({ store });

    const line = authorLine('Ελένη', 'Λένα, Ελενάκι, Nélé, Lèna, Hélène');
    assert.ok(user.includes(`<author>\n${line}\n</author>`), 'the default followUpAliases (5), best rank first');
    assert.ok(!user.includes('Éli') && !user.includes('Nènè'), 'aliases past the cap are left out');
    const authorAt = user.indexOf('<author>');
    assert.ok(authorAt > user.indexOf('earlier message'), 'after the transcript');
    assert.ok(authorAt < user.indexOf('<candidate>'), 'before the candidate');
    assert.deepEqual(store.getUserCalls, [['u7']], 'the candidate author profile, read once');
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

  test('follow-up author: ranking decays with memory.aliasHalfLifeDays, like the persona request', async () => {
    const profile = {
      id: 'u7',
      names: ['Ελένη'],
      aliases: [
        { name: 'Λένα', weight: 2, firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2020-01-01T00:00:00.000Z' },
        { name: 'Nélé', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const user = await classifierUserMessage({ store: fakeStore({ u7: profile }) });
    assert.ok(user.includes(authorLine('Ελένη', 'Nélé, Λένα')), 'the recent alias outranks the old heavier one');
  });

  test('follow-up author: a profile without aliases, or no stored profile, adds no <author> block', async () => {
    const cases = [
      { label: 'a profile without aliases', profiles: { u7: { id: 'u7', names: ['Ελένη'], aliases: [] } } },
      { label: 'no stored profile', profiles: {} },
    ];
    for (const { label, profiles } of cases) {
      const store = fakeStore(profiles);
      const user = await classifierUserMessage({ store });
      assert.ok(!user.includes('<author>'), `${label}: no <author> block`);
      assert.ok(user.includes('<candidate>') && user.includes('and you too'), `${label}: the candidate is still sent`);
      assert.deepEqual(store.getUserCalls, [['u7']], `${label}: the candidate author's profile, read once`);
    }
  });

  test('follow-up author: without labels.address.author the block is omitted', async () => {
    const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα']) });
    const prompts = { ...fakeAddressPrompts(), labels: { ...labels, address: undefined } };
    const user = await classifierUserMessage({ store, prompts });
    assert.ok(!user.includes('<author>'));
    assert.ok(!user.includes('Λένα'));
  });

  test('follow-up author: reading the profile writes nothing', async () => {
    const profile = profileWithAliases('u7', ['Λένα', 'Ελενάκι']);
    const before = structuredClone(profile);
    const touched: Array<Untyped> = [];
    const base = fakeStore({ u7: profile });
    const store = new Proxy(base, {
      get(target: Untyped, key) {
        if (key !== 'getUser' && key !== 'getUserCalls' && typeof key === 'string') touched.push(key);
        return target[key];
      },
    });
    const user = await classifierUserMessage({ store });
    assert.ok(user.includes('<author>'));
    assert.deepEqual(profile, before, 'the stored profile is unchanged');
    assert.deepEqual(
      // Naming the place and the account of a native id only reads. An emoji's and a sticker's
      // description stands in the legend, the line holds the stable name; `mediaNameOf` reads a stable name and writes nothing.
      touched.filter((key) => !['state', 'then', 'sharedPlaceOf', 'accountOf', 'mediaNameOf'].includes(key)),
      [],
      'no store method other than getUser'
    );
  });
});
