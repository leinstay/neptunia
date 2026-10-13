// The token limit buildRequest (src/behavior/prompt.js) fits a request under: `llm.safetyMargin`
// read with the validated fallback of src/llm/budget.js#requestTokenLimit (0.9), and `context.vision.tokensPerImage`
// with the same default the llm rail charges (400, src/llm/tokens.js#estimateMessages). Then where
// a pulled channel (`<channel_view>`) sits in that budget: capped by `context.caps.pulled`, after
// the chat on an ordinary turn, before it on a routed one, never a reason to fail the request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { estimateMessages, estimateTokens } from '../src/llm/tokens.js';
import { fill, formatClock, formatDate, formatDuration } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
// prompt.js keeps this many tokens for the tags around the blocks.
const TAG_OVERHEAD = 60;

function input({ llm = {}, vision = {}, picture = false } = {}) {
  const trigger = {
    id: '1',
    ts: NOW - 60_000,
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content: 'regarde',
    attachments: picture ? [{ id: 'p1', kind: 'image', name: 'photo.png', url: 'https://cdn.example/photo.png' }] : [],
    stickers: [],
    replyToId: null,
  };
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, pulled: 4000 },
        vision: { maxImages: 2, imageSize: 512, recentImages: 0, recentImageMinutes: 0, ...vision },
      },
      features: {},
      llm: { maxRequestTokens: 50000, ...llm },
      lore: { scanMessages: 30 },
      memory: {},
    },
    prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', reply: 'REPLY_TASK', labels },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
  };
}

test('buildRequest: a missing or unusable llm.safetyMargin is read as 0.9, a usable one as given', () => {
  for (const safetyMargin of [undefined, 1.5]) {
    const { stats } = buildRequest(input({ llm: { safetyMargin } }));
    assert.equal(stats.limit, Math.floor(50000 * 0.9) - TAG_OVERHEAD, String(safetyMargin));
  }
  assert.equal(buildRequest(input({ llm: { safetyMargin: 0.5 } })).stats.limit, 25000 - TAG_OVERHEAD);
  assert.equal(buildRequest(input({ llm: { safetyMargin: 1 } })).stats.limit, 50000 - TAG_OVERHEAD);
});

test('buildRequest: a picture reserves context.vision.tokensPerImage, 400 when unset -- what the llm rail charges for it', () => {
  const unset = buildRequest(input({ llm: { safetyMargin: 0.9 }, picture: true }));
  assert.equal(unset.stats.images, 1);
  assert.equal(unset.stats.limit, Math.floor(50000 * 0.9) - 400 - TAG_OVERHEAD);
  const pictureCost = estimateMessages([{ content: [{ type: 'image_url', image_url: { url: 'x' } }] }]) - estimateMessages([{ content: [] }]);
  assert.equal(pictureCost, 400, 'the rail charges the same default');

  const set = buildRequest(input({ llm: { safetyMargin: 0.9 }, vision: { tokensPerImage: 1000 }, picture: true }));
  assert.equal(set.stats.limit, Math.floor(50000 * 0.9) - 1000 - TAG_OVERHEAD);
});

// --- the pulled channel block (`<channel_view>`, budget section `pulled`) ----------------

const MIN = 60_000;
const TZ = 'UTC';
// The sections fitted ahead of the pulled block on an ordinary turn, in priority order.
const AHEAD_OF_PULLED = ['fixed', 'interlocutor', 'lookup', 'aboutChat', 'self', 'lore', 'server', 'chat'];

function line(id, ts, content, overrides = {}) {
  return { id, ts, authorId: 'w1', authorName: 'Zoé', self: false, content, attachments: [], stickers: [], replyToId: null, ...overrides };
}

/**
 * A turn in `dest` with five chat lines that pulls `src` (`lines` lines of `words` words each). `routed`
 * makes it a call from `src` answered in `dest`, the trigger being pulled line `triggerAt`.
 */
function pulledScene({ caps = {}, maxRequestTokens = 50000, routed = false, lines = 8, words = 20, triggerAt = lines - 1, extra = {} } = {}) {
  const history = Array.from({ length: 5 }, (_, i) =>
    line(`d${i + 1}`, NOW - (10 - i) * MIN, `chat ${i + 1} ${'mot '.repeat(30)}`, { authorId: 'a', authorName: 'Ana', channelId: 'dest', channelName: 'général' }),
  );
  const messages = Array.from({ length: lines }, (_, i) =>
    line(`p${i + 1}`, NOW - (lines + 30 - i) * MIN, `page ${i + 1} ${'σελίδα '.repeat(words)}`, { channelId: 'src', channelName: 'journal' }),
  );
  const base = input();
  return {
    ...base,
    config: {
      ...base.config,
      context: { ...base.config.context, caps: { ...base.config.context.caps, ...caps } },
      llm: { maxRequestTokens, safetyMargin: 1 },
    },
    prompts: { ...base.prompts, reply: 'REPLY_TASK {{target}}' },
    history,
    trigger: routed ? messages[triggerAt] : null,
    triggerKind: routed ? 'mention' : null,
    currentChannelId: 'dest',
    pulled: [
      {
        channelId: 'src',
        channelName: 'journal',
        readOnly: true,
        canReact: true,
        reason: routed ? 'routed' : 'mention',
        messages,
        earlierPingIds: new Set(),
        olderNotShown: false,
        descriptions: new Map(),
        picturesNotSeen: 0,
        pingState: new Map(),
        newestId: messages.at(-1).id,
        newestTs: messages.at(-1).ts,
      },
    ],
    source: routed ? { channelId: 'src', reason: 'routed' } : null,
    ...extra,
  };
}

/** The `<channel_view>` body of a request, or null without one. */
function viewOf(request) {
  const match = /<channel_view>\n([\s\S]*?)\n<\/channel_view>/.exec(contentText(request.messages[1].content));
  return match ? match[1] : null;
}

/** Tokens taken by the sections fitted before the pulled block on an ordinary turn. */
function aheadOfPulled(stats) {
  return AHEAD_OF_PULLED.reduce((sum, name) => sum + (stats[name]?.used ?? 0), 0);
}

/** Tokens taken by the sections fitted before the pulled block on a routed turn (no chat). */
function aheadOfRouted(stats) {
  return AHEAD_OF_PULLED.filter((name) => name !== 'chat').reduce((sum, name) => sum + (stats[name]?.used ?? 0), 0);
}

/** `{from}` / `{to}` of a pulled header in these scenes. */
function moment(ts) {
  return `${formatDate(ts, TZ, labels.locale)}, ${formatClock(ts, TZ, labels.locale)}`;
}

/** The `<task>` body of a request. */
function taskOf(request) {
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(contentText(request.messages[1].content))[1];
}

/** What a request's item costs in these scenes (the identity calibrator, plus the 2 per item). */
function itemCost(text) {
  return estimateTokens(text) + 2;
}

test('buildRequest: the pulled block is trimmed after the chat on an ordinary turn, newest lines kept', () => {
  const roomy = buildRequest(pulledScene());
  assert.equal(roomy.stats.pulled.kept, 1);
  const full = roomy.stats.pulled.used;
  const room = Math.floor(full / 2);
  const tight = buildRequest(pulledScene({ maxRequestTokens: aheadOfPulled(roomy.stats) + TAG_OVERHEAD + room }));

  assert.equal(tight.stats.chat.kept, 5, 'the chat keeps every line');
  assert.equal(tight.stats.pulled.kept, 1, 'the block is cut down, not dropped');
  assert.ok(tight.stats.pulled.used <= room, `${tight.stats.pulled.used} <= ${room}`);
  const view = viewOf(tight);
  assert.ok(view.includes('page 8 ') && !view.includes('page 1 '), view);
  assert.ok(view.split('\n').includes(labels.pull.olderNotShown));
  const [kept] = tight.pulledKept;
  assert.equal(kept.channelId, 'src');
  assert.equal(kept.newestId, 'p8');
  const firstTs = pulledScene().pulled[0].messages.find((m) => m.id === kept.ids[0]).ts;
  assert.ok(view.split('\n')[0].includes(`from ${moment(firstTs)} to`), 'the header starts at the first line kept');
  assert.deepEqual(tight.stats.pulled, { used: tight.stats.pulled.used, kept: 1, dropped: 0, lines: 8, linesCut: 8 - kept.ids.length });
  assert.ok(tight.stats.pulled.linesCut > 0, 'the lines cut are counted');
});

test('buildRequest: on a routed turn the pulled block is fitted before the chat', () => {
  const roomy = buildRequest(pulledScene({ routed: true }));
  const full = roomy.stats.pulled.used;
  const tight = buildRequest(pulledScene({ routed: true, maxRequestTokens: roomy.stats.fixed.used + TAG_OVERHEAD + full + 40 }));
  assert.equal(tight.stats.pulled.used, full, 'the block stays whole');
  assert.ok(tight.stats.chat.kept < 5, 'the chat gives way');
  assert.ok(viewOf(tight).includes('page 1 '));
});

test('buildRequest: the pulled block is capped by context.caps.pulled', () => {
  const capped = buildRequest(pulledScene({ lines: 60, words: 40, caps: { pulled: 1000 } }));
  assert.ok(capped.stats.pulled.used <= 1000 && capped.stats.pulled.used > 0, String(capped.stats.pulled.used));
  assert.ok(viewOf(capped).includes('page 60 '));
  const shown = capped.pulledKept[0].ids.length;
  assert.deepEqual(capped.stats.pulled, { used: capped.stats.pulled.used, kept: 1, dropped: 0, lines: 60, linesCut: 60 - shown });
  assert.ok(shown > 0 && shown < 60, String(shown));
});

test('buildRequest: the pulled block never raises a token-limit failure; with no room it is left out', () => {
  const roomy = buildRequest(pulledScene({ lines: 60, words: 40 }));
  const request = buildRequest(pulledScene({ lines: 60, words: 40, maxRequestTokens: aheadOfPulled(roomy.stats) + TAG_OVERHEAD + 5 }));
  assert.equal(viewOf(request), null);
  assert.deepEqual(request.stats.pulled, { used: 0, kept: 0, dropped: 1, lines: 60, linesCut: 60 }, 'pulled and cut, not "nothing pulled"');
  assert.deepEqual(request.pulledKept, []);
  assert.equal(request.pulledIds.size, 60, 'the lines stay mapped for the output side');
});

test('buildRequest: a header that keeps no line is dropped', () => {
  const request = buildRequest(pulledScene({ words: 400, caps: { pulled: 60 } }));
  assert.equal(viewOf(request), null);
  assert.deepEqual(request.stats.pulled, { used: 0, kept: 0, dropped: 1, lines: 8, linesCut: 8 });
  assert.ok(!contentText(request.messages[1].content).includes('channel #journal'));
});

test('buildRequest: a routed trigger line is kept even when newer lines fill the block', () => {
  const scene = pulledScene({ routed: true, triggerAt: 0 });
  const [first, , , , , , , newest] = scene.pulled[0].messages;
  const roomy = buildRequest(scene);
  const tight = buildRequest(pulledScene({ routed: true, triggerAt: 0, caps: { pulled: Math.floor(roomy.stats.pulled.used / 2) } }));
  const view = viewOf(tight);
  assert.ok(view.includes('#6 [') && view.includes('page 1 '), 'the trigger, numbered after the chat');
  assert.ok(view.includes('page 8 '));
  assert.ok(!view.includes('page 2 '));
  assert.ok(contentText(tight.messages[1].content).includes('<task>\nREPLY_TASK #6'), 'the task points at it');

  // The header spans the channel up to its newest line, and the lines cut after the trigger
  // are marked where they are, not announced as older ones.
  const lines = view.split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    fill(labels.pull.header, { channel: 'journal', from: moment(first.ts), to: moment(newest.ts), ago: formatDuration(NOW - newest.ts, labels.units) }),
    labels.server.readOnly,
    lines[2],
    labels.pull.olderNotShown,
  ]);
  assert.ok(lines[2].startsWith('#6 [') && lines[2].includes('page 1 '), lines[2]);
  assert.equal(lines.filter((text) => text === labels.pull.olderNotShown).length, 1);
});

test('buildRequest: a routed call keeps its header and its own line past context.caps.pulled', () => {
  const called = fill(labels.elsewhere.called, { channel: 'journal', destination: 'général' });

  // The call is the newest line: older ones are cut and said to be.
  const newestCall = pulledScene({ routed: true, caps: { pulled: 0 } });
  const newest = newestCall.pulled[0].messages.at(-1);
  const off = buildRequest(newestCall);
  const header = fill(labels.pull.header, { channel: 'journal', from: moment(newest.ts), to: moment(newest.ts), ago: formatDuration(NOW - newest.ts, labels.units) });
  const lines = viewOf(off).split('\n');
  assert.deepEqual(lines.slice(0, 3), [header, labels.server.readOnly, labels.pull.olderNotShown]);
  assert.equal(lines.length, 4);
  assert.ok(lines[3].startsWith('#13 [') && lines[3].includes('page 8 '), lines[3]);
  assert.equal(taskOf(off), `REPLY_TASK #13\n\n${called}`);
  assert.deepEqual(off.stats.pulled, { used: off.stats.pulled.used, kept: 1, dropped: 0, lines: 8, linesCut: 7 });
  assert.ok(off.stats.pulled.used > 0);

  // The call is the oldest line: the header still reaches the newest one, nothing older is cut.
  const oldestCall = pulledScene({ routed: true, triggerAt: 0, caps: { pulled: 0 } });
  const [first] = oldestCall.pulled[0].messages;
  const oldest = viewOf(buildRequest(oldestCall)).split('\n');
  assert.deepEqual(oldest.slice(0, 2), [
    fill(labels.pull.header, { channel: 'journal', from: moment(first.ts), to: moment(newest.ts), ago: formatDuration(NOW - newest.ts, labels.units) }),
    labels.server.readOnly,
  ]);
  assert.equal(oldest.length, 3);
  assert.ok(oldest[2].startsWith('#6 [') && oldest[2].includes('page 1 '), oldest[2]);
});

test('buildRequest: a routed call with no room for its line leaves the task without a target or the called text', () => {
  const roomy = buildRequest(pulledScene({ routed: true }));
  const request = buildRequest(pulledScene({ routed: true, maxRequestTokens: aheadOfRouted(roomy.stats) + TAG_OVERHEAD + 5 }));
  assert.equal(viewOf(request), null);
  assert.equal(taskOf(request), 'REPLY_TASK ');
  assert.ok(!contentText(request.messages[1].content).includes('the call came from'));
  assert.deepEqual(request.stats.pulled, { used: 0, kept: 0, dropped: 1, lines: 8, linesCut: 8 });
  // The shorter task is what the budget line counts.
  assert.ok(request.stats.fixed.used < roomy.stats.fixed.used);
  const sections = ['fixed', 'interlocutor', 'lookup', 'aboutChat', 'self', 'lore', 'server', 'pulled', 'chat', 'people', 'neighbors', 'emoji', 'gifs'];
  assert.equal(request.stats.used, sections.reduce((sum, name) => sum + request.stats[name].used, 0));
  assert.ok(request.stats.used <= request.stats.limit);
});

test('buildRequest: two pulled channels share the block\'s room evenly, each keeping its newest lines', () => {
  const base = pulledScene();
  const [journal] = base.pulled;
  const pages = journal.messages.map((message, i) => ({
    ...message,
    id: `q${i + 1}`,
    channelId: 'src2',
    channelName: 'carnet',
    content: `feuille ${i + 1} ${'φύλλο '.repeat(20)}`,
  }));
  const pulled = [journal, { ...journal, channelId: 'src2', channelName: 'carnet', messages: pages, newestId: 'q8', newestTs: pages.at(-1).ts }];
  const roomy = buildRequest(pulledScene({ extra: { pulled } }));
  assert.equal(roomy.stats.pulled.kept, 2);
  const room = Math.floor(roomy.stats.pulled.used * 0.6);
  const tight = buildRequest(pulledScene({ caps: { pulled: room }, extra: { pulled } }));

  const items = viewOf(tight).split('\n\n');
  assert.equal(items.length, 2);
  for (const item of items) assert.ok(itemCost(item) <= Math.floor(room / 2), `${itemCost(item)} <= ${Math.floor(room / 2)}`);
  assert.ok(items[0].startsWith('channel #journal') && items[0].includes('page 8 '), items[0]);
  assert.ok(items[1].startsWith('channel #carnet') && items[1].includes('feuille 8 '), items[1]);
  assert.deepEqual(tight.pulledKept.map((kept) => [kept.channelId, kept.newestId]), [['src', 'p8'], ['src2', 'q8']]);
  const shown = tight.pulledKept.reduce((sum, kept) => sum + kept.ids.length, 0);
  assert.deepEqual(tight.stats.pulled, { used: tight.stats.pulled.used, kept: 2, dropped: 0, lines: 16, linesCut: 16 - shown });
  assert.ok(shown < 16);
});

test('buildRequest: a pulled channel cut by the budget stays among the neighbours', () => {
  const neighbors = [{ channelId: 'src', channelName: 'journal', messages: [line('n1', NOW - 31 * MIN, 'une ligne courte', { channelId: 'src' })] }];
  const others = (request) => /<other_channels>\n([\s\S]*?)\n<\/other_channels>/.exec(contentText(request.messages[1].content))?.[1] ?? null;

  const cut = buildRequest(pulledScene({ words: 400, caps: { pulled: 60 }, extra: { neighbors } }));
  assert.equal(viewOf(cut), null);
  assert.ok(others(cut)?.startsWith('# journal'), String(others(cut)));
  assert.equal(cut.stats.neighbors.kept, 1);

  const shown = buildRequest(pulledScene({ extra: { neighbors } }));
  assert.ok(viewOf(shown) !== null);
  assert.equal(others(shown), null, 'shown once, in <channel_view>');
});

test('buildRequest: the pulled block outranks other profiles and neighbours on an ordinary turn', () => {
  const extra = {
    otherProfiles: [{ id: 'w9', names: ['Ilse'], character: 'ç'.repeat(600) }],
    neighbors: [{ channelId: 'n1', channelName: 'random', messages: [line('n', NOW - MIN, 'à côté '.repeat(40))] }],
  };
  const roomy = buildRequest(pulledScene({ extra }));
  assert.equal(roomy.stats.people.kept, 1);
  assert.equal(roomy.stats.neighbors.kept, 1);
  const tight = buildRequest(pulledScene({ extra, maxRequestTokens: aheadOfPulled(roomy.stats) + TAG_OVERHEAD + roomy.stats.pulled.used + 20 }));
  assert.equal(tight.stats.pulled.used, roomy.stats.pulled.used);
  assert.equal(tight.stats.people.kept, 0);
  assert.equal(tight.stats.neighbors.kept, 0);
});
