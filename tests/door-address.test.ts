// The door: on every interface the address classifier (prompts/address.md) decides each line of a group place, DMs and
// the core CLI never ask it, and two neutral rails bound its cost and the turns one author starts.
// Contract, plan 2026-11-04-cli-and-memory B1:
//   settings `address.attentionMinutes` and `address.maxTurnsPerAuthor`, read at the moment of use
//   a line with `addressing.mentioned` or `addressing.replyToSelf` goes to the classifier at once, any other line only
//   while the persona wrote in that place within `address.attentionMinutes`; the verdict `yes` starts a turn of kind
//   `mention`, `reply` or `followUp` by what the line carried, `overheard` an overheard turn, `no` nothing
//   past `address.maxTurnsPerAuthor` started turns of one author in one place within `address.attentionMinutes`, a
//   `yes` starts no turn and logs `address: refused` with `{ turns, limit }`
//   the names come from her person record (`selfNames`, the names the owner gave `person:self`) and reach the request
//   as an `<aliases>` block; `bot.nameTriggers` opens nothing
//   `missed.noteFact` carries `iface`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/behavior/pipeline.ts';
import { createTagHistory } from '../src/behavior/mention.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createReads } from '../src/interface/reads.ts';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import type { MessageReceived } from '../src/protocol/events.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { baseConfig } from './fixtures/events-rig.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { channel as channelOf } from './fixtures/reads-rig.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const MINUTE = 60_000;
const SELF = 'self-id';
const ADDRESS_PROMPT = 'Is the candidate said to {{name}}?';

type Shape = { label: string; iface: string; place: Partial<ConversationInfo> & { id: string } };

// A server's channel, a group that is its own root place, and a group outside any community.
const GROUP_SHAPES: Array<Shape> = [
  { label: 'a channel under a root place', iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } },
  { label: 'a group that is its own root', iface: 'beta', place: { id: 'r1', kind: 'channel', rootId: 'r1' } },
  {
    label: 'a group outside any community',
    iface: 'gamma',
    place: { id: 'r2', kind: 'channel', chatType: 'group_dm', rootId: null },
  },
];
const [CHANNEL, ROOT_GROUP] = GROUP_SHAPES as [Shape, Shape, Shape];

type LlmCall = { system: string; user: string; options: { purpose?: string; role?: string } };
type TurnAsked = { triggerKind: string | null; trigger: { id: string; authorId: string }; conversation: object };

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
  const infoOf = ({ iface, place }: Shape): ConversationInfo =>
    channelOf(place.id, { iface, name: place.id, ...place });
  for (const shape of shapes) adapterOf(shape.iface).seedConversation(infoOf(shape));
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
      // The lead: the address classifier answers in strict JSON (owner, 2026-11-06); a scene's verdict word is sent as the object.
      return Promise.resolve({ text: JSON.stringify({ answer }), usage: {}, estimated: 1 });
    },
  };
  const started: Array<TurnAsked> = [];
  const facts: Array<Record<string, unknown>> = [];
  const hot = {
    config: baseConfig({
      bot: { timezone: 'UTC', nameTriggers: options.nameTriggers ?? [] },
      private: { enabled: true, minAffinity: 0 },
      address: {
        attentionMinutes: options.attentionMinutes ?? 30,
        maxTurnsPerAuthor: options.maxTurnsPerAuthor ?? 100,
      },
    }),
    prompts: { address: ADDRESS_PROMPT, labels, ...options.prompts },
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
      isServedCommunity: () => true,
      communitiesOf: () => [],
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
      conversation: { kind: 'channel', name: shape.place.id, ...shape.place },
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
        mentionedConversationIds: [],
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

for (const shape of GROUP_SHAPES) {
  test(`a line with no flag and no recent post of hers never reaches the classifier, in ${shape.label}`, async () => {
    // Bug: a name trigger or the old window opens the door by a word match.
    const scene = door({ nameTriggers: ['Nova'], rng: () => 0 });
    await scene.say(shape, { text: 'η Nova είπε κάτι χθες' });
    assert.equal(scene.calls.length, 0);
    assert.equal(scene.started.length, 0);
  });

  test(`a mention goes to the classifier at once and its yes starts a mention turn, in ${shape.label}`, async () => {
    // Bug: a flagged line skips the verdict and always opens a turn on one platform.
    const scene = door();
    await scene.say(shape, { mentioned: true });
    assert.equal(scene.calls.length, 1);
    assert.equal(scene.calls[0]?.options.purpose, 'address');
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['mention']
    );
  });

  test(`a line with no flag goes to the classifier while she wrote there recently, in ${shape.label}`, async () => {
    // Bug: the attention window is wired for only some kinds of place.
    const scene = door({ attentionMinutes: 60 });
    await scene.say(shape, { author: SELF });
    scene.clock.at += 45 * MINUTE;
    await scene.say(shape);
    assert.equal(scene.calls.length, 1);
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['followUp']
    );
  });
}

test('a reply to her goes to the classifier and its yes starts a reply turn', async () => {
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

test('a mention of her that also mentions another member still reaches the classifier', async () => {
  // Bug: the pre-filter for other members' mentions answers no before the flagged line is asked about.
  const scene = door();
  await scene.say(CHANNEL, { mentioned: true, alsoMentions: ['u2'] });
  assert.equal(scene.calls.length, 1);
});

test('a line at the edge of the attention window is outside it', async () => {
  // Bug: an off-by-one opens the classifier for a minute more than the setting says.
  const scene = door({ attentionMinutes: 5 });
  await scene.say(CHANNEL, { author: SELF });
  scene.clock.at += 5 * MINUTE - 1;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
  scene.clock.at += 1;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
});

test('the attention window is read at the moment of use', async () => {
  // Bug: the setting is cached when the handler is built.
  const scene = door({ attentionMinutes: 5 });
  await scene.say(CHANNEL, { author: SELF });
  scene.clock.at += 20 * MINUTE;
  (scene.hot.config.address as { attentionMinutes: number }).attentionMinutes = 60;
  await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 1);
});

test('her post opens attention only in its own place', async () => {
  // Bug: attention is global, so one post makes every place pay for the classifier.
  const scene = door({ shapes: [CHANNEL, ROOT_GROUP] });
  await scene.say(CHANNEL, { author: SELF });
  await scene.say(ROOT_GROUP);
  assert.equal(scene.calls.length, 0);
});

test('her post opens attention only on its own interface when two interfaces share a native id', async () => {
  // Bug: the window is keyed by the native id alone, so a collision opens another interface's place.
  const other: Shape = {
    label: 'the same id elsewhere',
    iface: 'beta',
    place: { id: 'c1', kind: 'channel', rootId: 'g1' },
  };
  const scene = door({ shapes: [CHANNEL, other] });
  await scene.say(CHANNEL, { author: SELF });
  await scene.say(other);
  assert.equal(scene.calls.length, 0);
});

test('a run of no verdicts does not close attention', async () => {
  // Bug: the follow-up window's no-streak survives and silences a place while she is still recent there.
  const scene = door({ answer: 'no' });
  await scene.say(CHANNEL, { author: SELF });
  for (let i = 0; i < 8; i += 1) await scene.say(CHANNEL);
  assert.equal(scene.calls.length, 8);
});

test('attention survives a restart of the handler', async () => {
  // Bug: the window lives only in memory, so a restart makes her deaf to the talk she just joined.
  const storeState = { data: {}, markDirty() {} };
  const before = door({ storeState });
  await before.say(CHANNEL, { author: SELF });
  const after = door({ storeState });
  await after.say(CHANNEL);
  assert.equal(after.calls.length, 1);
});

test('sixty calls of one member all get their verdict and their turn, and nothing is rolled', async () => {
  // Bug: the spam silence or the mention chance stays in front of the classifier.
  const scene = door({ maxTurnsPerAuthor: 1000 });
  for (let i = 0; i < 60; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 60);
  assert.equal(scene.started.length, 60);
});

for (const iface of ['alpha', 'beta', 'cli']) {
  test(`a DM line on ${iface} starts her private turn with no classifier call`, async () => {
    // Bug: moving the classifier into the door catches direct chats too, and pays for what is already addressed.
    const scene = door({ shapes: [shapeOfDm(iface)] });
    await scene.say(shapeOfDm(iface));
    assert.equal(scene.calls.length, 0);
    assert.deepEqual(
      scene.started.map((turn) => turn.triggerKind),
      ['private']
    );
  });
}

test('the per-author rail refuses the turn past its limit, after the verdict', async () => {
  // Bug: the rail counts calls instead of started turns, or a flagged line stops reaching the classifier.
  const scene = door({ maxTurnsPerAuthor: 2 });
  for (let i = 0; i < 3; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 3);
  assert.equal(scene.started.length, 2);
});

test('the per-author refusal is logged by count, without the line', async () => {
  // Bug: the refusal is silent, or the log carries message text.
  const scene = door({ maxTurnsPerAuthor: 1 });
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
  // Bug: the rail counts verdicts of any kind, so a chatty member is refused after lines she never answered.
  const verdicts = ['no', 'no', 'no', 'yes'];
  const scene = door({ maxTurnsPerAuthor: 1, answer: () => verdicts.shift() ?? 'no' });
  for (let i = 0; i < 4; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 1);
});

test('an overheard turn counts toward the per-author rail', async () => {
  // Bug: only yes is counted, so talk about her starts turns without a bound.
  const scene = door({ maxTurnsPerAuthor: 1, answer: 'overheard' });
  for (let i = 0; i < 2; i += 1) await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 1);
});

test('the per-author rail counts each author on their own', async () => {
  // Bug: the count is per place, so one member's turns silence another.
  const scene = door({ maxTurnsPerAuthor: 1 });
  await scene.say(CHANNEL, { mentioned: true, author: 'u1' });
  await scene.say(CHANNEL, { mentioned: true, author: 'u2' });
  assert.equal(scene.started.length, 2);
});

test('the per-author rail counts each place on its own', async () => {
  // Bug: the count is per author across places, so a member's talk elsewhere silences them here.
  const scene = door({ maxTurnsPerAuthor: 1, shapes: [CHANNEL, ROOT_GROUP] });
  await scene.say(CHANNEL, { mentioned: true });
  await scene.say(ROOT_GROUP, { mentioned: true });
  assert.equal(scene.started.length, 2);
});

test('the per-author rail forgets a turn once its window has passed', async () => {
  // Bug: the count never decays, so a member is refused for good.
  const scene = door({ maxTurnsPerAuthor: 1, attentionMinutes: 10 });
  await scene.say(CHANNEL, { mentioned: true });
  scene.clock.at += 10 * MINUTE;
  await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.started.length, 2);
});

test('a yes verdict while a turn runs is held, not started and not lost', async () => {
  // Bug: the flagged path through the classifier forgets the pending queue a call waits in.
  const scene = door({ busy: true });
  await scene.say(CHANNEL, { mentioned: true });
  assert.equal(scene.calls.length, 1);
  assert.equal(scene.started.length, 0);
  assert.equal(scene.handler.pendingCount(), 1);
});

test('a failed classifier call on a flagged line leaves a fact that names its interface', async () => {
  // Bug: a provider outage drops a direct call without a trace, or the recovery cannot find the place again.
  const scene = door({ fails: true });
  await scene.say(ROOT_GROUP, { mentioned: true });
  assert.equal(scene.facts.length, 1);
  assert.equal(scene.facts[0]?.iface, ROOT_GROUP.iface);
});

// The owner moved aliases to her person record: they come from `selfNames`, the names he gave `person:self`.
test('the names of her person record reach the classifier as an aliases block', async () => {
  // Bug: the engine still holds its own list, so a nickname from the card is unknown to the verdict.
  const scene = door({ selfNames: ['Νόβα', 'Novita'], nameTriggers: ['Ενγκίνε'] });
  await scene.say(CHANNEL, { mentioned: true });
  const aliases = /<aliases>\n([\s\S]*?)\n<\/aliases>/.exec(JSON.parse(scene.calls[0]?.user ?? '""') as string)?.[1];
  assert.deepEqual(aliases?.split('\n'), ['Νόβα', 'Novita']);
});

test('a person record with no names adds no block, and no configured trigger stands in for it', async () => {
  // Bug: `bot.nameTriggers` keeps feeding the request as a hidden name list.
  const scene = door({ selfNames: [], nameTriggers: ['Ενγκίνε'] });
  await scene.say(CHANNEL, { mentioned: true });
  const user = scene.calls[0]?.user ?? '';
  assert.equal(user.includes('<aliases>'), false);
  assert.equal(user.includes('Ενγκίνε'), false);
});
