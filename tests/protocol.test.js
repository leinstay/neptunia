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
  CORE_KINDS,
  EVENT_KINDS,
  STATUSES,
  notOk,
  ok,
  portAction,
  validateAction,
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
  assert.deepEqual([...EVENT_KINDS], ['message.received', 'reaction.changed', 'command.requested', 'scheduler.tick', 'task.completed']);
  assert.deepEqual([...CORE_KINDS], ['scheduler.tick', 'task.completed']);
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
