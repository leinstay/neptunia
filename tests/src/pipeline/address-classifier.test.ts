// Tests for src/pipeline/address-classifier.ts, the address classifier's strict JSON answer: the request hands the client ADDRESS_FORMAT as `responseFormat`, an
// object `{ "answer": "yes" | "overheard" | "no" }` gives the decision the bare word gave, and every other answer, the
// bare word included, is a failed call: the line passes only when flagged or within an active one-to-one exchange.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_FORMAT, createAddressClassifier } from '../../../src/pipeline/address-classifier.ts';
import type { AddressAnswer } from '../../../src/pipeline/address-classifier.ts';
import type { ClassifierRequest } from '../../../src/pipeline/classifier-request.ts';
import type { Conv, Line } from '../../../src/pipeline/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  DEFAULT_CONFIG,
  fakeAddressPrompts,
  fakeChannel,
  fakeChannelWithHistory,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  openFollowUpWindow,
  rawHistoryMessage,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly, table } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { DailyCapError } from '../../../src/llm/openrouter.ts';
import { useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const SETTINGS = {
  models: { routes: chainsOf({ analyzer: 'small/analyzer' }) },
  llm: { analyzerTimeoutMs: 1000 },
  // The lead: the two settings `MentionConfig` requires, at values the classifier does not read, for the type check.
  mention: { followUpMaxOutputTokens: 20, neverIgnore: [], repeatWindowMinutes: 0 },
  bot: { timezone: 'UTC' },
};

const CHANNEL: Conv = {
  id: 'c1',
  kind: 'channel',
  rootId: 'g1',
  iface: 'test',
  permissions: { read: true, send: true, attach: true, react: true },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: true,
};

function line(fields: Partial<Line> & { id: string; authorId: string; ts: number }): Line {
  return { placeId: 'c1', replyToId: null, mentionedAccountIds: [], content: 'a line', ...fields };
}

const CANDIDATE = line({ id: 'm-candidate', authorId: 'u2', ts: NOW });

/** A one-to-one exchange: the persona's line half a minute ago answered the candidate's author. */
const EXCHANGE = [
  line({ id: 'h1', authorId: 'u2', ts: NOW - 60_000 }),
  line({ id: 'h2', authorId: 'self', ts: NOW - 30_000, self: true, replyToId: 'h1' }),
];

type Fact = { reason?: string; failure?: string };
type Sent = { options: { responseFormat?: unknown } };

/** A classifier whose model answers `text`, with the facts it noted and the options of each request. */
function classifierAnswering(text: string, history: Array<Line> = []) {
  const facts: Array<Fact> = [];
  const sent: Array<Sent> = [];
  const request: ClassifierRequest = { system: 'system', user: 'user', history };
  const { classifyAddress } = createAddressClassifier({
    hot: { config: SETTINGS, prompts: null },
    llm: {
      complete: (_messages, options) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    now: () => NOW,
    getSelfName: () => 'Self',
    missed: {
      noteFact: (fact: Fact) => facts.push(fact),
      noteActivity: () => undefined,
      noteNotAddressed: () => undefined,
    },
    buildClassifierRequest: () => Promise.resolve(request),
  });
  return { classifyAddress, facts, sent };
}

/** One classification of CANDIDATE, its answer, the facts it noted, the request options and its fail-open line. */
async function classify(text: string, { flagged = false, history = [] as Array<Line> } = {}) {
  const { classifyAddress, facts, sent } = classifierAnswering(text, history);
  const { result, logs } = await withCapturedLogs(() =>
    classifyAddress(CHANNEL, CANDIDATE, { config: SETTINGS, flagged })
  );
  const failOpen = logs.find((entry) => entry.msg === 'follow-up: fail-open');
  return { answer: result, facts, sent, failOpen };
}

/** Answers that are not the object, or whose `answer` is outside the three words: each is a failed call. */
const UNREADABLE = [
  'yes',
  'overheard',
  'no',
  'Yes, the line is for her.',
  '{}',
  '{"verdict":"yes"}',
  '{"answer":"maybe"}',
  '{"answer":"YES"}',
  '{"answer":true}',
  '{"answer":null}',
  '{"answer":["yes"]}',
  '"yes"',
  '["yes"]',
  'null',
  '{"answer":"yes"',
  '```json\n{"answer":"yes"}\n```',
];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, { enum?: Array<string> }>;
};

test('the address request hands the client ADDRESS_FORMAT as its responseFormat', async () => {
  const { sent } = await classify('{"answer":"yes"}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.deepEqual(request.options.responseFormat, ADDRESS_FORMAT);
});

test('ADDRESS_FORMAT is a closed object whose one required field answer is yes, overheard or no', () => {
  const schema = ADDRESS_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['answer']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['answer']);
  const answer = schema.properties?.answer;
  assert.deepEqual([...(answer?.enum ?? [])].sort(), ['no', 'overheard', 'yes']);
});

test('a well-formed answer gives the decision of its word, with no failed call', async () => {
  for (const word of ['yes', 'overheard', 'no'] satisfies Array<AddressAnswer>) {
    const { answer, facts, failOpen } = await classify(JSON.stringify({ answer: word }));
    assert.equal(answer, word, word);
    assert.deepEqual(facts, [], `${word}: no missed-answer fact`);
    assert.equal(failOpen, undefined, `${word}: no fail-open`);
  }
});

test('a well-formed no on a flagged line is a no, as the bare word was', async () => {
  const { answer, facts } = await classify('{"answer":"no"}', { flagged: true });
  assert.equal(answer, 'no');
  assert.deepEqual(facts, []);
});

test('an unreadable answer, the bare word included, drops an unflagged line outside an exchange as a failed call', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text);
    const label = JSON.stringify(text);
    assert.equal(answer, 'no', label);
    assert.equal(failOpen?.open, false, `${label}: fail-open logged, closed`);
    assert.equal(failOpen?.reason, 'unparsed', label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failed', 'unparsed']],
      label
    );
  }
});

test('an unreadable answer lets a flagged line through as a failed call does', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text, { flagged: true });
    const label = JSON.stringify(text);
    assert.equal(answer, 'yes', label);
    assert.equal(failOpen?.open, true, label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failopen', 'unparsed']],
      label
    );
  }
});

test('an unreadable answer lets an unflagged line through within an active one-to-one exchange', async () => {
  for (const text of UNREADABLE) {
    const { answer, facts, failOpen } = await classify(text, { history: EXCHANGE });
    const label = JSON.stringify(text);
    assert.equal(answer, 'yes', label);
    assert.equal(failOpen?.open, true, label);
    assert.deepEqual(
      facts.map((fact) => [fact.reason, fact.failure]),
      [['gate-failopen', 'unparsed']],
      label
    );
  }
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
const [, ROOT_GROUP] = GROUP_SHAPES as [Shape, Shape, Shape];

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
  const clock = { at: DOOR_ADDRESS_NOW };
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

test('a failed classifier call on a flagged line leaves a fact that names its interface', async () => {
  // Bug: a provider outage drops a direct call without a trace, or the recovery cannot find the place again.
  const scene = door({ fails: true });
  await scene.say(ROOT_GROUP, { mentioned: true });
  assert.equal(scene.facts.length, 1);
  const firstFact = scene.facts[0];
  assert.equal(firstFact?.iface, ROOT_GROUP.iface);
});

const FOLLOW_UP_NO_STREAK = 5;

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
// mention.failOpenMinutes -- a failed classifier call (thrown or empty) keeps an
// active one-to-one exchange: the facts are the channel history its request fetched.

/**
 * One classifier failure in channel c1 with Bob (u2) writing to the persona: a line by
 * `preceding`, the persona's line `agoMs` before the candidate (a reply to that line, unless
 * `reply` is false), then `between` (raw lines after the persona's), then Bob's candidate. `failure` is
 * `'throw'`, `'empty'` or an answer word (a working classifier).
 */
async function failOpenScenario({
  agoMs = 60_000,
  between = [],
  failure = 'throw',
  reply = true,
  preceding = 'u2',
  mention = {},
  extra,
  missed,
}: {
  agoMs?: number;
  between?: Array<Untyped>;
  failure?: string;
  reply?: boolean;
  preceding?: string;
  mention?: Record<string, Untyped>;
  extra?: Untyped;
  missed?: Untyped;
} = {}) {
  const llm = fakeFollowUpLlm();
  const turns = recordingTurns();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ mention: { failOpenMinutes: 3, ...mention } });
  const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts(), missed });
  const guild = fakeGuild();
  const t0 = Date.now();
  const personaTs = t0 - agoMs;
  const personaLine = {
    ...rawHistoryMessage({ id: 'h-her', authorId: 'self1', authorName: 'Ζωή', ts: personaTs, content: 'her answer' }),
    reference: reply ? { messageId: 'h-asked' } : null,
  };
  const history: Array<Untyped> = [
    rawHistoryMessage({
      id: 'h-asked',
      authorId: preceding,
      authorName: preceding === 'u2' ? 'Bob' : 'Carla',
      ts: personaTs - 20_000,
      content: 'a question',
    }),
    personaLine,
    ...between,
  ];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: personaTs });

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm-candidate', guild, channel, content: 'and then?', ts: t0 }));
    await tick();
    if (failure === 'throw') llm.fail(new Error('timeout'));
    else if (failure === 'empty') llm.respond('');
    else llm.respond(failure);
    await p;
    await tick();
    if (extra) await extra({ handler, llm, guild, channel, t0 });
  });
  return { turns, spontaneous, llm, logs };
}

/** A src/behavior/missed.ts stand-in recording the facts and the activity it is told of. */
function recordingMissed() {
  const facts: Array<Untyped> = [];
  const activity: Array<Untyped> = [];
  return {
    facts,
    activity,
    noteFact: (fact: string) => facts.push(fact),
    noteActivity: (placeId: string, at: Array<Record<string, Untyped>>) => activity.push([placeId, at]),
  };
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

  test('follow-up: the address classifier timeout is llm.analyzerTimeoutMs, read at each call; a missing key falls back to the config.json value', async () => {
    const llm = fakeFollowUpLlm();
    // Every answer below is "no": the streak limit is kept out of the way.
    const config = baseConfig({ llm: { timeoutMs: 3e5, analyzerTimeoutMs: 12000 }, mention: { followUpNoStreak: 10 } });
    const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild('g1', 'Neptunia');
    const t0 = Date.now();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

    const ask = async (id: string, ts: Untyped) => {
      const p = handler(
        fakeMessage({ id, guild, channel, placeId: 'c1', cleanContent: 'is this for you', createdTimestamp: ts })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      llm.respond('no');
      await p;
    };
    await ask('m-first', t0 + 2000);
    config.llm.analyzerTimeoutMs = 7000; // a hot edit between two calls
    await ask('m-second', t0 + 3000);
    delete config.llm.analyzerTimeoutMs; // an older config.local.json layer without the key
    await ask('m-third', t0 + 4000);

    assert.deepEqual(
      llm.calls.map((call) => call.options.timeoutMs),
      [12000, 7000, DEFAULT_CONFIG.llm.analyzerTimeoutMs]
    );
    assert.deepEqual(
      llm.calls.map((call) => call.options.purpose),
      ['address', 'address', 'address']
    );
  });

  test('follow-up: an empty or blank classifier answer is logged as a failure with its model and counts as "no"', async () => {
    for (const answer of ['', '  \n\t ']) {
      const llm = fakeFollowUpLlm();
      const turns = recordingTurns();
      const spontaneous = fakeSpontaneous();
      const config = baseConfig({ models: { routes: chainsOf({ analyzer: 'x/text' }) } });
      const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts() });
      const guild = fakeGuild();
      const channel = fakeChannelWithHistory('c1', guild, []);
      await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

      const { logs } = await withCapturedLogs(async () => {
        const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
        await tick();
        llm.respond(answer);
        await p;
      });
      const failed = logs.find((l) => l.msg === 'follow-up: classifier failed');
      assert.ok(failed, JSON.stringify(answer));
      assert.equal(failed.level, 'warn');
      assert.equal(failed.channel, 'c1');
      assert.equal(failed.reason, 'empty');
      assert.equal(failed.model, 'x/text');
      assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'no');
      assert.equal(turns.calls.length, 0, 'no reply turn');
      assert.equal(spontaneous.onMessageCalls.length, 0, 'handled as a "no", not handed to spontaneous');
    }
  });

  test('follow-up: a failure while building the classifier request is not reported as a missing prompts["classify/address"]', async () => {
    const llm = fakeFollowUpLlm();
    const prompts = fakeAddressPrompts();
    const handler = makeHandler({ llm, prompts });
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });
    world().failRead('history', 'c1');

    const first = await withCapturedLogs(async () => {
      await handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
      await tick();
    });
    assert.equal(llm.calls.length, 0);
    assert.ok(first.logs.some((l) => l.msg === 'follow-up: building the classifier request failed'));
    assert.equal(
      first.logs.some((l) => l.msg.startsWith('follow-up: prompts["classify/address"] is missing')),
      false
    );

    // The real cause still gets its warning afterwards.
    wrongly<Record<string, unknown>>(prompts)['classify/address'] = undefined;
    const second = await withCapturedLogs(async () => {
      await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'plain again' }));
      await tick();
    });
    assert.ok(second.logs.some((l) => l.msg.startsWith('follow-up: prompts["classify/address"] is missing')));
  });

  test('follow-up: a failed classifier call is logged with its error, not only as a "no"', async () => {
    const cases = [
      { label: 'an ordinary error', error: new Error('boom') },
      // The daily cap refuses before any request leaves: the same logged "no", never thrown.
      { label: 'a DailyCapError', error: new DailyCapError('daily LLM request cap reached (300)') },
    ];
    for (const { label, error } of cases) {
      const llm = fakeFollowUpLlm();
      const spontaneous = fakeSpontaneous();
      const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
      const guild = fakeGuild();
      const channel = fakeChannelWithHistory('c1', guild, []);
      await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

      const { logs } = await withCapturedLogs(async () => {
        const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
        await tick();
        llm.fail(error);
        await p;
      });
      const failed = logs.find((l) => l.msg === 'follow-up: classifier failed');
      assert.ok(failed, `${label}: logged as a failed call`);
      assert.equal(failed.level, 'warn', label);
      assert.equal(failed.channel, 'c1', label);
      assert.equal(failed.error.message, error.message, label);
      assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'no', `${label}: a "no"`);
      assert.equal(
        spontaneous.onMessageCalls.length,
        0,
        `${label}: still handled as a "no", not handed to spontaneous`
      );
    }
  });

  test('follow-up: a thrown classifier call keeps a one-to-one exchange whose last line of the persona answered this author a minute ago', async () => {
    const { turns, logs, llm }: Record<string, Untyped> = await failOpenScenario({
      // PR 7d: followUpNoStreak is the constant 5. A counted fail-open would close the window after four more "no"
      // verdicts, so the line after them must still reach the classifier.
      extra: async ({ handler, llm, guild, channel, t0 }: Record<string, Untyped>) => {
        for (let i = 0; i <= FOLLOW_UP_NO_STREAK - 1; i += 1) {
          const p = handler(
            plainFollowUpMessage({ id: `m-next${i}`, guild, channel, content: 'still there?', ts: t0 + 1000 + i })
          );
          await tick();
          llm.respond('no');
          await p;
        }
      },
    });
    assert.equal(turns.calls.length, 1, 'a reply turn');
    const firstCall = turns.calls[0];
    assert.equal(firstCall.trigger.id, 'm-candidate');
    assert.equal(firstCall.triggerKind, 'followUp');
    const failOpen = logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: fail-open');
    assert.ok(failOpen, 'logged');
    assert.equal(failOpen.channel, 'c1');
    assert.equal(failOpen.author, 'u2');
    assert.equal(failOpen.reason, 'classifier-failed');
    assert.equal(failOpen.open, true);
    assert.ok(!JSON.stringify(failOpen).includes('and then?'), 'no message contents');
    assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: verdict')?.verdict, 'yes');
    assert.equal(
      llm.calls.length,
      FOLLOW_UP_NO_STREAK + 1,
      'a fail-open "yes" leaves the no-streak alone: the window is still open'
    );
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

  test('follow-up: an empty classifier answer keeps the same one-to-one exchange', async () => {
    const { turns, logs }: Record<string, Untyped> = await failOpenScenario({ failure: 'empty' });
    assert.equal(turns.calls.length, 1, 'a reply turn');
    const failOpen = logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: fail-open');
    assert.equal(failOpen?.reason, 'empty');
    assert.equal(failOpen?.open, true);
  });

  test("follow-up: a failed classifier keeps the exchange when this author's line directly preceded the persona's", async () => {
    const { turns }: Record<string, Untyped> = await failOpenScenario({ reply: false });
    assert.equal(turns.calls.length, 1);
  });

  test('follow-up: a failed classifier is a "no" when the exchange is not an active one-to-one', async () => {
    const cases = [
      {
        label: 'another member wrote between the line of the persona and this message',
        between: [
          rawHistoryMessage({
            id: 'h-carla',
            authorId: 'u3',
            authorName: 'Carla',
            ts: Date.now() - 30_000,
            content: 'me too',
          }),
        ],
      },
      { label: 'the line of the persona is ten minutes old', agoMs: 10 * 60_000 },
      { label: 'the line of the persona answered someone else', preceding: 'u3' },
      { label: 'the line of the persona followed someone else', reply: false, preceding: 'u3' },
    ];
    for (const failure of ['throw', 'empty']) {
      for (const { label, ...scenario } of cases) {
        const { turns, spontaneous, logs }: Record<string, Untyped> = await failOpenScenario({ failure, ...scenario });
        assert.equal(turns.calls.length, 0, `${failure}, ${label}: no reply turn`);
        assert.equal(spontaneous.onMessageCalls.length, 0, `${failure}, ${label}: still handled`);
        assert.equal(
          logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: verdict')?.verdict,
          'no',
          `${failure}, ${label}`
        );
        const failOpen = logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: fail-open');
        assert.equal(failOpen?.open, false, `${failure}, ${label}`);
      }
    }
  });

  test('follow-up: a failed classifier is a missed-answer fact, gate-failopen when it keeps the exchange, gate-failed otherwise', async () => {
    const kept = recordingMissed();
    await failOpenScenario({ failure: 'throw', missed: kept });
    assert.deepEqual(
      kept.facts.map((f) => [f.reason, f.message.id, f.failure]),
      [['gate-failopen', 'm-candidate', 'classifier-failed']]
    );
    assert.ok(
      kept.activity.some(([placeId]) => placeId === 'c1'),
      'the message is activity in its channel'
    );

    const dropped = recordingMissed();
    await failOpenScenario({ failure: 'empty', preceding: 'u3', missed: dropped });
    assert.deepEqual(
      dropped.facts.map((f) => [f.reason, f.message.id, f.failure]),
      [['gate-failed', 'm-candidate', 'empty']]
    );

    for (const answer of ['no', 'yes']) {
      const working = recordingMissed();
      await failOpenScenario({ failure: answer, missed: working });
      assert.deepEqual(working.facts, [], `${answer}: a working classifier is no fact`);
    }
  });

  test('follow-up: a working classifier answer is never overridden by the fail-open facts', async () => {
    for (const [answer, expectedTurns] of table([
      ['no', 0],
      ['yes', 1],
    ])) {
      const { turns, logs }: Record<string, Untyped> = await failOpenScenario({ failure: wrongly(answer) });
      assert.equal(turns.calls.length, expectedTurns, wrongly(answer));
      assert.equal(
        logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: fail-open'),
        undefined,
        `${answer}: no fail-open`
      );
      assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'follow-up: verdict')?.answer, answer);
    }
  });
});
