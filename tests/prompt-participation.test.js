// Tests for the `<participation>` block of src/behavior/prompt.js#buildRequest:
// the persona's own exchanges on other channels, selected, deduplicated against
// the rest of the request, cut, budgeted and rendered after `<recent>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { fill, formatClock } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'Europe/Athens';
const HERE = 'c1';

function fakeConfig({ features = {}, caps = {}, participation = {} } = {}) {
  return {
    bot: { timezone: TZ },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      ageAfterMinutes: 60,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, recent: 1200, ...caps },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
    },
    features: { vision: true, relationships: true, episodes: true, lore: true, recent: true, participation: true, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    memory: { recentHours: 72 },
    participation: { hours: 72, shown: 4, perChannel: 2, episodeChars: 1800, ...participation },
  };
}

function prompts(labelOverrides = null) {
  return {
    'system-prompt': 'SYSTEM for {{name}}',
    'character-card': 'CARD',
    rules: 'RULES',
    format: 'FORMAT',
    reply: 'Called by {{author}}.',
    interject: 'INTERJECT',
    initiate: 'INITIATE',
    labels: labelOverrides ?? labels,
  };
}

function chatLine(id, ts, overrides = {}) {
  return { id, ts, authorId: `a-${id}`, authorName: `User${id}`, self: false, content: `message ${id}`, attachments: [], stickers: [], replyToId: null, ...overrides };
}

/** A stored participation message. */
function stored(id, ts, { name = 'Ana', authorId = 'u1', self = false, text = `γραμμή ${id}`, caption = null, replyTo = null } = {}) {
  return { id, ts, authorId: self ? 'self' : authorId, name: self ? 'Zoë' : name, self, text, replyTo, caption };
}

/** p1 in #journal (c2, 2 h ago), p2 in #jardin (c3, 30 min ago). */
function state(extra = []) {
  return {
    nextId: 10,
    episodes: [
      {
        id: 'p1',
        channelId: 'c2',
        continues: null,
        messages: [stored('a1', NOW - 2 * HOUR - MIN, { text: 'πού είναι το βιβλίο;' }), stored('a2', NOW - 2 * HOUR, { self: true, text: 'στο ράφι' })],
      },
      {
        id: 'p2',
        channelId: 'c3',
        continues: null,
        messages: [stored('b1', NOW - 30 * MIN, { self: true, text: 'ωραία λουλούδια', caption: 'a red tulip' })],
      },
      ...extra,
    ],
  };
}

const CHANNELS = [
  { id: HERE, name: 'general' },
  { id: 'c2', name: 'journal', purpose: 'a reading log' },
  { id: 'c3', name: 'jardin' },
];

function input(overrides = {}) {
  const trigger = chatLine('m1', NOW - MIN, { authorName: 'Nikos', content: 'θυμάσαι το βιβλίο;' });
  return {
    config: fakeConfig(),
    prompts: prompts(),
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Zoë',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: CHANNELS,
    currentChannelId: HERE,
    participation: { state: state(), pickedIds: [], audience: () => true, channelName: () => null },
    ...overrides,
  };
}

const textOf = (request) => contentText(request.messages[1].content);
const blockOf = (text, tag) => {
  const start = text.indexOf(`<${tag}>\n`);
  return start === -1 ? null : text.slice(start + tag.length + 3, text.indexOf(`\n</${tag}>`, start));
};
const clock = (ts) => formatClock(ts, TZ, labels.locale);
const aged = (ts, age) => fill(labels.transcript.timeAged, { clock: clock(ts), age });

test('participation block: header, channel lines once per channel, episodes with their age, lines in the transcript form', () => {
  const request = buildRequest(input());
  const body = blockOf(textOf(request), 'participation');
  assert.equal(
    body,
    [
      fill(labels.participation.header, { hours: 72 }),
      '#jardin:',
      '30 min ago:',
      `[${clock(NOW - 30 * MIN)}] Zoë (you): ωραία λουλούδια [image: a red tulip]`,
      '#journal (a reading log):',
      '2 h ago:',
      `${aged(NOW - 2 * HOUR - MIN, '2 h 1 min')} Ana: πού είναι το βιβλίο;`,
      `${aged(NOW - 2 * HOUR, '2 h')} Zoë (you): στο ράφι`,
    ].join('\n'),
  );
  assert.ok(!body.includes('#1 ') && !body.includes('#2 '), 'no #n index');
  assert.deepEqual(
    { ...request.stats.participation, used: undefined },
    { used: undefined, kept: 3, dropped: 0, offered: 2, shown: 2, cut: 0, deduped: 0 },
  );
});

test('participation block: right after <recent>, before <other_channels>, in the tail', () => {
  const recentLines = [{ id: 1, at: NOW - HOUR, addedAt: new Date(NOW).toISOString(), channelId: HERE, text: 'σημείωση', who: [], weight: 2 }];
  const neighbors = [{ channelId: 'c4', channelName: 'next', messages: [chatLine('n1', NOW - 2 * MIN, { channelId: 'c4' })] }];
  const text = textOf(buildRequest(input({ recentLines, neighbors })));
  const recent = text.indexOf('<recent>');
  const participation = text.indexOf('<participation>');
  const others = text.indexOf('<other_channels>');
  assert.ok(recent !== -1 && participation > recent && others > participation, text);
  assert.ok(participation > text.indexOf('<people>') || text.indexOf('<people>') === -1);
});

test('participation block: the senses line is there with the block and gone without it', () => {
  const sense = labels.senses.participation;
  // A per-turn line: in the tail's <senses>, never in a cached part.
  const parts = buildRequest(input()).messages[1].content.filter((part) => part.type === 'text');
  assert.ok(blockOf(parts.at(-1).text, 'senses').includes(sense));
  assert.ok(parts.filter((part) => part.cacheSegment).every((part) => !part.text.includes(sense)));
  const off = textOf(buildRequest(input({ config: fakeConfig({ features: { participation: false } }) })));
  assert.equal(blockOf(off, 'participation'), null);
  assert.ok(!off.includes(sense));
  const empty = textOf(buildRequest(input({ participation: { state: { episodes: [], nextId: 1 }, audience: () => true } })));
  assert.ok(!empty.includes(sense) && !empty.includes('<participation>'));
});

test('participation block: a missing header or episode label means no block and no senses line', () => {
  for (const key of ['header', 'episode']) {
    const partial = { ...labels, participation: { ...labels.participation, [key]: '' } };
    const text = textOf(buildRequest(input({ prompts: prompts(partial) })));
    assert.equal(blockOf(text, 'participation'), null, key);
    assert.ok(!text.includes(labels.senses.participation), key);
  }
});

test('participation block: never in a private chat', () => {
  const trigger = chatLine('d1', NOW - MIN, { content: 'θυμάσαι το βιβλίο;' });
  const text = textOf(buildRequest(input({ history: [trigger], trigger, triggerKind: 'private', currentChannelId: 'dm1', privateChat: { userId: 'a-d1' } })));
  assert.equal(blockOf(text, 'participation'), null);
  assert.ok(!text.includes(labels.senses.participation));
});

test('participation block: the audience and the current channel decide what is offered', () => {
  const onlyJardin = textOf(buildRequest(input({ participation: { state: state(), audience: (id) => id === 'c3' } })));
  assert.ok(onlyJardin.includes('#jardin:') && !onlyJardin.includes('#journal'));
  const fromJournal = textOf(buildRequest(input({ currentChannelId: 'c2' })));
  assert.ok(!blockOf(fromJournal, 'participation').includes('#journal'), 'never the current channel');
  const noAudience = textOf(buildRequest(input({ participation: { state: state() } })));
  assert.equal(blockOf(noAudience, 'participation'), null, 'no audience predicate offers nothing');
});

test('participation block: a line shown in the chat, a neighbour or a pulled channel is dropped; an episode without an own line goes', () => {
  // a1 (a member's line of p1) is in the chat: dropped, p1 stays.
  const trigger = chatLine('m1', NOW - MIN, { content: 'θυμάσαι;' });
  const inChat = buildRequest(input({ history: [chatLine('a1', NOW - 2 * HOUR - MIN), trigger], trigger }));
  const chatBody = blockOf(textOf(inChat), 'participation');
  assert.ok(!chatBody.includes('πού είναι το βιβλίο;') && chatBody.includes('στο ράφι'));
  assert.equal(inChat.stats.participation.deduped, 1);
  // b1 (p2's only own line) is a neighbour's line: p2 goes whole.
  const neighbors = [{ channelId: 'c4', channelName: 'next', messages: [chatLine('b1', NOW - 30 * MIN, { channelId: 'c4' })] }];
  const inNeighbor = buildRequest(input({ neighbors }));
  const neighborBody = blockOf(textOf(inNeighbor), 'participation');
  assert.ok(!neighborBody.includes('#jardin') && neighborBody.includes('#journal'));
  assert.equal(inNeighbor.stats.participation.cut, 1);
  // a2 (p1's own line) in a pulled channel: p1 goes.
  const pulled = [{ channelId: 'c5', channelName: 'pulled', messages: [chatLine('a2', NOW - 2 * HOUR, { channelId: 'c5' })], descriptions: new Map(), readOnly: false }];
  const inPulled = buildRequest(input({ pulled }));
  const pulledBody = blockOf(textOf(inPulled), 'participation');
  assert.ok(textOf(inPulled).includes('<channel_view>'), 'the pulled channel is shown');
  assert.ok(!pulledBody.includes('#journal') && pulledBody.includes('#jardin'), pulledBody);
});

test('participation block: picks come first and win the budget; the newest fill up', () => {
  const tight = fakeConfig({ participation: { shown: 1 } });
  const picked = blockOf(textOf(buildRequest(input({ config: tight, participation: { state: state(), pickedIds: ['p1'], audience: () => true } }))), 'participation');
  assert.ok(picked.includes('#journal') && !picked.includes('#jardin'));
  const newest = blockOf(textOf(buildRequest(input({ config: tight }))), 'participation');
  assert.ok(newest.includes('#jardin') && !newest.includes('#journal'));
});

test('participation block: context.caps.participation cuts whole episodes, the picked one kept', () => {
  const probe = buildRequest(input({ participation: { state: state(), pickedIds: ['p1'], audience: () => true } }));
  const cap = probe.stats.participation.used - 3;
  const request = buildRequest(input({ config: fakeConfig({ caps: { participation: cap } }), participation: { state: state(), pickedIds: ['p1'], audience: () => true } }));
  const body = blockOf(textOf(request), 'participation');
  assert.ok(body.includes('#journal (a reading log):') && !body.includes('#jardin'), body);
  assert.equal(request.stats.participation.shown, 1);
  assert.equal(request.stats.participation.cut, 1);
  const none = buildRequest(input({ config: fakeConfig({ caps: { participation: 5 } }) }));
  assert.equal(blockOf(textOf(none), 'participation'), null, 'the header alone makes no block');
  assert.ok(!textOf(none).includes(labels.senses.participation));
});

test('participation block: a long episode is cut to episodeChars, keeping lines that share a word with the candidate', () => {
  const long = {
    id: 'p3',
    channelId: 'c3',
    continues: null,
    messages: [
      stored('c1m', NOW - 50 * MIN, { text: 'αρχή της κουβέντας εδώ' }),
      stored('c2m', NOW - 49 * MIN, { text: 'x'.repeat(60) }),
      stored('c3m', NOW - 48 * MIN, { text: 'y'.repeat(60) }),
      stored('c4m', NOW - 47 * MIN, { text: 'μιλάμε για ποδήλατο τώρα' }),
      stored('c5m', NOW - 46 * MIN, { text: 'z'.repeat(60) }),
      stored('c6m', NOW - 45 * MIN, { text: 'w'.repeat(60) }),
      stored('c7m', NOW - 44 * MIN, { self: true, text: 'εντάξει' }),
    ],
  };
  const trigger = chatLine('m1', NOW - MIN, { content: 'το Ποδήλατο;' });
  const config = fakeConfig({ participation: { episodeChars: 100 } });
  const request = buildRequest(input({ config, history: [trigger], trigger, participation: { state: { episodes: [long], nextId: 4 }, audience: () => true } }));
  const body = blockOf(textOf(request), 'participation');
  assert.ok(body.includes('μιλάμε για ποδήλατο τώρα'), 'the line sharing a word with the candidate is kept');
  assert.ok(body.includes('εντάξει'), 'the persona\'s own line is kept');
  assert.ok(body.includes(fill(labels.participation.skipped, { count: 1 })) || body.includes(fill(labels.participation.skipped, { count: 2 })), body);
});

test('participation block: a channel with no stored name takes the live name, and no name at all drops it', () => {
  const names = { c3: 'jardin-live' };
  const live = blockOf(textOf(buildRequest(input({ channels: [], participation: { state: state(), audience: () => true, channelName: (id) => names[id] ?? null } }))), 'participation');
  assert.ok(live.includes('#jardin-live:') && !live.includes('journal'));
});
