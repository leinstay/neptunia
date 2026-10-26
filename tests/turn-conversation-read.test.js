// conversation.read in a turn (features.coreTools, src/behavior/turn.js): her call reads a channel
// from the record first and the interface's history when the record lacks the span, the lines
// carry handles that resolve in the next steps (message calls, before=/around= paging), a channel
// the pull rail hides is refused. Over a real admin and the fake interface adapter; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { onWorld, useIface, world } from './fixtures/turn-world.ts';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { createAdmin } from '../src/admin.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';

// The conversations are held by a fake interface named `fake`.
useIface('fake');
const createTurnRunner = onWorld(createRealTurnRunner);

const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 3_600_000;
const L = {
  ...labels,
  skills: {
    ...labels.skills,
    tools: {
      ...labels.skills.tools,
      conversation: {
        source: 'from conversation.read #{channel}',
        handles: 'lines carry message numbers',
        none: 'no messages',
        cut: '({dropped} lines cut)',
        earlier: 'earlier: before=#{n}',
        later: 'later: after=#{n}',
      },
    },
  },
};

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 1000,
  content = 'hey bot',
  channelId = 'c1',
}) {
  return {
    id,
    channelId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw) {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/**
 * The server: #general (c1, the turn's), #jardin (c2, readable), #secret (c3, the bot cannot read it), in the world of
 * the test. `fetches` lists the history reads made of each.
 */
function fakeServer(history, jardinLive = []) {
  const fetches = { c1: [], c2: [], c3: [] };
  world().tap('history', ([ref, query]) => {
    fetches[ref.conversationId]?.push(query);
  });
  const channels = new Map([
    ['c1', world().channel({ id: 'c1', name: 'general', guildId: 'g1', historyMessages: history })],
    ['c2', world().channel({ id: 'c2', name: 'jardin', guildId: 'g1', historyMessages: jardinLive })],
    ['c3', world().channel({ id: 'c3', name: 'secret', guildId: 'g1', permissions: { read: false } })],
  ]);
  return { channels, fetches };
}

function fakeStore() {
  const profiles = [{ id: 'u7', names: ['Éloïse'] }];
  return {
    getGuild: () => ({}),
    getUser: (guildId, id) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith(allowed, features) {
  return {
    config: {
      bot: {
        timezone: 'UTC',
        dryRunChannelId: '',
        owners: ['u1'],
        access: Object.fromEntries(allowed.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: false },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        record: true,
        ...features,
      },
      models: { base: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      skills: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 4, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.',
      labels: L,
    },
  };
}

function sequenceLlm(answers) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      if (messages[0].content.startsWith('Decide whether') || messages[0].content.startsWith('Pick a second look'))
        return { text: 'none', usage: {}, estimated: 5 };
      calls.push(messages);
      return completionOf(answers[Math.min(calls.length - 1, answers.length - 1)]);
    },
  };
}

/** A record line of channel `channel`, `hoursAgo` before NOW. */
function line(id, hoursAgo, text, { channel = 'c2', kind = 'seen', by = 'u7', revision = 1 } = {}) {
  const at = new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    kind,
    messageId: id,
    revision,
    occurredAt: at,
    recordedAt: at,
    scope: { channel },
    ...(kind === 'said' ? {} : { by }),
    text,
    media: [],
    mentions: [],
  };
}

function fakeRecord(lines) {
  const reads = [];
  return {
    reads,
    append: async () => ({ written: 0, duplicates: 0 }),
    iterate: async function* iterate(guildId, query) {
      reads.push(query);
      for (const entry of lines) {
        if (query.channelIds && !query.channelIds.includes(entry.scope.channel)) continue;
        if (query.from && Date.parse(entry.occurredAt) < Date.parse(query.from)) continue;
        yield entry;
      }
    },
  };
}

const JARDIN = [
  line('q0', 6, 'παλιότερη γραμμή'),
  line('q2', 5, 'ξένο κείμενο'),
  line('q1', 4, 'παλιό κείμενο', { kind: 'said' }),
  line('q3', 3, 'πριν την αλλαγή'),
  line('q3', 3, 'μετά την αλλαγή', { revision: 2 }),
  line('q4', 2, 'θα διαγραφεί'),
  {
    kind: 'deleted',
    messageId: 'q4',
    occurredAt: new Date(NOW - 2 * HOUR).toISOString(),
    scope: { channel: 'c2' },
    participants: ['u7'],
  },
  line('q5', 1, 'η τελευταία'),
];

/** One mention in #general answered with `answers` in turn; `record` and `jardinLive` are what the record and the history of #jardin hold. */
async function turn({
  answers,
  allowed = ['conversation.read'],
  record = fakeRecord(JARDIN),
  jardinLive = [],
  features = {},
  seeds = [],
}) {
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoë', content: 'καλημέρα' }),
    rawMessage({ id: 'm1', content: 'διάβασε το jardin' }),
  ];
  const hot = hotWith(allowed, features);
  const server = fakeServer(history, jardinLive);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const seed of seeds) port.seed(seed.conversationId, seed);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  const admin = createAdmin({ hot, store, client, getGuildId: () => 'g1', reads: world().adopt(port), port });
  const llm = sequenceLlm(answers);
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    record,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: server.channels.get('c1'),
      mode: 'reply',
      trigger: normalizedTrigger(history[1]),
      triggerKind: 'mention',
    })
  );
  return { result, logs, llm, port, server, record };
}

/** What she read of her calls in request `i`: the content of each tool message, in order. */
const toolReads = (llm, i) =>
  llm.calls[i]
    .filter((message) => message.role === 'tool')
    .map((message) =>
      typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join('')
    );
const requestText = (llm, i) => toolReads(llm, i).join('\n');
const handleOf = (text, needle) => Number(new RegExp(`^#(\\d+) .*${needle}`, 'm').exec(text)?.[1]);

test('conversation.read in a turn: the channel comes from the record with the edit and deletion marks, nothing is fetched from the history', async () => {
  const run = await turn({
    answers: [toolAnswer('', [call('conversation.read', { channel: 'jardin', last: 6 })]), '<skip/>'],
  });
  const text = requestText(run.llm, 1);
  assert.ok(text.startsWith(labels.skills.result.ok), text);
  assert.ok(text.includes('from conversation.read #jardin'), text);
  assert.ok(text.includes('lines carry message numbers'), text);
  assert.match(text, /^#\d+ \[\d\d:\d\d\] Éloïse: μετά την αλλαγή \(edited\)$/m);
  assert.ok(
    !text.includes('πριν την αλλαγή') && !text.includes('θα διαγραφεί'),
    'the newest revision stands, a deleted text is gone'
  );
  assert.match(text, /Éloïse: message deleted/);
  assert.ok(text.includes('earlier: before=#'), text);
  assert.deepEqual(run.server.fetches.c2, [], 'the record held the span');
});

test('handles: a line she read is a message she can edit or page from in the next steps, in its own channel', async () => {
  const probe = await turn({
    answers: [toolAnswer('', [call('conversation.read', { channel: 'jardin', last: 6 })]), '<skip/>'],
  });
  const probeText = requestText(probe.llm, 1);
  const mine = handleOf(probeText, 'παλιό κείμενο');
  const theirs = handleOf(probeText, 'ξένο κείμενο');
  const first = handleOf(probeText, 'ξένο κείμενο');
  assert.ok(mine > 3 && theirs === mine - 1, `numbered past the chat: ${mine} ${theirs}`);
  const run = await turn({
    answers: [
      toolAnswer('', [call('conversation.read', { channel: 'jardin', last: 6 })]),
      toolAnswer(``, [
        call('message.edit', { message: `#${mine}`, text: `νέο κείμενο` }),
        call('conversation.read', { before: `#${first}`, last: 2 }),
      ]),
      '<skip/>',
    ],
    allowed: ['conversation.read', 'message.edit'],
    seeds: [{ conversationId: 'c2', authorId: 'self-id', messageId: 'q1', text: 'παλιό κείμενο' }],
  });
  const edits = run.port.calls
    .filter((call) => call.op === 'edit')
    .map((call) => [call.args[0].conversationId, call.args[0].messageId, call.args[1].text]);
  assert.deepEqual(edits, [['c2', 'q1', 'νέο κείμενο']]);
  const third = requestText(run.llm, 2);
  const blocks = toolReads(run.llm, 2).filter((content) => content.includes('from conversation.read'));
  assert.equal(blocks.length, 2, 'both reads are in the continuation');
  assert.ok(blocks[1].includes('παλιότερη γραμμή') && !blocks[1].includes('ξένο κείμενο'), blocks[1]);
  assert.ok(blocks[1].includes('from conversation.read #jardin'), 'before= resolved to the channel of the line');
});

test('around a transcript number: #N of the chat she sees names the message and the channel, read from the record', async () => {
  const record = fakeRecord([
    line('m0', 5000 / HOUR, 'καλημέρα', { channel: 'c1', by: 'u2' }),
    line('m9', 3000 / HOUR, 'μετά', { channel: 'c1', by: 'u2' }),
  ]);
  const run = await turn({
    answers: [toolAnswer('', [call('conversation.read', { around: '#1', before: '0', after: '3' })]), '<skip/>'],
    record,
  });
  const text = requestText(run.llm, 1);
  assert.ok(text.startsWith(labels.skills.result.ok), text);
  assert.ok(
    text.includes('from conversation.read #general') && text.includes('καλημέρα') && text.includes('μετά'),
    text
  );
});

test('the record lacks the span: the history of the channel is asked and its lines come back with handles', async () => {
  const jardinLive = [
    rawMessage({
      id: 'h1',
      ts: NOW - 2 * HOUR,
      authorId: 'u7',
      authorName: 'Éloïse',
      content: 'από το ιστορικό',
      channelId: 'c2',
    }),
  ];
  const run = await turn({
    answers: [toolAnswer('', [call('conversation.read', { channel: 'jardin', last: 3 })]), '<skip/>'],
    record: fakeRecord([]),
    jardinLive,
  });
  assert.deepEqual(run.server.fetches.c2, [{ limit: 3 }]);
  const text = requestText(run.llm, 1);
  assert.match(text, /^#\d+ \[\d\d:\d\d\] Éloïse: από το ιστορικό$/m);
});

test('a channel the pull rail hides is refused channel-not-visible and nothing of it is read', async () => {
  const run = await turn({
    answers: [toolAnswer('', [call('conversation.read', { channel: 'secret', last: 3 })]), '<skip/>'],
  });
  const text = requestText(run.llm, 1);
  assert.ok(
    text.startsWith(
      fill(labels.skills.result.refused, { reason: labels.skills.result.reasons['channel-not-visible'] })
    ),
    'a refusal is a result with its reason, no data'
  );
  assert.ok(!text.includes('from conversation.read'), text);
  assert.deepEqual(run.server.fetches.c3, []);
  assert.ok(run.record.reads.every((query) => !query.channelIds?.includes('c3')));
  assert.ok(
    run.logs.some(
      (entry) =>
        entry.msg === 'skills: called' && entry.skill === 'conversation.read' && entry.code === 'channel-not-visible'
    )
  );
});

test('not granted: the call is refused before anything is read', async () => {
  const run = await turn({
    answers: [toolAnswer('', [call('conversation.read', { channel: 'jardin' })]), '<skip/>'],
    allowed: ['lore.list'],
  });
  assert.ok(
    run.record.reads.every((query) => !query.channelIds?.includes('c2')),
    'the record of #jardin was not read'
  );
  assert.deepEqual(run.server.fetches.c2, []);
  assert.ok(!requestText(run.llm, 1).startsWith(labels.skills.result.ok));
});
