// Tests for src/skills/executors.js and the operations her calls run: one `<call>` of the
// persona's output resolved on the server's side (channels, members, roles, transcript numbers)
// into the arguments of the /nep command behind the skill, then run through that command's own
// path (src/admin.js#runCommand: the requester's rights checked again), the persona as the actor.
// Whatever the operation answers -- an error or a refusal included -- is her result, with a
// structured status; the `/nep message` operations go through a fake interface adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';

import '../src/ops/index.js';
import { createAdmin } from '../src/admin.js';
import { createDiary } from '../src/behavior/diary.js';
import { skillResultBlock } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { QUIET_ON_OK, RESULT_STATUSES, bodyArguments, executeCall, needsFollowUp, outcomeDetail, refusalStatus, resolveCall } from '../src/skills/executors.js';
import { skillRegistry } from '../src/skills/registry.js';
import { checkSkill } from '../src/skills/gateway.js';
import { labels } from './fixtures/labels.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const NEWS = 'c-news';
const ELSEWHERE = 'c-else';
const READ_ONLY = 'c-read-only';
const NO_FILES = 'c-no-files';
const OTHER_GUILD = 'c-other-guild';
const DM = 'c-dm';

const { ViewChannel, SendMessages, ReadMessageHistory, AddReactions } = PermissionFlagsBits;

/**
 * A text channel the client knows: of the served guild g1 (`guildId` another, or a DM without a
 * guild), the bot holding the permissions in `allowed` (every one when null).
 */
function textChannel(id, { guildId = 'g1', dm = false, allowed = null } = {}) {
  return {
    id,
    guild: dm ? null : { id: guildId, members: { me: { id: SELF } } },
    viewable: allowed === null || allowed.includes(ViewChannel),
    isTextBased: () => true,
    isDMBased: () => dm,
    permissionsFor: () => ({ has: (flag) => allowed === null || allowed.includes(flag) }),
  };
}

/** The client's channels: NEWS and 555 open, ELSEWHERE seen but no send, READ_ONLY readable, NO_FILES without Attach Files, one of another guild, a DM. */
function clientChannels() {
  return new Map([
    [NEWS, textChannel(NEWS)],
    ['555', textChannel('555')],
    [ELSEWHERE, textChannel(ELSEWHERE, { allowed: [ViewChannel, ReadMessageHistory, AddReactions] })],
    [READ_ONLY, textChannel(READ_ONLY, { allowed: [ViewChannel, SendMessages, ReadMessageHistory] })],
    [NO_FILES, textChannel(NO_FILES, { allowed: [ViewChannel, SendMessages, ReadMessageHistory, AddReactions] })],
    [OTHER_GUILD, textChannel(OTHER_GUILD, { guildId: 'g2' })],
    [DM, textChannel(DM, { dm: true })],
  ]);
}

/** A config with the settings these tests read, each set here. */
function config({ features = {}, skills = {}, access = {}, diary = {} } = {}) {
  return {
    features: { skills: true, diary: true, ...features },
    skills: { safeMode: false, ...skills },
    bot: { owners: [OWNER], access },
    diary: { channelId: '', kinds: { photos: 1, thought: 1 }, ...diary },
  };
}

/** The turn's view: three channels, a transcript of four lines, three stored members, two roles. */
function view(overrides = {}) {
  const lines = new Map([
    [1, { id: '1001', conversationId: HERE, authorId: MEMBER }],
    [2, { id: '1002', conversationId: HERE, authorId: SELF, self: true }],
    [3, { id: '1003', conversationId: NEWS, authorId: MEMBER }],
    [4, { id: '1004', conversationId: NEWS, authorId: SELF, self: true }],
  ]);
  return {
    skills: skillRegistry(),
    conversations: [
      { id: HERE, name: 'γενικά' },
      { id: NEWS, name: '💖νέα' },
      { id: ELSEWHERE, name: 'αλλού' },
      { id: READ_ONLY, name: 'ανάγνωση' },
      { id: 'k1', name: '🍡κουζίνα' },
      { id: 'k2', name: '🍰κουζίνα' },
    ],
    messageAt: (n) => lines.get(n) ?? null,
    members: [
      { id: MEMBER, names: ['Zoë'], aliases: [{ name: 'Ζωή' }] },
      { id: '8', names: ['Élodie'], aliases: [] },
      { id: '9', names: ['Ana'], aliases: [{ name: 'Élodie' }] },
    ],
    roles: [{ id: 'r1', name: 'Φίλοι' }, { id: 'r2', name: 'Mods' }],
    selfId: SELF,
    ...overrides,
  };
}

/** `<call>` -> resolveCall over the view. */
function resolve(skill, args = {}, body = '', overrides = {}) {
  return resolveCall({ skill, args, body }, view(overrides));
}

test('resolveCall: only a registry skill; its attributes are its command\'s options, the body its `text`', () => {
  assert.deepEqual([resolve('files.wipe').ok, resolve('files.wipe').code], [false, 'unknown-skill']);
  assert.equal(resolve('draw').code, 'unknown-skill', 'no skill exists that is not an operation');
  const said = resolve('message.create', { channel: '#Νέα' }, 'καλημέρα');
  assert.deepEqual([said.ok, said.skill, said.args], [true, 'message.create', { channel: NEWS, text: 'καλημέρα' }]);
  assert.deepEqual(resolve('message.create', { channel: '#νέα', who: 'x' }, 'γεια').reason, 'args.who:unknown');
  assert.deepEqual(resolve('message.create', { text: 'δύο' }, 'φορές').reason, 'args.text:twice');
  // A body where the command takes no text is her comment: left out, the call goes on with its attributes.
  const commented = resolve('message.delete', { message: '#2' }, 'σβήνω το δοκιμαστικό');
  assert.deepEqual([commented.ok, commented.bodyIgnored, commented.args], [true, true, { message: '1002', channel: HERE }]);
  assert.equal('bodyIgnored' in resolve('message.delete', { message: '#2' }), false);
  assert.equal('bodyIgnored' in said, false, 'a body the command takes is its text, as before');
  // whole numbers and yes/no are read strictly; anything else stays text for the schema to refuse
  assert.deepEqual(resolve('rule.remove', { number: '3' }).args, { number: 3 });
  assert.deepEqual(resolve('rule.remove', { number: 'τρία' }).args, { number: 'τρία' });
  assert.deepEqual(resolve('draw.create', { self: 'TRUE' }, 'a lighthouse').args, { self: true, text: 'a lighthouse' });
  assert.deepEqual(resolve('draw.create', { self: 'ναι' }, 'a lighthouse').args.self, 'ναι');
});

test('resolveCall: the body is the skill\'s main argument -- an errand\'s goal, her text -- when the call leaves it out', () => {
  // Each skill declares the argument its body fills; a skill without one takes none.
  const bodyOf = (name) => skillRegistry().get(name).command.body;
  assert.deepEqual(['task.run', 'message.create', 'message.edit', 'rule.add'].map(bodyOf), ['goal', 'text', 'text', 'text']);
  for (const name of ['task.status', 'task.cancel', 'message.delete', 'memory.journal.read', 'rule.remove']) assert.equal(bodyOf(name), null, name);
  // The live call: agent on the tag, the goal in the body -- the errand goes through the gateway.
  const goal = 'read the git history of the server and say what changed this week';
  const errand = resolve('task.run', { agent: 'server' }, goal);
  assert.deepEqual([errand.ok, errand.args, errand.bodyArg, 'bodyIgnored' in errand], [true, { agent: 'server', goal }, 'goal', false]);
  const cfg = config({ access: { 'task.run': { everyone: false, roles: [], users: [SELF] } } });
  const verdict = checkSkill({
    skill: errand.skill,
    args: errand.args,
    principal: { kind: 'persona' },
    requester: { id: OWNER, roleIds: [] },
    audience: { conversationId: HERE },
    context: { config: cfg, selfId: SELF, tasks: { budget: () => ({ spent: false }) } },
  });
  assert.deepEqual(verdict, { ok: true });
  // The same without its agent: refused naming the agents she may pick, never a bare missing argument.
  const agentless = resolve('task.run', {}, goal);
  assert.deepEqual([agentless.ok, agentless.code, agentless.reason], [false, 'agent-required', 'web,server']);
  assert.equal(refusalStatus(agentless.code), 'invalid');
  assert.deepEqual(outcomeDetail({ status: 'invalid', code: agentless.code, reason: agentless.reason }), { kind: 'agent-required', code: 'agent-required', arg: 'agent', values: ['web', 'server'] });
  assert.equal(resolve('task.run', { goal }).code, 'agent-required', 'with the goal on the tag too');
  // The goal given both ways is refused as any argument given twice; on the tag alone, as before.
  assert.equal(resolve('task.run', { agent: 'web', goal: 'one' }, 'two').reason, 'args.goal:twice');
  const tagged = resolve('task.run', { agent: 'web', goal });
  assert.deepEqual([tagged.ok, tagged.args, 'bodyArg' in tagged], [true, { agent: 'web', goal }, false]);
  // message.create keeps its body as its text, as before; now named for the log.
  const said = resolve('message.create', {}, 'καλημέρα');
  assert.deepEqual([said.ok, said.args, said.bodyArg], [true, { text: 'καλημέρα' }, 'text']);
  assert.deepEqual(resolve('rule.add', {}, 'όχι emoji').args, { text: 'όχι emoji' });
  // An empty body fills nothing.
  assert.equal(resolve('task.run', { agent: 'web', goal }, '   ').ok, true);
  assert.equal('bodyArg' in resolve('task.run', { agent: 'web', goal }, '   '), false);
});

test('bodyArguments: `name: value`, `name = value` lines and `<name>value</name>` tags of known options, else null', () => {
  const names = ['day', 'kind', 'n', 'topic'];
  assert.deepEqual(bodyArguments('day: 2026-10-14\n\n  kind = all  \nn: 50', names), { day: '2026-10-14', kind: 'all', n: '50' });
  assert.deepEqual(bodyArguments('<topic>a walk by the sea</topic>\nkind: photos', names), { topic: 'a walk by the sea', kind: 'photos' });
  assert.deepEqual(bodyArguments('<topic>ένας περίπατος</topic><kind>thought</kind>', names), { topic: 'ένας περίπατος', kind: 'thought' });
  assert.deepEqual(bodyArguments('<br/>day: 2026-10-14<br>kind: all', names), { day: '2026-10-14', kind: 'all' }, 'a line break written as <br> splits lines');
  assert.deepEqual(bodyArguments('topic: ώρα: δώδεκα', names), { topic: 'ώρα: δώδεκα' }, 'the value is everything after the first separator');
  for (const body of ['', '   ', 'just reading the journal', 'day: 2026-10-14\nplease', 'who: Zoë', 'day: 1\nday: 2', 'day:', '<who>Zoë</who>', '<topic>x</kind>']) {
    assert.equal(bodyArguments(body, names), null, JSON.stringify(body));
  }
});

test('resolveCall: a body of `name: value` lines for a skill without text is read as its arguments; an attribute wins', () => {
  const read = resolve('memory.journal.read', {}, 'day: 2026-10-14\nkind: all\nn: 50');
  assert.deepEqual([read.ok, read.args, read.bodyArgs, 'bodyIgnored' in read], [true, { day: '2026-10-14', kind: 'all', n: 50 }, 3, false]);
  const both = resolve('memory.journal.read', { kind: 'errors' }, 'kind: all\nn = 5');
  assert.deepEqual([both.args, both.bodyArgs], [{ kind: 'errors', n: 5 }, 1], 'the attribute given explicitly wins');
  const tagged = resolve('diary.post', { kind: 'photos' }, '<topic>θάλασσα</topic>');
  assert.deepEqual([tagged.args, tagged.bodyArgs], [{ kind: 'photos', topic: 'θάλασσα' }, 1]);
  // Anything else in the body: her comment, left out as before.
  for (const body of ['day: 2026-10-14\nreading it now', 'day: 2026-10-14\nwho: Zoë']) {
    const ignored = resolve('memory.journal.read', { kind: 'all' }, body);
    assert.deepEqual([ignored.ok, ignored.args, ignored.bodyIgnored, 'bodyArgs' in ignored], [true, { kind: 'all' }, true, false], body);
  }
  const said = resolve('message.create', {}, 'channel: #νέα');
  assert.deepEqual([said.args, 'bodyArgs' in said], [{ text: 'channel: #νέα' }, false], 'a skill that takes text keeps its body as its text');
});

test('resolveCall: a channel by name, mention or id; a member by name, alias or mention; a role by name or mention', () => {
  for (const channel of ['#🍡νέα', '💖νέα', 'ΝΕΑ']) assert.equal(resolve('memory.channel.read', { channel }).args.channel, NEWS, channel);
  assert.equal(resolve('memory.channel.read', { channel: '<#123>' }).args.channel, '123', 'a mention is its id');
  assert.deepEqual([resolve('memory.channel.read', { channel: '#κουζίνα' }).code], ['target-ambiguous']);
  assert.equal(resolve('memory.channel.read', { channel: '#🍰κουζίνα' }).args.channel, 'k2', 'the exact name wins');
  assert.deepEqual(resolve('memory.channel.read', { channel: '#κανένα' }).reason, 'args.channel:unknown-channel');
  for (const user of ['Zoë', '@zoë', 'Ζωή', `<@${MEMBER}>`, MEMBER]) assert.equal(resolve('memory.profile.read', { user }).args.user, MEMBER, user);
  assert.deepEqual([resolve('memory.profile.read', { user: 'Élodie' }).code, resolve('memory.profile.read', { user: 'Élodie' }).reason], ['unknown-member', 'ambiguous']);
  assert.equal(resolve('memory.profile.read', { user: '<@555>' }).code, 'unknown-member');
  assert.equal(resolve('access.grant', { command: 'lore.list', role: 'φίλοι' }).args.role, 'r1');
  assert.equal(resolve('access.grant', { command: 'lore.list', role: '<@&r2>' }).reason, 'args.role:unknown-role');
  assert.equal(resolve('access.grant', { command: 'lore.list', role: '<@&77>' }).args.role, '77');
});

test('resolveCall: a transcript number names a message she saw and its channel; edit and delete reach only her own', () => {
  const edit = resolve('message.edit', { message: '#4' }, 'διόρθωση');
  assert.deepEqual(edit.args, { message: '1004', text: 'διόρθωση', channel: NEWS });
  assert.equal(resolve('message.delete', { message: '#2' }).args.message, '1002');
  assert.deepEqual([resolve('message.edit', { message: '#1' }, 'όχι').code], ['not-own-message']);
  assert.deepEqual([resolve('message.delete', { message: '#3' }).code], ['not-own-message']);
  assert.deepEqual([resolve('message.delete', { message: '#7' }).code, resolve('message.delete', { message: '#7' }).reason], ['unknown-message', 'message']);
  // the channel she names must be the line's
  assert.deepEqual([resolve('message.delete', { message: '#4', channel: '#γενικά' }).code], ['unknown-message']);
  // a reaction on anyone's line; a reply records whom it answers
  assert.deepEqual(resolve('message.react.add', { message: '#3', emoji: '🎉' }).args, { message: '1003', emoji: '🎉', channel: NEWS });
  const reply = resolve('message.create', { reply: '#3' }, 'απάντηση');
  assert.deepEqual([reply.args, reply.repliedAuthorId], [{ reply: '1003', text: 'απάντηση', channel: NEWS }, MEMBER]);
});

/** An admin over a fake store and the fake port, with the operations a call reaches. */
function makeAdmin({ cfg = config(), diary = null, port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => 1000 }), channels = clientChannels(), extra = {} } = {}) {
  const hot = { config: cfg, prompts: { labels: {} } };
  const store = { state: { data: {}, markDirty() {} }, getUser: () => null, getGuild: () => ({}), isPingsOff: (guildId, userId) => userId === '8' };
  const admin = createAdmin({ discord: DISCORD, hot, store, client: { user: { id: SELF }, channels: { cache: channels } }, getGuildId: () => 'g1', diary, port, ...extra });
  return { admin, hot, store, port };
}

/** The executor's dependencies: the admin's command path, the port, the envelope of `requester`. */
function deps(admin, port, { requester = { id: OWNER, roleIds: [] }, ...over } = {}) {
  return {
    port,
    refOf: (conversationId) => ({ iface: 'fake', conversationId: String(conversationId) }),
    renderText: (text) => text,
    envelope: Object.freeze({ actor: 'persona', requester, mixed: false, invocationId: 'inv-1', originChannelId: HERE }),
    runCommand: admin.runCommand,
    runOwnCommand: admin.runOwnCommand,
    opContext: { guildId: 'g1', channelId: HERE },
    ...over,
  };
}

test('executeCall: a member asks her to post photos to the diary and the diary is not connected -- the operation\'s own text comes back to her', async () => {
  // A real diary over a config with kinds but no channel: its forced post says why it did not post.
  const cfg = config();
  const hot = { config: cfg, prompts: { labels: {} } };
  const diary = createDiary({ discord: DISCORD, hot, store: { state: { data: {} } }, client: {}, turns: { isAnyBusy: () => false }, getGuildId: () => 'g1' });
  const { admin, port } = makeAdmin({ cfg, diary });
  const resolved = resolve('diary.post', { kind: 'photos' });
  assert.equal(resolved.ok, true);

  // The owner asked: the operation runs and answers it has no channel -- not_configured, its line as data.
  const result = await executeCall(resolved, deps(admin, port));
  assert.deepEqual(result, { status: 'not_configured', code: 'not-configured', data: { text: 'the diary has no channel set' } });
  assert.equal(needsFollowUp('diary.post', result), true, 'she hears it in the follow-up');
  const block = skillResultBlock({ skill: 'diary.post', ...result }, labels);
  assert.ok(block.startsWith('<result skill="diary.post" status="not_configured">\n'), block);
  assert.ok(block.includes('the diary has no channel set'), block);
  assert.ok(block.includes(labels.skills.result.failed.split('{reason}')[0]), 'told with the nearest label the labels have');

  // Without a running diary at all: the same, its own text.
  const bare = makeAdmin({ cfg });
  const none = await executeCall(resolved, deps(bare.admin, bare.port));
  assert.deepEqual(none, { status: 'not_configured', code: 'not-configured', data: { text: 'diary not running' } });

  // A member who asked: her diary is hers (a self-owned operation), the same answer.
  const member = await executeCall(resolved, deps(admin, port, { requester: { id: MEMBER, roleIds: [] } }));
  assert.deepEqual(member, result);
});

test('executeCall: her diary post inside her own turn is queued for right after it, once per invocation; its outcome journaled', async () => {
  const forced = [];
  let idle;
  const turns = { waitIdle: () => new Promise((resolve) => { idle = resolve; }) };
  const diary = { force: async (request) => { forced.push(request); return { outcome: 'spoke' }; } };
  const records = [];
  const journal = { system: async (guildId, record) => records.push({ guildId, ...record }) };
  const cfg = { ...config({ diary: { channelId: 'd1' } }), features: { skills: true, diary: true, journal: true } };
  const { admin, port } = makeAdmin({ cfg, diary, extra: { turns, journal } });
  const resolved = resolve('diary.post', { kind: 'photos' });
  const first = await executeCall(resolved, deps(admin, port));
  assert.deepEqual(first, { status: 'ok', data: { text: 'diary post photos: queued, posting after this turn' } });
  assert.equal(needsFollowUp('diary.post', first), true, 'she hears it is queued');
  // the same invocation again: queued once
  await executeCall(resolved, deps(admin, port));
  assert.deepEqual(forced, [], 'nothing runs while her turn holds the attention');
  idle();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forced, [{ kind: 'photos' }]);
  assert.deepEqual(records, [{ guildId: 'g1', event: 'skill-deferred', op: 'diary.post', invocationId: 'inv-1', outcome: 'spoke', reason: null }]);
  // a person's own command is not queued: it waits and posts as before
  const person = await admin.runCommand('diary.post', { kind: 'photos' }, { guildId: 'g1', channelId: HERE, userId: OWNER, roleIds: [] });
  assert.deepEqual([person.status, person.summary], ['ok', 'diary post photos: spoke']);
});

test('runOwnCommand: only her own expressive operations, without the requester\'s right', async () => {
  const { admin } = makeAdmin({ diary: { force: async () => ({ outcome: 'spoke' }), status: () => ({ slots: [], history: 0 }) } });
  const other = await admin.runOwnCommand('lore.list', {}, { guildId: 'g1', userId: MEMBER });
  assert.deepEqual([other.status, other.code], ['denied', 'not-self-owned']);
  const own = await admin.runOwnCommand('diary.show', {}, { guildId: 'g1', userId: MEMBER, actor: 'persona' });
  assert.equal(own.status, 'ok', 'an owner-only diary read, for her, whoever asked');
});

test('executeCall: the result she reads is cut to skills.resultMaxChars; ok is said only when the operation answered ok', async () => {
  const long = { status: 'ok', data: { text: 'λ'.repeat(500) } };
  const block = skillResultBlock({ skill: 'lore.list', ...long }, labels, { maxChars: 40 });
  const data = block.split('\n')[2];
  assert.ok(data.length <= 40 && data.endsWith('…'), data);
  assert.ok(block.includes(labels.skills.result.ok));
  for (const status of RESULT_STATUSES.filter((s) => s !== 'ok')) {
    assert.ok(!skillResultBlock({ skill: 'lore.add', status, code: 'x', data: { text: 't' } }, labels).includes(labels.skills.result.ok), status);
  }
  assert.deepEqual([refusalStatus('invalid-args'), refusalStatus('unknown-message'), refusalStatus('not-allowed'), refusalStatus('owner-only')], ['invalid', 'invalid', 'denied', 'denied']);
});

test('executeCall: message.create posts her own text where she may, the reply notifying its author unless pings are off', async () => {
  const { admin, port } = makeAdmin();
  port.seed(NEWS, { authorId: MEMBER, messageId: '1003', text: 'ερώτηση' });
  const resolved = resolve('message.create', { reply: '#3' }, 'απάντηση');
  const result = await executeCall(resolved, deps(admin, port));
  assert.equal(result.status, 'ok');
  assert.equal(result.ref.conversationId, NEWS);
  assert.equal(needsFollowUp('message.create', result), false, 'a message that went out is its own answer');
  const [posted] = port.messagesIn(NEWS).filter((message) => message.authorId === SELF);
  assert.equal(posted.text, 'απάντηση');
  assert.deepEqual(posted.mentions, { users: [], repliedUser: true });
  // a channel the bot may see but not send in: refused before anything is sent
  const away = await executeCall(resolve('message.create', { channel: '#αλλού' }, 'γεια'), deps(admin, port));
  assert.deepEqual([away.status, away.code], ['denied', 'channel-no-permission']);
  assert.equal(port.messagesIn(ELSEWHERE).length, 0);
  // a port answer of unknown fate: unknown, never ok
  port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } });
  const lost = await executeCall(resolve('message.create', {}, 'ξανά'), deps(admin, port));
  assert.deepEqual([lost.status, lost.code], ['unknown', 'timeout']);
});

test('resolveCall and executeCall: a file handle of one of her errands attaches its file; an unknown handle or a file too large is refused', async () => {
  const known = 'file:tab1/meme.png';
  const fileOf = (handle) => (handle === known ? { name: 'meme.png' } : null);
  const call = resolve('message.create', { file: known, channel: '#νέα' }, 'βρήκα', { fileOf });
  assert.deepEqual([call.ok, call.args], [true, { file: known, channel: NEWS, text: 'βρήκα' }]);
  const unknown = resolve('message.create', { file: 'file:tab1/other.png' }, 'βρήκα', { fileOf });
  assert.deepEqual([unknown.ok, unknown.code, unknown.reason], [false, 'unknown-file', 'file']);
  assert.equal(refusalStatus('unknown-file'), 'invalid', 'a call that was not right');
  assert.equal(resolve('message.create', { file: known }, 'βρήκα').code, 'unknown-file', 'no errands in view, no file');
  // The operation reads the file from the errand's out directory and sends it through the port.
  const dir = tempDir('errand-file-');
  const filePath = path.join(dir, 'meme.png');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
  const asked = [];
  const errands = {
    fileOf: ({ handle, privateChannelId }) => {
      asked.push({ handle, privateChannelId });
      return handle === known ? { path: filePath, name: 'meme.png', contentType: 'image/png', bytes: 4 } : null;
    },
  };
  const { admin, port } = makeAdmin({ extra: { errands } });
  const result = await executeCall(call, deps(admin, port));
  assert.equal(result.status, 'ok');
  assert.deepEqual(asked, [{ handle: known, privateChannelId: NEWS }], 'resolved for the conversation it goes to');
  const [posted] = port.messagesIn(NEWS).filter((message) => message.authorId === SELF);
  assert.equal(posted.text, 'βρήκα');
  assert.equal(posted.attachments.length, 1);
  assert.equal(posted.attachments[0].name, 'meme.png');
  assert.equal(posted.attachments[0].contentType, 'image/png');
  assert.deepEqual([...posted.attachments[0].data], [1, 2, 3, 4]);
  // Larger than the interface takes: failed with its code, nothing sent.
  const small = createFakeAdapter({ iface: 'fake', selfId: SELF, limits: { maxAttachmentBytes: 2 } });
  const tight = makeAdmin({ port: small, extra: { errands } });
  const big = await executeCall(call, deps(tight.admin, small));
  assert.deepEqual([big.status, big.code], ['failed', 'attachment-too-large']);
  assert.equal(small.messagesIn(NEWS).length, 0);
  // A handle the errands do not know by the time it runs: invalid, nothing sent.
  const gone = await executeCall(call, deps(makeAdmin({ port: small, extra: { errands: { fileOf: () => null } } }).admin, small));
  assert.deepEqual([gone.status, gone.code], ['invalid', 'unknown-file']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCall: an errand\'s file goes to the channel the errand was asked in, elsewhere only to a channel its goal or the trigger names', async () => {
  const handle = 'file:tab2/meme.png';
  const task = (goal) => ({ id: 'tab2', goal, origin: { channelId: HERE, messageId: '1001' } });
  const fileOf = (goal) => (given) => (given === handle ? { name: 'meme.png', task: task(goal) } : null);
  const here = { fileOf: fileOf('φέρε μια εικόνα εδώ') };
  // To the origin channel (the result turn's own): passes.
  const origin = resolve('message.create', { file: handle, channel: '#γενικά' }, 'βρήκα', here);
  assert.deepEqual([origin.ok, origin.args], [true, { file: handle, channel: HERE, text: 'βρήκα' }]);
  // To another channel nobody named: refused, a rule said no.
  const elsewhere = resolve('message.create', { file: handle, channel: '#νέα' }, 'βρήκα', here);
  assert.deepEqual([elsewhere.ok, elsewhere.code], [false, 'file-elsewhere']);
  assert.equal(refusalStatus('file-elsewhere'), 'denied');
  assert.equal(outcomeDetail({ status: 'denied', code: 'file-elsewhere', reason: elsewhere.reason }).kind, 'file-elsewhere');
  // A reply to a line of another channel takes the file there too: the same rule.
  assert.equal(resolve('message.create', { file: handle, reply: '#3' }, 'βρήκα', here).code, 'file-elsewhere');
  // The goal names that channel (by name, any case or accents, its emoji left out; by handle; by mention): passes.
  for (const goal of ['στείλε την εικόνα στο ΝΕΑ', 'στείλε την εικόνα στο #c8gtz', 'στείλε την στο <#c-news>, ευχαριστώ']) {
    const named = resolve('message.create', { file: handle, channel: '#νέα' }, 'βρήκα', { fileOf: fileOf(goal), channelHandles: new Map([['c8gtz', NEWS]]) });
    assert.deepEqual([named.ok, named.args.channel], [true, NEWS], goal);
  }
  // A word that only contains the name is no naming of it.
  assert.equal(resolve('message.create', { file: handle, channel: '#νέα' }, 'βρήκα', { fileOf: fileOf('μια εικόνα για τη γενεά μας') }).code, 'file-elsewhere');
  // The trigger message of the turn names it: passes.
  const asked = resolve('message.create', { file: handle, channel: '#νέα' }, 'βρήκα', { ...here, triggerText: 'βάλ\' την και στο νέα' });
  assert.deepEqual([asked.ok, asked.args.channel], [true, NEWS]);
  assert.equal(resolve('message.create', { file: handle, channel: '#νέα' }, 'βρήκα', { ...here, triggerText: 'ωραία' }).code, 'file-elsewhere');
  // Without a channel: resolved without one, and posted to the current conversation as today.
  const plain = resolve('message.create', { file: handle }, 'βρήκα', here);
  assert.deepEqual([plain.ok, plain.args], [true, { file: handle, text: 'βρήκα' }]);
  const dir = tempDir('errand-file-');
  const filePath = path.join(dir, 'meme.png');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3]));
  const errands = { fileOf: ({ handle: given }) => (given === handle ? { path: filePath, name: 'meme.png', contentType: 'image/png', bytes: 3, task: task('') } : null) };
  const { admin, port } = makeAdmin({ extra: { errands } });
  const result = await executeCall(plain, deps(admin, port));
  assert.equal(result.status, 'ok');
  const [posted] = port.messagesIn(HERE).filter((message) => message.authorId === SELF);
  assert.deepEqual([posted.text, posted.attachments.length], ['βρήκα', 1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCall and executeCall: a file handle written in the body instead of as `file` is the attachment, out of the text', async () => {
  const handle = 'file:t4ee514e0/poop-meme.jpg';
  const fileOf = (given) => (given === handle ? { name: 'poop-meme.jpg', task: { id: 't4ee514e0', goal: '', origin: { channelId: HERE } } } : null);
  // The body is exactly the handle: a file-only post, its text empty.
  const only = resolve('message.create', { reply: '#2' }, `  ${handle}\n`, { fileOf });
  assert.deepEqual([only.ok, only.args.file, only.args.text, only.fileFromBody], [true, handle, '', true]);
  const cfg = config({});
  const check = (resolved) => checkSkill({ skill: resolved.skill, args: resolved.args, principal: { kind: 'persona' }, requester: { id: OWNER, roleIds: [] }, audience: { conversationId: HERE }, context: { config: cfg, selfId: SELF } });
  assert.deepEqual(check(only), { ok: true }, 'an empty text beside a file passes the gateway');
  assert.equal(check(resolve('message.create', {}, 'βρήκα')).ok, true);
  // The handle on a line of its own beside her words: the file, her words the text.
  const beside = resolve('message.create', {}, `βρήκα αυτό\n${handle}\nτι λες;`, { fileOf });
  assert.deepEqual([beside.ok, beside.args], [true, { text: 'βρήκα αυτό\nτι λες;', file: handle }]);
  // With file= given, the text is left as written.
  const tagged = resolve('message.create', { file: handle }, `δες\n${handle}`, { fileOf });
  assert.deepEqual([tagged.ok, tagged.args, 'fileFromBody' in tagged], [true, { file: handle, text: `δες\n${handle}` }, false]);
  // Two handles in the body: refused as an unknown file.
  const two = resolve('message.create', {}, `${handle}\nfile:t4ee514e0/other.jpg`, { fileOf });
  assert.deepEqual([two.ok, two.code, two.reason], [false, 'unknown-file', 'file:several']);
  // A handle of another errand: still refused.
  const foreign = resolve('message.create', {}, 'file:tzzz999/poop-meme.jpg', { fileOf });
  assert.deepEqual([foreign.ok, foreign.code], [false, 'unknown-file']);
  // A handle inside a sentence is her text.
  assert.deepEqual(resolve('message.create', {}, `δες το ${handle}`, { fileOf }).args, { text: `δες το ${handle}` });
  // The file-only post goes out: the file, no text.
  const dir = tempDir('errand-file-');
  const filePath = path.join(dir, 'poop-meme.jpg');
  fs.writeFileSync(filePath, Buffer.from([1, 2]));
  const errands = { fileOf: ({ handle: given }) => (given === handle ? { path: filePath, name: 'poop-meme.jpg', contentType: 'image/jpeg', bytes: 2 } : null) };
  const { admin, port } = makeAdmin({ extra: { errands } });
  const result = await executeCall(resolve('message.create', {}, handle, { fileOf }), deps(admin, port));
  assert.equal(result.status, 'ok');
  const [posted] = port.messagesIn(HERE).filter((message) => message.authorId === SELF);
  assert.deepEqual([posted.text, posted.attachments.length], ['', 1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('executeCall: her written text goes out as rendered; only the members the rendering resolved are notified, never one with pings off', async () => {
  const { admin, port } = makeAdmin();
  // The turn's rendering: two names it knows become mentions; @everyone is no name of anyone.
  const renderText = (text) => {
    const userIds = [];
    const out = text.replace(/@(Zoë|Élodie)/g, (whole, name) => {
      const id = name === 'Zoë' ? MEMBER : '8';
      userIds.push(id);
      return `<@${id}>`;
    });
    return { text: out, userIds };
  };
  const created = await executeCall(resolve('message.create', {}, '@Zoë @Élodie @everyone'), deps(admin, port, { renderText }));
  assert.equal(created.status, 'ok');
  const posted = port.messagesIn(HERE).at(-1);
  assert.equal(posted.text, `<@${MEMBER}> <@8> @everyone`);
  assert.deepEqual(posted.mentions, { users: [MEMBER], repliedUser: false }, 'Élodie (8) turned pings off');
  // The edit: the same text and mentions.
  port.seed(NEWS, { authorId: SELF, messageId: '1004', text: 'λάθος' });
  const edited = await executeCall(resolve('message.edit', { message: '#4' }, '@Zoë'), deps(admin, port, { renderText }));
  assert.equal(edited.status, 'ok');
  assert.deepEqual(port.calls.filter((call) => call.op === 'edit').at(-1).args[1], { text: `<@${MEMBER}>`, mentions: { users: [MEMBER], repliedUser: false } });
  // A rendering that is a plain string: the text as rendered, nobody notified.
  await executeCall(resolve('message.create', {}, '@Zoë'), deps(admin, port, { renderText: (text) => text.toUpperCase() }));
  assert.deepEqual([port.messagesIn(HERE).at(-1).text, port.messagesIn(HERE).at(-1).mentions], ['@ZOË', { users: [], repliedUser: false }]);
});

test('executeCall: a person who runs /nep message create gives her a turn; her own call posts -- the mode is the server\'s, by who acts', async () => {
  const forced = [];
  const spontaneous = { force: async (channel, mode, options) => { forced.push([channel.id, mode, options]); return { outcome: 'spoke' }; } };
  const client = { user: { id: SELF }, channels: { fetch: async (id) => ({ id }) } };
  const { admin, port } = makeAdmin({ extra: { spontaneous, client } });
  // a person: a turn, even with a text in the arguments
  const person = await admin.runCommand('message.create', { text: 'πες αυτό' }, { guildId: 'g1', channelId: HERE, userId: OWNER, roleIds: [] });
  assert.equal(person.status, 'ok');
  assert.deepEqual(forced, [[HERE, null, { requester: { id: OWNER, roleIds: [] } }]]);
  assert.equal(port.calls.length, 0, 'nothing posted as given text');
  // her own call: her text, no turn
  const own = await executeCall(resolve('message.create', {}, 'το λέω εγώ'), deps(admin, port));
  assert.equal(own.status, 'ok');
  assert.equal(forced.length, 1);
  assert.equal(port.messagesIn(HERE).at(-1).text, 'το λέω εγώ');
});

test('executeCall: edit and delete change her own message; the port refuses anyone else\'s', async () => {
  const { admin, port } = makeAdmin();
  port.seed(NEWS, { authorId: SELF, messageId: '1004', text: 'λάθος' });
  port.seed(NEWS, { authorId: MEMBER, messageId: '1003', text: 'δικό της' });
  const edited = await executeCall({ ...resolve('message.edit', { message: '#4' }, 'σωστό') }, deps(admin, port));
  assert.equal(edited.status, 'ok');
  assert.equal(port.messagesIn(NEWS).find((message) => message.ref.messageId === '1004').text, 'σωστό');
  // someone else's message, should a raw id get past the transcript: the port says no
  const skill = skillRegistry().get('message.edit');
  const foreign = await executeCall({ ok: true, skill: 'message.edit', args: { message: '1003', text: 'όχι', channel: NEWS }, command: skill.command, repliedAuthorId: null }, deps(admin, port));
  assert.deepEqual([foreign.status, foreign.code], ['failed', 'not-own-message']);
  const deleted = await executeCall(resolve('message.delete', { message: '#4' }), deps(admin, port));
  assert.equal(deleted.status, 'ok');
  assert.equal(port.messagesIn(NEWS).some((message) => message.ref.messageId === '1004'), false);
});

test('executeCall: `last` edits or deletes her own most recent message in the channel, looked up in its recent history', async () => {
  // HERE's recent history, newest first as Discord gives it: a member's line, then two of hers.
  const asked = [];
  const history = [
    { id: '3003', author: { id: MEMBER }, createdTimestamp: 3 },
    { id: '3002', author: { id: SELF }, createdTimestamp: 2 },
    { id: '3001', author: { id: SELF }, createdTimestamp: 1 },
  ];
  const here = { ...textChannel(HERE), messages: { fetch: async (options) => { asked.push(options); return new Map(history.map((m) => [m.id, m])); } } };
  const quiet = { ...textChannel(NEWS), messages: { fetch: async () => new Map([['4001', { id: '4001', author: { id: MEMBER }, createdTimestamp: 5 }]]) } };
  const { admin, port } = makeAdmin({ channels: new Map([...clientChannels(), [HERE, here], [NEWS, quiet]]) });
  for (const [id, authorId] of [['3001', SELF], ['3002', SELF], ['3003', MEMBER]]) port.seed(HERE, { authorId, messageId: id, text: 'λάθος' });
  const edit = resolve('message.edit', { message: 'last' }, 'σωστό');
  assert.deepEqual(edit.args, { message: 'last', text: 'σωστό' }, 'passed on as written');
  const edited = await executeCall(edit, deps(admin, port));
  assert.equal(edited.status, 'ok', JSON.stringify(edited));
  assert.deepEqual(port.messagesIn(HERE).map((m) => [m.ref.messageId, m.text]), [['3001', 'λάθος'], ['3002', 'σωστό'], ['3003', 'λάθος']]);
  assert.deepEqual(asked, [{ limit: 100 }], 'up to 100 messages back');
  const deleted = await executeCall(resolve('message.delete', { message: ' Last ' }), deps(admin, port));
  assert.equal(deleted.status, 'ok', JSON.stringify(deleted));
  assert.deepEqual(port.messagesIn(HERE).map((m) => m.ref.messageId), ['3001', '3003']);
  // None of hers among them: a clear failure, nothing touched.
  const none = await executeCall(resolve('message.delete', { message: 'last', channel: '#νέα' }), deps(admin, port));
  assert.deepEqual([none.status, none.code], ['invalid', 'no-own-message']);
});

test('resolveCall: a message link names the message and its channel; a raw id passes as written', () => {
  const link = 'https://discord.com/channels/111/555/1009';
  const conversations = [...view().conversations, { id: '555', name: 'ιστορίες' }];
  assert.deepEqual(resolve('message.delete', { message: link }).args, { message: '1009', channel: '555' });
  assert.deepEqual(resolve('message.delete', { message: `<${link}>` }).args, { message: '1009', channel: '555' }, 'in angle brackets too');
  assert.deepEqual(resolve('message.edit', { message: link, channel: '#ιστορίες' }, 'σωστό', { conversations }).args, { message: '1009', channel: '555', text: 'σωστό' });
  assert.deepEqual(resolve('message.react.add', { message: 'https://ptb.discord.com/channels/111/555/1009', emoji: '🎉' }).args, { message: '1009', emoji: '🎉', channel: '555' });
  const reply = resolve('message.create', { reply: link }, 'απάντηση');
  assert.deepEqual([reply.ok, reply.args], [true, { reply: '1009', text: 'απάντηση', channel: '555' }]);
  // the channel she names must be the link's
  assert.deepEqual([resolve('message.delete', { message: link, channel: '#γενικά' }).code, resolve('message.delete', { message: link, channel: '#γενικά' }).reason], ['unknown-message', 'conversation']);
  // a raw id: as written, its channel the one she names
  assert.deepEqual(resolve('message.delete', { message: '123456789012345678', channel: '#νέα' }).args, { message: '123456789012345678', channel: NEWS });
});

test('executeCall: a message she posted elsewhere is deleted by its link', async () => {
  const { admin, port } = makeAdmin();
  port.seed('555', { authorId: SELF, messageId: '1009', text: 'λάθος κανάλι' });
  const deleted = await executeCall(resolve('message.delete', { message: 'https://discord.com/channels/111/555/1009' }), deps(admin, port));
  assert.equal(deleted.status, 'ok', JSON.stringify(deleted));
  assert.equal(port.messagesIn('555').some((message) => message.ref.messageId === '1009'), false);
});

test('executeCall: draw.create without a channel posts its picture here, once; with one, the operation posts it there', async () => {
  const generated = [];
  const images = {
    familyOf: () => 'openai',
    generate: async ({ prompt }) => { generated.push(prompt); return { buffer: Buffer.from('pic'), mediaType: 'image/png', model: 'm', seconds: 1, cost: 0.02 }; },
    quota: () => ({ spent: false, userSpent: false }),
  };
  const cfg = { ...config(), models: { agents: { drawing: 'openai/gpt-image' } } };
  const { admin, port } = makeAdmin({ cfg, extra: { images } });
  const here = await executeCall(resolve('draw.create', {}, 'a lighthouse at dusk'), deps(admin, port));
  assert.equal(here.status, 'ok', JSON.stringify(here));
  assert.equal(generated.length, 1);
  assert.equal(port.calls.filter((call) => call.op === 'send')[0].args[0].conversationId, HERE);
  const there = await executeCall(resolve('draw.create', { channel: '#νέα' }, 'a lighthouse'), deps(admin, port));
  assert.equal(there.status, 'ok', JSON.stringify(there));
  assert.equal(port.calls.filter((call) => call.op === 'send')[1].args[0].conversationId, NEWS);
  assert.equal(generated.length, 2, 'one generation per call');
});

/** A call aimed at a raw channel id, as the server resolved it: `args` keyed by the command's options. */
function direct(skill, args) {
  return { ok: true, skill, args, command: skillRegistry().get(skill).command, repliedAuthorId: null };
}

test('executeCall: she may post in any text channel of the served guild where the bot may send -- no list; Discord permissions are the only limit', async () => {
  const { admin, port } = makeAdmin();
  const there = await executeCall(resolve('message.create', { channel: '#νέα' }, 'καλημέρα'), deps(admin, port));
  assert.equal(there.status, 'ok', JSON.stringify(there));
  assert.equal(port.messagesIn(NEWS).at(-1).text, 'καλημέρα');
  // the current conversation needs no lookup at all, as before
  const here = await executeCall(resolve('message.create', {}, 'εδώ'), deps(admin, port));
  assert.equal(here.status, 'ok', JSON.stringify(here));
  assert.equal(port.messagesIn(HERE).at(-1).text, 'εδώ');
  // no permission to send, a DM, another guild's channel, a channel the bot cannot find: refused, nothing sent
  for (const channel of [ELSEWHERE, DM, OTHER_GUILD, 'c-unknown']) {
    const refused = await executeCall(direct('message.create', { channel, text: 'γεια' }), deps(admin, port));
    assert.deepEqual([refused.status, refused.code], ['denied', 'channel-no-permission'], channel);
    assert.equal(port.messagesIn(channel).length, 0, channel);
  }
});

test('executeCall: a leftover skills.conversations is ignored -- it neither opens nor closes a channel', async () => {
  const { admin, port } = makeAdmin({ cfg: config({ skills: { conversations: [ELSEWHERE] } }) });
  const listed = await executeCall(resolve('message.create', { channel: '#αλλού' }, 'γεια'), deps(admin, port));
  assert.deepEqual([listed.status, listed.code], ['denied', 'channel-no-permission']);
  const unlisted = await executeCall(resolve('message.create', { channel: '#νέα' }, 'γεια'), deps(admin, port));
  assert.equal(unlisted.status, 'ok', JSON.stringify(unlisted));
});

test('executeCall: each operation needs its own permissions there -- edit, delete and unreact read the history, a reaction adds one, a reply reads and sends', async () => {
  const { admin, port } = makeAdmin();
  port.seed(READ_ONLY, { authorId: SELF, messageId: '2001', text: 'λάθος' });
  port.seed(ELSEWHERE, { authorId: SELF, messageId: '2002', text: 'παλιό' });
  port.seed(ELSEWHERE, { authorId: MEMBER, messageId: '2003', text: 'ερώτηση' });
  // READ_ONLY: no Add Reactions -- an edit and taking a reaction back pass, a new reaction does not
  const edited = await executeCall(direct('message.edit', { message: '2001', channel: READ_ONLY, text: 'σωστό' }), deps(admin, port));
  assert.equal(edited.status, 'ok', JSON.stringify(edited));
  const reacted = await executeCall(direct('message.react.add', { message: '2001', channel: READ_ONLY, emoji: '🎉' }), deps(admin, port));
  assert.deepEqual([reacted.status, reacted.code], ['denied', 'channel-no-permission']);
  const unreacted = await executeCall(direct('message.react.remove', { message: '2001', channel: READ_ONLY, emoji: '🎉' }), deps(admin, port));
  assert.equal(unreacted.status, 'ok', JSON.stringify(unreacted));
  // ELSEWHERE: no Send Messages -- her old message may go and a reaction may land, a reply may not
  const deleted = await executeCall(direct('message.delete', { message: '2002', channel: ELSEWHERE }), deps(admin, port));
  assert.equal(deleted.status, 'ok', JSON.stringify(deleted));
  const liked = await executeCall(direct('message.react.add', { message: '2003', channel: ELSEWHERE, emoji: '🎉' }), deps(admin, port));
  assert.equal(liked.status, 'ok', JSON.stringify(liked));
  const replied = await executeCall(direct('message.create', { reply: '2003', channel: ELSEWHERE, text: 'απάντηση' }), deps(admin, port));
  assert.deepEqual([replied.status, replied.code], ['denied', 'channel-no-permission']);
  // a DM is never a target, whatever it would allow
  const dm = await executeCall(direct('message.delete', { message: '2002', channel: DM }), deps(admin, port));
  assert.deepEqual([dm.status, dm.code], ['denied', 'channel-no-permission']);
});

test('executeCall: draw.create to a channel without Attach Files is refused before anything is generated', async () => {
  const generated = [];
  const images = {
    familyOf: () => 'openai',
    generate: async ({ prompt }) => { generated.push(prompt); return { buffer: Buffer.from('pic'), mediaType: 'image/png', model: 'm', seconds: 1, cost: 0.02 }; },
    quota: () => ({ spent: false, userSpent: false }),
  };
  const { admin, port } = makeAdmin({ cfg: { ...config(), models: { agents: { drawing: 'openai/gpt-image' } } }, extra: { images } });
  const refused = await executeCall(direct('draw.create', { channel: NO_FILES, text: 'a lighthouse' }), deps(admin, port));
  assert.deepEqual([refused.status, refused.code], ['denied', 'channel-no-permission']);
  assert.deepEqual([generated.length, port.calls.length], [0, 0]);
});

test('executeCall: an operation that does not answer in time is unknown, never retried', async () => {
  const runCommand = () => new Promise(() => {});
  // The executor's timer never holds a process open; this one keeps the test's loop alive meanwhile.
  const keepAlive = setTimeout(() => {}, 1000);
  const result = await executeCall(resolve('lore.list'), { envelope: { requester: { id: OWNER } }, runCommand, opContext: {}, timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert.deepEqual(result, { status: 'unknown', code: 'timeout', data: { text: '' } });
  // the envelope, never the model, says who asked; the actor and the invocation id ride along
  const seen = [];
  await executeCall(resolve('lore.list'), { envelope: { requester: { id: MEMBER, roleIds: ['r1'] }, invocationId: 'inv-9' }, runCommand: async (...args) => { seen.push(args); return { status: 'ok', summary: 'none' }; }, opContext: { guildId: 'g1', channelId: HERE } });
  assert.deepEqual(seen, [['lore.list', { query: undefined }, { guildId: 'g1', channelId: HERE, userId: MEMBER, roleIds: ['r1'], actor: 'persona', invocationId: 'inv-9' }]]);
});

test('needsFollowUp: an operation\'s answer or any failure brings the follow-up; a message or picture that went out does not; never under the full stop', () => {
  assert.deepEqual([...QUIET_ON_OK].sort(), ['draw.create', 'message.create', 'message.delete', 'message.edit', 'message.react.add', 'message.react.remove', 'task.run']);
  assert.equal(needsFollowUp('lore.list', { status: 'ok', data: { text: 'none' } }), true);
  assert.equal(needsFollowUp('lore.add', { status: 'ok', data: { text: 'Added' } }), true);
  assert.equal(needsFollowUp('message.create', { status: 'ok', data: { text: 'sent' } }), false);
  assert.equal(needsFollowUp('draw.create', { status: 'ok', data: { text: 'm' } }), false);
  assert.equal(needsFollowUp('message.edit', { status: 'denied', code: 'not-allowed' }), true);
  assert.equal(needsFollowUp('message.create', { status: 'unknown', code: 'timeout' }), true);
  assert.equal(needsFollowUp('message.create', { status: 'denied', code: 'skills-off' }), false);
});

test('outcomeDetail: a non-ok outcome names its argument, its message or its code; an ok one has none', () => {
  const detail = (code, reason, status = 'invalid') => outcomeDetail({ status, code, reason });
  // The gateway's schema paths: the argument and what was wrong with it.
  assert.deepEqual(detail('invalid-args', 'args.message:required'), { kind: 'missing-arg', code: 'invalid-args', arg: 'message' });
  assert.deepEqual(detail('invalid-args', 'args.text:max-length'), { kind: 'too-long', code: 'invalid-args', arg: 'text' });
  assert.deepEqual(detail('invalid-args', 'args.text:min-length'), { kind: 'too-short', code: 'invalid-args', arg: 'text' });
  assert.deepEqual(detail('invalid-args', 'args.n:maximum'), { kind: 'wrong-arg', code: 'invalid-args', arg: 'n' });
  assert.deepEqual(detail('invalid-args', 'args.tags.0:type'), { kind: 'wrong-arg', code: 'invalid-args', arg: 'tags' });
  assert.deepEqual(detail('invalid-args', 'command'), { kind: 'invalid-args', code: 'invalid-args', arg: null });
  // resolveCall's own reasons, as it gives them.
  const of = (refusal) => outcomeDetail({ status: refusalStatus(refusal.code), code: refusal.code, reason: refusal.reason });
  assert.deepEqual(of(resolve('message.create', { channel: '#νέα', who: 'x' }, 'γεια')), { kind: 'unknown-arg', code: 'invalid-args', arg: 'who' });
  // An argument the skill does not take, with the ones it does: the mark can name them.
  const diaryCall = resolve('diary.post', { channel: '#νέα' }, 'δεν μπορώ να κοιμηθώ');
  assert.deepEqual(outcomeDetail({ status: 'invalid', code: diaryCall.code, reason: diaryCall.reason }, { argNames: ['kind', 'topic'] }), { kind: 'unknown-arg', code: 'invalid-args', arg: 'channel', values: ['kind', 'topic'] });
  assert.deepEqual(outcomeDetail({ status: 'invalid', code: 'invalid-args', reason: 'args.text:max-length' }, { argNames: ['text'] }), { kind: 'too-long', code: 'invalid-args', arg: 'text' }, 'only an unknown argument lists them');
  assert.deepEqual(of(resolve('message.create', { text: 'δύο' }, 'φορές')), { kind: 'arg-twice', code: 'invalid-args', arg: 'text' });
  assert.deepEqual(of(resolve('message.create', { channel: '#πουθενά' }, 'x')), { kind: 'unknown-channel', code: 'invalid-args', arg: 'channel' });
  assert.deepEqual(of(resolve('message.delete', { message: '#7' })), { kind: 'unknown-message', code: 'unknown-message', arg: 'message' });
  assert.deepEqual(of(resolve('message.delete', { message: '#4', channel: '#γενικά' })), { kind: 'message-elsewhere', code: 'unknown-message', arg: null });
  assert.deepEqual(of(resolve('message.delete', { message: '#1' })), { kind: 'not-own-message', code: 'not-own-message', arg: 'message' });
  assert.deepEqual(detail('unknown-member', 'ambiguous'), { kind: 'member-ambiguous', code: 'unknown-member', arg: null });
  // Any other code is its own kind; nothing without a code, nothing for an ok outcome.
  assert.deepEqual(detail('channel-no-permission', '', 'denied'), { kind: 'channel-no-permission', code: 'channel-no-permission', arg: null });
  assert.deepEqual(detail('timeout', undefined, 'unknown'), { kind: 'timeout', code: 'timeout', arg: null });
  assert.equal(outcomeDetail({ status: 'ok', code: 'ok' }), null);
  assert.equal(outcomeDetail({ status: 'failed' }), null);
  assert.equal(outcomeDetail(null), null);
  // The operation's own message rides along on one line, cut, only when asked for.
  const diary = { status: 'not_configured', code: 'not-configured', data: { text: 'diary post photos:\n  not-now (no-channel)' } };
  assert.deepEqual(outcomeDetail(diary, { textChars: 200 }), { kind: 'not-configured', code: 'not-configured', arg: null, text: 'diary post photos: not-now (no-channel)' });
  assert.equal('text' in outcomeDetail(diary), false);
  assert.equal('text' in outcomeDetail({ ...diary, data: { text: '  ' } }, { textChars: 200 }), false);
  const long = outcomeDetail({ status: 'failed', code: 'error', data: { text: 'λέξη '.repeat(40) } }, { textChars: 30 }).text;
  assert.ok(Array.from(long).length <= 30 && long.endsWith('…') && !long.includes('\n'), long);
});

test('executeCall: an in-turn tool runs in place of the command, on the operation\'s arguments her call maps to; its result as it is', async () => {
  const { admin, port } = makeAdmin();
  const seen = [];
  const inTurn = { 'memory.search': async (args) => (seen.push(args), { status: 'ok', data: { text: 'βρέθηκαν' } }) };
  const resolved = resolve('memory.search', { channel: '#νέα', terms: 'λαγός' }, 'τι είπε η Ana');
  assert.equal(resolved.ok, true);
  const result = await executeCall(resolved, deps(admin, port, { inTurn, runCommand: () => assert.fail('the command never runs') }));
  assert.deepEqual(result, { status: 'ok', data: { text: 'βρέθηκαν' } });
  assert.deepEqual(seen, [{ question: 'τι είπε η Ana', people: undefined, channelId: NEWS, when: undefined, terms: 'λαγός' }]);
  // A result without a known status is a failure; one not back in time is unknown, never retried.
  const odd = await executeCall(resolved, deps(admin, port, { inTurn: { 'memory.search': async () => ({ status: 'great' }) } }));
  assert.deepEqual(odd, { status: 'failed', code: 'error' });
  const slow = await executeCall(resolved, deps(admin, port, { timeoutMs: 5, inTurn: { 'memory.search': () => new Promise((done) => setTimeout(() => done({ status: 'ok', data: { text: '' } }), 50)) } }));
  assert.deepEqual([slow.status, slow.code], ['unknown', 'timeout']);
  // A skill the turn holds no tool for goes through its command as before.
  const keys = [];
  const other = await executeCall(resolve('lore.list'), deps(admin, port, { inTurn, runCommand: async (key) => (keys.push(key), { status: 'ok', code: 'ok', summary: 'κενό', data: { text: 'κενό' } }) }));
  assert.deepEqual([other.status, keys], ['ok', ['lore.list']]);
  assert.deepEqual(seen.length, 1);
});
