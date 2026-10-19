// Tests for the inner turn (src/behavior/turn.js, mode `inner`; docs/inner-life.md): no message
// is fabricated, the request carries `<wake>` and the inner task, her reads run; in shadow mode
// nothing else does (proposed, journalled as shadow, no call mark), live her calls run through
// the gateway on her own grants, the kill switch is asked right before an action, the public post
// cap refuses, text outside a call reaches nobody, and an ordinary turn's request is unchanged by
// the switch; a refusal in shadow reaches her within the turn; what her reads found comes back as
// the turn's episode for her memory. The loop's inner rules: text outside a call and no post gets
// one stray follow-up step (task.continueInnerStray, once per turn, never past the steps), the
// open-intentions line lists what she woke for and has not touched, and her last step still runs
// one post or intention change; the stray step names the channel the turn runs in by its directory
// handle, and a post that leaves nothing to show while a woken intention is untouched gets one open
// follow-up step. Over a real admin and the fake interface adapter; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createJournal, callMarksOf } from '../src/memory/journal.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { checkSkill } from '../src/skills/gateway.js';
import { createAdmin } from '../src/admin.js';
import { placesBlockText, wakeBlockText } from '../src/behavior/wake.js';
import { wakeLanes } from '../src/behavior/prefetch.js';
import { labels } from './fixtures/labels.js';
import { fill } from '../src/format.js';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../src/behavior/handles.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const INNER_TASK = 'Nobody wrote to you; read the wake block.';

function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 60_000, content = 'καλημέρα' }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The channel c1 over `historyMessages`; `listed`: whether the guild's channel directory lists it. */
function fakeChannel(historyMessages, { listed = true } = {}) {
  const channel = {
    id: 'c1',
    name: 'general',
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    parent: null,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async () => ({ id: 'sent' }),
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.slice(-arg.limit).map((m) => [m.id, m]));
        return historyMessages.find((m) => m.id === arg) ?? null;
      },
    },
  };
  if (listed) channel.guild.channels.cache.set(channel.id, channel);
  return channel;
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith({ features = {}, access = {}, innerLife = {} } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', owners: ['u1'], access },
      context: {
        channelMessages: 100, neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, maxMessageChars: 800,
        gapMarkerMinutes: 20, otherProfiles: 6, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { memory: true, reactions: true, multiMessage: true, typingSimulation: false, vision: false, followUpContinuation: true, callMarkers: true, coreTools: true, ...features },
      models: { helpers: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      skills: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
      innerLife: { mode: 'shadow', chatMessages: 2, ...innerLife },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      inner: INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers, { onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return { text: answer, usage: {}, estimated: 10 };
    },
  };
}

function journalOverMemory() {
  const lines = [];
  const appendStore = { append: async (file, line) => lines.push(JSON.parse(line)), async *iterate() {} };
  let n = 0;
  const journal = createJournal({ appendStore, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], taskId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα στο κανάλι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: {
    day: { used: 1, cap: 24, left: 23, resetAt: Date.parse('2026-10-20T00:00:00Z') },
    hour: { used: 1, cap: 4, left: 3, resetAt: NOW + 3_000_000 },
    chain: { used: 0, cap: 3, left: 3 },
    usd: { used: 0.15, cap: 4, left: 3.85, resetAt: Date.parse('2026-10-20T00:00:00Z') },
    posts: { used: 0, cap: 2, left: 2, resetAt: Date.parse('2026-10-20T00:00:00Z') },
  },
};

/**
 * One inner turn in #general (c1) answered with `answers`; `shadow` its mode; `gate` overrides of
 * the inner parameter (mayAct, postAllowed, onPosted).
 */
async function innerTurn({ answers, shadow = true, gate = {}, journal = null, allowed = ['lore.list'], onCall = null, features = {}, intentions = null, withErrands = false, errandConfigured = true, loop = null, listed = true }) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' }), rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Zoë', content: 'δεύτερο' }), rawMessage({ id: 'm2', ts: NOW - 30_000, content: 'τρίτο' })];
  const hot = hotWith({ features: { journal: Boolean(journal), ...features }, access: personaGrants(allowed) });
  if (loop) hot.config.skills.loop = { ...hot.config.skills.loop, ...loop };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const m of history) port.seed('c1', { authorId: m.author.id, messageId: m.id, text: m.cleanContent });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = fakeStore();
  // A real errand service over a temp task store, its runner a fake whose runs never end.
  let errands = null;
  if (withErrands) {
    hot.config.agents = { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } } };
    const stores = createTaskStores({ dataDir: tempDir('nep-inner-errand-'), config: () => hot.config });
    errands = createErrandService({ client: { configured: () => errandConfigured, run: () => new Promise(() => {}), cancel: () => true }, stores, hot, getGuildId: () => 'g1' });
  }
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', port, ...(errands ? { errands } : {}) });
  const llm = sequenceLlm(answers, { onCall });
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal, runCommand: admin.runCommand, runOwnCommand: admin.runOwnCommand, runInitiativeCommand: admin.runInitiativeCommand, intentions, ...(errands ? { errands } : {}) });
  const posted = [];
  const inner = { wake: WAKE, shadow, mayAct: () => true, postAllowed: () => true, onPosted: () => posted.push(NOW), ...gate };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history, { listed }), guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner }));
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: call.args[0].conversationId, ...call.args[1] }));
  return { result, logs, llm, sends, posted, tasks: errands ? errands.store('g1').recent(10) : [] };
}

test('inner turn: no message is fabricated; the request carries <wake>, the inner task and the bounded slice of the channel', async () => {
  const run = await innerTurn({ answers: ['<skip/>'] });
  const text = userText(run.llm.calls[0][1].content);
  assert.ok(text.includes(`<wake>\n${labels.wake.header}`), text);
  assert.ok(text.includes('πες καλημέρα στο κανάλι'));
  assert.ok(text.includes(`<task>\n${INNER_TASK}\n</task>`));
  assert.ok(!text.includes('πρώτο'), 'innerLife.chatMessages bounds the slice');
  assert.ok(text.includes('τρίτο'));
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.result.reason, 'nothing-to-do');
});

test('inner turn: what she writes outside a call reaches nobody and is counted; the turn is silence', async () => {
  // Her stray text gets the one follow-up step (below); she ends it: the turn is silence.
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg><react to="#2">👍</react>', '<skip/>'] });
  assert.deepEqual(run.sends, []);
  assert.equal(run.llm.calls.length, 2);
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.result.reason, 'nothing-to-do');
  assert.equal(run.result.inner.stray.messages, 1);
  assert.equal(run.result.inner.stray.reactions, 1);
  assert.equal(run.result.inner.strayFollowUp, true);
});

test('inner turn, shadow: a read runs, a post is only proposed and journalled as shadow, with no call mark', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], journal });
  assert.deepEqual(run.sends, [], 'nothing left the turn');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:proposed']);
  assert.equal(run.result.shadow, true);
  assert.equal(run.posted.length, 0);
  assert.equal(run.llm.calls.length, 2, 'the read came back to her');
  const skillLines = lines.filter((l) => l.kind === 'action' && l.name === 'skill');
  const proposed = skillLines.filter((l) => l.input?.skill === 'message.create');
  assert.deepEqual(proposed.map((l) => l.phase), ['proposed']);
  assert.equal(proposed[0].shadow, true);
  // A shadow turn leaves no call mark at all, after a restart either: nobody saw it.
  assert.deepEqual(callMarksOf(lines).calls, []);
  const readOp = skillLines.find((l) => l.input?.skill === 'lore.list').opId;
  const read = skillLines.filter((l) => l.opId === readOp).map((l) => l.phase);
  assert.deepEqual(read, ['proposed', 'started', 'succeeded'], 'the read ran on her own initiative');
  const start = lines.find((l) => l.kind === 'turn.start');
  assert.equal(start.mode, 'inner');
  assert.equal(start.trigger.kind, 'inner');
});

test('inner turn, live: her post runs through the gateway on her own grant and counts as a public post', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], shadow: false });
  assert.equal(run.sends.length, 1);
  assert.equal(run.llm.calls.length, 2, 'the open follow-up step: i1 is still untouched');
  assert.equal(run.sends[0].to, 'c1');
  assert.equal(run.sends[0].text, 'καλημέρα σε όλους');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:executed']);
  assert.equal(run.posted.length, 1);
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
});

test('inner turn, live: a stop between her answer and the action refuses the action', async () => {
  let stopped = false;
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false, gate: { mayAct: () => !stopped }, onCall: () => (stopped = true) });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['message.create:refused:inner-stopped']);
});

test('inner turn, live: a public post past the day\'s cap is refused; a read still runs', async () => {
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false, gate: { postAllowed: () => false } });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:refused']);
  assert.equal(run.result.inner.actions[1].code, 'inner-post-cap');
});

test('inner turn: an ordinary reply\'s request is the same with the inner life on or off', async () => {
  const requestOf = async (innerLife) => {
    const history = [rawMessage({ id: 'm1', content: 'γεια' })];
    const hot = hotWith({ features: { innerLife } });
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
    const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
    const llm = sequenceLlm(['<skip/>']);
    const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
    const turns = createTurnRunner({ discord: DISCORD, hot, store: fakeStore(), llm, calibrator, client, now: () => NOW, port, skills: skillRegistry() });
    const trigger = { id: 'm1', channelId: 'c1', authorId: 'u1', authorName: 'Alice', self: false, bot: false, content: 'γεια', ts: NOW - 60_000, replyToId: null, attachments: [], stickers: [] };
    await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history), mode: 'reply', trigger, triggerKind: 'mention' }));
    return llm.calls[0];
  };
  const off = await requestOf(false);
  const on = await requestOf(true);
  assert.deepEqual(on, off);
  assert.ok(!userText(off[1].content).includes('<wake>'));
});

test('gateway: with nobody asking only a read runs, unless the turn is her own initiative', () => {
  const config = { features: { skills: true }, bot: { owners: ['u1'], access: personaGrants(['lore.add']) }, skills: { safeMode: false } };
  const call = { skill: 'lore.add', args: { title: 'x', keys: 'x', text: 'y' }, principal: { kind: 'persona' }, requester: null, audience: { conversationId: 'c1' } };
  const unasked = checkSkill({ ...call, context: { config, selfId: 'self-id', registry: skillRegistry() } });
  assert.equal(unasked.ok, false);
  assert.equal(unasked.reason, 'no-requester');
  const own = checkSkill({ ...call, context: { config, selfId: 'self-id', registry: skillRegistry(), ownInitiative: true } });
  assert.notEqual(own.reason, 'no-requester');
  // Her grant still decides.
  const ungranted = checkSkill({ ...call, context: { config: { ...config, bot: { ...config.bot, access: {} } }, selfId: 'self-id', registry: skillRegistry(), ownInitiative: true } });
  assert.equal(ungranted.ok, false);
  assert.notEqual(ungranted.reason, 'no-requester');
});

test('wakeBlockText: the wake, the moment and the budgets as facts; none without its header', () => {
  const text = wakeBlockText({ ...WAKE, channels: ['général'] }, labels);
  const lines = text.split('\n');
  assert.equal(lines[0], labels.wake.header);
  assert.ok(lines.some((line) => line.startsWith('due: i1 πες καλημέρα')), text);
  assert.ok(lines.some((line) => line.startsWith('now: ')));
  assert.ok(lines.includes('recent channels: #général'));
  assert.ok(lines.includes('day 23/24 until 10/20/2026 12:00 AM') || lines.some((line) => line.startsWith('day 23/24 until ')), text);
  assert.ok(lines.includes('chain 3/3'));
  assert.equal(wakeBlockText(WAKE, { ...labels, wake: undefined }), '');
  // A recurring intention's last occurrence before its expiry: the note joins its line.
  const noted = wakeBlockText({ ...WAKE, notes: { i1: 'last-occurrence' } }, { ...labels, intentions: { notes: { 'last-occurrence': 'LAST' } } }).split('\n');
  assert.ok(noted.some((line) => line.startsWith('due: i1 πες καλημέρα') && line.endsWith(' · LAST')), noted.join('|'));
  assert.equal(wakeBlockText({ ...WAKE, notes: { i1: 'last-occurrence' } }, labels).split('\n')[1], lines[1], 'without the note label the line stays as it is');
});

test('wakeBlockText: an attend wake names the place, the lines and the people; the places page follows with its total and the rest; placesBlockText stands alone', () => {
  const attend = { kind: 'attend', reason: 'lines', intentionIds: ['i1'], taskId: null, attend: { place: 'c2', placeName: 'κήπος', lines: 3, people: ['u1', 'u2'], peopleNames: ['Ana', 'u2'], since: NOW - 3_600_000 } };
  const places = { total: 5, more: 2, items: [{ id: 'c2', name: 'κήπος', lines: 3, people: 2, writable: true, attended: true }, { id: 'c3', name: 'νέα', lines: 1, people: 1, writable: false, attended: false }, { id: 'c1', name: 'general', lines: 0, people: 0, writable: true, attended: false }] };
  const lines = wakeBlockText({ ...WAKE, kind: 'attend', items: [attend], places }, labels).split('\n');
  assert.ok(lines.includes('talk in #κήπος (i1 πες καλημέρα στο κανάλι): 3 lines since 10/19/2026 11:00 AM by Ana, u2') || lines.some((line) => line.startsWith('talk in #κήπος (i1 πες καλημέρα στο κανάλι): 3 lines since ') && line.endsWith(' by Ana, u2')), lines.join('|'));
  const at = lines.indexOf('places (5):');
  assert.ok(at > 0, lines.join('|'));
  assert.deepEqual(lines.slice(at, at + 5), ['places (5):', '#κήπος 3/2 *', '#νέα 1/1 ro', '#general 0/0', '+2']);
  assert.ok(lines.indexOf('budgets:') > at, 'the budgets close the block');
  assert.equal(wakeBlockText({ ...WAKE, places: { total: 1, more: 0, items: [{ id: 'c1', name: 'general', lines: 0, people: 0 }] } }, labels).split('\n').filter((line) => line.startsWith('+')).length, 0, 'no "more" line when nothing follows');
  assert.equal(wakeBlockText({ ...WAKE, places }, { ...labels, wake: { ...labels.wake, places: undefined } }).includes('#κήπος'), false, 'no page without its lead label');
  assert.equal(placesBlockText(places, labels), ['places (5):', '#κήπος 3/2 *', '#νέα 1/1 ro', '#general 0/0', '+2'].join('\n'));
  assert.equal(placesBlockText(null, labels), '');
});

test('wakeLanes: the purposes of the intentions as one wake lane; none for a review alone', () => {
  assert.deepEqual(wakeLanes(['a', ' b ']), { lanes: [{ kind: 'wake', text: 'a\nb', words: 'a\nb' }], skip: null });
  assert.deepEqual(wakeLanes([]), { lanes: [], skip: 'no-trigger' });
});

test('inner turn, shadow: a diary.post with a channel she gave it is refused, and she hears why within the turn (no lasting mark)', async () => {
  // The call shape of a recorded shadow review: an attribute diary.post does not take, her entry as the body.
  const { journal, lines } = journalOverMemory();
  const run = await innerTurn({
    answers: ['<call skill="diary.post" channel="#general">δεν μπορώ να κοιμηθώ</call>', '<call skill="diary.post" topic="δεν μπορώ να κοιμηθώ"/>', '<skip/>'],
    allowed: ['diary.post'],
    journal,
  });
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`), ['diary.post:refused:invalid-args', 'diary.post:proposed:shadow']);
  assert.equal(run.llm.calls.length, 2, 'the refusal came back to her; the corrected call is only proposed');
  const step = userText(run.llm.calls[1][1].content);
  const reason = fill(labels.skills.refusals.unknownArg, { arg: 'channel', args: 'kind, topic' });
  assert.ok(step.includes(reason), step);
  assert.deepEqual(callMarksOf(lines).calls, [], 'nothing of a shadow turn is marked for later turns');
});

test('inner turn: what her reads found, her thinks and her other calls come back as the turn\'s episode, shadow marked', async () => {
  const run = await innerTurn({ answers: ['<think>θα κοιτάξω τα λήμματα</think><call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<think>τίποτα καινούριο</think><skip/>'] });
  const episode = run.result.inner.episode;
  assert.ok(episode, 'an episode');
  assert.equal(episode.shadow, true);
  assert.equal(episode.channelId, 'c1');
  assert.equal(episode.privateUserId, null);
  assert.equal(episode.selfId, 'self-id');
  assert.equal(episode.turnId, run.result.inner.turnId);
  assert.deepEqual(episode.thinks, ['θα κοιτάξω τα λήμματα', 'τίποτα καινούριο']);
  assert.deepEqual(episode.findings.map((f) => f.skill), ['lore.list']);
  assert.ok(episode.findings[0].text.length > 0);
  assert.deepEqual(episode.actions, [{ skill: 'message.create', status: 'proposed' }], 'reads are findings, not actions');
  const silent = await innerTurn({ answers: ['<skip/>'] });
  assert.equal(silent.result.inner.episode, null, 'nothing found: no episode');
});

test('inner turn, live: an errand is handed off only when its hold fits; the hold is bound to the errand, a refused one queues nothing', async () => {
  const asked = [];
  const bound = [];
  const released = [];
  const gate = {
    reserveErrand: (input) => (asked.push(input), asked.length === 1 ? { ok: true, id: 'h1' } : { ok: false, code: 'inner-usd-cap' }),
    bindErrand: (hold, taskId) => bound.push([hold, taskId]),
    releaseErrand: (hold) => released.push(hold),
  };
  const run = await innerTurn({ answers: ['<call skill="task.run" agent="web">βρες τον πρώτο πίνακα</call><call skill="task.run" agent="web">βρες τον δεύτερο πίνακα</call>', '<skip/>'], shadow: false, allowed: ['task.run'], gate, withErrands: true });
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`), ['task.run:executed:', 'task.run:refused:inner-usd-cap']);
  assert.deepEqual(asked.map((a) => a.agent), ['web', 'web']);
  assert.ok(asked.every((a) => typeof a.key === 'string' && a.key), 'each hold carries its call\'s idempotency key');
  assert.equal(run.tasks.length, 1, 'the refused errand was never queued');
  assert.deepEqual(bound, [['h1', run.tasks[0].id]]);
  assert.equal(run.tasks[0].idempotencyKey, asked[0].key);
  assert.deepEqual(released, []);
});

test('inner turn, live: a hold whose errand was not queued (the operation refused it) is released', async () => {
  const released = [];
  const gate = { reserveErrand: () => ({ ok: true, id: 'h1' }), bindErrand: () => assert.fail('nothing to bind'), releaseErrand: (hold) => released.push(hold) };
  // The agent's runner is not set up: the operation refuses the errand (`not-configured`).
  const run = await innerTurn({ answers: ['<call skill="task.run" agent="web">βρες κάτι</call>', '<skip/>'], shadow: false, allowed: ['task.run'], gate, withErrands: true, errandConfigured: false });
  assert.notEqual(run.result.inner.actions[0].result, 'ok');
  assert.deepEqual(released, ['h1']);
});

test('inner turn: once the day\'s dollars are spent her calls are refused (inner-usd-cap) and the loop makes no further request', async () => {
  let spent = false;
  const run = await innerTurn({ answers: ['<call skill="lore.list"/>', '<skip/>'], shadow: false, gate: { spendAllowed: () => !spent }, onCall: () => (spent = true) });
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['lore.list:refused:inner-usd-cap']);
  assert.equal(run.llm.calls.length, 1, 'no step after the refusal');
});

test('inner turn, live: the line she posts is noted with its turn and chain, and as read when a read of the turn returned something first', async () => {
  const notes = [];
  const intentions = { noteLine: (id, sources) => notes.push({ id, ...sources }) };
  const wake = { ...WAKE, chainId: 'chain:greet' };
  await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], shadow: false, gate: { wake }, intentions });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].inner, true);
  assert.equal(notes[0].chainId, 'chain:greet');
  assert.equal(notes[0].read, undefined, 'nothing read before it');
  notes.length = 0;
  await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], shadow: false, gate: { wake }, intentions });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].read, true);
});

/** The task text of the request `n` (0-based) of `run`. */
function taskOf(run, n) {
  const text = userText(run.llm.calls[n][1].content);
  const match = /<task>\n([\s\S]*?)\n<\/task>/.exec(text);
  assert.ok(match, `request ${n} has a task`);
  return match[1];
}

/** The handle `<channel_directory>` gives c1 (the one channel listed: the short form). */
const C1_HANDLE = `#${handleOf('c1', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}`;
const STRAY_LEAD = fill(labels.task.continueInnerStray.split('\n')[0], { channel: C1_HANDLE });
const OPEN_LINE = fill(labels.task.continueInnerOpen, { list: 'i1: πες καλημέρα στο κανάλι' });
const INNER_LEAD = (skill) => fill(labels.task.continueInner.split('\n')[0], { skill });
const LAST_LEAD = (skill) => fill(labels.task.continueInnerLast.split('\n')[0], { skill });

test('inner turn, stray: a <msg> with no call gets one follow-up step under continueInnerStray with the open intentions; her post then goes out', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg>', '<call skill="message.create">γεια σας</call>', '<skip/>'], shadow: false });
  assert.equal(run.llm.calls.length, 3, 'the stray follow-up step, then the open follow-up after its post');
  assert.equal(run.result.inner.openFollowUp, true);
  assert.equal(taskOf(run, 1), `${STRAY_LEAD}\n${OPEN_LINE}`);
  assert.ok(STRAY_LEAD.includes(C1_HANDLE), 'the step names the channel the turn runs in by its handle');
  assert.ok(userText(run.llm.calls[1][1].content).includes(`${C1_HANDLE} "general"`), 'the same handle the channel directory shows');
  assert.equal(run.sends.length, 1);
  assert.equal(run.sends[0].text, 'γεια σας');
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.inner.strayFollowUp, true);
  assert.equal(run.result.inner.stray.messages, 1, 'the stray counter is as before');
});

test('inner turn, stray: a channel the directory does not list gets no handle, and the channel sentence is left out whole', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg>', '<skip/>'], listed: false });
  assert.equal(run.llm.calls.length, 2);
  const task = taskOf(run, 1);
  assert.ok(!task.includes('{channel}'), task);
  assert.ok(!task.includes(C1_HANDLE), task);
  const template = labels.task.continueInnerStray.split('\n')[0];
  const sentence = template.split('. ').find((part) => part.includes('{channel}'));
  assert.ok(sentence, 'the fixture label keeps the channel in a sentence of its own');
  assert.equal(task, `${template.replace(`${sentence}. `, '')}\n${OPEN_LINE}`);
});

test('inner turn, stray: the follow-up is made once per turn; a second stray answer ends the turn as silence', async () => {
  const run = await innerTurn({ answers: ['<msg>ένα</msg>', '<msg>δύο</msg>', '<msg>τρία</msg>'] });
  assert.equal(run.llm.calls.length, 2);
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.result.reason, 'nothing-to-do');
  assert.equal(run.result.inner.stray.messages, 2);
  assert.equal(run.result.inner.strayFollowUp, true);
});

test('inner turn, stray: beside a read the next step takes the stray label in place of continueInner; a message.create call beside it does not', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια</msg><call skill="lore.list"/>', '<skip/>'] });
  assert.equal(run.llm.calls.length, 2);
  assert.ok(taskOf(run, 1).startsWith(STRAY_LEAD), taskOf(run, 1));
  assert.equal(run.result.inner.strayFollowUp, true);
  const posted = await innerTurn({ answers: ['<msg>γεια</msg><call skill="lore.list"/><call skill="message.create">γεια</call>', '<skip/>'] });
  assert.equal(posted.llm.calls.length, 2);
  assert.ok(posted.result.inner.strayFollowUp === undefined, 'she posted: no stray follow-up');
  assert.equal(taskOf(posted, 1), `${fill(labels.task.continueInner.split('\n')[0], { skill: 'lore.list' })}\n${OPEN_LINE}`, 'after a proposed post the open intentions are listed');
});

test('inner turn, stray: no new request once the steps are spent; the open line names only intentions no intent call touched', async () => {
  const spent = await innerTurn({ answers: ['<call skill="lore.list"/>', '<msg>γεια</msg>', '<msg>πάλι</msg>'], loop: { maxSteps: 1 } });
  assert.equal(spent.llm.calls.length, 2, 'the last step was spent on the read; her stray answer there gets no step');
  assert.equal(spent.result.inner.strayFollowUp, undefined);
  // intent.update naming i1 (in shadow: only proposed) takes it off the open line, which is then left out whole.
  const touched = await innerTurn({ answers: ['<msg>έτοιμο</msg><call skill="intent.update" id="i1" state="done"/>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.deepEqual(touched.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['intent.update:proposed']);
  assert.deepEqual(touched.result.inner.intentIds, ['i1'], 'the result names the intentions her calls touched (the scheduler advances a recurring one as recurred)');
  assert.deepEqual(spent.result.inner.intentIds, []);
  assert.equal(touched.llm.calls.length, 2);
  assert.equal(taskOf(touched, 1), STRAY_LEAD, 'no open line, no empty placeholder');
  // The id alone in the body counts the same.
  const bare = await innerTurn({ answers: ['<msg>έτοιμο</msg><call skill="intent.update" state="done">i1</call>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.deepEqual(bare.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['intent.update:proposed']);
  assert.equal(taskOf(bare, 1), STRAY_LEAD);
});

test('inner turn, last step: one post or intention change still runs, nothing follows it; a read there is dropped', async () => {
  const run = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/><call skill="message.create">καλημέρα</call><call skill="intent.update" id="i1" state="done"/>', '<skip/>'], shadow: false, loop: { maxSteps: 1 }, allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.equal(run.llm.calls.length, 2, 'the last step, and no request after its action');
  assert.ok(taskOf(run, 1).startsWith(LAST_LEAD('lore.list')));
  assert.equal(run.sends.length, 1, 'the post went out');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:executed'], 'the first terminal call alone');
  const cap = run.logs.find((l) => l.msg === 'skills: loop cap');
  assert.equal(cap?.dropped, 2);
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
  // A read alone on the last step is dropped as on every turn.
  const read = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/>'], shadow: false, loop: { maxSteps: 1 } });
  assert.equal(read.llm.calls.length, 2);
  assert.deepEqual(read.result.inner.actions.map((a) => a.skill), ['lore.list']);
});

test('inner turn, open follow-up: a post that leaves nothing to show while a woken intention is untouched gets one more step with the open line', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>', '<call skill="intent.update" id="i1" state="done"/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.equal(run.llm.calls.length, 2, 'the open follow-up step; the proposed update leaves nothing to show');
  assert.equal(taskOf(run, 1), `${INNER_LEAD('message.create')}\n${OPEN_LINE}`);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:proposed', 'intent.update:proposed']);
  assert.equal(run.result.inner.openFollowUp, true);
  assert.equal(run.result.inner.strayFollowUp, undefined);
  // Live, the same: the post went out, the intention was named on the extra step (without an
  // intention service the update's outcome comes back to her once more; she ends the turn).
  const live = await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>', '<call skill="intent.update" id="i1" state="done"/>', '<skip/>'], shadow: false, allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.equal(taskOf(live, 1), `${INNER_LEAD('message.create')}\n${OPEN_LINE}`);
  assert.equal(live.sends.length, 1);
  assert.equal(live.result.inner.openFollowUp, true);
  assert.equal(live.result.outcome, 'spoke');
});

test('inner turn, open follow-up: once per turn; none when her post named the intention, and none past the steps', async () => {
  const again = await innerTurn({ answers: ['<call skill="message.create">ένα</call>', '<call skill="message.create">δύο</call>', '<call skill="message.create">τρία</call>'] });
  assert.equal(again.llm.calls.length, 2, 'a second post with the intention still open gets no second extra step');
  assert.equal(again.result.inner.openFollowUp, true);
  const named = await innerTurn({ answers: ['<call skill="message.create">έτοιμο</call><call skill="intent.update" id="i1" state="done"/>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.equal(named.llm.calls.length, 1, 'nothing left open: no step');
  assert.equal(named.result.inner.openFollowUp, undefined);
  // The post as the last step's terminal action: nothing follows it.
  const spent = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="message.create">καλημέρα</call>', '<skip/>'], loop: { maxSteps: 1 } });
  assert.equal(spent.llm.calls.length, 2);
  assert.equal(spent.result.inner.openFollowUp, undefined);
  // A read beside the post: the step is made for the read anyway, with the open line; it is not the extra one.
  const beside = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<skip/>'] });
  assert.equal(beside.llm.calls.length, 2);
  assert.equal(taskOf(beside, 1), `${INNER_LEAD('lore.list')}\n${OPEN_LINE}`);
  assert.equal(beside.result.inner.openFollowUp, undefined);
});

test('inner turn, open follow-up: on the last step the open line comes with continueInnerLast, and the intention change still runs', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα</call>', '<call skill="intent.update" id="i1" state="done"/>', '<skip/>'], loop: { maxSteps: 1 }, allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.equal(run.llm.calls.length, 2, 'the extra step is the last one; its terminal action ends the turn');
  assert.equal(taskOf(run, 1), `${LAST_LEAD('message.create')}\n${OPEN_LINE}`);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:proposed', 'intent.update:proposed']);
  assert.equal(run.result.inner.openFollowUp, true);
  // A read beside a post on the last step: the open line too, no extra step after the last.
  const read = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<skip/>'], loop: { maxSteps: 1 } });
  assert.equal(read.llm.calls.length, 2);
  assert.equal(taskOf(read, 1), `${LAST_LEAD('lore.list')}\n${OPEN_LINE}`);
  assert.equal(read.result.inner.openFollowUp, undefined);
});
