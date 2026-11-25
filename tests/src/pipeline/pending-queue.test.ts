import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { observe, OBSERVATION_VERSION } from '../../../src/memory/db/observe.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { fillStems } from '../../../src/memory/db/stems.ts';
import { generated } from '../../fixtures/memory-db/roundtrip.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { Completion } from '../../fixtures/tool-answers.ts';
import { withRig, startUnitsCore, spawnCli, startedUnit, until, query, runCli } from '../../fixtures/core-units.ts';
import type { Dirs, Llm } from '../../fixtures/core-units.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  asDiscordEvents,
  fakeAddressPrompts,
  fakeChannel,
  fakeChannelWithHistory,
  fakeChannelWithMessage,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  mutableNow,
  openFollowUpWindow,
  scripted,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { fill } from '../../../src/format.ts';
import { deepMerge } from '../../../src/config.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { freshWorld, refTo, runnerOptions, seedExisting, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const PRIVATE = 'amber-orchid-731';
const NEIGHBOR = 'silver-fern-842';

function seed(dirs: Dirs) {
  mkdirSync(dirs.dataDir, { recursive: true });
  const userDir = join(dirs.dataDir, 'guilds', 'g1', 'users');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'u1.json'),
    JSON.stringify({ ...generated('user')[0], id: 'u1', names: ['Eleni'], affinity: { score: 10 } })
  );
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'));
  try {
    for (const [id, person, chat, text, minute] of [
      ['target-before', 'benoit', 'dm', `κουνέλι κήπο ${NEIGHBOR}`, 0],
      ['target-anchor', 'benoit', 'dm', `κουνέλι κήπο ${PRIVATE}`, 1],
      ['target-old', 'benoit', 'dm', 'κουνέλι old-date-evidence-608', -14400],
      ['other-private', 'carol', 'dm', 'κουνέλι other-private-164', 2],
      ['public', 'alice', 'group', 'κουνέλι public-evidence-275', 3],
    ] as const) {
      const result = observe(
        handle,
        {
          v: OBSERVATION_VERSION,
          iface: 'telegram',
          authority: 'telegram/global',
          connection: 'conn:test',
          native: { kind: 'message', key: id, revision: 0 },
          place: { authority: 'telegram/global', key: `chat:${person}`, kind: 'room', chat, title: person },
          author: { kind: 'account', key: person, display: person },
          occurredAt: new Date(Date.parse('2026-10-23T10:00:00Z') + minute * 60_000).toISOString(),
          observedAt: new Date(NOW).toISOString(),
          text,
          relations: [],
        },
        { now: () => NOW }
      );
      assert.equal(result.ok, true);
    }
    const db = dbOf(handle);
    const account = db.prepare("SELECT author_account FROM sources WHERE native_id = 'target-anchor'").get();
    assert.ok(account && typeof account.author_account === 'string');
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES ('person:benoit', 'person')").run();
    db.prepare("UPDATE accounts SET person_id = 'person:benoit', link = 'verified', names = ? WHERE id = ?").run(
      JSON.stringify(['Benoit']),
      account.author_account
    );
    db.prepare(
      "INSERT INTO account_person_links (id, account_id, person_id, state, recorded_at) VALUES ('link:benoit', ?, 'person:benoit', 'verified', ?)"
    ).run(account.author_account, new Date(NOW).toISOString());
    fillStems(db);
  } finally {
    handle.close();
  }
}

async function grantSearch(dirs: Dirs) {
  for (const command of ['/tools grant memory.search']) {
    const result = await runCli(dirs, ['-p', command]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
}

function toolText(request: unknown): string {
  assert.ok(Array.isArray(request));
  return request
    .filter(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool'
    )
    .map((message: unknown) => JSON.stringify(message))
    .join('\n');
}

const CONFIG = {
  bot: {
    timezone: 'UTC',
    owners: ['u1'],
    placeId: 'g1',
    access: { 'memory.search': { everyone: true, roles: [], users: [] } },
  },
  dm: { enabled: true },
  private: { likeServer: true, minAffinity: 0 },
  split: { minChars: 20, maxTasks: 2, contextMessages: 2, maxOutputTokens: 200 },
  tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 1 } },
  recall: {
    prefetch: {
      deadlineMs: 1000,
      maxTokens: 1500,
      contextTokens: 500,
      minFormsMatched: 1,
      singleTermScore: 0,
      maxTermShare: 1,
      trivial: [],
    },
  },
  gifs: { backfillMessages: 0 },
};

// The lead: split, merge and missed answer in strict JSON.
test('a live CLI query queued behind a blocked turn retains its own internal reads and CLI reply', async (t) => {
  // Drain waits between two and nine seconds. Fix the random boundary so its delay fits the bounded fixture wait.
  t.mock.method(Math, 'random', () => 0);
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, units, logs }) => {
    seed(dirs);
    const waiting = Promise.withResolvers<Completion>();
    const requested = Promise.withResolvers<void>();
    const requests: Array<unknown> = [];
    const options: Array<unknown> = [];
    const llm: Llm = {
      requests,
      options,
      complete: async (messages, given) => {
        const purpose = given && typeof given === 'object' && 'purpose' in given ? given.purpose : null;
        if (purpose === 'address') return toolAnswer('yes');
        if (purpose === 'lookup' || purpose === 'elsewhere-pick') return toolAnswer('none');
        if (purpose === 'split') return toolAnswer('{"parts":[]}');
        requests.push(messages);
        options.push(given);
        if (requests.length === 1) {
          requested.resolve();
          return waiting.promise;
        }
        if (requests.length === 2)
          return toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit', when: '2026-10-23' })]);
        assert.equal(requests.length, 3, 'one search continuation for the queued event');
        return toolAnswer('<msg>queued-owner-answer-719</msg>');
      },
    };
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await grantSearch(dirs);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('Please reply to this first message.');
    await until(
      () => requests.length === 1,
      () => JSON.stringify({ out: chat.stdout(), logs: logs.slice(-8) })
    );
    const queued = 'Please find what Benoit said about κουνέλι on 2026-10-23.';
    chat.type(queued);
    await until(
      () => query(dirs, 'SELECT id FROM sources WHERE text = ?', queued).length === 1,
      'the second live message is observed while the first turn is blocked'
    );
    assert.equal(requests.length, 1);
    waiting.resolve(toolAnswer('<msg>first-owner-answer-820</msg>'));
    await until(
      () => chat.stdout().includes('queued-owner-answer-719') || logs.some((entry) => entry.msg === 'mention: dropped'),
      () =>
        JSON.stringify({
          count: requests.length,
          out: chat.stdout(),
          logs: logs.filter((entry) => String(entry.msg).startsWith('mention:')).slice(-10),
        }),
      8000
    );
    assert.deepEqual(
      logs.filter((entry) => entry.msg === 'mention: dropped').map((entry) => entry.reason),
      [],
      'a live authenticated query must not be dropped'
    );
    assert.ok(chat.stdout().includes('queued-owner-answer-719'));
    assert.ok(chat.stdout().includes('first-owner-answer-820'));
    assert.ok(toolText(requests[2]).includes(PRIVATE), toolText(requests[2]));
    assert.deepEqual(await unit.posted('c1'), []);
    const contexts = query(dirs, "SELECT id FROM execution_contexts WHERE mode = 'internal'");
    assert.equal(new Set(contexts.map((row) => row.id)).size, 2, 'each fresh authenticated event has its own context');
  });
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

test('a yes verdict while a turn runs is held, not started and not lost', async () => {
  // Bug: the flagged path through the classifier forgets the pending queue a call waits in.
  const scene = door({ busy: true });
  await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.started.length, 0);
  assert.equal(scene.handler.pendingCount(), 1);
});

// Plan 2026-11-04-cli-and-memory B1: `address.attentionMinutes` of the config these tests run under, and a run of `no`
// verdicts for the tests that show it no longer closes anything.
const FOLLOW_UP_MINUTES = 15;

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- a direct ping (mention/reply)
// that arrives while a turn is running elsewhere is remembered as pending
// instead of dropped; drainPending() (called in production once a turn
// frees its channel, see src/behavior/turn.ts's setOnIdle) answers the
// oldest one through the normal reply path after a human switch pause.

function directPingMessage(overrides: Record<string, Untyped> = {}) {
  return fakeMessage({
    id: 'm1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    ...overrides,
  });
}

// Plan 2026-11-04-cli-and-memory B1: a name in the text opens nothing at the door, so the name-call tests went.

/**
 * Turns whose channel `c1` is busy until `.finish()`: runTurn answers 'busy' while it is, records
 * every call, and `spokeAfterSeeing` reports the ids passed in `seen`.
 */
function busyChannelTurns({ seen = [] }: { seen?: Array<Untyped> } = {}) {
  let busy = true;
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    isBusy: (id: string) => busy && id === 'c1',
    isAnyBusy: () => busy,
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return { outcome: busy && args.chat.chatId === 'c1' ? 'busy' : 'spoke' };
    },
  });
  turns.spokeAfterSeeing = (placeId: string, messageId: string) => placeId === 'c1' && seen.includes(messageId);
  turns.calls = calls;
  turns.finish = () => {
    busy = false;
  };
  return turns;
}

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

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

/**
 * A follow-up window opened in c1 at FOLLOW_UP_T0, then one message per answer in `answers`
 * (`m1`, `m2`, ... by u1, a second apart), each classified while a turn starts in `busyIn`: the
 * attention is free when the message arrives and taken before the verdict comes back.
 * `beforeAnswer` runs right before each answer.
 */
async function deferredFollowUps({
  answers = ['yes'],
  busyIn = 'c9',
  config = baseConfig(),
  beforeAnswer,
  tagHistory,
  missed,
}: {
  answers?: Untyped;
  busyIn?: string;
  config?: Untyped;
  beforeAnswer?: Untyped;
  tagHistory?: Untyped;
  missed?: Untyped;
} = {}) {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const turns = attentionTurns(busyIn);
  const handler = makeHandler({
    config,
    turns,
    llm,
    tagHistory,
    now: clock,
    sleep: async () => {},
    rng: () => 0.5,
    prompts: fakeAddressPrompts(),
    missed,
  });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  const { logs } = await withCapturedLogs(async () => {
    for (const [i, answer] of answers.entries()) {
      const id = `m${i + 1}`;
      const ts = FOLLOW_UP_T0 + (i + 1) * 1000;
      clock.set(ts);
      seedExisting(channel.id, id);
      turns.busy = false;
      const p = handler(
        plainFollowUpMessage({ id, guild, channel, content: 'and then?', authorId: 'u1', authorName: 'Élodie', ts })
      );
      await tick();
      turns.busy = true; // the turn started while the classifier was thinking
      beforeAnswer?.();
      llm.respond(answer);
      await p;
      await tick();
    }
  });
  return { clock, llm, turns, handler, guild, channel, logs };
}

/** The running turn ends and the drain runs (onIdle): resolves the drain's log lines. */
async function endTurnAndDrain(scene: Record<string, Untyped>) {
  scene.turns.busy = false;
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());
  return logs;
}
const followUpDropped = (logs: Array<Record<string, Untyped>>) =>
  logs.filter((l) => l.msg === 'follow-up: dropped').map((l) => [l.message, l.reason]);
const startedTurns = (turns: Record<string, Untyped>) =>
  turns.calls.map((c: Record<string, Untyped>) => [c.trigger.id, c.triggerKind]);

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

// ---------------------------------------------------------------------------
// Several calls, one attention: the real turn runner (src/behavior/turn.ts) behind the handler.
// A message that holds several requests is answered part by part; every waiting call gets its
// own turn, in arrival order; a call about something still waiting is folded into it.

const LIVE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const LIVE_NAMES: Record<string, Untyped> = { u1: 'Alice', u2: 'Léa' };

/**
 * Like withCapturedLogs, but the entries are visible to `fn` while it runs (`fn(logs)`), so a
 * scene can wait for a log line. Only the logger's own lines are captured.
 */
async function withLiveLogs(fn: Untyped) {
  const original = process.stdout.write;
  const logs: Array<Untyped> = [];
  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"level"')) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          logs.push(JSON.parse(line));
        } catch {
          // a truncated line -- ignore
        }
      }
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    }
    return original.call(process.stdout, chunk, ...wrongly<[]>(rest));
  };
  try {
    await fn(logs);
  } finally {
    process.stdout.write = original;
  }
  return { logs };
}

/** Resolves after `check()` holds, or after a bounded number of event-loop turns (no wall clock). */
async function tickUntil(check: Untyped, rounds = 3000) {
  // PR 7d: the real turn is longer now (memory and the typing imitation are code), so a round waits a millisecond.
  for (let i = 0; i < rounds && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * A server channel (or, `dm`, a private chat with u1) whose history is every message sent so far,
 * a real turn runner, and the handler, wired as src/index.ts wires them. `talk(index)` answers the
 * talk requests (it may return a promise: a gate holding the turn); `split` and `merge` the
 * splitter and the merge classifier (a string, an Error, or a function of the call's index).
 * `prompts['classify/split']` / `prompts['classify/merge']` exist only when their answer is given.
 */
function liveScene({
  dm = false,
  talk = () => '<msg>ok</msg>',
  split,
  merge,
  labels: ownLabels = labels,
  config: overrides = {},
}: {
  dm?: boolean;
  talk?: Untyped;
  split?: Untyped;
  merge?: Untyped;
  labels?: Untyped;
  config?: Record<string, Untyped>;
} = {}) {
  freshWorld();
  const config = baseConfig(
    deepMerge(
      {
        // PR 7d: the switches are code, features.privateMessages is dm.enabled, and the split measures are constants.
        dm: { enabled: true },
        // The typing imitation is code too: no pause, so the turns of a chain follow each other at once.
        typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
        split: { maxOutputTokens: 50 },
        mention: { maxPending: 6, pendingMinutes: 10 },
      },
      overrides
    )
  );
  const prompts = {
    main: 'SYSTEM',
    persona: 'CARD',
    rules: 'RULES',
    format: 'FORMAT',
    'turn/reply': 'Reply to {{author}}.',
    labels: ownLabels,
    ...(split !== undefined ? { 'classify/split': 'Split for {{name}}, at most {{maxTasks}}.' } : {}),
    ...(merge !== undefined ? { 'classify/merge': 'Merge for {{name}}.' } : {}),
  };
  const hot = { config, prompts };
  const calls: Record<string, Array<Untyped>> = { talk: [], split: [], merge: [] };
  const answer = async (spec: Record<string, Untyped>, index: number) => {
    const value = typeof spec === 'function' ? await spec(index) : spec;
    if (value instanceof Error) throw value;
    return { text: value, usage: {}, estimated: 10 };
  };
  const llm = {
    complete: async (messages: Array<Record<string, Untyped>>, options: Record<string, Untyped>) => {
      const kind = options?.purpose === 'split' ? 'split' : options?.purpose === 'merge' ? 'merge' : 'talk';
      calls[kind].push(wrongly({ messages, options }));
      const spec = kind === 'split' ? split : kind === 'merge' ? merge : talk;
      return answer(spec, calls[kind].length - 1);
    },
  };
  let t = LIVE_T0;
  const now = () => t;
  const history: Array<Untyped> = [];
  const client = fakeDmClient();
  const store: Record<string, Untyped> = fakePrivateStore();
  store.state.markDirty = () => {};
  const guild = dm ? null : { id: 'g1', members: { me: { displayName: 'Ζωή' } }, channels: { cache: new Map() } };
  world().knowMembers('g1', client.knows);
  const channel = dm
    ? fakeDmChannel('dm1', 'u1')
    : fakeChannel('c1', guild, { name: 'general', sendTyping: async () => {} });
  world().follow(channel.id, history);
  const tagHistory = countingTagHistory();
  const turns = createTurnRunner(
    wrongly(
      runnerOptions({
        hot,
        store,
        llm,
        calibrator: { ratio: 1, apply: (n: string) => n, observe: () => {} },
        now,
        schedule: () => () => {},
      })
    )
  );
  const handler = asDiscordEvents(
    createMessageHandler(
      wrongly({
        hot,
        store,
        reads: world().reads,
        selfId: () => client.user.id,
        getSelfName: () => 'Ζωή',
        port: world().port,
        turns,
        spontaneous: fakeSpontaneous(),
        memory: fakeMemory(),
        tagHistory,
        isServedRoot: (id: unknown) => id === 'g1',
        llm,
        rng: () => 0.5,
        now,
        sleep: async () => {},
      })
    ),
    hot,
    client
  );
  turns.setOnIdle(() => handler.drainPending());
  /** A call of `authorId` (a mention on the server, any DM in private), one second after the last. */
  const call = async (id: string, authorId: Untyped, content: string) => {
    t += 1000;
    const author = { id: authorId, bot: false, globalName: LIVE_NAMES[authorId], username: LIVE_NAMES[authorId] };
    const message = fakeMessage({
      id,
      guild,
      channel,
      placeId: channel.id,
      author,
      member: dm ? null : { displayName: LIVE_NAMES[authorId] },
      cleanContent: content,
      createdTimestamp: t,
      mentions: { users: new Map(dm ? [] : [['self1', { id: 'self1' }]]) },
    });
    history.push(message);
    await handler(message);
  };
  return { calls, call, store, turns, handler, tagHistory };
}

/** A talk answer that holds the first talk request until `open()`. */
function heldFirst() {
  let open: Untyped;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  const talk = (index: number) => (index === 0 ? held.then(() => '<msg>ok</msg>') : '<msg>ok</msg>');
  return { talk, open: () => open() };
}

/** The `<task>` block of a talk request. */
function liveTask(call: Record<string, Untyped>) {
  const secondMessage = call.messages[1];
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userText(secondMessage.content))?.[1] ?? '';
}

/** Who each talk request answered: the author its task names. */
function answeredAuthors(calls: Record<string, Untyped>) {
  return calls.talk.map(
    (call: Array<Record<string, Untyped>>) => /^Reply to ([^.]+)\./.exec(liveTask(call))?.[1] ?? null
  );
}

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

/** A direct mention during the running turn, whose classifier says yes (plan 2026-11-04-cli-and-memory B1). */
async function busyMention(scene: Record<string, Untyped>, id: string, createdTimestamp: number) {
  const { logs } = await withCapturedLogs(async () => {
    const p = scene.handler(
      directPingMessage({ id, guild: scene.guild, channel: scene.channel, placeId: 'c1', createdTimestamp })
    );
    await tick();
    scene.llm.respond('yes');
    await p;
  });
  return logs;
}

const deferredOf = (logs: Array<Record<string, Untyped>>) =>
  logs
    .filter((l) => l.msg === 'follow-up: deferred')
    .map(({ channel, message, runningIn, sameChannel }) => [channel, message, runningIn, sameChannel]);

// ---------------------------------------------------------------------------
// mention.pendingOverheard: an "overheard" verdict that finds the attention
// taken waits in the pending queue like a "yes", keeping its kind; one entry
// per channel, a waiting followUp outranking a later overheard line.

const PENDING_OVERHEARD = { mention: { pendingOverheard: true } };
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

  test('events: a direct ping elsewhere becomes pending and is answered after the running turn plus the switch pause', async () => {
    let seenArgs = null;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async (args: Record<string, Untyped>) => {
        seenArgs = args;
        return { outcome: 'spoke' };
      },
    });
    const sleepCalls: Array<Untyped> = [];
    const sleep = async (ms: string) => {
      sleepCalls.push(ms);
    };
    const handler = makeHandler({ turns, sleep, rng: scripted([0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    const message = directPingMessage({ guild, channel, placeId: 'c1' });
    await handler(message);

    assert.equal(seenArgs, null, 'must not run immediately while busy elsewhere');

    await handler.drainPending();

    assert.ok(seenArgs, 'expected the deferred turn to run once drained');
    assert.deepEqual(wrongly<Untyped>(seenArgs).chat, refTo(channel));
    assert.equal(wrongly<Untyped>(seenArgs).mode, 'reply');
    assert.equal(wrongly<Untyped>(seenArgs).triggerKind, 'mention');
    assert.equal(wrongly<Untyped>(seenArgs).trigger.content, 'γεια');
    assert.deepEqual(sleepCalls, [5500], 'between(switchDelayMs=[2000,9000], rng=0.5) -- the human switch pause');
  });

  for (const oneAtATime of [true, false]) {
    test(`events: a mention in the channel whose turn is running is deferred, answered after it (oneAtATime=${oneAtATime})`, async () => {
      const turns = busyChannelTurns();
      const tagHistory = countingTagHistory();
      const config = baseConfig({ mention: { oneAtATime } });
      // Exactly two values: the switch pause and decideMention at drain time -- none on arrival.
      const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

      const guild = fakeGuild();
      const channel = fakeChannelWithMessage('c1', guild, 'm1');
      const { logs } = await withCapturedLogs(() => handler(directPingMessage({ guild, channel, placeId: 'c1' })));

      assert.equal(turns.calls.length, 0, 'not run against the busy channel');
      assert.equal(tagHistory.hits, 0, 'counted at drain time, not on arrival');
      const deferred = logs.find((entry) => entry.msg === 'mention: deferred');
      assert.ok(deferred, 'logged as deferred');
      assert.equal(deferred.sameChannel, true);

      turns.finish();
      await handler.drainPending();

      assert.equal(turns.calls.length, 1);
      const firstCall = turns.calls[0];
      assert.deepEqual(firstCall.chat, refTo(channel));
      const firstCall2 = turns.calls[0];
      assert.equal(firstCall2.trigger.id, 'm1');
      assert.equal(firstCall2.triggerKind, 'mention');
      assert.equal(tagHistory.hits, 1);
    });
  }

  test('events: a reply to the persona in the channel whose turn is running is deferred and answered after it', async () => {
    const turns = busyChannelTurns();
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    const { cache } = channel.messages;
    cache.set('m0', { author: { id: 'self1' } });
    await handler(
      fakeMessage({ id: 'm1', guild, channel, placeId: 'c1', cleanContent: 'γεια', reference: { messageId: 'm0' } })
    );
    assert.equal(turns.calls.length, 0);

    turns.finish();
    await handler.drainPending();

    assert.equal(turns.calls.length, 1);
    const firstCall = turns.calls[0];
    assert.equal(firstCall.trigger.id, 'm1');
    assert.equal(firstCall.triggerKind, 'reply');
  });

  test('events: a deferred ping the last speaking turn already had in view is not answered again', async () => {
    const turns = busyChannelTurns({ seen: ['m1'] });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    turns.finish();
    const { logs } = await withCapturedLogs(() => handler.drainPending());

    assert.equal(turns.calls.length, 0, 'the running turn already answered it');
    assert.ok(logs.some((entry) => entry.msg === 'mention: already answered' && entry.channel === 'c1'));
  });

  test('events: a newer direct ping in the same channel waits beside the older one; both are answered in arrival order', async () => {
    const seen: Array<Untyped> = [];
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async (args: Record<string, Untyped>) => {
        seen.push(args.trigger.content);
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm2');
    seedExisting(channel.id, 'm1');

    await handler(directPingMessage({ id: 'm1', guild, channel, placeId: 'c1', cleanContent: 'first' }));
    await handler(directPingMessage({ id: 'm2', guild, channel, placeId: 'c1', cleanContent: 'second' }));
    await new Promise((resolve) => setImmediate(resolve));

    await handler.drainPending();

    assert.deepEqual(seen, ['first', 'second'], "no call takes another one's place");
  });

  test('events: mention.maxPending caps distinct pending channels, dropping the oldest', async () => {
    const config = baseConfig({ mention: { maxPending: 2 } });
    const answeredChannels: Array<Untyped> = [];
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async (args: Record<string, Untyped>) => {
        answeredChannels.push(args.chat.chatId);
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

    const guild = fakeGuild();
    for (const id of ['c1', 'c2', 'c3']) {
      const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
      await handler(directPingMessage({ id: `m-${id}`, guild, channel, placeId: id, cleanContent: id }));
    }

    await handler.drainPending();

    assert.deepEqual(
      answeredChannels.sort(),
      ['c2', 'c3'],
      'c1 (the oldest) was evicted once maxPending=2 was exceeded'
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

  test('events: a call evicted from a full pending queue is a pending-full missed fact with its message', async () => {
    const missed = recordingMissed();
    const config = baseConfig({ mention: { maxPending: 2 } });
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => ({ outcome: 'spoke' }),
    });
    const handler = makeHandler({
      config,
      turns,
      sleep: async () => {},
      rng: scripted([0.5, 0.99, 0.5, 0.99]),
      missed,
    });
    const guild = fakeGuild();
    for (const id of ['c1', 'c2', 'c3']) {
      const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
      await handler(directPingMessage({ id: `m-${id}`, guild, channel, placeId: id, cleanContent: id }));
    }
    assert.deepEqual(
      missed.facts.map((fact) => [fact.reason, fact.message.id, fact.message.placeId]),
      [['pending-full', 'm-c1', 'c1']]
    );
  });

  // /nep pause: clearPending() drops every queued ping without answering any of them.
  test('events: clearPending empties the pending queue -- drainPending afterwards answers nothing', async () => {
    let called = false;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => {
        called = true;
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ id: 'm1', guild, channel, placeId: 'c1' }));

    handler.clearPending();
    await handler.drainPending();

    assert.equal(called, false, 'the cleared ping must never be answered');
  });

  test('follow-up: a "yes" during a turn elsewhere is deferred, then picked up and answered once the turn ends', async () => {
    const tagHistory = countingTagHistory();
    const scene = await deferredFollowUps({ tagHistory });
    const { calls } = scene.turns;
    assert.equal(calls.length, 0, 'no turn while the attention is taken');
    assert.equal(tagHistory.hits, 0, 'counted when picked up, not on deferral');
    const deferred = scene.logs.filter((l) => l.msg === 'follow-up: deferred');
    assert.deepEqual(
      deferred.map(({ channel, author, message, runningIn, sameChannel }) => [
        channel,
        author,
        message,
        runningIn,
        sameChannel,
      ]),
      [['c1', 'u1', 'm1', 'c9', false]]
    );

    const logs = await endTurnAndDrain(scene);
    assert.deepEqual(
      logs.filter((l) => l.msg === 'follow-up: picked up').map((l) => [l.channel, l.kind, l.message]),
      [['c1', 'followUp', 'm1']]
    );
    assert.deepEqual(
      logs.filter((l) => l.msg === 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]),
      [['followUp', 'respond', true]],
      'rolled once, when picked up'
    );
    const { calls: callsValue } = scene.turns;
    assert.equal(callsValue.length, 1);
    const [call] = scene.turns.calls;
    assert.deepEqual(call.chat, refTo(scene.channel));
    assert.equal(call.mode, 'reply');
    assert.equal(call.triggerKind, 'followUp');
    assert.equal(call.trigger.id, 'm1');
    assert.equal(tagHistory.hits, 1);
  });

  test('follow-up: a "yes" during a spontaneous turn in its own channel that ends not-now is answered after it', async () => {
    const scene = await deferredFollowUps({ busyIn: 'c1' });
    const deferred = scene.logs.find((l) => l.msg === 'follow-up: deferred');
    assert.equal(deferred?.runningIn, 'c1');
    assert.equal(deferred.sameChannel, true);
    const { calls } = scene.turns;
    assert.equal(calls.length, 0);

    // The spontaneous turn ends not-now: nothing was posted, the window is as it was.
    const logs = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(logs), []);
    const { calls: callsValue } = scene.turns;
    assert.equal(callsValue.length, 1);
    const { trigger } = callsValue[0];
    assert.equal(trigger.id, 'm1');
    assert.equal(callsValue[0].triggerKind, 'followUp');
  });

  test('follow-up: a line that arrived after the running turn fetched its history is drained, not dropped as answered', async () => {
    const scene = await deferredFollowUps({ busyIn: 'c1' });
    // The running turn in c1 posts after the line, from a history fetched before it arrived.
    await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
    scene.turns.spokeAfterSeeing = () => false;
    const logs = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(logs), []);
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
  });

  test('follow-up: a deferred "yes" is dropped when its window closed while it waited', async () => {
    // PR 7d: followUpMinutes is the constant 15, so pendingMinutes is raised to keep the ping alive past the window.
    const config = baseConfig({ mention: { pendingMinutes: 30 } });
    const scene = await deferredFollowUps({ config });
    scene.clock.set(FOLLOW_UP_T0 + (FOLLOW_UP_MINUTES + 1) * 60_000); // past the window, not past pendingMinutes
    const logs = await endTurnAndDrain(scene);
    const { calls } = scene.turns;
    assert.equal(calls.length, 0);
    assert.deepEqual(followUpDropped(logs), [['m1', 'closed']]);
  });

  test('follow-up: a deferred "yes" replaced by a newer one is a replaced-deferred fact with both ids', async () => {
    const missed = recordingMissed();
    await deferredFollowUps({ answers: ['yes', 'yes'], missed });
    assert.deepEqual(
      missed.facts.map((f) => [f.reason, f.message.id, f.replacedBy]),
      [['replaced-deferred', 'm1', 'm2']]
    );
    const firstFact = missed.facts[0];
    assert.equal(firstFact.message.authorId, 'u1');
  });

  test('follow-up: a newer deferred "yes" in the same channel replaces the older one', async () => {
    const scene = await deferredFollowUps({ answers: ['yes', 'yes'] });
    assert.deepEqual(
      scene.logs.filter((l) => l.msg === 'follow-up: deferred').map((l) => l.message),
      ['m1', 'm2']
    );
    assert.deepEqual(followUpDropped(scene.logs), [['m1', 'newer']]);

    await endTurnAndDrain(scene);
    const { calls } = scene.turns;
    assert.deepEqual(
      calls.map((c: Record<string, Untyped>) => c.trigger.id),
      ['m2']
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

  test('events: five calls in a row from one author while the persona is busy get five turns, in arrival order', async () => {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk });
    const { talk: talkCalls } = scene.calls;
    const texts = ['ένα', 'δύο', 'τρία', 'τέσσερα', 'πέντε'];
    const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('m1', 'u1', texts[0]);
      await tickUntil(() => talkCalls.length === 1);
      for (const [i, text] of texts.slice(1).entries()) await scene.call(`m${i + 2}`, 'u1', text);
      await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 4);
      open();
      await tickUntil(() => talkCalls.length === 5);
    });

    const { talk: talkValue } = scene.calls;
    assert.equal(talkValue.length, 5);
    assert.equal(logs.filter((line) => line.msg === 'mention: already answered').length, 0, 'none dropped as seen');
    assert.deepEqual(
      logs.filter((line) => line.msg === 'mention: deferred').map((line) => line.queued),
      [1, 2, 3, 4]
    );
    // The turn of m2 names the author's calls still waiting, so it leaves them to their own turns.
    const { talk: talkValue3 } = scene.calls;
    assert.ok(liveTask(talkValue3[1]).endsWith(fill(labels.task.queued, { others: '1. τρία; 2. τέσσερα; 3. πέντε' })));
    const { talk: talkValue4 } = scene.calls;
    assert.ok(liveTask(talkValue4[4]).endsWith('Reply to Alice.'), 'the last one has nothing left to name');
    assert.deepEqual(
      logs.filter((line) => line.msg === 'merge: failed').map((line) => line.reason),
      ['no-prompt', 'no-prompt', 'no-prompt'],
      'no merge prompt: each call is new'
    );
  });

  test("events: calls of two authors waiting in one channel each get their own turn, in arrival order, each request naming the other's", async () => {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk });
    const { talk: talkCalls } = scene.calls;
    const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('m1', 'u1', 'ένα');
      await tickUntil(() => talkCalls.length === 1);
      await scene.call('m2', 'u2', 'δύο');
      await scene.call('m3', 'u1', 'τρία');
      await scene.call('m4', 'u2', 'τέσσερα');
      await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 3);
      open();
      await tickUntil(() => talkCalls.length === 4);
    });
    assert.deepEqual(answeredAuthors(scene.calls), ['Alice', 'Léa', 'Alice', 'Léa']);
    assert.equal(logs.filter((line) => line.msg === 'mention: already answered').length, 0, 'none dropped as seen');
    // m2 (Léa): Léa's own m4 under task.queued, Alice's m3 under task.queuedOthers.
    const { talk: talkValue } = scene.calls;
    assert.ok(
      liveTask(talkValue[1]).endsWith(
        [
          fill(labels.task.queued, { others: '1. τέσσερα' }),
          fill(labels.task.queuedOthers, { others: '1. Alice: τρία' }),
        ].join('\n\n')
      )
    );
    // m3 (Alice): Léa's m4 under task.queuedOthers.
    const { talk: talkValue3 } = scene.calls;
    assert.ok(liveTask(talkValue3[2]).endsWith(fill(labels.task.queuedOthers, { others: '1. Léa: τέσσερα' })));
    const { talk: talkValue4 } = scene.calls;
    assert.ok(liveTask(talkValue4[3]).endsWith('Reply to Léa.'), 'nothing left to name');
  });

  test('events: mention.maxPending evicts the oldest waiting call of an author too', async () => {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk, config: { mention: { maxPending: 2 } } });
    const { talk: talkCalls } = scene.calls;
    const { logs } = await withLiveLogs(async (logs: Array<Record<string, Untyped>>) => {
      await scene.call('m1', 'u1', 'ένα');
      await tickUntil(() => talkCalls.length === 1);
      for (const [i, text] of ['δύο', 'τρία', 'τέσσερα'].entries()) await scene.call(`m${i + 2}`, 'u1', text);
      await tickUntil(() => logs.some((line) => line.msg === 'mention: dropped' && line.reason === 'full'));
      open();
      await tickUntil(() => talkCalls.length === 3);
    });
    const { talk: talkValue } = scene.calls;
    assert.equal(talkValue.length, 3);
    assert.ok(liveTask(talkValue[1]).startsWith('Reply to Alice.'));
    const { talk: talkValue3 } = scene.calls;
    assert.equal(liveTask(talkValue3[1]).includes('δύο'), false, 'm2, the oldest, was evicted');
  });

  test('follow-up: a candidate arriving during a turn in its own channel is classified; a "yes" is deferred under pendingSameChannel and answered after it', async () => {
    const scene = await busyFollowUpScene({ busyIn: 'c1' });
    const logs = await busyCandidate(scene, 'm1', 'yes');
    const { calls } = scene.llm;
    assert.equal(calls.length, 1);
    assert.deepEqual(deferredOf(logs), [['c1', 'm1', 'c1', true]]);

    const drain = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(drain), []);
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
  });

  test('follow-up: a line the turn had in its history is dropped as answered', async () => {
    const scene = await busyFollowUpScene({ busyIn: 'c1' });
    await busyCandidate(scene, 'm1', 'yes');
    // The running turn in c1 posts after the candidate, with the candidate in its history.
    await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
    scene.turns.spokeAfterSeeing = (placeId: string, messageId: Untyped) => placeId === 'c1' && messageId === 'm1';
    const drain = await endTurnAndDrain(scene);
    const { calls } = scene.turns;
    assert.equal(calls.length, 0, 'not answered a second time');
    assert.deepEqual(followUpDropped(drain), [['m1', 'answered']]);
  });

  test('follow-up: an overheard verdict during a running turn is deferred and drained as an overheard turn', async () => {
    const tagHistory = countingTagHistory();
    const scene = await deferredFollowUps({
      answers: ['overheard'],
      config: baseConfig(PENDING_OVERHEARD),
      tagHistory,
    });
    const { calls } = scene.turns;
    assert.equal(calls.length, 0, 'no turn while the attention is taken');
    assert.deepEqual(followUpDropped(scene.logs), [], 'not dropped');
    const deferred = scene.logs.filter((l) => l.msg === 'follow-up: deferred');
    assert.deepEqual(
      deferred.map(({ channel, message, runningIn, sameChannel, kind }) => [
        channel,
        message,
        runningIn,
        sameChannel,
        kind,
      ]),
      [['c1', 'm1', 'c9', false, 'overheard']]
    );

    const logs = await endTurnAndDrain(scene);
    assert.deepEqual(
      logs.filter((l) => l.msg === 'follow-up: picked up').map((l) => [l.channel, l.kind, l.message]),
      [['c1', 'overheard', 'm1']]
    );
    // Plan 2026-11-04-cli-and-memory B1: an overheard turn passes the per-author rail at pickup.
    assert.deepEqual(
      logs.filter((l) => l.msg === 'mention: decided').map((l) => [l.kind, l.deferred]),
      [['overheard', true]]
    );
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'overheard']]);
    const { calls: callsValue } = scene.turns;
    assert.equal(callsValue[0].mode, 'reply');
    assert.deepEqual(callsValue[0].chat, refTo(scene.channel));
    // Plan 2026-11-04-cli-and-memory B1: an overheard turn counts toward the per-author rail.
    assert.equal(tagHistory.hits, 1, 'the started overheard turn is counted');
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

  test('follow-up: an overheard turn whose runTurn answers busy is deferred, then drained with its kind', async () => {
    const clock = mutableNow(FOLLOW_UP_T0);
    const llm = fakeFollowUpLlm();
    const results = [{ outcome: 'busy' }, { outcome: 'spoke' }];
    const calls: Array<Untyped> = [];
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        calls.push(args);
        return results.shift();
      },
    });
    const handler = makeHandler({
      config: baseConfig(PENDING_OVERHEARD),
      turns,
      llm,
      now: clock,
      sleep: async () => {},
      rng: () => 0.5,
      prompts: fakeAddressPrompts(),
    });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
    clock.set(FOLLOW_UP_T0 + 1000);
    seedExisting(channel.id, 'm1');

    const { logs } = await withCapturedLogs(async () => {
      const p = handler(
        plainFollowUpMessage({
          id: 'm1',
          guild,
          channel,
          content: 'she again',
          authorId: 'u1',
          authorName: 'Élodie',
          ts: FOLLOW_UP_T0 + 1000,
        })
      );
      await tick();
      llm.respond('overheard');
      await p;
      for (let i = 0; i < 5; i += 1) await settle();
    });

    assert.deepEqual(followUpDropped(logs), []);
    assert.deepEqual(
      logs.filter((l) => l.msg === 'follow-up: deferred').map((l) => [l.message, l.kind]),
      [['m1', 'overheard']]
    );
    assert.deepEqual(
      calls.map((c) => [c.trigger.id, c.triggerKind]),
      [
        ['m1', 'overheard'],
        ['m1', 'overheard'],
      ]
    );
  });

  test('follow-up: a pending followUp is not replaced by a later overheard', async () => {
    const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
    const first = await busyCandidate(scene, 'm1', 'yes');
    const second = await busyCandidate(scene, 'm2', 'overheard');
    assert.deepEqual(deferredOf(first), [['c1', 'm1', 'c9', false]]);
    assert.deepEqual(deferredOf(second), [], 'the overheard line does not take the slot');
    assert.deepEqual(followUpDropped(second), [['m2', 'outranked']]);

    const drain = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(drain), []);
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
  });

  test('follow-up: a pending overheard is replaced by a later followUp', async () => {
    const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
    await busyCandidate(scene, 'm1', 'overheard');
    const second = await busyCandidate(scene, 'm2', 'yes');
    assert.deepEqual(followUpDropped(second), [['m1', 'newer']]);
    assert.deepEqual(deferredOf(second), [['c1', 'm2', 'c9', false]]);

    await endTurnAndDrain(scene);
    assert.deepEqual(startedTurns(scene.turns), [['m2', 'followUp']]);
  });

  test('follow-up: a pending overheard is replaced by a later direct mention in its channel', async () => {
    const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
    await busyCandidate(scene, 'm1', 'overheard');
    seedExisting('c1', 'm2');
    const logs = await busyMention(scene, 'm2', FOLLOW_UP_T0 + 5000);
    assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
    assert.equal(logs.filter((l) => l.msg === 'mention: deferred').length, 1);

    await endTurnAndDrain(scene);
    assert.deepEqual(startedTurns(scene.turns), [['m2', 'mention']]);
  });

  test('follow-up: a waiting followUp stays beside a later direct mention with pendingOverheard on, as before', async () => {
    const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
    await busyCandidate(scene, 'm1', 'yes');
    seedExisting('c1', 'm2');
    const logs = await busyMention(scene, 'm2', FOLLOW_UP_T0 + 5000);
    assert.deepEqual(followUpDropped(logs), []);
    await endTurnAndDrain(scene);
    assert.deepEqual(
      startedTurns(scene.turns).map(([id]: Array<Record<string, Untyped>>) => id),
      ['m1', 'm2']
    );
  });

  test('follow-up: a deferred overheard line is not shown to another turn of its channel as a waiting call', async () => {
    const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
    // A direct mention queued first, then the overheard line of the same channel (a later
    // direct call would take its place, so the mention must come before it).
    seedExisting('c1', 'm0');
    await busyMention(scene, 'm0', FOLLOW_UP_T0 + 500);
    await busyCandidate(scene, 'm1', 'overheard');
    // What each turn would show as waiting, read when it starts (queued is read lazily).
    const shown: Array<Untyped> = [];
    const run = scene.turns.runTurn;
    scene.turns.runTurn = (args: Record<string, Untyped>) => (
      shown.push([args.trigger.id, args.queued?.() ?? null]),
      run(args)
    );
    // The fake turn never posts, so the drain answers both; the mention first.
    await endTurnAndDrain(scene);
    assert.deepEqual(startedTurns(scene.turns), [
      ['m0', 'mention'],
      ['m1', 'overheard'],
    ]);
    assert.deepEqual(shown[0], ['m0', []], 'the overheard line is not a call waiting for its turn');
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

  test('follow-up: three messages in a row keep the newest in the slot and the drained turn reads them from history', async () => {
    const clock = mutableNow(FOLLOW_UP_T0);
    const llm = fakeFollowUpLlm();
    const turns = attentionTurns('c9');
    const handler = makeHandler({
      config: baseConfig(PENDING_OVERHEARD),
      turns,
      llm,
      now: clock,
      sleep: async () => {},
      rng: () => 0.5,
      prompts: fakeAddressPrompts(),
    });
    const guild = fakeGuild();
    const history: Array<Untyped> = [];
    const channel = fakeChannelWithHistory('c1', guild, wrongly(history));
    await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
    turns.busy = true;

    const allLogs = [];
    for (const [i, content] of ['she said so', 'ask her', 'Zoé knows'].entries()) {
      const id = `m${i + 1}`;
      const ts = FOLLOW_UP_T0 + (i + 1) * 1000;
      clock.set(ts);
      const message = plainFollowUpMessage({ id, guild, channel, content, authorId: 'u1', authorName: 'Élodie', ts });
      history.push(message);
      const { logs } = await withCapturedLogs(async () => {
        const p = handler(message);
        await tick();
        llm.respond('overheard');
        await p;
        await tick();
      });
      allLogs.push(...logs);
    }

    assert.equal(llm.calls.length, 3, 'each line was classified');
    assert.deepEqual(followUpDropped(allLogs), [
      ['m1', 'newer'],
      ['m2', 'newer'],
    ]);
    const deferred = allLogs.filter((l) => l.msg === 'follow-up: deferred');
    assert.deepEqual(
      deferred.map((l) => l.message),
      ['m1', 'm2', 'm3']
    );
    assert.equal(present(deferred.at(-1)).pending, 1, 'the slot holds one entry');

    turns.busy = false;
    await withCapturedLogs(() => handler.drainPending());
    assert.deepEqual(startedTurns(turns), [['m3', 'overheard']], 'the slot held the last one');
    const page = await world().reads.history(refTo({ id: 'c1' }), { limit: 50 });
    assert.deepEqual(
      present(page).events.map((event) => event.message.id),
      ['m1', 'm2', 'm3'],
      'the drained turn reads all three in the history'
    );
  });

  test('follow-up: an overheard line that arrived after the running turn fetched its history is drained, not dropped as answered', async () => {
    const scene = await deferredFollowUps({
      busyIn: 'c1',
      answers: ['overheard'],
      config: baseConfig({ mention: { pendingOverheard: true } }),
    });
    await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
    scene.turns.spokeAfterSeeing = () => false;
    const logs = await endTurnAndDrain(scene);
    assert.deepEqual(followUpDropped(logs), []);
    assert.deepEqual(startedTurns(scene.turns), [['m1', 'overheard']]);
  });
});
