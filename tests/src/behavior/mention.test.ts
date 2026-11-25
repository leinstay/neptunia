// Tests for src/behavior/mention.ts: whether and how the persona was called, whether the persona reacts to it at
// all, and the reader of the address classifier's strict JSON answer.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTrigger,
  createTagHistory,
  decideTurn,
  inAttention,
  followUpPreFilter,
  parseAddressAnswer,
  followUpTriggerKind,
  isTaggedCall,
} from '../../../src/behavior/mention.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannelWithHistory,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  openFollowUpWindow,
  scripted,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { refTo, useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

// --- detectTrigger ----------------------------------------------------------
// The door has no name triggers. A reply ranks above a mention.

test('detectTrigger: a reply takes priority over a mention', () => {
  assert.equal(detectTrigger({ mentionsSelf: true, repliesToSelf: true }), 'reply');
});

test('detectTrigger: a line with no flag has no kind', () => {
  assert.equal(detectTrigger({ mentionsSelf: false, repliesToSelf: false }), null);
});

// --- createTagHistory -----------------------------------------------------------

test('createTagHistory: counts hits within the window, this call included', () => {
  const history = createTagHistory();
  assert.equal(history.hit('u1', 1000, 60_000), 1);
  assert.equal(history.hit('u1', 2000, 60_000), 2);
  assert.equal(history.hit('u1', 3000, 60_000), 3);
});

test('createTagHistory: hits outside the window age out', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 1000);
  assert.equal(history.hit('u1', 5000, 1000), 1); // the first hit is long gone
});

test('createTagHistory: tracks different users independently', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 60_000);
  assert.equal(history.hit('u2', 100, 60_000), 1);
});

// --- decideTurn -------------------------------------------------------------
// The per-author rail decides a turn and rolls nothing. An author in neverIgnore always gets one.

test('decideTurn: neverIgnore always responds, whatever the count', () => {
  const result = decideTurn({ turns: 60, limit: 1, neverIgnore: true });
  assert.equal(result.respond, true);
  assert.equal(result.reason, 'never-ignore');
});

test('decideTurn: the limit refuses the turn past it, and under it every turn starts', () => {
  assert.equal(decideTurn({ turns: 50, limit: 50, neverIgnore: false }).respond, false);
  assert.equal(decideTurn({ turns: 49, limit: 50, neverIgnore: false }).respond, true);
});

test('decideTurn: a limit of zero turns the rail off', () => {
  assert.equal(decideTurn({ turns: 1000, limit: 0, neverIgnore: false }).respond, true);
});

test('isTaggedCall: a typed tag counts, the reply ping alone does not', () => {
  assert.equal(isTaggedCall({ mentionedAccountIds: ['s1'], replyPingAccountId: null }, 's1'), true);
  assert.equal(isTaggedCall({ mentionedAccountIds: ['s1'], replyPingAccountId: 's1' }, 's1'), false);
  assert.equal(isTaggedCall({ mentionedAccountIds: ['u2'], replyPingAccountId: null }, 's1'), false);
  assert.equal(isTaggedCall({}, 's1'), false);
});

// --- The address classifier: inAttention / followUpPreFilter ---------------------

// Attention is the window after the persona's own post. A run of `no` verdicts leaves it open.
test("inAttention: false with no post of the persona's", () => {
  assert.equal(inAttention(undefined, 1000, 15), false);
});

test('inAttention: false at the edge of the window, true a moment before', () => {
  assert.equal(inAttention(1000, 1000 + 15 * 60_000, 15), false);
  assert.equal(inAttention(1000, 1000 + 15 * 60_000 - 1, 15), true);
});

test('followUpPreFilter: a reply to another member reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: [], replyPingAccountId: null };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply whose only mention is the implicit reply ping reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: ['u2'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply that also mentions a third member explicitly is "no" material', () => {
  const normalized = { replyToId: 'm100', mentionedAccountIds: ['u2', 'u3'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: the reply-ping exemption only applies to a reply', () => {
  const normalized = { replyToId: null, mentionedAccountIds: ['u2'], replyPingAccountId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: a mention of the persona itself does not pre-filter', () => {
  const normalized = { replyToId: null, mentionedAccountIds: ['self1'] };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: mentionedAccountIds omitted is treated as empty', () => {
  const rows: Array<[string, { replyToId: null; mentionedAccountIds?: Array<string> }]> = [
    ['plain text with no reply and no mention reaches the model', { replyToId: null, mentionedAccountIds: [] }],
    ['mentionedAccountIds omitted is treated as empty', { replyToId: null }],
  ];
  for (const [label, normalized] of rows) {
    // The omitted field is the case under test, so the row is passed as the full shape it stands in for.
    assert.equal(followUpPreFilter(normalized as Parameters<typeof followUpPreFilter>[0], 'self1'), false, label);
  }
});

test('parseAddressAnswer: the three objects read as their answers', () => {
  assert.equal(parseAddressAnswer('{"answer":"yes"}'), 'yes');
  assert.equal(parseAddressAnswer('{"answer":"overheard"}'), 'overheard');
  assert.equal(parseAddressAnswer('{"answer":"no"}'), 'no');
});

test('parseAddressAnswer: bare words, other values and anything else are unreadable', () => {
  for (const text of [
    'yes',
    'Overheard.',
    'no',
    '',
    '   ',
    null,
    undefined,
    '{"answer":"maybe"}',
    '{"verdict":"yes"}',
    '```json\n{"answer":"yes"}\n```',
    '**yes**',
  ]) {
    assert.equal(parseAddressAnswer(text), null, JSON.stringify(text));
  }
});

// --- parseAddressAnswer over the strict JSON answer of the address classifier ---------------

const ADDRESS_UNREADABLE = [
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

test('parseAddressAnswer reads the answer field of the object text', () => {
  assert.equal(parseAddressAnswer('{"answer":"yes"}'), 'yes');
  assert.equal(parseAddressAnswer(' {"answer": "overheard"}\n'), 'overheard');
  assert.equal(parseAddressAnswer('{"answer":"no"}'), 'no');
});

test('parseAddressAnswer gives null for every unreadable answer and for no answer', () => {
  for (const text of [...ADDRESS_UNREADABLE, '', '   ', null, undefined]) {
    assert.equal(parseAddressAnswer(text), null, JSON.stringify(text));
  }
});

test('followUpTriggerKind: no starts nothing, yes a followUp turn, overheard an overheard turn', () => {
  assert.equal(followUpTriggerKind('no'), null);
  assert.equal(followUpTriggerKind('yes'), 'followUp');
  assert.equal(followUpTriggerKind('overheard'), 'overheard');
});

const NOW = Date.parse('2026-11-05T12:00:00Z');

const SELF = 'self-id';

// The aliases live on the persona's person record: they come from `selfNames`, the names given to `person:self`.
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
          // The lead: the address classifier answers in strict JSON, and a scene's verdict word is sent as the object.
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

test('a declined form of an alias reaches the classifier through the stemmer', async () => {
  // Bug: only the base form matches, so "της Ζεφύρας" never reaches the persona.
  const scene = door();
  await scene.say(GROUP, 'τι λέει η γνώμη της Ζεφύρας;');
  assert.equal(scene.calls.length, 1);
});

test('without a stemmer an alias still matches as a whole word in any case', async () => {
  // Bug: a missing stemmer turns the gate off altogether.
  const scene = door({ stemmer: null });
  await scene.say(GROUP, 'zefira, hello?');
  assert.equal(scene.calls.length, 1);
});

for (const stemmer of [GREEK_STEMS, null]) {
  test(`a short alias inside a longer word does not open the gate${stemmer ? '' : ' without a stemmer'}`, async () => {
    // Bug: a substring match makes "Ilona" a call to the persona.
    const scene = door({ stemmer });
    await scene.say(GROUP, 'Ilona brought the cake');
    assert.equal(scene.calls.length, 0);
  });
}

describe('the event pipeline over the fake interface', () => {
  let ownerAccounts = (): void => {};
  before(() => {
    useIface('fake');
    useSelf('self1');
    ownerAccounts = ownedBy(['owner1']);
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    ownerAccounts();
  });

  test('events: a mention with rng above ignoreChance runs a reply turn', async () => {
    let seenArgs: Untyped = null;
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        seenArgs = args;
        return { outcome: 'spoke' };
      },
    });
    const memory = fakeMemory();
    const handler = makeHandler({ turns, memory, rng: scripted([0.99]) });

    const message = fakeMessage({
      cleanContent: 'γεια',
      mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    });
    await handler(message);
    // let the fire-and-forget runTurn promise settle
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(seenArgs, 'expected runTurn to be called');
    assert.deepEqual(seenArgs.chat, refTo(message.channel));
    assert.equal(seenArgs.mode, 'reply');
    assert.equal(seenArgs.triggerKind, 'mention');
    assert.equal(seenArgs.trigger.content, 'γεια');
    assert.equal(memory.observeCalls.length, 1);
  });

  test('follow-up: a reply carrying only the implicit reply ping reaches the classifier', async () => {
    const llm = fakeFollowUpLlm();
    const handler = makeHandler({ llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      content: 'and what do you think',
      cleanContent: 'and what do you think',
      reference: { messageId: 'm-other' },
      mentions: { users: new Map([['u2', { id: 'u2' }]]), repliedUser: { id: 'u2' } },
    });
    const pending = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(llm.calls.length, 1, 'the reply ping is not a mention of another member');
    llm.respond('no');
    await pending;
  });

  test('follow-up: a reply that also mentions a third member is "no" without consulting the model', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    await handler(
      fakeMessage({
        guild,
        channel,
        placeId: 'c1',
        content: '<@u3> look at this',
        cleanContent: '@Carol look at this',
        reference: { messageId: 'm-other' },
        mentions: {
          users: new Map([
            ['u2', { id: 'u2' }],
            ['u3', { id: 'u3' }],
          ]),
          repliedUser: { id: 'u2' },
        },
      })
    );

    assert.equal(llm.calls.length, 0);
    assert.equal(spontaneous.onMessageCalls.length, 0, 'handled by the pre-filter, not handed to spontaneous');
  });

  test('follow-up: a mention of another member is "no" without consulting the model', async () => {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const msg = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: '@Bob check this out',
      mentions: { users: new Map([['u2', { id: 'u2' }]]) },
    });
    await handler(msg);

    assert.equal(llm.calls.length, 0, 'a mention of another member never reaches the model');
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });
});
