// Tests for the inner turn (src/behavior/turn.js, mode `inner`; docs/inner-life.md): no message
// is fabricated, the request carries `<wake>` and the inner task, her reads run; in shadow mode
// nothing else does (proposed, journalled as shadow, no call mark), live her calls run through
// the gateway on her own grants, the kill switch is asked right before an action, the public post
// cap refuses, her output tags (<msg>, <gif>, <draw>, <react to>) are lowered into the calls they
// stand for in the current channel (a refusal when there is none or a reaction names no line),
// and an ordinary turn's request is unchanged by
// the switch; a refusal in shadow reaches her within the turn; what her reads found comes back as
// the turn's episode for her memory. The loop's inner rules: the loop runs under innerLife.loop's
// own bounds (a generous budget: nobody waits), the open-intentions line lists what she woke for
// and has not touched, her last step still runs one post or intention change, and a post that
// leaves nothing to show while a woken intention is untouched gets one open follow-up step. Over a real admin and the fake interface adapter; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTurnRunner, loopSettings } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createJournal, callMarksOf } from '../src/memory/journal.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { checkSkill } from '../src/skills/gateway.js';
import { createAdmin } from '../src/admin.js';
import { feedbackInTurnText, placesBlockText, wakeBlockText } from '../src/behavior/wake.js';
import { feedbackFacts } from '../src/behavior/inner.js';
import { wakeLanes } from '../src/behavior/prefetch.js';
import { labels } from './fixtures/labels.js';
import { fill, formatClock, formatDate } from '../src/format.js';
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
    chain: { used: 0, cap: 3, left: 3 },
  },
};

/**
 * One inner turn in #general (c1) answered with `answers`; `shadow` its mode; `gate` overrides of
 * the inner parameter (mayAct); `loop` overrides of `innerLife.loop` (the
 * inner turn's bounds), `skillsLoop` of `skills.loop` (an ordinary turn's); `clock` the turn's
 * clock (NOW when none); `slowMs` delays every operation of hers by that many real milliseconds.
 */
async function innerTurn({ answers, shadow = true, gate = {}, journal = null, allowed = ['lore.list'], onCall = null, features = {}, intentions = null, withErrands = false, errandConfigured = true, loop = null, skillsLoop = null, listed = true, clock = () => NOW, slowMs = 0, gifs = null }) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' }), rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Zoë', content: 'δεύτερο' }), rawMessage({ id: 'm2', ts: NOW - 30_000, content: 'τρίτο' })];
  const hot = hotWith({ features: { journal: Boolean(journal), ...features }, access: personaGrants(allowed) });
  if (loop) hot.config.innerLife.loop = { ...loop };
  if (skillsLoop) hot.config.skills.loop = { ...hot.config.skills.loop, ...skillsLoop };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const m of history) port.seed('c1', { authorId: m.author.id, messageId: m.id, text: m.cleanContent });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = fakeStore();
  if (gifs) Object.assign(store, { findGif: (guildId, handle) => gifs[handle] ?? null, recordOwnGif: () => {} });
  // A real errand service over a temp task store, its runner a fake whose runs never end.
  let errands = null;
  if (withErrands) {
    hot.config.agents = { maxOpen: 3, web: { enabled: true, daily: { tasks: 10 } } };
    const stores = createTaskStores({ dataDir: tempDir('nep-inner-errand-'), config: () => hot.config });
    errands = createErrandService({ client: { configured: () => errandConfigured, run: () => new Promise(() => {}), cancel: () => true }, stores, hot, getGuildId: () => 'g1' });
  }
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', port, ...(errands ? { errands } : {}) });
  const llm = sequenceLlm(answers, { onCall });
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const slow = (fn) => (slowMs > 0 ? async (...a) => { await new Promise((resolve) => setTimeout(resolve, slowMs)); return fn(...a); } : fn);
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: clock, port, skills: skillRegistry(), journal, runCommand: slow(admin.runCommand), runOwnCommand: slow(admin.runOwnCommand), runInitiativeCommand: slow(admin.runInitiativeCommand), intentions, ...(errands ? { errands } : {}) });
  const inner = { wake: WAKE, shadow, mayAct: () => true, ...gate };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history, { listed }), guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner }));
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: call.args[0].conversationId, ...call.args[1] }));
  return { result, logs, llm, sends, store, tasks: errands ? errands.store('g1').recent(10) : [] };
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

test('inner turn, live: her <msg> and <gif> are public actions in the current channel, run through the gate like message.create calls', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg><gif>g1</gif>', '<skip/>'], shadow: false, gifs });
  assert.deepEqual(run.sends.map((send) => send.text), ['γεια σας', 'https://tenor.example/cat']);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.result}`), ['message.create:executed:ok', 'message.create:executed:ok']);
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
  assert.equal(run.result.inner.actions[0].target.channel, undefined, 'the turn\'s own channel is the default: no channel argument');
});


test('inner turn: <skills_tools> lists the posting skills after the reads when granted; an addressed turn\'s does not', async () => {
  const allowed = ['lore.list', 'web.read', 'message.create', 'message.react.add', 'draw.create'];
  const run = await innerTurn({ answers: ['<skip/>'], allowed });
  const text = userText(run.llm.calls[0][1].content);
  const block = /<skills_tools>\n([\s\S]*?)\n<\/skills_tools>/.exec(text)?.[1] ?? '';
  const at = (name) => block.indexOf(name);
  assert.ok(at('web.read') >= 0 && at('message.create') > at('web.read') && at('message.react.add') > at('message.create') && at('draw.create') > at('message.react.add'), block);
  const bare = await innerTurn({ answers: ['<skip/>'], allowed: ['lore.list', 'web.read'] });
  assert.ok(!userText(bare.llm.calls[0][1].content).includes('message.create'), 'not granted: not listed');
});

test('inner turn, shadow: the tags are only proposed, as a message.create call is', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg><react to="#2">👍</react>', '<skip/>'] });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.react.add:proposed', 'message.create:proposed']);
});

test('inner turn: with no current channel a <msg>, <gif> or <draw> is refused destination-required before any side effect; message.create with a channel goes', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg><gif>g1</gif>', '<call skill="message.create" channel="#general">καλημέρα</call>', '<skip/>'], shadow: false, gifs, gate: { currentChannel: null } });
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`), ['message.create:refused:destination-required', 'message.create:refused:destination-required', 'message.create:executed:']);
  assert.deepEqual(run.sends.map((send) => send.text), ['καλημέρα']);
  assert.ok(userText(run.llm.calls[1][1].content).includes(labels.skills.result.reasons['destination-required']), 'she reads the refusal');
});

test('inner turn, live: a <react> needs a target; without one it is refused target-required, with one it reacts', async () => {
  const bare = await innerTurn({ answers: ['<react>👍</react>', '<skip/>'], shadow: false });
  assert.deepEqual(bare.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['message.react.add:refused:target-required']);
  assert.equal(bare.llm.calls.length, 2, 'she reads the refusal');
  assert.ok(userText(bare.llm.calls[1][1].content).includes(labels.skills.result.reasons['target-required']));
  const targeted = await innerTurn({ answers: ['<react to="#2">👍</react>', '<skip/>'], shadow: false });
  assert.deepEqual(targeted.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.react.add:executed']);
});

test('inner turn, live: <msg reply="#N"> replies to that line; the tags go first, in the order of an addressed turn, then her calls', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">τρίτο</call><msg reply="#2">πρώτο</msg><msg>δεύτερο</msg>', '<skip/>'], shadow: false });
  assert.deepEqual(run.sends.map((send) => send.text), ['πρώτο', 'δεύτερο', 'τρίτο']);
  assert.equal(run.sends[0].replyTo?.messageId, 'm2');
  assert.equal(run.sends[1].replyTo, undefined);
});


test('inner turn, shadow: a read runs, a post is only proposed and journalled as shadow, with no call mark', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], journal });
  assert.deepEqual(run.sends, [], 'nothing left the turn');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:proposed']);
  assert.equal(run.result.shadow, true);
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

test('inner turn, live: her post runs through the gateway on her own grant', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], shadow: false });
  assert.equal(run.sends.length, 1);
  assert.equal(run.llm.calls.length, 2, 'the open follow-up step: i1 is still untouched');
  assert.equal(run.sends[0].to, 'c1');
  assert.equal(run.sends[0].text, 'καλημέρα σε όλους');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:executed']);
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
});

test('inner turn, live: a stop between her answer and the action refuses the action', async () => {
  let stopped = false;
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false, gate: { mayAct: () => !stopped }, onCall: () => (stopped = true) });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['message.create:refused:inner-stopped']);
});

test('inner turn, live: no count of posts refuses a post; a read still runs', async () => {
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false });
  assert.equal(run.sends.length, 1);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:executed']);
  assert.equal(run.result.inner.actions[1].code, undefined);
  assert.equal(run.result.inner.actions[1].delivery, undefined);
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
  assert.ok(!lines.some((line) => line.startsWith('day ') || line.startsWith('hour ') || line.startsWith('posts ')), text);
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

test('wakeBlockText: a review\'s expired intentions follow the wake lines -- the lead, one line each with its moment, the rest counted; none without the labels or items', () => {
  const l = { ...labels, wake: { ...labels.wake, expired: 'gone:', expiredItem: '- {id} {purpose} at {when}', expiredMore: '+{more} gone' } };
  const at = NOW - 3_600_000;
  const expired = { items: [{ id: 'i9', purpose: 'κάτι  που\nξέχασα', at }, { id: 'i8', purpose: 'άλλο', at: at - 60_000 }], more: 2 };
  const review = { ...WAKE, kind: 'review', items: [{ kind: 'review', reason: 'review', intentionIds: [], taskId: null }], channels: ['γενικά'], expired };
  const lines = wakeBlockText(review, l).split('\n');
  assert.deepEqual(lines.slice(1, 6), ['review', 'gone:', `- i9 κάτι που ξέχασα at ${formatDate(at, 'UTC')} ${formatClock(at, 'UTC')}`, `- i8 άλλο at ${formatDate(at - 60_000, 'UTC')} ${formatClock(at - 60_000, 'UTC')}`, '+2 gone']);
  assert.ok(lines[6].startsWith('now: '), 'the moment follows the expired list');
  assert.equal(wakeBlockText({ ...review, expired: { ...expired, more: 0 } }, l).includes('gone'), true);
  assert.equal(wakeBlockText({ ...review, expired: { ...expired, more: 0 } }, l).includes('+'), false, 'no "more" line when nothing follows');
  assert.equal(wakeBlockText({ ...review, expired: { items: [], more: 0 } }, l).includes('gone:'), false, 'no lead without an item');
  assert.equal(wakeBlockText(review, labels).includes('i9'), false, 'nothing without the labels');
  assert.equal(wakeBlockText(review, { ...labels, wake: { ...labels.wake, expired: 'gone:' } }).includes('gone:'), false, 'the lead needs the item label too');
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

test('inner turn, live: errands she hands off are queued like any call, with no hold and no dollar check', async () => {
  const run = await innerTurn({ answers: ['<call skill="task.run" agent="web">βρες τον πρώτο πίνακα</call><call skill="task.run" agent="web">βρες τον δεύτερο πίνακα</call>', '<skip/>'], shadow: false, allowed: ['task.run'], withErrands: true });
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`), ['task.run:executed:', 'task.run:executed:']);
  assert.equal(run.tasks.length, 2);
  assert.ok(run.tasks.every((task) => typeof task.idempotencyKey === 'string' && task.idempotencyKey));
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
const OPEN_LINE = fill(labels.task.continueInnerOpen, { list: 'i1: πες καλημέρα στο κανάλι' });
const INNER_LEAD = (skill) => fill(labels.task.continueInner.split('\n')[0], { skill });
const LAST_LEAD = (skill) => fill(labels.task.continueInnerLast.split('\n')[0], { skill });

test('inner turn, live: a <msg> that leaves nothing to show while a woken intention is untouched gets the one open follow-up step', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg>', '<skip/>'], shadow: false });
  assert.equal(run.llm.calls.length, 2);
  assert.equal(taskOf(run, 1), `${INNER_LEAD('message.create')}\n${OPEN_LINE}`);
  assert.equal(run.result.inner.openFollowUp, true);
  assert.equal(run.sends.length, 1);
});

test('inner turn, live: message.create with gif= posts the text then the GIF', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({ answers: ['<call skill="message.create" gif="g1">νιάου</call>', '<skip/>'], shadow: false, gifs });
  assert.deepEqual(run.sends.map((send) => send.text), ['νιάου', 'https://tenor.example/cat']);
  assert.equal(run.store.state.data.gifCount, 1);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:executed']);
});

test('loopSettings: an inner turn\'s bounds are innerLife.loop\'s (config.json\'s when missing or unusable); an ordinary turn\'s stay skills.loop\'s', () => {
  const tracked = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(loopSettings({}, { inner: true }), tracked.innerLife.loop);
  assert.deepEqual(tracked.innerLife.loop, { maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 });
  assert.deepEqual(loopSettings({ innerLife: { loop: { maxSteps: 0, timeBudgetMs: -1, maxCallsPerStep: 1.5, callTimeoutMs: 'x' } } }, { inner: true }), tracked.innerLife.loop);
  assert.deepEqual(loopSettings({ innerLife: { loop: { maxSteps: 2, timeBudgetMs: 900, maxCallsPerStep: 1, callTimeoutMs: 500 } } }, { inner: true }), { maxSteps: 2, timeBudgetMs: 900, maxCallsPerStep: 1, callTimeoutMs: 500 });
  // skills.loop never reaches an inner turn, innerLife.loop never an ordinary one.
  const both = { skills: { loop: { maxSteps: 1, timeBudgetMs: 5, maxCallsPerStep: 1 } }, innerLife: { loop: { maxSteps: 9, timeBudgetMs: 99, maxCallsPerStep: 9, callTimeoutMs: 9 } } };
  assert.deepEqual(loopSettings(both, { inner: true }), both.innerLife.loop);
  assert.deepEqual(loopSettings(both), both.skills.loop);
  assert.deepEqual(loopSettings(both, { inner: false }), both.skills.loop);
});

test('inner turn, budget: a slow call past skills.loop\'s 20 s completes inside innerLife.loop; past innerLife.loop.callTimeoutMs it is unknown as today', async () => {
  // The clock jumps 25 s while the second request is out: skills.loop's budget would be spent, innerLife.loop's is not.
  const jumping = () => {
    let at = NOW;
    return { clock: () => at, onCall: (n) => { if (n === 2) at += 25_000; } };
  };
  let t = jumping();
  const run = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/>', '<skip/>'], clock: t.clock, onCall: t.onCall, slowMs: 300, skillsLoop: { maxSteps: 1, timeBudgetMs: 1000 } });
  assert.equal(run.llm.calls.length, 3, 'the read came back to her twice');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.result}`), ['lore.list:executed:ok', 'lore.list:executed:ok']);
  assert.ok(taskOf(run, 2).startsWith(INNER_LEAD('lore.list')), 'not her last step: 25 s is inside the inner budget');
  assert.ok(!run.logs.some((l) => l.msg === 'skills: loop cap'));
  // The inner per-call timeout: min(innerLife.loop.callTimeoutMs, what is left) -- here 100 ms against a 300 ms call.
  t = jumping();
  const cut = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/>', '<skip/>'], clock: t.clock, onCall: t.onCall, slowMs: 300, loop: { maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 100 } });
  assert.deepEqual(cut.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.result}:${a.code}`), ['lore.list:executed:unknown:timeout', 'lore.list:executed:unknown:timeout']);
  // The inner budget spent: the next step is her last, as on every turn.
  let at = NOW;
  const spent = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/>', '<skip/>'], clock: () => at, onCall: (n) => { if (n === 2) at += 181_000; } });
  assert.equal(spent.llm.calls.length, 3);
  assert.ok(taskOf(spent, 2).startsWith(LAST_LEAD('lore.list')), taskOf(spent, 2));
});

test('inner turn: the open line names only intentions no intent call touched', async () => {
  // intent.update naming i1 (in shadow: only proposed) takes it off the open line: no step is made for it.
  const touched = await innerTurn({ answers: ['<msg>έτοιμο</msg><call skill="intent.update" id="i1" state="done"/>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.deepEqual(touched.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:proposed', 'intent.update:proposed']);
  assert.deepEqual(touched.result.inner.intentIds, ['i1'], 'the result names the intentions her calls touched (the scheduler advances a recurring one as recurred)');
  assert.equal(touched.llm.calls.length, 1, 'nothing left open: no step');
  // The id alone in the body counts the same.
  const bare = await innerTurn({ answers: ['<msg>έτοιμο</msg><call skill="intent.update" state="done">i1</call>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.deepEqual(bare.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:proposed', 'intent.update:proposed']);
  assert.equal(bare.llm.calls.length, 1);
  const none = await innerTurn({ answers: ['<skip/>'] });
  assert.deepEqual(none.result.inner.intentIds, []);
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

test('inner turn, last step: her tags all run, in order, beside the one terminal call; of two explicit calls only the first runs', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({ answers: ['<call skill="lore.list"/>', '<msg>πρώτο</msg><gif>g1</gif><call skill="message.create">τρίτο</call>', '<skip/>'], shadow: false, loop: { maxSteps: 1 }, gifs });
  assert.deepEqual(run.sends.map((send) => send.text), ['πρώτο', 'https://tenor.example/cat', 'τρίτο']);
  assert.equal(run.logs.find((l) => l.msg === 'skills: loop cap'), undefined, 'nothing she wrote as a tag is counted as cut');
  const two = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="message.create">ένα</call><call skill="message.create">δύο</call>', '<skip/>'], shadow: false, loop: { maxSteps: 1 } });
  assert.deepEqual(two.sends.map((send) => send.text), ['ένα']);
  assert.equal(two.logs.find((l) => l.msg === 'skills: loop cap')?.dropped, 1);
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

test('inner turn: the result carries the loop\'s end state, a refused post as the episode\'s fact, and the intention an intent.update closed with its state', async () => {
  // A refused post (no current channel) is an action the episode and the feedback facts carry.
  const refused = await innerTurn({ answers: ['<msg>γεια σας</msg>', '<skip/>'], shadow: false, gate: { currentChannel: null } });
  assert.deepEqual(refused.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['message.create:refused:destination-required']);
  assert.equal(refused.result.inner.actions[0].presented, true, 'a step followed: she read the refusal');
  assert.deepEqual(feedbackFacts(refused.result).filter((fact) => fact.kind === 'callFailed'), [], 'told in the turn: no fact');
  // The same refusal on the last step has no step after it: it is a fact.
  const last = await innerTurn({ answers: ['<call skill="lore.list"/>', '<msg>γεια σας</msg>', '<skip/>'], shadow: false, loop: { maxSteps: 1 }, gate: { currentChannel: null } });
  assert.equal(last.llm.calls.length, 2, 'nothing follows the terminal call');
  assert.equal(last.result.inner.actions.at(-1).presented, undefined);
  assert.deepEqual(feedbackFacts(last.result).filter((fact) => fact.kind === 'callFailed'), [{ kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' }]);
  assert.ok(refused.result.inner.episode, 'a turn with a refused post has an episode for the feedback facts to ride');
  // No loop at all: zeros.
  const silent = await innerTurn({ answers: ['<skip/>'] });
  assert.deepEqual(silent.result.inner.loop, { steps: 0, cut: null, droppedCalls: 0 });
  // The loop cut on its last step with calls dropped; the intent.update action names its intention and state.
  const cut = await innerTurn({ answers: ['<call skill="lore.list"/>', '<call skill="lore.list"/><call skill="message.create">καλημέρα</call><call skill="intent.update" id="i1" state="done"/>', '<skip/>'], shadow: false, loop: { maxSteps: 1 }, allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  assert.deepEqual(cut.result.inner.loop, { steps: 1, cut: 'steps', droppedCalls: 2 });
  const done = await innerTurn({ answers: ['<call skill="intent.update" id="i1" state="done"/>', '<skip/>'], allowed: ['lore.list', 'intent.update'], features: { intentions: true } });
  const action = done.result.inner.actions[0];
  assert.equal(action.skill, 'intent.update');
  assert.equal(action.intentionId, 'i1');
  assert.equal(action.state, 'done');
  assert.ok(done.result.inner.episode, 'a turn with a call other than a read has an episode');
  assert.deepEqual(done.result.inner.episode.actions, [{ skill: 'intent.update', status: 'proposed' }]);
});

test('wakeBlockText: the current channel and why, or that there is none, follow the wake lines; nothing without the labels', () => {
  const here = wakeBlockText({ ...WAKE, here: { channel: 'general', why: 'asked' } }, labels).split('\n');
  assert.ok(here.includes(fill(labels.wake.here, { channel: 'general', why: 'asked' })), here.join('\n'));
  assert.ok(here.indexOf(fill(labels.wake.here, { channel: 'general', why: 'asked' })) < here.findIndex((line) => line.startsWith('now:')));
  const none = wakeBlockText({ ...WAKE, here: null }, labels).split('\n');
  assert.ok(none.includes(labels.wake.hereNone));
  const bare = wakeBlockText({ ...WAKE, here: { channel: 'general', why: 'asked' } }, { ...labels, wake: { ...labels.wake, here: undefined, hereNone: undefined } });
  assert.ok(!bare.includes('general'));
});

test('wakeBlockText: a feedback wake is its kind line and one feedbackItem per fact, each worded by its kind\'s label; a fact without a label is left out', () => {
  const facts = [
    { kind: 'callFailed', skill: 'web.search', status: 'timeout', code: 'timeout' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
    { kind: 'loopCut', cut: 'steps', droppedCalls: 1, steps: 2 },
    { kind: 'wakeDropped', id: 'w', wake: 'intention_due', code: 'no-channel', intentionId: 'i7', purpose: 'announce' },
    { kind: 'unknownKind' },
  ];
  const wake = { ...WAKE, kind: 'feedback', items: [{ kind: 'feedback', reason: 'feedback', intentionIds: [], taskId: null, facts, turnId: 't-1' }], intentions: [] };
  const text = wakeBlockText(wake, labels);
  const lines = text.split('\n');
  assert.equal(lines[0], labels.wake.header);
  assert.equal(lines[1], labels.wake.kinds.feedback);
  assert.equal(lines[2], fill(labels.wake.feedbackItem, { fact: fill(labels.wake.feedback.callFailed, { skill: 'web.search', status: 'timeout', code: 'timeout', text: '' }).trim() }));
  assert.equal(lines[3], fill(labels.wake.feedbackItem, { fact: fill(labels.wake.feedback.doneWithoutDelivery, { id: 'i1', purpose: 'send a cat meme' }) }));
  assert.equal(lines[4], fill(labels.wake.feedbackItem, { fact: fill(labels.wake.feedback.loopCut, { cut: 'steps', dropped: '1', steps: '2' }) }));
  assert.equal(lines[5], fill(labels.wake.feedbackItem, { fact: fill(labels.wake.feedback.wakeDropped, { kind: 'intention_due', code: 'no-channel', id: 'i7', purpose: 'announce', why: '' }).trim() }));
  assert.ok(lines[6].startsWith(labels.wake.now.split('{')[0]), 'the unknown kind left out; the moment follows');
  assert.ok(!text.includes('{'), 'every placeholder filled');
  // Without the item label the facts are left out; the kind line stays.
  const bare = wakeBlockText(wake, { ...labels, wake: { ...labels.wake, feedbackItem: '' } });
  assert.equal(bare.split('\n')[1], labels.wake.kinds.feedback);
  assert.ok(!bare.includes('web.search'));
});

test('wakeBlockText: held, failed-turn and send-failed facts, the sub-code behind a drop, a drop of a wake with no intention by its kind; the kept facts of a turn follow under their header', () => {
  const until = NOW + 6 * 3_600_000;
  const when = `${formatDate(until, 'UTC', 'en-US')} ${formatClock(until, 'UTC', 'en-US')}`;
  const facts = [
    { kind: 'wakeHeld', wakeId: 'w1', wake: 'intention_due', code: 'per-chain', intentionId: 'i2', purpose: 'say hi', until },
    { kind: 'wakeDropped', wakeId: 'w2', wake: 'intention_due', code: 'stale', why: 'done', intentionId: 'i3', purpose: 'old one' },
    { kind: 'wakeDropped', wakeId: 'w3', wake: 'review', code: 'no-channel', why: 'no-review-channel', intentionId: null, purpose: '' },
    { kind: 'turnFailed', code: 'provider-limit', wake: 'attend' },
    { kind: 'sendFailed', code: 'send-failed', n: 1, total: 3 },
    { kind: 'callFailed', skill: 'web.search', status: 'failed', code: 'error', text: 'the page is gone' },
    { kind: 'unknownKind' },
  ];
  const lines = wakeBlockText({ ...WAKE, facts }, labels).split('\n');
  const at = lines.indexOf(labels.wake.feedbackInTurn);
  assert.ok(at > 0, lines.join('\n'));
  const item = (fact) => fill(labels.wake.feedbackItem, { fact });
  assert.deepEqual(lines.slice(at + 1, at + 7), [
    item(`held intention_due i2 say hi per-chain until ${when}`),
    item('wake intention_due i3 old one stale is done'),
    item('wake review no-channel no review channel'),
    item('turn attend failed provider-limit'),
    item('send failed send-failed 1/3'),
    item('call web.search failed error the page is gone'),
  ]);
  assert.ok(lines[at + 7].startsWith(labels.wake.now.split('{')[0]), 'the unknown kind left out; the moment follows');
  // The same lines stand alone for an addressed turn; nothing without facts, a header or the item label.
  assert.equal(feedbackInTurnText(facts, labels).split('\n')[0], labels.wake.feedbackInTurn);
  assert.equal(feedbackInTurnText(facts, labels).split('\n').length, 7);
  assert.equal(feedbackInTurnText([], labels), '');
  assert.equal(feedbackInTurnText([{ kind: 'unknownKind' }], labels), '');
  assert.equal(feedbackInTurnText(facts, { ...labels, wake: { ...labels.wake, feedbackInTurn: undefined } }), '');
  assert.equal(feedbackInTurnText(facts, { ...labels, wake: { ...labels.wake, feedbackItem: undefined } }), '');
});

test('feedbackFacts: every status that is not ok is a callFailed with its code and the operation\'s own text; a proposed call is none', () => {
  const statuses = ['failed', 'partial', 'invalid', 'denied', 'not_configured', 'unknown'];
  const actions = statuses.map((result) => ({ skill: 'web.search', status: 'executed', result, code: `c-${result}`, text: `said ${result}` }));
  actions.push({ skill: 'web.search', status: 'executed', result: 'unknown', code: 'timeout' });
  actions.push({ skill: 'message.create', status: 'proposed', result: 'ok' });
  actions.push({ skill: 'message.create', status: 'refused', result: 'denied', code: 'inner-stopped' });
  const facts = feedbackFacts({ inner: { actions, intentIds: [] } });
  assert.deepEqual(facts.map((fact) => `${fact.status}:${fact.code}:${fact.text ?? ''}`), [
    ...statuses.map((status) => `${status}:c-${status}:said ${status}`),
    'timeout:timeout:',
    'refused:inner-stopped:',
  ]);
});

test('inner turn, live: a call that did not work carries the operation\'s own words into its action and its callFailed fact', async () => {
  const run = await innerTurn({ answers: ['<call skill="task.run" agent="web">βρες τον πίνακα</call>', '<skip/>'], shadow: false, allowed: ['task.run'], withErrands: true, errandConfigured: false });
  const [action] = run.result.inner.actions;
  assert.notEqual(action.result, 'ok');
  assert.equal(action.presented, true);
  assert.deepEqual(feedbackFacts(run.result), [], 'her next step showed the outcome: no fact');
  const [fact] = feedbackFacts({ inner: { actions: [{ ...action, presented: undefined }] } });
  assert.equal(fact.kind, 'callFailed');
  assert.equal(fact.skill, 'task.run');
  assert.equal(fact.status, ['failed', 'partial', 'invalid', 'denied', 'not_configured', 'unknown', 'timeout', 'refused'].includes(action.result) ? action.result : 'failed');
  assert.equal(fact.code, action.code ?? null);
  if (action.text) assert.equal(fact.text, action.text);
});

test('inner turn, live: calls past maxCallsPerStep are told in the step that follows; with no step after them they are a loopCut of the turn', async () => {
  const told = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="lore.list"/>', '<skip/>'], shadow: false, loop: { maxCallsPerStep: 1 } });
  assert.equal(told.llm.calls.length, 2);
  const line = fill(labels.task.callsDropped, { count: '1', why: 'extra-call' });
  assert.ok(taskOf(told, 1).includes(line), taskOf(told, 1));
  assert.deepEqual(told.result.inner.loop, { steps: 1, cut: null, droppedCalls: 0 }, 'told in the turn: not a cut');
  // A post leaves nothing to show and nothing is open: no step follows, the dropped call is a cut.
  const quiet = { ...WAKE, intentions: [] };
  const cut = await innerTurn({ answers: ['<call skill="message.create">καλημέρα</call><call skill="message.create">γεια</call>', '<skip/>'], shadow: false, loop: { maxCallsPerStep: 1 }, gate: { wake: quiet }, allowed: ['message.create'] });
  assert.equal(cut.llm.calls.length, 1);
  assert.deepEqual(cut.result.inner.loop, { steps: 0, cut: 'extra-call', droppedCalls: 1 });
  assert.deepEqual(feedbackFacts(cut.result).filter((fact) => fact.kind === 'loopCut'), [{ kind: 'loopCut', cut: 'extra-call', droppedCalls: 1, steps: 0 }]);
});

test('wakeBlockText: a retried wake is followed by its delayed line with the minutes and the code; none without the label', () => {
  const wake = { items: [{ kind: 'review', intentionIds: [], delayed: { minutes: 7, code: 'timeout' } }, { kind: 'review', intentionIds: [] }], now: NOW, timezone: 'UTC' };
  const lines = wakeBlockText(wake, labels).split('\n');
  assert.equal(lines.filter((line) => line === 'delayed 7 timeout').length, 1);
  assert.equal(lines[lines.indexOf('delayed 7 timeout') - 1], labels.wake.kinds.review);
  const bare = { wake: { ...labels.wake, delayed: undefined } };
  assert.equal(wakeBlockText(wake, { ...labels, ...bare }).includes('delayed'), false);
});
