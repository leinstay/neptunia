// Tests for the participation pick classifier (src/behavior/participation-pick.js):
// its settings and switch, which turns may ask it, the numbered episode list,
// the request, the answer parser and the picker's I/O side with a fake store and LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARTICIPATION_PICK_DEFAULTS,
  buildParticipationPickRequest,
  createParticipationPicker,
  participationEpisodeList,
  participationPickAllowed,
  participationPickSettings,
  parseParticipationPick,
} from '../src/behavior/participation-pick.js';
import { userText } from '../src/behavior/prompt.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GUILD = 'g1';

/** The shipped config with the participation settings pinned and `overrides` merged one level deep. */
function config(overrides = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.participation = { ...base.participation, contextMessages: 6, maxOutputTokens: 60, hours: 72 };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

/** A stored participation message. */
function stored(id, ts, { authorId = 'u1', name = 'Ana', self = false, text = `γραμμή ${id}` } = {}) {
  return { id, ts, authorId, name, self, text, replyTo: null, caption: null };
}

/** A store state with one episode in #journal (c2, 2 h old) and one in #jardin (c3, 30 min old). */
function participationState() {
  return {
    nextId: 3,
    episodes: [
      {
        id: 'p1',
        channelId: 'c2',
        continues: null,
        messages: [stored('a1', NOW - 2 * HOUR - MINUTE, { text: 'πού είναι το βιβλίο;' }), stored('a2', NOW - 2 * HOUR, { self: true, authorId: 'self', name: 'Zoë', text: 'στο ράφι' })],
      },
      {
        id: 'p2',
        channelId: 'c3',
        continues: null,
        messages: [stored('b1', NOW - 30 * MINUTE, { self: true, authorId: 'self', name: 'Zoë', text: 'ωραία λουλούδια' })],
      },
    ],
  };
}

/** A transcript line of the turn's channel (c1). */
function line(id, { authorId = 'u1', authorName = 'Ana', ts = NOW - MINUTE, content = 'γεια', self = false, bot = false } = {}) {
  return { id, channelId: 'c1', authorId, authorName, ts, content, self, bot, attachments: [], links: [], stickers: [], reactions: [] };
}

// ---- settings and the switch ----------------------------------------------------------

test('participationPickSettings: the shipped config.json values equal the code fallbacks', () => {
  assert.equal(SHIPPED_CONFIG.participation.contextMessages, PARTICIPATION_PICK_DEFAULTS.contextMessages);
  assert.equal(SHIPPED_CONFIG.participation.maxOutputTokens, PARTICIPATION_PICK_DEFAULTS.maxOutputTokens);
  assert.equal(SHIPPED_CONFIG.context.caps.participation, 6000);
});

test('participationPickSettings: a missing group falls back, a missing switch counts as on, false turns it off', () => {
  assert.deepEqual(participationPickSettings({}), { ...PARTICIPATION_PICK_DEFAULTS });
  assert.deepEqual(participationPickSettings({ participation: { contextMessages: 3.8, maxOutputTokens: 0 } }), {
    contextMessages: 3,
    maxOutputTokens: PARTICIPATION_PICK_DEFAULTS.maxOutputTokens,
  });
  assert.equal(participationPickSettings({ features: { participation: false } }), null);
});

test('participationPickAllowed: server reply and spontaneous turns ask; a private chat, a diary post and a drawFailed turn do not', () => {
  for (const triggerKind of ['mention', 'reply', 'name', 'followUp', 'overheard', null]) {
    assert.equal(participationPickAllowed({ mode: 'reply', triggerKind }), true, String(triggerKind));
  }
  assert.equal(participationPickAllowed({ mode: 'interject' }), true);
  assert.equal(participationPickAllowed({ mode: 'initiate' }), true);
  assert.equal(participationPickAllowed({ mode: 'reply', triggerKind: 'drawFailed' }), false);
  assert.equal(participationPickAllowed({ mode: 'reply', triggerKind: 'private', privateChat: true }), false);
  assert.equal(participationPickAllowed({ mode: 'diary' }), false);
});

// ---- the list, the request, the parser --------------------------------------------------

test('participationEpisodeList: one numbered line per headline with channel, age, the member and the persona', () => {
  const headlines = [
    { id: 'p2', channelId: 'c3', lastOwnAt: NOW - 30 * MINUTE, ageMs: 30 * MINUTE, memberLine: null, selfLine: 'ωραία λουλούδια', memberLines: '', selfLines: 'ωραία λουλούδια / δεύτερη γραμμή' },
    { id: 'p1', channelId: 'c2', lastOwnAt: NOW - 2 * HOUR, ageMs: 2 * HOUR, memberLine: 'πού είναι το βιβλίο;', selfLine: 'στο ράφι', memberLines: 'πού είναι το βιβλίο; / ευχαριστώ | πολύ', selfLines: 'στο ράφι' },
    { id: 'p9', channelId: 'c9', lastOwnAt: NOW - HOUR, ageMs: HOUR, memberLine: null, selfLine: 'χωρίς όνομα', memberLines: '', selfLines: 'χωρίς όνομα' },
  ];
  const { lines, ids } = participationEpisodeList(headlines, {
    state: participationState(),
    channelNameOf: (id) => ({ c2: 'journal', c3: 'jardin' })[id] ?? null,
    units: labels.units,
    selfName: 'Zoë',
  });
  assert.deepEqual(lines, ['1 | #jardin | 30 min |  | Zoë: ωραία λουλούδια / δεύτερη γραμμή', '2 | #journal | 2 h | Ana: πού είναι το βιβλίο; / ευχαριστώ / πολύ | Zoë: στο ράφι']);
  assert.deepEqual(ids, ['p2', 'p1'], 'a headline whose channel has no name is left out');
});

test('buildParticipationPickRequest: the prompt with {{name}}, then the tagged episodes part, then transcript and candidate', () => {
  const messages = buildParticipationPickRequest({
    prompt: 'Pick for {{name}}.',
    selfName: 'Zoë',
    transcriptBlock: '<transcript>\nT\n</transcript>',
    candidateBlock: '<candidate>\nAna: C\n</candidate>',
    lines: ['1 | #a | 1 h |  | Zoë: x'],
  });
  assert.equal(messages[0].content, 'Pick for Zoë.');
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: '<episodes>\n1 | #a | 1 h |  | Zoë: x\n</episodes>\n', cacheSegment: 'stable' },
    { type: 'text', text: '<transcript>\nT\n</transcript>\n<candidate>\nAna: C\n</candidate>' },
  ]);
  const bare = buildParticipationPickRequest({ prompt: 'p', selfName: 'Zoë', lines: ['x'] });
  assert.deepEqual(bare[1].content, [{ type: 'text', text: '<episodes>\nx\n</episodes>', cacheSegment: 'stable' }], 'no per-turn part: no trailing separator');
  assert.equal(buildParticipationPickRequest({ prompt: '  ', selfName: 'Zoë', lines: ['x'] }), null);
  assert.equal(buildParticipationPickRequest({ prompt: 'p', selfName: 'Zoë', lines: [] }), null);
});

test('parseParticipationPick: numbers separated by commas or spaces, in order, unknown ones dropped', () => {
  assert.deepEqual(parseParticipationPick('2, 1', 3), { indices: [2, 1], reason: 'pick' });
  assert.deepEqual(parseParticipationPick('#3 1.', 3), { indices: [3, 1], reason: 'pick' });
  assert.deepEqual(parseParticipationPick('1,1, 7', 3), { indices: [1], reason: 'pick' });
  assert.deepEqual(parseParticipationPick('7, 9', 3), { indices: [], reason: 'unknown-id' });
  assert.deepEqual(parseParticipationPick('None.', 3), { indices: [], reason: 'none' });
  assert.deepEqual(parseParticipationPick('', 3), { indices: [], reason: 'empty' });
  assert.deepEqual(parseParticipationPick(undefined, 3), { indices: [], reason: 'empty' });
  assert.deepEqual(parseParticipationPick('episode two', 3), { indices: [], reason: 'unparsed' });
  assert.deepEqual(parseParticipationPick('1 and 2', 3), { indices: [], reason: 'unparsed' });
});

// ---- the picker -------------------------------------------------------------------------

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

function pickerScene({ answer = '2', features = {}, prompt = 'You are {{name}}.', state = participationState(), audience = () => true } = {}) {
  const hot = { config: config({ features, llm: { helperTimeoutMs: 4321 } }), prompts: { 'participation-pick': prompt, labels } };
  const llm = fakeLlm(answer);
  const store = {
    getParticipation: () => structuredClone(state),
    listChannels: () => [{ id: 'c2', name: 'journal' }],
  };
  const guild = { id: GUILD, channels: { cache: new Map([['c3', { id: 'c3', name: 'jardin' }]]) } };
  const channel = { id: 'c1', name: 'general', guild };
  let t = NOW;
  const picker = createParticipationPicker({ hot, store, llm, now: () => (t += 5) });
  const history = [line('m1', { content: 'πρώτο' }), line('m2', { self: true, authorId: 'self', authorName: 'Zoë', content: 'δεύτερο' }), line('m3', { authorName: 'Nikos', content: 'θυμάσαι το βιβλίο;' })];
  const args = { guildId: GUILD, channel, history, trigger: history[2], triggerKind: 'mention', mode: 'reply', selfName: 'Zoë', audience };
  return { picker, llm, hot, args };
}

test('createParticipationPicker: a pick maps back through the headline order; the request carries the blocks', async () => {
  const { picker, llm, args } = pickerScene({ answer: '2' });
  const { result, logs } = await withCapturedLogs(() => picker(args));
  assert.deepEqual(result, ['p1'], 'number 2 is the older episode: headlines are newest first');
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'You are Zoë.');
  assert.ok(userText(user.content).startsWith('<episodes>\n'), userText(user.content));
  assert.equal(user.content[0].cacheSegment, 'stable', 'the episodes part is tagged');
  assert.equal(user.content[1].cacheSegment, undefined);
  assert.ok(userText(user.content).includes('Zoë (you)'), 'the persona\'s own transcript lines carry labels.self');
  assert.ok(userText(user.content).includes('<candidate>\nNikos: θυμάσαι το βιβλίο;\n</candidate>'));
  assert.ok(userText(user.content).includes('<episodes>\n1 | #jardin | 30 min |  | Zoë: ωραία λουλούδια\n2 | #journal | 2 h | Ana: πού είναι το βιβλίο; | Zoë: στο ράφι\n</episodes>'), userText(user.content));
  const classified = logs.find((l) => l.msg === 'participation: classified');
  assert.equal(classified.channel, 'c1');
  assert.equal(classified.offered, 2);
  assert.equal(classified.picked, 1);
  assert.equal(classified.parse, 'pick');
  assert.ok(!JSON.stringify(logs).includes('βιβλίο') && !JSON.stringify(logs).includes('journal'), 'no text, no channel name in the logs');
});

test('createParticipationPicker: the request options carry the classifier model, the purpose, the cap and the helper timeout', async () => {
  const { picker, llm, args, hot } = pickerScene();
  await withCapturedLogs(() => picker(args));
  const { options } = llm.calls[0];
  assert.equal(options.model, hot.config.roles.analyzer);
  assert.equal(options.role, 'analyzer');
  assert.equal(options.purpose, 'participation-pick');
  assert.equal(options.maxOutputTokens, 60);
  assert.equal(options.timeoutMs, 4321);
});

test('createParticipationPicker: the transcript holds the last contextMessages lines before the candidate', async () => {
  const { llm, args } = pickerScene();
  args.history = [line('m0', { content: 'παλιό' }), ...args.history];
  const hot = { config: config({ participation: { contextMessages: 1 } }), prompts: { 'participation-pick': 'p', labels } };
  const narrow = createParticipationPicker({ hot, store: { getParticipation: () => participationState(), listChannels: () => [{ id: 'c2', name: 'journal' }] }, llm, now: () => NOW });
  await withCapturedLogs(() => narrow(args));
  const user = userText(llm.calls.at(-1).messages[1].content);
  assert.ok(user.includes('δεύτερο') && !user.includes('πρώτο') && !user.includes('παλιό'));
});

test('createParticipationPicker: none, garbage and unknown numbers pick nothing', async () => {
  for (const [answer, parse] of [['none', 'none'], ['', 'empty'], ['μάλλον το δεύτερο', 'unparsed'], ['5', 'unknown-id']]) {
    const { picker, args } = pickerScene({ answer });
    const { result, logs } = await withCapturedLogs(() => picker(args));
    assert.deepEqual(result, [], answer);
    const classified = logs.find((l) => l.msg === 'participation: classified');
    assert.equal(classified.parse, parse, answer);
    assert.equal(classified.picked, 0);
  }
});

test('createParticipationPicker: the audience and the current channel decide what is offered; nothing offered asks nothing', async () => {
  const { picker, llm, args } = pickerScene({ audience: (id) => id === 'c3' });
  await withCapturedLogs(() => picker(args));
  assert.ok(!llm.calls[0].messages[1].content.includes('#journal'), 'a channel the audience refuses is not offered');
  const none = pickerScene({ audience: () => false });
  const { result, logs } = await withCapturedLogs(() => none.picker(none.args));
  assert.deepEqual(result, []);
  assert.equal(none.llm.calls.length, 0);
  assert.equal(logs.filter((l) => l.msg.startsWith('participation:')).length, 0, 'no headline: no call and no log');
});

test('createParticipationPicker: the switch off, a refused turn kind or no store asks nothing', async () => {
  const off = pickerScene({ features: { participation: false } });
  assert.deepEqual(await off.picker(off.args), []);
  assert.equal(off.llm.calls.length, 0);
  const drawFailed = pickerScene();
  assert.deepEqual(await drawFailed.picker({ ...drawFailed.args, triggerKind: 'drawFailed' }), []);
  assert.equal(drawFailed.llm.calls.length, 0);
  const llm = fakeLlm('1');
  const bare = createParticipationPicker({ hot: { config: config(), prompts: { 'participation-pick': 'p', labels } }, store: {}, llm, now: () => NOW });
  assert.deepEqual(await bare(pickerScene().args), []);
  assert.equal(llm.calls.length, 0);
});

test('createParticipationPicker: without the prompt it is skipped with no-prompt', async () => {
  const { picker, llm, args } = pickerScene({ prompt: '' });
  const { result, logs } = await withCapturedLogs(() => picker(args));
  assert.deepEqual(result, []);
  assert.equal(llm.calls.length, 0);
  const skipped = logs.find((l) => l.msg === 'participation: skipped');
  assert.equal(skipped.reason, 'no-prompt');
});

test('createParticipationPicker: a refused or failed request picks nothing and logs its rail code', async () => {
  const { picker, args } = pickerScene({ answer: new DailyCapError('cap') });
  const { result, logs } = await withCapturedLogs(() => picker(args));
  assert.deepEqual(result, []);
  const failed = logs.find((l) => l.msg === 'participation: failed');
  assert.equal(failed.reason, 'daily-cap');
});
