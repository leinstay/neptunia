// Tests for src/skills/executors.js and the operations her calls run: one `<call>` of the
// persona's output resolved on the server's side (channels, members, roles, transcript numbers)
// into the arguments of the /nep command behind the skill, then run through that command's own
// path (src/admin.js#runCommand: the requester's rights checked again), the persona as the actor.
// Whatever the operation answers -- an error or a refusal included -- is her result, with a
// structured status; the `/nep message` operations go through a fake interface adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/ops/index.js';
import { createAdmin } from '../src/admin.js';
import { createDiary } from '../src/behavior/diary.js';
import { skillResultBlock } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { QUIET_ON_OK, RESULT_STATUSES, executeCall, needsFollowUp, refusalStatus, resolveCall } from '../src/skills/executors.js';
import { skillRegistry } from '../src/skills/registry.js';
import { labels } from './fixtures/labels.js';

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const NEWS = 'c-news';
const ELSEWHERE = 'c-else';

/** A config with the settings these tests read, each set here. */
function config({ features = {}, skills = {}, access = {}, diary = {} } = {}) {
  return {
    features: { skills: true, diary: true, ...features },
    skills: { conversations: [NEWS], safeMode: false, ...skills },
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
  assert.deepEqual(resolve('message.delete', { message: '#2' }, 'κείμενο').reason, 'args:body');
  // whole numbers and yes/no are read strictly; anything else stays text for the schema to refuse
  assert.deepEqual(resolve('rule.remove', { number: '3' }).args, { number: 3 });
  assert.deepEqual(resolve('rule.remove', { number: 'τρία' }).args, { number: 'τρία' });
  assert.deepEqual(resolve('draw.create', { self: 'TRUE' }, 'a lighthouse').args, { self: true, text: 'a lighthouse' });
  assert.deepEqual(resolve('draw.create', { self: 'ναι' }, 'a lighthouse').args.self, 'ναι');
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
function makeAdmin({ cfg = config(), diary = null, port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => 1000 }), extra = {} } = {}) {
  const hot = { config: cfg, prompts: { labels: {} } };
  const store = { state: { data: {}, markDirty() {} }, getUser: () => null, getGuild: () => ({}), isPingsOff: (guildId, userId) => userId === '8' };
  const admin = createAdmin({ hot, store, client: { user: { id: SELF } }, getGuildId: () => 'g1', diary, port, ...extra });
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
  const diary = createDiary({ hot, store: { state: { data: {} } }, client: {}, turns: { isAnyBusy: () => false }, getGuildId: () => 'g1' });
  const { admin, port } = makeAdmin({ cfg, diary });
  const resolved = resolve('diary.post', { kind: 'photos' });
  assert.equal(resolved.ok, true);

  // The owner asked: the operation runs and answers it has no channel -- not_configured, its line as data.
  const result = await executeCall(resolved, deps(admin, port));
  assert.deepEqual(result, { status: 'not_configured', code: 'not-configured', data: { text: 'diary post photos: not-now (no-channel)' } });
  assert.equal(needsFollowUp('diary.post', result), true, 'she hears it in the follow-up');
  const block = skillResultBlock({ skill: 'diary.post', ...result }, labels);
  assert.ok(block.startsWith('<result skill="diary.post" status="not_configured">\n'), block);
  assert.ok(block.includes('diary post photos: not-now (no-channel)'), block);
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
  // a channel neither here nor listed: the operation's own rule
  const away = await executeCall(resolve('message.create', { channel: '#αλλού' }, 'γεια'), deps(admin, port));
  assert.deepEqual([away.status, away.code], ['invalid', 'conversation-not-allowed']);
  // a port answer of unknown fate: unknown, never ok
  port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } });
  const lost = await executeCall(resolve('message.create', {}, 'ξανά'), deps(admin, port));
  assert.deepEqual([lost.status, lost.code], ['unknown', 'timeout']);
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

test('executeCall: draw.create without a channel posts its picture here, once; with one, the operation posts it there', async () => {
  const generated = [];
  const images = {
    familyOf: () => 'openai',
    generate: async ({ prompt }) => { generated.push(prompt); return { buffer: Buffer.from('pic'), mediaType: 'image/png', model: 'm', seconds: 1, cost: 0.02 }; },
    quota: () => ({ spent: false, userSpent: false }),
  };
  const cfg = { ...config(), roles: { drawing: 'openai/gpt-image' } };
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
  assert.deepEqual([...QUIET_ON_OK].sort(), ['draw.create', 'message.create', 'message.delete', 'message.edit', 'message.react.add', 'message.react.remove']);
  assert.equal(needsFollowUp('lore.list', { status: 'ok', data: { text: 'none' } }), true);
  assert.equal(needsFollowUp('lore.add', { status: 'ok', data: { text: 'Added' } }), true);
  assert.equal(needsFollowUp('message.create', { status: 'ok', data: { text: 'sent' } }), false);
  assert.equal(needsFollowUp('draw.create', { status: 'ok', data: { text: 'm' } }), false);
  assert.equal(needsFollowUp('message.edit', { status: 'denied', code: 'not-allowed' }), true);
  assert.equal(needsFollowUp('message.create', { status: 'unknown', code: 'timeout' }), true);
  assert.equal(needsFollowUp('message.create', { status: 'denied', code: 'skills-off' }), false);
});
