// Tests for packages/protocol/ (through src/protocol.js, the engine's one import of it): every
// inbound event kind validated, malformed events and actions refused with a reason, every
// outbound action validated, and the checks never throwing whatever they are given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  CAPABILITIES,
  COMMAND_RESULT,
  CONVERSATION_KINDS,
  CHAT_TYPES,
  CORE_KINDS,
  ENVELOPE_TYPES,
  EVENT_KINDS,
  MEMBERSHIP_CHANGES,
  STATUSES,
  ackOf,
  envelope,
  notOk,
  ok,
  originOf,
  portAction,
  validateAction,
  validateEnvelope,
  validateEvent,
} from '../src/protocol.js';
import * as port from '../src/interface/port.js';

const conversation = { id: 'c1', kind: 'channel', guildId: 'g1', name: 'γενικά', topic: null, category: null };

function messageEvent(overrides = {}) {
  return {
    kind: 'message.received',
    iface: 'discord',
    at: 1000,
    id: 'discord:message:m1',
    conversation,
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Ελένη', self: false, bot: false },
      content: 'καλημέρα',
      at: 1000,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: true, replyToSelf: false, mentionedUserIds: ['self'], mentionedConversationIds: [] },
    ...overrides,
  };
}

const EVENTS = {
  'message.received': messageEvent(),
  'reaction.changed': {
    kind: 'reaction.changed', iface: 'discord', at: 1000, id: 'discord:reaction:1', conversation,
    messageId: 'm1', emoji: { name: '\u{1F389}' }, userId: 'u1', added: true,
  },
  'command.requested': {
    kind: 'command.requested', iface: 'discord', at: 1000, id: 'discord:command:i1', conversation,
    name: 'memory.show', args: { userId: 'u2' }, requester: { id: 'u1', name: null, roles: ['r1'], owner: true }, replyRef: 'i1',
  },
  'scheduler.tick': { kind: 'scheduler.tick', at: 1000 },
  'task.completed': { kind: 'task.completed', at: 1000, taskId: 't1', status: 'done', result: { text: 'έτοιμο' } },
  'membership.changed': {
    kind: 'membership.changed', iface: 'discord', at: 1000, id: 'discord:member:g1:u1:joined:1000', guildId: 'g1', userId: 'u1',
    change: 'joined', member: { id: 'u1', name: 'Ελένη', bot: false },
  },
  'voice.changed': {
    kind: 'voice.changed', iface: 'discord', at: 1000, id: 'discord:voice:g1:u1:1000', guildId: 'g1', userId: 'u1',
    conversationId: 'v1', previousId: null, muted: false, streaming: true,
  },
  'inner.wake': { kind: 'inner.wake', at: 1000, id: 'inner.wake:review:2026-10-19', guildId: 'g1', wake: { kind: 'review' } },
};

const ref = { iface: 'fake', conversationId: 'c1' };
const messageRef = { iface: 'fake', conversationId: 'c1', messageId: 'm1' };

const ACTION_SAMPLES = {
  'message.send': { action: 'message.send', conversation: ref, content: { text: 'γεια', replyTo: messageRef, mentions: { users: ['u1'], repliedUser: true } } },
  'message.edit': { action: 'message.edit', message: messageRef, content: { text: 'άλλο' } },
  'message.delete': { action: 'message.delete', message: messageRef },
  'message.react.add': { action: 'message.react.add', message: messageRef, emoji: '\u{1F389}' },
  'message.react.remove': { action: 'message.react.remove', message: messageRef, emoji: '\u{1F389}' },
  'conversation.typing': { action: 'conversation.typing', conversation: ref },
  'command.result': { action: 'command.result', replyRef: 'i1', text: 'έγινε', files: [], ephemeral: true },
};

test('protocol: the kinds, conversation kinds and actions are the contract', () => {
  assert.deepEqual([...EVENT_KINDS], ['message.received', 'reaction.changed', 'command.requested', 'scheduler.tick', 'task.completed', 'membership.changed', 'voice.changed', 'inner.wake']);
  assert.deepEqual([...CORE_KINDS], ['scheduler.tick', 'task.completed', 'inner.wake']);
  assert.deepEqual([...CONVERSATION_KINDS], ['channel', 'dm', 'thread']);
  assert.deepEqual([...ACTIONS], [...Object.values(CAPABILITIES), COMMAND_RESULT]);
  assert.deepEqual(Object.keys(ACTION_SAMPLES).sort(), [...ACTIONS].sort());
  assert.deepEqual(Object.keys(EVENTS).sort(), [...EVENT_KINDS].sort());
});

test('protocol: the port re-exports the package, so its importers are unchanged', () => {
  assert.equal(port.CAPABILITIES, CAPABILITIES);
  assert.equal(port.STATUSES, STATUSES);
  assert.equal(port.ok, ok);
  assert.equal(port.notOk, notOk);
  for (const name of ['INCOMING_HOOKS', 'NO_MENTIONS', 'mentionsOf', 'isRefOf', 'refRefusal', 'contentRefusal', 'declaredHooks']) assert.ok(name in port, name);
});

test('validateEvent: every kind is valid in its documented shape', () => {
  for (const [kind, event] of Object.entries(EVENTS)) assert.deepEqual(validateEvent(event), { ok: true }, kind);
});

test('validateEvent: an inner wake needs its own id and its wake record', () => {
  const base = EVENTS['inner.wake'];
  assert.deepEqual(validateEvent({ ...base, id: undefined }), { ok: false, reason: 'id:required' });
  assert.deepEqual(validateEvent({ ...base, wake: undefined }), { ok: false, reason: 'wake:required' });
  assert.deepEqual(validateEvent({ ...base, wake: {} }), { ok: false, reason: 'wake.kind:required' });
});

test('validateEvent: a direct chat, an edit, a deletion and a partial edit are message.received', () => {
  const dm = messageEvent({ conversation: { id: 'd1', kind: 'dm' } });
  assert.deepEqual(validateEvent(dm), { ok: true });
  assert.deepEqual(validateEvent(messageEvent({ edit: true })), { ok: true });
  const deleted = { kind: 'message.received', iface: 'discord', at: 2000, id: 'discord:delete:m1', conversation, message: { id: 'm1' }, deleted: true };
  assert.deepEqual(validateEvent(deleted), { ok: true });
  const partial = { ...deleted, deleted: undefined, edit: true, partial: true };
  delete partial.deleted;
  assert.deepEqual(validateEvent(partial), { ok: true });
  // Only an edit may be partial; a whole message needs its addressing.
  assert.deepEqual(validateEvent({ ...partial, edit: undefined }), { ok: false, reason: 'partial:edit-only' });
  assert.deepEqual(validateEvent(messageEvent({ addressing: undefined })), { ok: false, reason: 'addressing:required' });
});

test('validateEvent: a custom emoji is known by its id even without a name', () => {
  const base = EVENTS['reaction.changed'];
  assert.deepEqual(validateEvent({ ...base, emoji: { name: null, id: '123' } }), { ok: true });
  assert.deepEqual(validateEvent({ ...base, emoji: { name: null } }), { ok: false, reason: 'emoji:required' });
});

test('validateEvent: reaction.changed takes authorId and the cleared forms', () => {
  const base = EVENTS['reaction.changed'];
  assert.deepEqual(validateEvent({ ...base, authorId: 'u9' }), { ok: true });
  assert.deepEqual(validateEvent({ ...base, authorId: null }), { ok: true });
  const clearEmoji = { ...base, added: false, cleared: 'emoji' };
  assert.deepEqual(validateEvent(clearEmoji), { ok: true });
  assert.deepEqual(validateEvent({ ...clearEmoji, userId: null }), { ok: true });
  const { userId: _u, ...noUser } = clearEmoji;
  assert.deepEqual(validateEvent(noUser), { ok: true });
  const clearAll = { ...noUser, cleared: 'all' };
  assert.deepEqual(validateEvent({ ...clearAll, emoji: null }), { ok: true });
  assert.deepEqual(validateEvent({ ...clearAll, emoji: undefined }), { ok: true });
  assert.deepEqual(validateEvent({ ...clearAll, emoji: { name: 'x' } }), { ok: true });
});

test('validateEvent: reaction.changed refuses the bad cleared and authorId shapes', () => {
  const base = EVENTS['reaction.changed'];
  const clearEmoji = { ...base, added: false, cleared: 'emoji', userId: null };
  const cases = [
    [{ ...base, authorId: 7 }, 'authorId:type'],
    [{ ...base, authorId: '' }, 'authorId:type'],
    [{ ...base, cleared: 'some' }, 'cleared:unknown'],
    [{ ...base, cleared: 'all', added: true }, 'added:cleared'],
    [{ ...clearEmoji, added: true }, 'added:cleared'],
    [{ ...clearEmoji, emoji: null }, 'emoji:type'],
    [{ ...clearEmoji, emoji: undefined }, 'emoji:required'],
    [{ ...clearEmoji, userId: 5 }, 'userId:type'],
    [{ ...clearEmoji, cleared: 'all', emoji: { name: null } }, 'emoji:required'],
    [{ ...base, userId: null }, 'userId:type'],
    [{ ...base, emoji: null }, 'emoji:type'],
  ];
  for (const [event, reason] of cases) assert.deepEqual(validateEvent(event), { ok: false, reason }, reason);
});

test('validateEvent: the core kinds need no iface, id or conversation; an interface kind does', () => {
  assert.deepEqual(validateEvent({ kind: 'scheduler.tick', at: 5 }), { ok: true });
  const { iface: _iface, ...noIface } = EVENTS['reaction.changed'];
  assert.deepEqual(validateEvent(noIface), { ok: false, reason: 'iface:required' });
  const { conversation: _c, ...noConversation } = EVENTS['command.requested'];
  assert.deepEqual(validateEvent(noConversation), { ok: false, reason: 'conversation:required' });
});

test('validateEvent: invalid shapes are refused with the field and the problem', () => {
  const message = EVENTS['message.received'];
  const cases = [
    [null, 'event:type'],
    ['message.received', 'event:type'],
    [[], 'event:type'],
    [{ ...message, kind: 'message.sent' }, 'kind:unknown'],
    [{ ...message, at: Number.NaN }, 'at:type'],
    [{ ...message, at: '1000' }, 'at:type'],
    [{ ...message, id: '' }, 'id:type'],
    [{ ...message, conversation: { ...conversation, id: 42 } }, 'conversation.id:type'],
    [{ ...message, conversation: { ...conversation, kind: 'group' } }, 'conversation.kind:unknown'],
    [{ ...message, message: { ...message.message, id: 7 } }, 'message.id:type'],
    [{ ...message, message: { ...message.message, author: { ...message.message.author, id: 1 } } }, 'message.author.id:type'],
    [{ ...message, message: { ...message.message, author: { ...message.message.author, bot: 'no' } } }, 'message.author.bot:type'],
    [{ ...message, message: { ...message.message, at: undefined } }, 'message.at:required'],
    [{ ...message, message: { ...message.message, attachments: null } }, 'message.attachments:type'],
    [{ ...message, addressing: { ...message.addressing, mentionedUserIds: [1] } }, 'addressing.mentionedUserIds.0:type'],
    [{ ...message, edit: 'yes' }, 'edit:type'],
    [{ ...EVENTS['reaction.changed'], added: 1 }, 'added:type'],
    [{ ...EVENTS['command.requested'], args: [] }, 'args:type'],
    [{ ...EVENTS['command.requested'], requester: { id: 'u1', name: null, roles: 'r1', owner: false } }, 'requester.roles:type'],
    [{ ...EVENTS['command.requested'], replyRef: '' }, 'replyRef:type'],
    [{ kind: 'scheduler.tick' }, 'at:required'],
    [{ ...EVENTS['task.completed'], taskId: undefined }, 'taskId:required'],
  ];
  for (const [event, reason] of cases) assert.deepEqual(validateEvent(event), { ok: false, reason }, reason);
});

test('validateEvent: a platform object or a throwing getter is refused, never thrown', () => {
  const hostile = { kind: 'message.received', get at() { throw new Error('boom'); } };
  assert.deepEqual(validateEvent(hostile), { ok: false, reason: 'malformed' });
  assert.doesNotThrow(() => validateEvent(undefined));
  assert.equal(validateEvent(undefined).ok, false);
});

test('validateEvent: keys starting with raw are the adapter\'s and never looked at', () => {
  assert.deepEqual(validateEvent({ ...EVENTS['message.received'], raw: { get id() { throw new Error('never read'); } } }), { ok: true });
});

test('validateAction: every action is valid in its documented shape', () => {
  for (const [name, action] of Object.entries(ACTION_SAMPLES)) assert.deepEqual(validateAction(action), { ok: true }, name);
});

test('validateAction: invalid shapes are refused with the field and the problem', () => {
  const cases = [
    [null, 'action:type'],
    [{ action: 'message.shout' }, 'action:unknown'],
    [{ action: 'message.send', conversation: null, content: { text: 'x' } }, 'conversation:type'],
    [{ action: 'message.send', conversation: { iface: 'fake' }, content: { text: 'x' } }, 'conversation.conversationId:required'],
    [{ action: 'message.send', conversation: ref }, 'content:required'],
    [{ action: 'message.send', conversation: ref, content: { text: 5 } }, 'content.text:type'],
    [{ action: 'message.send', conversation: ref, content: { attachments: 'a.png' } }, 'content.attachments:type'],
    [{ action: 'message.edit', message: ref, content: { text: 'x' } }, 'message.messageId:required'],
    [{ action: 'message.delete', message: { ...messageRef, messageId: 9 } }, 'message.messageId:type'],
    [{ action: 'message.react.add', message: messageRef }, 'emoji:required'],
    [{ action: 'conversation.typing', conversation: {} }, 'conversation.iface:required'],
    [{ action: 'command.result', replyRef: 'i1' }, 'text:required'],
    [{ action: 'command.result', replyRef: 'i1', text: 'x', ephemeral: 'yes' }, 'ephemeral:type'],
  ];
  for (const [action, reason] of cases) assert.deepEqual(validateAction(action), { ok: false, reason }, reason);
});

test('validateAction: what the content holds and whose the target is stay the adapter\'s checks', () => {
  // Empty text, a foreign interface and null parts are well-formed actions; the port refuses them by its own codes.
  assert.equal(validateAction({ action: 'message.send', conversation: { iface: 'elsewhere', conversationId: 'c1' }, content: { text: '' } }).ok, true);
  assert.equal(validateAction({ action: 'message.send', conversation: ref, content: { text: 'x', replyTo: null, mentions: null, attachments: null } }).ok, true);
});

test('portAction: a port call as its action object', () => {
  assert.deepEqual(portAction('send', [ref, { text: 'x' }]), { action: 'message.send', conversation: ref, content: { text: 'x' } });
  assert.deepEqual(portAction('edit', [messageRef, { text: 'x' }]), { action: 'message.edit', message: messageRef, content: { text: 'x' } });
  assert.deepEqual(portAction('delete', [messageRef]), { action: 'message.delete', message: messageRef });
  assert.deepEqual(portAction('react', [messageRef, 'e']), { action: 'message.react.add', message: messageRef, emoji: 'e' });
  assert.deepEqual(portAction('unreact', [messageRef, 'e']), { action: 'message.react.remove', message: messageRef, emoji: 'e' });
  assert.deepEqual(portAction('typing', [ref]), { action: 'conversation.typing', conversation: ref });
  assert.equal(validateAction(portAction('shout', [ref])).ok, false);
  assert.equal(validateAction(portAction('send', null)).ok, false);
});

test('validateEvent: membership and voice events need their community, member and change', () => {
  const member = EVENTS['membership.changed'];
  const voice = EVENTS['voice.changed'];
  assert.deepEqual([...MEMBERSHIP_CHANGES], ['joined', 'left', 'updated']);
  const { member: _m, ...left } = { ...member, change: 'left' };
  assert.deepEqual(validateEvent(left), { ok: true });
  assert.deepEqual(validateEvent({ ...member, change: 'banned' }), { ok: false, reason: 'change:unknown' });
  assert.deepEqual(validateEvent({ ...member, guildId: undefined }), { ok: false, reason: 'guildId:required' });
  assert.deepEqual(validateEvent({ ...member, member: { id: 'u1', name: null } }), { ok: false, reason: 'member.bot:required' });
  assert.deepEqual(validateEvent({ ...voice, conversationId: null, previousId: 'v1' }), { ok: true });
  assert.deepEqual(validateEvent({ ...voice, conversationId: undefined }), { ok: false, reason: 'conversationId:required' });
  assert.deepEqual(validateEvent({ ...voice, muted: 'yes' }), { ok: false, reason: 'muted:type' });
  assert.deepEqual(validateEvent({ ...voice, userId: '' }), { ok: false, reason: 'userId:type' });
});

test('validateEvent: an origin record is optional, and checked when present', () => {
  const origin = { chatType: 'thread', place: 't1', parent: 'c1', thread: 't1', replyToAuthorId: 'u2', replyExpected: false };
  assert.deepEqual([...CHAT_TYPES], ['dm', 'group', 'channel', 'thread']);
  assert.deepEqual(validateEvent(messageEvent({ origin })), { ok: true });
  assert.deepEqual(validateEvent(messageEvent({ origin: { ...origin, replyExpected: null, parent: null } })), { ok: true });
  assert.deepEqual(validateEvent(messageEvent({ origin: { ...origin, chatType: 'forum' } })), { ok: false, reason: 'origin.chatType:unknown' });
  assert.deepEqual(validateEvent(messageEvent({ origin: { ...origin, replyExpected: undefined } })), { ok: false, reason: 'origin.replyExpected:required' });
  assert.deepEqual(validateEvent(messageEvent({ origin: 'x' })), { ok: false, reason: 'origin:type' });
  assert.deepEqual(validateEvent(messageEvent({ conversation: { ...conversation, kind: 'thread', parentId: 'c0' } })), { ok: true });
  assert.deepEqual(validateEvent(messageEvent({ conversation: { ...conversation, parentId: 7 } })), { ok: false, reason: 'conversation.parentId:type' });
});

test('originOf: the origin an adapter sent wins; else it is read off the conversation and the addressing', () => {
  const plain = originOf(messageEvent({ addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] } }));
  assert.deepEqual(plain, { chatType: 'channel', place: 'c1', parent: null, thread: null, replyToAuthorId: null, replyExpected: null });
  assert.equal(originOf(messageEvent()).replyExpected, true, 'a mention expects an answer');
  assert.equal(originOf(messageEvent({ conversation: { id: 'd1', kind: 'dm' }, addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] } })).chatType, 'dm');
  assert.equal(originOf(messageEvent({ conversation: { id: 'd1', kind: 'dm' } })).replyExpected, true, 'a direct chat expects an answer');
  const thread = originOf(messageEvent({ conversation: { ...conversation, id: 't1', kind: 'thread', parentId: 'c1' } }));
  assert.deepEqual([thread.chatType, thread.place, thread.parent, thread.thread], ['thread', 't1', 'c1', 't1']);
  const sent = { chatType: 'group', place: 'g9', parent: null, thread: null, replyToAuthorId: 'u2', replyExpected: false };
  assert.deepEqual(originOf(messageEvent({ origin: sent })), sent);
  assert.doesNotThrow(() => originOf(null));
});

test('envelope: every type validates in its documented body, and a bad one is refused with a reason', () => {
  assert.deepEqual([...ENVELOPE_TYPES], ['hello', 'event', 'ack', 'action', 'action_result', 'ping']);
  const event = EVENTS['reaction.changed'];
  const valid = [
    envelope('hello', { iface: 'discord', capabilities: ['message.send'], resume: null }, { id: 'h1' }),
    envelope('event', event, { id: event.id }),
    envelope('ack', { status: 'duplicate' }, { id: 'a1', replyTo: event.id }),
    envelope('action', ACTION_SAMPLES['message.send'], { id: 'x1' }),
    envelope('action_result', { status: 'ok' }, { id: 'r1', replyTo: 'x1' }),
    envelope('ping', { at: 5 }, { id: 'p1' }),
    ackOf('p1', 'ok'),
  ];
  for (const value of valid) assert.deepEqual(validateEnvelope(value), { ok: true }, value.type);
  assert.deepEqual(valid[0].v, 1);
  assert.deepEqual(valid[6], { v: 1, id: 'ack:p1', type: 'ack', replyTo: 'p1', body: { status: 'ok' } });
  const cases = [
    [null, 'envelope:type'],
    [{ ...valid[0], v: 2 }, 'v:unsupported'],
    [{ ...valid[0], id: '' }, 'id:type'],
    [{ ...valid[0], type: 'event2' }, 'type:unknown'],
    [{ ...valid[0], replyTo: 3 }, 'replyTo:type'],
    [{ ...valid[2], replyTo: null }, 'replyTo:required'],
    [{ ...valid[0], body: null }, 'body:type'],
    [{ ...valid[0], body: { iface: '' } }, 'body.iface:type'],
    [{ ...valid[1], body: { ...event, userId: '' } }, 'body.userId:type'],
    [{ ...valid[2], body: { status: 'maybe' } }, 'body.status:unknown'],
    [{ ...valid[3], body: { action: 'message.nuke' } }, 'body.action:unknown'],
    [{ ...valid[4], body: {} }, 'body.status:type'],
    [{ ...valid[5], body: { at: 'now' } }, 'body.at:type'],
  ];
  for (const [value, reason] of cases) assert.deepEqual(validateEnvelope(value), { ok: false, reason }, reason);
});
