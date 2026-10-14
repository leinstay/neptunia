// Tests for src/skills/executors.js: how one `<call>` of the persona's output is resolved on the
// server's side (conversations, transcript numbers, members) and run once the gateway let it
// pass -- messages through a fake interface adapter, reads through the operations, a picture
// generated once and published once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/ops/index.js';
import { getOp } from '../src/ops/registry.js';
import { createAdmin } from '../src/admin.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { ImageCapError } from '../src/llm/images.js';
import { CALL_FORMS, READ_SKILLS, executeCall, needsFollowUp, resolveCall } from '../src/skills/executors.js';
import { SKILL_DEFINITIONS, loadSkills } from '../src/skills/registry.js';
import { checkSkill } from '../src/skills/gateway.js';

const OWNER = '42';
const MEMBER = '7';
const SELF = 'self-1';
const HERE = 'c-here';
const NEWS = 'c-news';
const ELSEWHERE = 'c-else';

/** A config with the settings these tests read, each set here. */
function config({ features = {}, skills = {}, access = {} } = {}) {
  return {
    features: { skills: true, ...features },
    skills: { conversations: [NEWS], safeMode: false, ...skills },
    bot: { owners: [OWNER], access },
  };
}

/** The turn's view: three channels, a transcript of four lines, two stored members. */
function view(overrides = {}) {
  const lines = new Map([
    [1, { id: 'm1', conversationId: HERE, authorId: MEMBER }],
    [2, { id: 'm2', conversationId: HERE, authorId: SELF, self: true }],
    [3, { id: 'm3', conversationId: NEWS, authorId: MEMBER }],
    [4, { id: 'm4', conversationId: NEWS, authorId: SELF, self: true }],
  ]);
  return {
    currentConversationId: HERE,
    allowedConversationIds: [NEWS],
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
    selfId: SELF,
    ...overrides,
  };
}

/** Every skill of phases 0-1, against stand-in operations. */
function registry() {
  return loadSkills(SKILL_DEFINITIONS, { getOp: (name) => ({ name, rights: { kind: 'read' } }) });
}

/** The gateway over a resolved call, as the turn checks it. */
function gate(resolved, { cfg = config(), allowed = [], requester = { id: MEMBER } } = {}) {
  return checkSkill({
    skill: resolved.skill,
    args: resolved.args,
    principal: { kind: 'persona' },
    requester,
    audience: { conversationId: HERE },
    context: {
      config: cfg,
      state: { skills: { allowed: Object.fromEntries(allowed.map((name) => [name, { by: OWNER, at: 't' }])) } },
      selfId: SELF,
      targetMessage: resolved.targetMessage ?? undefined,
      registry: registry(),
      images: { quota: () => ({ spent: false, userSpent: false }) },
    },
  });
}

test('executors: every callable skill is a registry skill; the reads are the read skills', () => {
  const skills = registry();
  for (const name of Object.keys(CALL_FORMS)) assert.ok(skills.has(name), name);
  for (const name of READ_SKILLS) assert.equal(skills.get(name).effects, 'read', name);
});

test('resolveCall: message.send names a listed conversation by #name, its body is the text, a reply target must be in it', () => {
  const sent = resolveCall({ skill: 'message.send', args: { conversation: '#Νέα', replyTo: '#3' }, body: 'καλημέρα' }, view());
  assert.deepEqual(sent, { ok: true, skill: 'message.send', args: { conversationId: NEWS, text: 'καλημέρα', replyTo: 'm3' }, targetMessage: null, repliedAuthorId: MEMBER });
  // No conversation: the current one; an id or a channel mention resolve as well.
  assert.equal(resolveCall({ skill: 'message.send', args: {}, body: 'ναι' }, view()).args.conversationId, HERE);
  assert.equal(resolveCall({ skill: 'message.send', args: { conversation: '<#123>' }, body: 'ναι' }, view({ allowedConversationIds: ['123'] })).args.conversationId, '123');
  // A channel name is matched by its core: another or no leading emoji still names it.
  for (const conversation of ['#🍡νέα', '💖νέα', 'ΝΕΑ']) {
    assert.equal(resolveCall({ skill: 'message.send', args: { conversation }, body: 'ναι' }, view()).args.conversationId, NEWS, conversation);
  }
  // Two channels share the core: no guess, even when both are listed.
  const shared = resolveCall({ skill: 'message.send', args: { conversation: '#κουζίνα' }, body: 'ναι' }, view({ allowedConversationIds: [NEWS, 'k1', 'k2'] }));
  assert.deepEqual([shared.ok, shared.code], [false, 'target-ambiguous']);
  assert.equal(resolveCall({ skill: 'draw', args: { conversation: '#🍰κουζίνα' }, body: 'a cake' }, view({ allowedConversationIds: ['k2'] })).args.conversationId, 'k2', 'the exact name wins');

  const refusals = [
    [{ conversation: '#αλλού' }, 'target-not-allowed'],
    [{ conversation: '#κανένα' }, 'target-not-allowed'],
    [{ conversation: '#νέα', replyTo: '#1' }, 'unknown-message'],
    [{ conversation: '#νέα', replyTo: '#99' }, 'unknown-message'],
    [{ conversation: '#νέα', who: 'x' }, 'invalid-args'],
    [{ conversation: '#νέα', text: 'δύο φορές' }, 'invalid-args'],
  ];
  for (const [args, code] of refusals) {
    const result = resolveCall({ skill: 'message.send', args, body: 'γεια' }, view());
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, code, JSON.stringify(args));
  }
  assert.equal(resolveCall({ skill: 'message.delete', args: { message: '#2' }, body: 'κείμενο' }, view()).code, 'invalid-args');
  assert.equal(resolveCall({ skill: 'files.wipe', args: {}, body: '' }, view()).code, 'unknown-skill');
});

test('resolveCall: edit and delete reach only her own messages, in a conversation she may act in', () => {
  const edit = resolveCall({ skill: 'message.edit', args: { message: '#4' }, body: 'διόρθωση' }, view());
  assert.deepEqual(edit.args, { conversationId: NEWS, messageId: 'm4', text: 'διόρθωση' });
  assert.deepEqual(edit.targetMessage, { id: 'm4', authorId: SELF, conversationId: NEWS });
  assert.equal(resolveCall({ skill: 'message.delete', args: { message: '#2' }, body: '' }, view()).args.messageId, 'm2');
  assert.equal(resolveCall({ skill: 'message.edit', args: { message: '#1' }, body: 'όχι' }, view()).code, 'not-own-message');
  assert.equal(resolveCall({ skill: 'message.delete', args: { message: '#3' }, body: '' }, view()).code, 'not-own-message');
  assert.equal(resolveCall({ skill: 'message.delete', args: { message: '#7' }, body: '' }, view()).code, 'unknown-message');
  // Her message in a conversation no longer listed.
  assert.equal(resolveCall({ skill: 'message.delete', args: { message: '#4' }, body: '' }, view({ allowedConversationIds: [] })).code, 'target-not-allowed');
});

test('resolveCall: memory.read finds a stored member by name, alias or mention; two by one name is no answer', () => {
  for (const member of ['Zoë', '@zoë', 'Ζωή', `<@${MEMBER}>`, MEMBER]) {
    assert.deepEqual(resolveCall({ skill: 'memory.read', args: { member }, body: '' }, view()).args, { memberId: MEMBER }, member);
  }
  assert.deepEqual([resolveCall({ skill: 'memory.read', args: { member: 'Élodie' }, body: '' }, view())].map((r) => [r.code, r.reason]), [['unknown-member', 'ambiguous']]);
  assert.equal(resolveCall({ skill: 'memory.read', args: { member: 'Ταξιάρχης' }, body: '' }, view()).code, 'unknown-member');
  assert.equal(resolveCall({ skill: 'memory.read', args: { member: '<@555>' }, body: '' }, view()).code, 'unknown-member');
});

test('gateway over a resolved call: nothing runs unless the owner allowed it; a listed conversation still needs the allow', () => {
  const elsewhere = resolveCall({ skill: 'message.send', args: { conversation: '#νέα' }, body: 'γεια' }, view());
  assert.equal(gate(elsewhere).code, 'not-allowed');
  assert.equal(gate(elsewhere, { allowed: ['message.send'] }).ok, true);
  assert.equal(gate(elsewhere, { allowed: ['message.send'], cfg: config({ skills: { safeMode: true } }) }).code, 'safe-mode');
  assert.equal(gate(elsewhere, { allowed: ['message.send'], cfg: config({ features: { skills: false } }) }).code, 'skills-off');
  // The list moved since: the gateway refuses what the resolution let through.
  assert.equal(gate(elsewhere, { allowed: ['message.send'], cfg: config({ skills: { conversations: [] } }) }).code, 'conversation-not-allowed');
  // Here, the reply tag's own skill is carried over; an edit never is.
  assert.equal(gate(resolveCall({ skill: 'message.send', args: {}, body: 'ναι' }, view())).ok, true);
  const edit = resolveCall({ skill: 'message.edit', args: { message: '#2' }, body: 'ναι' }, view());
  assert.equal(gate(edit).code, 'not-allowed');
  assert.equal(gate(edit, { allowed: ['message.edit'] }).ok, true);
  // Someone else's message, should the resolution ever let it through: the gateway refuses it too.
  assert.equal(gate({ ...edit, targetMessage: { ...edit.targetMessage, authorId: MEMBER } }, { allowed: ['message.edit'] }).code, 'not-own-message');
});

/** The executor's dependencies over a fake adapter. */
function deps(overrides = {}) {
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => 1000 });
  return {
    port,
    refOf: (conversationId) => ({ iface: 'fake', conversationId: String(conversationId) }),
    renderText: (text) => text,
    pingsOff: () => false,
    requester: { id: MEMBER },
    config: config(),
    getOp,
    opContext: { guildId: 'g1', channelId: HERE },
    ...overrides,
  };
}

test('executeCall: message.send posts in the other conversation, notifying only the replied author', async () => {
  const d = deps();
  d.port.seed(NEWS, { authorId: MEMBER, messageId: 'm3', text: 'ερώτηση' });
  const resolved = resolveCall({ skill: 'message.send', args: { conversation: '#νέα', replyTo: '#3' }, body: 'απάντηση <@8>' }, view());
  const result = await executeCall(resolved, d);
  assert.equal(result.status, 'ok');
  assert.equal(result.ref.conversationId, NEWS);
  const [posted] = d.port.messagesIn(NEWS).filter((message) => message.authorId === SELF);
  assert.equal(posted.text, 'απάντηση <@8>');
  assert.deepEqual(posted.mentions, { users: [], repliedUser: true });
  assert.deepEqual(posted.replyTo, { iface: 'fake', conversationId: NEWS, messageId: 'm3' });
  // That member turned pings off: the reply notifies nobody.
  const quiet = deps({ pingsOff: (id) => id === MEMBER });
  await executeCall(resolved, quiet);
  assert.deepEqual(quiet.port.calls[0].args[1].mentions, { users: [], repliedUser: false });
  // Unknown delivery is said so, never ok.
  const lost = deps();
  lost.port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } });
  assert.deepEqual([(await executeCall(resolved, lost)).status], ['unknown']);
});

test('executeCall: edit and delete change her own message; the port refuses anyone else\'s', async () => {
  const d = deps();
  const own = d.port.seed(NEWS, { authorId: SELF, messageId: 'm4', text: 'λάθος' });
  d.port.seed(NEWS, { authorId: MEMBER, messageId: 'm3', text: 'δικό της' });
  const edited = await executeCall({ skill: 'message.edit', args: { conversationId: NEWS, messageId: 'm4', text: 'σωστό' } }, d);
  assert.equal(edited.status, 'ok');
  assert.equal(d.port.messages.get(`${NEWS}/${own.messageId}`).text, 'σωστό');
  const foreign = await executeCall({ skill: 'message.edit', args: { conversationId: NEWS, messageId: 'm3', text: 'όχι' } }, d);
  assert.deepEqual([foreign.status, foreign.code], ['failed', 'not-own-message']);
  const deleted = await executeCall({ skill: 'message.delete', args: { conversationId: NEWS, messageId: 'm4' } }, d);
  assert.equal(deleted.status, 'ok');
  assert.equal(d.port.messagesIn(NEWS).some((message) => message.ref.messageId === 'm4'), false);
  const notHers = await executeCall({ skill: 'message.delete', args: { conversationId: NEWS, messageId: 'm3' } }, d);
  assert.deepEqual([notHers.status, notHers.code], ['failed', 'not-own-message']);
});

/** A real admin over a store with one member's public profile and private layer. */
function memoryAdmin(cfg) {
  const profile = { id: MEMBER, names: ['Zoë'], aliases: [], messageCount: 12, character: 'λατρεύει τα βουνά', affinity: { score: 10, reason: '' }, interests: [], details: [], episodes: [] };
  const privateCalls = [];
  const store = {
    state: { data: {}, markDirty() {} },
    getUser: (guildId, userId) => (userId === MEMBER ? profile : null),
    getPrivate: (...args) => {
      privateCalls.push(args);
      return { affinity: { score: 50, reason: 'μυστικό' }, interests: [{ topic: 'ιδιωτικό' }] };
    },
    getGuild: () => ({}),
  };
  const admin = createAdmin({ hot: { config: cfg, prompts: { labels: {} } }, store, client: {}, getGuildId: () => 'g1' });
  return { admin, privateCalls };
}

test('executeCall: memory.read gives the asker the /nep memory show summary, never the private layer; a member needs the same right', async () => {
  const resolved = { skill: 'memory.read', args: { memberId: MEMBER } };
  for (const [requester, access] of [[{ id: OWNER }, {}], [{ id: MEMBER }, { 'memory.profile.read': { everyone: false, roles: [], users: [MEMBER] } }]]) {
    const cfg = config({ access });
    const { admin, privateCalls } = memoryAdmin(cfg);
    const result = await executeCall(resolved, deps({ requester, config: cfg, runOp: admin.runOperation }));
    assert.equal(result.status, 'ok', requester.id);
    assert.ok(result.data.text.includes('name: Zoë') && result.data.text.includes('λατρεύει τα βουνά'), result.data.text);
    assert.ok(!result.data.text.includes('μυστικό') && !result.data.text.includes('ιδιωτικό'), 'no private-layer data');
    assert.deepEqual(privateCalls, []);
  }
  // A member without the right: refused before any memory is read.
  const cfg = config();
  const asked = [];
  const result = await executeCall(resolved, deps({ requester: { id: MEMBER }, config: cfg, runOp: async (...args) => asked.push(args) }));
  assert.deepEqual([result.status, result.code], ['refused', 'requester-denied']);
  assert.deepEqual(asked, []);
  // Nobody asked (a spontaneous turn): only a grant to everyone opens it.
  const unasked = await executeCall(resolved, deps({ requester: null, config: cfg, runOp: async (...args) => asked.push(args) }));
  assert.deepEqual([unasked.status, unasked.code], ['refused', 'requester-denied']);
});

test('executeCall: status.show is the member-level card, whoever asks; skills.list the catalogue rows', async () => {
  const asked = [];
  const runOp = async (name, args, context) => {
    asked.push({ name, args, context });
    return { status: 'ok', code: 'ok', summary: '', data: { text: '', embeds: [{ fields: [{ name: 'state', value: 'running' }, { name: 'uptime', value: '2 h' }] }] } };
  };
  const result = await executeCall({ skill: 'status.show', args: {} }, deps({ requester: { id: OWNER }, runOp }));
  assert.deepEqual(result, { status: 'ok', data: { text: 'state: running\nuptime: 2 h' } });
  assert.deepEqual(asked, [{ name: 'status.show', args: {}, context: { guildId: 'g1', channelId: HERE, userId: null } }]);

  const rows = [{ name: 'draw', title: 'Ζωγράφισε', whenToUse: '', allowed: true, reason: 'allowed' }];
  assert.deepEqual(await executeCall({ skill: 'skills.list', args: {} }, deps({ catalogue: () => rows })), { status: 'ok', data: { rows } });
});

test('executeCall: draw generates once and publishes once; a failed publication is not generated again', async () => {
  const generated = [];
  const generate = async (prompt) => {
    generated.push(prompt);
    return { buffer: Buffer.from('pic'), mediaType: 'image/png', cost: 0.02 };
  };
  const base = { generate, fileName: () => 'image.png', recheck: () => ({ ok: true }) };
  const d = deps(base);
  const resolved = { skill: 'draw', args: { conversationId: NEWS, prompt: 'a lighthouse at dusk' } };
  const ok = await executeCall(resolved, d);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(generated, ['a lighthouse at dusk']);
  assert.equal(d.port.calls[0].args[0].conversationId, NEWS);
  assert.equal(d.port.calls[0].args[1].attachments[0].name, 'image.png');

  const lost = deps(base);
  lost.port.failNext('send', { status: 'unknown', error: { code: 'http-500', retryable: false } });
  const unknown = await executeCall(resolved, lost);
  assert.deepEqual([unknown.status, unknown.generated], ['unknown', true]);
  assert.equal(generated.length, 2, 'one generation per call, none again after the failed publication');
  assert.equal(lost.port.calls.length, 1);

  // Revoked while it was generated: paid for, never published.
  const revoked = deps({ ...base, recheck: () => ({ ok: false, code: 'not-allowed', reason: 'draw' }) });
  const late = await executeCall(resolved, revoked);
  assert.deepEqual([late.status, late.code], ['refused', 'not-allowed']);
  assert.equal(revoked.port.calls.length, 0);

  const capped = deps({ ...base, generate: async () => { throw new ImageCapError('cap', { key: 'image.maxPerDay' }); } });
  assert.deepEqual([(await executeCall(resolved, capped)).code], ['daily-cap']);
});

test('needsFollowUp: a read that worked or any call that did not; never under the full stop', () => {
  assert.equal(needsFollowUp('memory.read', { status: 'ok' }), true);
  assert.equal(needsFollowUp('status.show', { status: 'ok' }), true);
  assert.equal(needsFollowUp('message.send', { status: 'ok' }), false);
  assert.equal(needsFollowUp('draw', { status: 'ok' }), false);
  assert.equal(needsFollowUp('message.edit', { status: 'refused', code: 'not-allowed' }), true);
  assert.equal(needsFollowUp('message.send', { status: 'unknown', code: 'timeout' }), true);
  assert.equal(needsFollowUp('message.send', { status: 'refused', code: 'skills-off' }), false);
});
