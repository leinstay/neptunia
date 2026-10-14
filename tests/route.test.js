import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_DEFAULTS,
  buildRouteRequest,
  parseRouteAnswer,
  routeAllowed,
  routeCandidate,
  routeChannelList,
  routeContext,
  routeEntries,
  routeSettings,
  routeWriter,
} from '../src/behavior/route.js';
import { userText } from '../src/behavior/prompt.js';
import { createChannelRouter } from '../src/behavior/route-channel.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GUILD = 'g1';
const iso = (ms) => new Date(ms).toISOString();

// The route settings the router tests rely on, pinned here instead of read from the shipped defaults.
const ROUTE_PIN = { contextMessages: 20, maxChannels: 40, purposeChars: 80, maxOutputTokens: 120 };

/** The shipped config.json with the route settings pinned and the given groups merged over a fresh copy (one level deep). */
function config(overrides = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.route = { ...ROUTE_PIN };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

// ---- settings and the switch ----------------------------------------------------------

test('routeSettings: the shipped config.json values equal the code fallbacks', () => {
  assert.deepEqual(SHIPPED_CONFIG.route, { ...ROUTE_DEFAULTS });
  assert.equal(SHIPPED_CONFIG.features.channelRoute, true);
});

test('routeSettings: a missing group falls back, a missing switch counts as on, false turns it off', () => {
  assert.deepEqual(routeSettings({}), { ...ROUTE_DEFAULTS });
  assert.deepEqual(routeSettings({ features: {}, route: { contextMessages: 5.7, maxChannels: -1, purposeChars: 'x', maxOutputTokens: 0 } }), {
    contextMessages: 5,
    maxChannels: ROUTE_DEFAULTS.maxChannels,
    purposeChars: ROUTE_DEFAULTS.purposeChars,
    maxOutputTokens: ROUTE_DEFAULTS.maxOutputTokens,
  });
  assert.equal(routeSettings({ features: { channelRoute: false } }), null);
});

test('routeAllowed: every reply kind and a turn without a trigger ask; overheard, drawFailed and private do not', () => {
  for (const triggerKind of ['mention', 'reply', 'name', 'followUp', null, undefined]) assert.equal(routeAllowed({ triggerKind }), true, String(triggerKind));
  for (const triggerKind of ['overheard', 'drawFailed', 'private']) assert.equal(routeAllowed({ triggerKind }), false, triggerKind);
  assert.equal(routeAllowed({ triggerKind: 'mention', privateChat: true }), false);
  assert.equal(routeAllowed(), true);
});

// ---- the list ----------------------------------------------------------------------------

test('routeChannelList: numbered lines with the writer, their aliases and the clamped purpose', () => {
  const { lines, ids } = routeChannelList(
    [
      { id: 'c2', name: 'journal', writer: { name: 'Éloïse', aliases: ['Élo', 'Lili'] }, purpose: 'personal\n diary   of one member' },
      { id: 'c3', name: 'jardin', writer: { name: 'Nikos', aliases: [] }, purpose: '' },
      { id: 'c4', name: 'café', writer: null, purpose: 'everyday chat' },
    ],
    { max: 40, purposeChars: 80 },
  );
  assert.deepEqual(ids, ['c2', 'c3', 'c4']);
  assert.deepEqual(lines, ['1 | #journal | Éloïse (Élo, Lili) | personal diary of one member', '2 | #jardin | Nikos |', '3 | #café |  | everyday chat']);
});

test('routeChannelList: the purpose is cut at a word boundary, max caps the list, 0 chars drops the purpose', () => {
  const entries = [
    { id: 'a', name: 'alpha', purpose: 'μια πολύ μεγάλη περιγραφή του καναλιού' },
    { id: 'b', name: 'beta', purpose: 'δεύτερο' },
  ];
  const { lines, ids } = routeChannelList(entries, { max: 1, purposeChars: 12 });
  assert.deepEqual(ids, ['a']);
  assert.equal(lines.length, 1);
  const purpose = lines[0].split(' | ')[3];
  assert.ok([...purpose].length <= 12, purpose);
  assert.ok('μια πολύ μεγάλη περιγραφή'.startsWith(purpose), purpose);
  assert.deepEqual(routeChannelList(entries, { max: 5, purposeChars: 0 }).lines, ['1 | #alpha |  |', '2 | #beta |  |']);
  assert.deepEqual(routeChannelList([], {}), { lines: [], ids: [] });
});

test('routeWriter: the top writer with at least half the messages, named from the profile with two aliases by rank', () => {
  const profile = {
    names: ['Éloïse', 'Elo'],
    aliases: [
      { name: 'Lili', weight: 1, firstSeen: iso(NOW - 9 * DAY), lastSeen: iso(NOW - 9 * DAY) },
      { name: 'Élo', weight: 5, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW - DAY) },
      { name: 'Zaza', weight: 3, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW - DAY) },
    ],
  };
  const profileOf = (id) => (id === 'u3' ? profile : null);
  const channel = { topWriters: [{ id: 'u3', count: 30 }, { id: 'u2', count: 20 }], messageCount: 60 };
  assert.deepEqual(routeWriter(channel, profileOf, 365), { name: 'Éloïse', aliases: ['Élo', 'Zaza'] });
  assert.equal(routeWriter({ ...channel, messageCount: 61 }, profileOf, 365), null, 'under half');
  assert.equal(routeWriter({ topWriters: [], messageCount: 0 }, profileOf), null);
  assert.equal(routeWriter({ topWriters: [{ id: 'u9', count: 9 }], messageCount: 9 }, profileOf), null, 'no stored name');
});

test('routeEntries: newest first, the excluded and refused channels left out, max kept, check not asked past it', () => {
  const channels = [
    { id: 'c1', name: 'general', lastMessageAt: NOW },
    { id: 'c2', name: 'old', lastMessageAt: NOW - 3 * DAY },
    { id: 'c3', name: 'new', lastMessageAt: NOW - MINUTE, purpose: 'news' },
    { id: 'c4', name: 'denied', lastMessageAt: NOW - 2 * MINUTE },
    { id: 'c5', name: '', lastMessageAt: NOW - 3 * MINUTE },
    { id: 'c6', name: 'never', lastMessageAt: null },
  ];
  const asked = [];
  const check = (id) => (asked.push(id), id === 'c4' ? null : { name: id === 'c5' ? 'live-name' : 'x' });
  const entries = routeEntries({ channels, exclude: ['c1'], check, max: 3 });
  assert.deepEqual(entries.map((e) => [e.id, e.name]), [['c2', 'old'], ['c3', 'new'], ['c5', 'live-name']], 'the newest three, listed by id');
  assert.equal(entries[1].purpose, 'news');
  assert.deepEqual(asked, ['c3', 'c4', 'c5', 'c2']);
  assert.deepEqual(routeEntries({ channels, check, max: 0 }), []);
});

// ---- the request and the answer ----------------------------------------------------------

test('buildRouteRequest: the system prompt with the name, then channels, transcript and candidate', () => {
  const messages = buildRouteRequest({
    prompt: 'You are {{name}}. Pick one.',
    selfName: 'Zoë',
    transcriptBlock: '<transcript>\nT\n</transcript>',
    candidateBlock: '<candidate>\nAna: ποιο κανάλι;\n</candidate>',
    lines: ['1 | #a |  |', '2 | #b |  |'],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'You are Zoë. Pick one.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '<channels>\n1 | #a |  |\n2 | #b |  |\n</channels>\n', cacheSegment: 'stable' },
        { type: 'text', text: '<transcript>\nT\n</transcript>\n<candidate>\nAna: ποιο κανάλι;\n</candidate>' },
      ],
    },
  ]);
  assert.equal(
    userText(messages[1].content),
    '<channels>\n1 | #a |  |\n2 | #b |  |\n</channels>\n<transcript>\nT\n</transcript>\n<candidate>\nAna: ποιο κανάλι;\n</candidate>',
    'the parts joined are the old single string',
  );
  const noTranscript = buildRouteRequest({ prompt: 'p', selfName: 'Zoë', candidateBlock: '<candidate>\nx\n</candidate>', lines: ['1 | #a |  |'] });
  assert.ok(userText(noTranscript[1].content).startsWith('<channels>\n'));
  const bare = buildRouteRequest({ prompt: 'p', selfName: 'Zoë', lines: ['1 | #a |  |'] });
  assert.deepEqual(bare[1].content, [{ type: 'text', text: '<channels>\n1 | #a |  |\n</channels>', cacheSegment: 'stable' }], 'no per-turn part: no trailing separator');
});

test('buildRouteRequest: null for a blank prompt or no line', () => {
  assert.equal(buildRouteRequest({ prompt: '  ', selfName: 'Zoë', lines: ['1 | #a |  |'] }), null);
  assert.equal(buildRouteRequest({ prompt: undefined, selfName: 'Zoë', lines: ['1 | #a |  |'] }), null);
  assert.equal(buildRouteRequest({ prompt: 'p', selfName: 'Zoë', lines: [] }), null);
});

test('parseRouteAnswer: every outcome', () => {
  assert.deepEqual(parseRouteAnswer('2', 3), { index: 2, reason: 'pick', direction: null });
  assert.deepEqual(parseRouteAnswer('\n  #3.\nbecause', 3), { index: 3, reason: 'pick', direction: null });
  assert.deepEqual(parseRouteAnswer('"1."', 3), { index: 1, reason: 'pick', direction: null });
  assert.deepEqual(parseRouteAnswer('none', 3), { index: null, reason: 'none', direction: null });
  assert.deepEqual(parseRouteAnswer('NONE of them fit', 3), { index: null, reason: 'none', direction: null });
  assert.deepEqual(parseRouteAnswer('4', 3), { index: null, reason: 'unknown-id', direction: null });
  assert.deepEqual(parseRouteAnswer('0', 3), { index: null, reason: 'unknown-id', direction: null });
  assert.deepEqual(parseRouteAnswer('', 3), { index: null, reason: 'empty', direction: null });
  assert.deepEqual(parseRouteAnswer('  \n \n', 3), { index: null, reason: 'empty', direction: null });
  assert.deepEqual(parseRouteAnswer(null, 3), { index: null, reason: 'empty', direction: null });
  assert.deepEqual(parseRouteAnswer('channel 2', 3), { index: null, reason: 'unparsed', direction: null });
  assert.deepEqual(parseRouteAnswer('2 or 3', 3), { index: null, reason: 'unparsed', direction: null });
});

test('parseRouteAnswer: a number followed by earlier or older asks for the page before the last view', () => {
  assert.deepEqual(parseRouteAnswer('3', 3), { index: 3, reason: 'pick', direction: null });
  assert.deepEqual(parseRouteAnswer('3 earlier', 3), { index: 3, reason: 'pick', direction: 'earlier' });
  assert.deepEqual(parseRouteAnswer('3 older', 3), { index: 3, reason: 'pick', direction: 'earlier' });
  assert.deepEqual(parseRouteAnswer('"#2 EARLIER."\nbecause', 3), { index: 2, reason: 'pick', direction: 'earlier' });
  assert.deepEqual(parseRouteAnswer('2 Older', 3), { index: 2, reason: 'pick', direction: 'earlier' });
  assert.deepEqual(parseRouteAnswer('none', 3), { index: null, reason: 'none', direction: null });
  assert.deepEqual(parseRouteAnswer('none earlier', 3), { index: null, reason: 'none', direction: null });
  assert.deepEqual(parseRouteAnswer('4 earlier', 3), { index: null, reason: 'unknown-id', direction: null });
  assert.deepEqual(parseRouteAnswer('3 later', 3), { index: null, reason: 'unparsed', direction: null });
  assert.deepEqual(parseRouteAnswer('3 earlier please', 3), { index: null, reason: 'unparsed', direction: null });
  assert.deepEqual(parseRouteAnswer('earlier 3', 3), { index: null, reason: 'unparsed', direction: null });
  assert.deepEqual(parseRouteAnswer('garbage', 3), { index: null, reason: 'unparsed', direction: null });
});

// ---- the context ---------------------------------------------------------------------------

/** A normalized message of the chat. */
function line(id, { authorId = 'u1', authorName = 'Ana', ts = NOW - MINUTE, content = 'γεια', self = false, bot = false } = {}) {
  return { id, channelId: 'c1', authorId, authorName, ts, content, self, bot, attachments: [], links: [], stickers: [], reactions: [] };
}

test('routeCandidate: the trigger, else the newest message neither the persona\'s nor a bot\'s', () => {
  const history = [line('m1'), line('m2', { authorName: 'Nikos' }), line('m3', { self: true }), line('m4', { bot: true })];
  assert.equal(routeCandidate(history, history[0]), history[0]);
  assert.equal(routeCandidate(history, null), history[1]);
  assert.equal(routeCandidate([line('m3', { self: true })], null), null);
});

test('routeContext: the last contextMessages before the candidate, and the candidate block', () => {
  const history = [line('m1', { content: 'πρώτο' }), line('m2', { content: 'δεύτερο' }), line('m3', { content: 'τρίτο' }), line('m4', { content: 'μετά' })];
  const { transcriptBlock, candidateBlock } = routeContext({ history, candidate: history[2], contextMessages: 1, config: config(), labels, selfName: 'Zoë' });
  assert.ok(transcriptBlock.startsWith('<transcript>\n') && transcriptBlock.endsWith('\n</transcript>'));
  assert.ok(transcriptBlock.includes('δεύτερο') && !transcriptBlock.includes('πρώτο') && !transcriptBlock.includes('τρίτο') && !transcriptBlock.includes('μετά'));
  assert.equal(candidateBlock, '<candidate>\nAna: τρίτο\n</candidate>');
  assert.equal(routeContext({ history, candidate: history[2], contextMessages: 0, config: config(), labels, selfName: 'Zoë' }).transcriptBlock, '');
});

// ---- the router ------------------------------------------------------------------------------

/** A discord.js-shaped text channel of `guild` every member may view. */
function fakeChannel(guild, id, name) {
  const channel = {
    id,
    name,
    guild,
    viewable: true,
    lastMessageId: null,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: { cache: new Map() },
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

/** A guild holding #general (c1, the turn's channel), #journal (c2), #jardin (c3) and #secret (c4). */
function fakeGuild() {
  const guild = { id: GUILD, members: { me: { id: 'self' } }, roles: { everyone: { id: GUILD }, cache: new Map() }, channels: { cache: new Map() } };
  const channel = fakeChannel(guild, 'c1', 'general');
  fakeChannel(guild, 'c2', 'journal');
  fakeChannel(guild, 'c3', 'jardin');
  fakeChannel(guild, 'c4', 'secret');
  return { guild, channel };
}

const STORED_CHANNELS = [
  { id: 'c1', name: 'general', lastMessageAt: NOW, messageCount: 500, topWriters: [] },
  { id: 'c2', name: 'journal', lastMessageAt: NOW - 10 * MINUTE, messageCount: 40, topWriters: [{ id: 'u3', count: 40 }], purpose: 'a diary' },
  { id: 'c3', name: 'jardin', lastMessageAt: NOW - 20 * MINUTE, messageCount: 40, topWriters: [], purpose: 'garden photos' },
  { id: 'c4', name: 'secret', lastMessageAt: NOW - 5 * MINUTE, messageCount: 4, topWriters: [] },
];

function fakeStore(channels = STORED_CHANNELS) {
  return {
    listChannels: () => channels,
    getUser: (guildId, id) => (id === 'u3' ? { names: ['Éloïse'], aliases: [{ name: 'Élo', weight: 2, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW - DAY) }] } : null),
  };
}

function fakeLlm(answer) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (answer instanceof Error) throw answer;
      return { text: answer };
    },
  };
}

/** A router over the fake guild, the shipped config with #secret (c4) denied, and a stand-in prompt. */
function routerScene({ answer = '1', features = {}, prompt = 'You are {{name}}.', channels } = {}) {
  const { guild, channel } = fakeGuild();
  const hot = {
    config: config({ features, bot: { channels: { allow: [], deny: ['c4'] } }, llm: { helperTimeoutMs: 12345 } }),
    prompts: { 'route-channel': prompt, labels },
  };
  const llm = fakeLlm(answer);
  let t = NOW;
  const router = createChannelRouter({ hot, store: fakeStore(channels), llm, now: () => (t += 7) });
  const history = [line('m1', { content: 'τι έγραψε η Ελο;' }), line('m2', { authorName: 'Nikos', content: 'στο ημερολόγιο' })];
  const args = { guildId: GUILD, channel, guild, history, trigger: history[1], triggerKind: 'mention', selfName: 'Zoë', config: hot.config };
  return { router, llm, hot, args };
}

test('createChannelRouter: a pick returns its channel id; the request lists only pullable channels, newest first', async () => {
  const { router, llm, args } = routerScene({ answer: '1' });
  const { result, logs } = await withCapturedLogs(() => router(args));
  assert.deepEqual(result, ['c2']);
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'You are Zoë.');
  assert.ok(userText(user.content).includes('<channels>\n1 | #journal | Éloïse (Élo) | a diary\n2 | #jardin |  | garden photos\n</channels>'), userText(user.content));
  assert.ok(!userText(user.content).includes('#secret') && !userText(user.content).includes('#general'), 'the denied and the current channel are not listed');
  assert.ok(userText(user.content).startsWith('<channels>\n'), 'the stable channel list leads the request');
  assert.ok(userText(user.content).indexOf('<channels>') < userText(user.content).indexOf('<transcript>') && userText(user.content).endsWith('<candidate>\nNikos: στο ημερολόγιο\n</candidate>'));
  const classified = logs.find((l) => l.msg === 'route: classified');
  assert.equal(classified.channel, 'c1');
  assert.equal(classified.kind, 'mention');
  assert.equal(classified.channels, 2);
  assert.equal(classified.pick, 'c2');
  assert.equal(classified.parse, 'pick');
  assert.equal(classified.direction, null);
  assert.equal(typeof classified.ms, 'number');
  assert.ok(!JSON.stringify(logs).includes('journal') && !JSON.stringify(logs).includes('ημερολόγιο'), 'no channel name, no message text in the logs');
});

test('createChannelRouter: the list is ordered by channel id, not by activity, and the answered number maps back to its channel', async () => {
  // The second scene makes c2 the less recent channel; it is still listed first, and the list text is unchanged.
  const { router, llm, args } = routerScene({ answer: '2' });
  const first = await withCapturedLogs(() => router(args));
  assert.deepEqual(first.result, ['c3'], 'number 2 is the second line of the id-ordered list');
  const listed = (content) => content.slice(0, content.indexOf('</channels>'));
  const swapped = routerScene({
    answer: '1',
    channels: STORED_CHANNELS.map((c) => (c.id === 'c2' ? { ...c, lastMessageAt: NOW - 90 * MINUTE } : c)),
  });
  const second = await withCapturedLogs(() => swapped.router(swapped.args));
  assert.deepEqual(second.result, ['c2'], 'number 1 is the lower id');
  assert.equal(listed(userText(llm.calls[0].messages[1].content)), listed(userText(swapped.llm.calls[0].messages[1].content)), 'the list text does not move with activity');
});

test('createChannelRouter: the request options carry the classifier model, the purpose and the helper timeout', async () => {
  const { router, llm, args, hot } = routerScene();
  await withCapturedLogs(() => router(args));
  const { options } = llm.calls[0];
  assert.equal(options.model, hot.config.roles.analyzer);
  assert.equal(options.role, 'analyzer');
  assert.equal(options.purpose, 'route-channel');
  assert.equal(options.maxOutputTokens, 120);
  assert.equal(options.timeoutMs, 12345);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
});

test('createChannelRouter: an earlier pick returns its channel id with the direction and logs it', async () => {
  const { router, args } = routerScene({ answer: '1 earlier' });
  const { result, logs } = await withCapturedLogs(() => router(args));
  assert.deepEqual(result, [{ id: 'c2', direction: 'earlier' }]);
  const classified = logs.find((l) => l.msg === 'route: classified');
  assert.equal(classified.pick, 'c2');
  assert.equal(classified.direction, 'earlier');
});

test('createChannelRouter: none, an unknown number or junk return no id', async () => {
  for (const [answer, parse] of [['none', 'none'], ['7', 'unknown-id'], ['maybe', 'unparsed'], ['', 'empty']]) {
    const { router, args } = routerScene({ answer });
    const { result, logs } = await withCapturedLogs(() => router(args));
    assert.deepEqual(result, [], answer);
    assert.equal(logs.find((l) => l.msg === 'route: classified').parse, parse);
  }
});

test('createChannelRouter: overheard, drawFailed and private turns, and the switch off, make no call', async () => {
  for (const triggerKind of ['overheard', 'drawFailed', 'private']) {
    const { router, llm, args } = routerScene();
    const { result, logs } = await withCapturedLogs(() => router({ ...args, triggerKind }));
    assert.deepEqual(result, []);
    assert.equal(llm.calls.length, 0, triggerKind);
    assert.equal(logs.length, 0);
  }
  const off = routerScene({ features: { channelRoute: false } });
  const { result, logs } = await withCapturedLogs(() => off.router(off.args));
  assert.deepEqual(result, []);
  assert.equal(off.llm.calls.length, 0);
  assert.equal(logs.length, 0);
});

test('createChannelRouter: a private chat with its partner lists the server channels the partner can view; without one it makes no call', async () => {
  const { router, llm, args } = routerScene({ answer: '2' });
  const dm = { id: 'dm1', guild: null };
  const partner = { id: 'u9', guild: args.guild };
  args.guild.channels.cache.get('c3').permissionsFor = (target) => ({ has: () => target !== partner });
  const history = args.history.map((m) => ({ ...m, channelId: 'dm1' }));
  const turn = { ...args, channel: dm, partner, history, trigger: history[1], triggerKind: 'private' };
  const { result, logs } = await withCapturedLogs(() => router(turn));
  assert.deepEqual(result, ['c2']);
  const user = userText(llm.calls[0].messages[1].content);
  assert.ok(user.includes('<channels>\n1 | #general |  |\n2 | #journal | Éloïse (Élo) | a diary\n</channels>'), user);
  assert.equal(logs.find((l) => l.msg === 'route: classified').kind, 'private');

  const alone = routerScene();
  const refused = await withCapturedLogs(() => alone.router({ ...turn, guild: alone.args.guild, partner: null }));
  assert.deepEqual(refused.result, []);
  assert.equal(alone.llm.calls.length, 0);
  assert.equal(refused.logs.length, 0);
});

test('createChannelRouter: a spontaneous turn judges the newest member line; no candidate is skipped', async () => {
  const { router, llm, args } = routerScene();
  const own = line('m3', { self: true, authorName: 'Zoë', content: 'εγώ' });
  await withCapturedLogs(() => router({ ...args, trigger: null, triggerKind: null, history: [...args.history, own] }));
  assert.ok(userText(llm.calls[0].messages[1].content).endsWith('<candidate>\nNikos: στο ημερολόγιο\n</candidate>'));

  const lonely = routerScene();
  const { result, logs } = await withCapturedLogs(() => lonely.router({ ...lonely.args, trigger: null, triggerKind: null, history: [own] }));
  assert.deepEqual(result, []);
  assert.equal(lonely.llm.calls.length, 0);
  assert.deepEqual(logs.map((l) => [l.msg, l.reason]), [['route: skipped', 'no-candidate']]);
});

test('createChannelRouter: no prompt is skipped, no listable channel makes no call and no log', async () => {
  const blank = routerScene({ prompt: '' });
  const skipped = await withCapturedLogs(() => blank.router(blank.args));
  assert.deepEqual(skipped.result, []);
  assert.equal(blank.llm.calls.length, 0);
  assert.deepEqual(skipped.logs.map((l) => [l.msg, l.reason]), [['route: skipped', 'no-prompt']]);

  const empty = routerScene({ channels: [STORED_CHANNELS[0], STORED_CHANNELS[3]] });
  const { result, logs } = await withCapturedLogs(() => empty.router(empty.args));
  assert.deepEqual(result, []);
  assert.equal(empty.llm.calls.length, 0);
  assert.equal(logs.length, 0);
});

test('createChannelRouter: a thrown request returns no id and logs its rail code', async () => {
  const err = new DailyCapError('cap');
  const { router, args } = routerScene({ answer: err });
  const { result, logs } = await withCapturedLogs(() => router(args));
  assert.deepEqual(result, []);
  const failed = logs.find((l) => l.msg === 'route: failed');
  assert.equal(failed.reason, 'daily-cap');
  assert.equal(failed.channel, 'c1');

  const plain = routerScene({ answer: Object.assign(new Error('boom'), { statusCode: 502 }) });
  const second = await withCapturedLogs(() => plain.router(plain.args));
  assert.deepEqual(second.result, []);
  const failedAgain = second.logs.find((l) => l.msg === 'route: failed');
  assert.equal(failedAgain.reason, 'llm-error');
  assert.equal(failedAgain.status, 502);
});

test('createChannelRouter: a channel whose pull check throws is dropped from the list', async () => {
  const { router, llm, args } = routerScene();
  args.guild.channels.cache.get('c3').isTextBased = () => {
    throw new Error('fixture: broken channel');
  };
  const { result } = await withCapturedLogs(() => router(args));
  assert.deepEqual(result, ['c2']);
  assert.ok(userText(llm.calls[0].messages[1].content).includes('<channels>\n1 | #journal | Éloïse (Élo) | a diary\n</channels>'));
});

test('createChannelRouter: a store that throws resolves no id instead of rejecting', async () => {
  const { args } = routerScene();
  const { result, logs } = await withCapturedLogs(() =>
    createChannelRouter({
      hot: { config: config(), prompts: { 'route-channel': 'p', labels } },
      store: {
        listChannels: () => {
          throw new Error('fixture: unreadable');
        },
      },
      llm: fakeLlm('1'),
    })(args),
  );
  assert.deepEqual(result, []);
  assert.equal(logs.find((l) => l.msg === 'route: failed').reason, 'error');
});
