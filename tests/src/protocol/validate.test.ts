// Tests for src/protocol/validate.ts, through src/protocol/index.ts: every inbound event kind validated in its documented
// shape, malformed events and actions refused with the field and the problem, every outbound action and every read
// action validated, and the checks never throwing whatever they are given. The first case pins the kinds and actions
// the sample tables below cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  CAPABILITIES,
  COMMAND_RESULT,
  CHAT_KINDS,
  CORE_KINDS,
  EVENT_KINDS,
  MEMBERSHIP_CHANGES,
  validateAction,
  validateEvent,
} from '../../../src/protocol/index.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  validateAction as validateActionOfModule,
  validateEvent as validateEventOfModule,
} from '../../../src/protocol/validate.ts';

const chat = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'γενικά', topic: null, category: null };

function messageEvent(overrides: Record<string, unknown> = {}) {
  // A loose literal on purpose: the cases below bend it into invalid events, so it is read as the valid shape here.
  return {
    kind: 'message.received',
    iface: 'discord',
    at: 1000,
    id: 'discord:message:m1',
    chat,
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Ελένη', self: false, bot: false },
      content: 'καλημέρα',
      at: 1000,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: true, replyToSelf: false, mentionedAccountIds: ['self'], mentionedChatIds: [] },
    ...overrides,
  } as MessageReceived;
}

const EVENTS = {
  'message.received': messageEvent(),
  'reaction.changed': {
    kind: 'reaction.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:reaction:1',
    chat,
    messageId: 'm1',
    emoji: { name: '\u{1F389}' },
    accountId: 'u1',
    added: true,
  },
  'command.requested': {
    kind: 'command.requested',
    iface: 'discord',
    at: 1000,
    id: 'discord:command:i1',
    chat,
    name: 'memory.show',
    args: { accountId: 'u2' },
    requester: { id: 'u1', name: null, roles: ['r1'], owner: true },
    replyRef: 'i1',
  },
  'scheduler.tick': { kind: 'scheduler.tick', at: 1000 },
  'errand.done': { kind: 'errand.done', at: 1000, errandId: 't1', status: 'done', result: { text: 'έτοιμο' } },
  'membership.changed': {
    kind: 'membership.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:member:g1:u1:joined:1000',
    placeId: 'g1',
    accountId: 'u1',
    change: 'joined',
    member: { id: 'u1', name: 'Ελένη', bot: false },
  },
  'voice.changed': {
    kind: 'voice.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:voice:g1:u1:1000',
    placeId: 'g1',
    accountId: 'u1',
    chatId: 'v1',
    previousId: null,
    muted: false,
    streaming: true,
  },
  'inner.wake': {
    kind: 'inner.wake',
    at: 1000,
    id: 'inner.wake:review:2026-10-19',
    placeId: 'g1',
    wake: { kind: 'review' },
  },
  // The detailed refusals of these four kinds are in the cases further down.
  'presence.changed': {
    kind: 'presence.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:presence:u1:1000',
    accountId: 'u1',
    name: 'Ελένη',
    status: 'online',
    activities: [{ kind: 'playing', name: 'Chess', details: '', state: '' }],
  },
  'presence.snapshot': {
    kind: 'presence.snapshot',
    iface: 'discord',
    at: 1000,
    id: 'discord:presence-snapshot:g1:1000',
    voice: [],
    presence: [],
  },
  'chat.changed': {
    kind: 'chat.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:chat:c1:created:1000',
    chat,
    change: 'created',
  },
  'connection.changed': {
    kind: 'connection.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:connection:lost:1000',
    state: 'lost',
  },
  'root.changed': {
    kind: 'root.changed',
    iface: 'discord',
    at: 1000,
    id: 'discord:root:g7:joined:1000',
    root: { id: 'g7', name: 'Gamma' },
    change: 'joined',
  },
};

const ref = { iface: 'fake', chatId: 'c1' };

const messageRef = { iface: 'fake', chatId: 'c1', messageId: 'm1' };

const ACTION_SAMPLES = {
  'message.send': {
    action: 'message.send',
    chat: ref,
    content: { text: 'γεια', replyTo: messageRef },
  },
  'message.edit': { action: 'message.edit', message: messageRef, content: { text: 'άλλο' } },
  'message.delete': { action: 'message.delete', message: messageRef },
  'message.react.add': { action: 'message.react.add', message: messageRef, emoji: '\u{1F389}' },
  'message.react.remove': { action: 'message.react.remove', message: messageRef, emoji: '\u{1F389}' },
  'chat.typing': { action: 'chat.typing', chat: ref },
  'command.result': { action: 'command.result', replyRef: 'i1', text: 'έγινε', files: [], ephemeral: true },
};

test('protocol: the kinds, chat kinds and actions are the contract', () => {
  assert.deepEqual(
    [...EVENT_KINDS],
    [
      'message.received',
      'reaction.changed',
      'command.requested',
      'scheduler.tick',
      'errand.done',
      'membership.changed',
      'voice.changed',
      'inner.wake',
      // An interface sends these four, so CORE_KINDS below holds none of them.
      'presence.changed',
      'presence.snapshot',
      'chat.changed',
      'connection.changed',
      // An interface reports a root it joined, holds or left.
      'root.changed',
    ]
  );
  assert.deepEqual([...CORE_KINDS], ['scheduler.tick', 'errand.done', 'inner.wake']);
  assert.deepEqual([...CHAT_KINDS], ['channel', 'dm', 'thread']);
  assert.deepEqual([...ACTIONS], [...Object.values(CAPABILITIES), COMMAND_RESULT]);
  assert.deepEqual(Object.keys(ACTION_SAMPLES).sort(), [...ACTIONS].sort());
  assert.deepEqual(Object.keys(EVENTS).sort(), [...EVENT_KINDS].sort());
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
  const dm = messageEvent({ chat: { id: 'd1', kind: 'dm' } });
  assert.deepEqual(validateEvent(dm), { ok: true });
  assert.deepEqual(validateEvent(messageEvent({ edit: true })), { ok: true });
  const deleted = {
    kind: 'message.received',
    iface: 'discord',
    at: 2000,
    id: 'discord:delete:m1',
    chat,
    message: { id: 'm1' },
    deleted: true,
  };
  assert.deepEqual(validateEvent(deleted), { ok: true });
  const partial = { ...deleted, deleted: undefined, edit: true, partial: true };
  delete partial.deleted;
  assert.deepEqual(validateEvent(partial), { ok: true });
  // Only an edit may be partial; a whole message needs its addressing.
  assert.deepEqual(validateEvent({ ...partial, edit: undefined }), { ok: false, reason: 'partial:edit-only' });
  assert.deepEqual(validateEvent(messageEvent({ addressing: undefined })), {
    ok: false,
    reason: 'addressing:required',
  });
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
  assert.deepEqual(validateEvent({ ...clearEmoji, accountId: null }), { ok: true });
  const { accountId: _u, ...noUser } = clearEmoji;
  assert.deepEqual(validateEvent(noUser), { ok: true });
  const clearAll = { ...noUser, cleared: 'all' };
  assert.deepEqual(validateEvent({ ...clearAll, emoji: null }), { ok: true });
  assert.deepEqual(validateEvent({ ...clearAll, emoji: undefined }), { ok: true });
  assert.deepEqual(validateEvent({ ...clearAll, emoji: { name: 'x' } }), { ok: true });
});

test('validateEvent: reaction.changed refuses the bad cleared and authorId shapes', () => {
  const base = EVENTS['reaction.changed'];
  const clearEmoji = { ...base, added: false, cleared: 'emoji', accountId: null };
  const cases: Array<[unknown, string]> = [
    [{ ...base, authorId: 7 }, 'authorId:type'],
    [{ ...base, authorId: '' }, 'authorId:type'],
    [{ ...base, cleared: 'some' }, 'cleared:unknown'],
    [{ ...base, cleared: 'all', added: true }, 'added:cleared'],
    [{ ...clearEmoji, added: true }, 'added:cleared'],
    [{ ...clearEmoji, emoji: null }, 'emoji:type'],
    [{ ...clearEmoji, emoji: undefined }, 'emoji:required'],
    [{ ...clearEmoji, accountId: 5 }, 'accountId:type'],
    [{ ...clearEmoji, cleared: 'all', emoji: { name: null } }, 'emoji:required'],
    [{ ...base, accountId: null }, 'accountId:type'],
    [{ ...base, emoji: null }, 'emoji:type'],
  ];
  for (const [event, reason] of cases) assert.deepEqual(validateEvent(event), { ok: false, reason }, reason);
});

test('validateEvent: the core kinds need no iface, id or chat; an interface kind does', () => {
  assert.deepEqual(validateEvent({ kind: 'scheduler.tick', at: 5 }), { ok: true });
  const { iface: _iface, ...noIface } = EVENTS['reaction.changed'];
  assert.deepEqual(validateEvent(noIface), { ok: false, reason: 'iface:required' });
  const { chat: _c, ...noChat } = EVENTS['command.requested'];
  assert.deepEqual(validateEvent(noChat), { ok: false, reason: 'chat:required' });
});

test('validateEvent: invalid shapes are refused with the field and the problem', () => {
  const message = EVENTS['message.received'];
  const { message: line } = message;
  const cases: Array<[unknown, string]> = [
    [null, 'event:type'],
    ['message.received', 'event:type'],
    [[], 'event:type'],
    [{ ...message, kind: 'message.sent' }, 'kind:unknown'],
    [{ ...message, at: Number.NaN }, 'at:type'],
    [{ ...message, at: '1000' }, 'at:type'],
    [{ ...message, id: '' }, 'id:type'],
    [{ ...message, chat: { ...chat, id: 42 } }, 'chat.id:type'],
    [{ ...message, chat: { ...chat, kind: 'group' } }, 'chat.kind:unknown'],
    [{ ...message, message: { ...line, id: 7 } }, 'message.id:type'],
    [{ ...message, message: { ...line, author: { ...line.author, id: 1 } } }, 'message.author.id:type'],
    [{ ...message, message: { ...line, author: { ...line.author, bot: 'no' } } }, 'message.author.bot:type'],
    [{ ...message, message: { ...line, at: undefined } }, 'message.at:required'],
    [{ ...message, message: { ...line, attachments: null } }, 'message.attachments:type'],
    [
      { ...message, addressing: { ...message.addressing, mentionedAccountIds: [1] } },
      'addressing.mentionedAccountIds.0:type',
    ],
    [{ ...message, edit: 'yes' }, 'edit:type'],
    [{ ...EVENTS['reaction.changed'], added: 1 }, 'added:type'],
    [{ ...EVENTS['command.requested'], args: [] }, 'args:type'],
    [
      { ...EVENTS['command.requested'], requester: { id: 'u1', name: null, roles: 'r1', owner: false } },
      'requester.roles:type',
    ],
    [{ ...EVENTS['command.requested'], replyRef: '' }, 'replyRef:type'],
    [{ kind: 'scheduler.tick' }, 'at:required'],
    [{ ...EVENTS['errand.done'], errandId: undefined }, 'errandId:required'],
  ];
  for (const [event, reason] of cases) assert.deepEqual(validateEvent(event), { ok: false, reason }, reason);
});

test('validateEvent: a platform object or a throwing getter is refused, never thrown', () => {
  const hostile = {
    kind: 'message.received',
    get at() {
      throw new Error('boom');
    },
  };
  assert.deepEqual(validateEvent(hostile), { ok: false, reason: 'malformed' });
  assert.doesNotThrow(() => validateEvent(undefined));
  assert.equal(validateEvent(undefined).ok, false);
});

test("validateEvent: keys starting with raw are the adapter's and never looked at", () => {
  assert.deepEqual(
    validateEvent({
      ...EVENTS['message.received'],
      raw: {
        get id() {
          throw new Error('never read');
        },
      },
    }),
    { ok: true }
  );
});

test('validateAction: every action is valid in its documented shape', () => {
  for (const [name, action] of Object.entries(ACTION_SAMPLES))
    assert.deepEqual(validateAction(action), { ok: true }, name);
});

test('validateAction: invalid shapes are refused with the field and the problem', () => {
  const cases: Array<[unknown, string]> = [
    [null, 'action:type'],
    [{ action: 'message.shout' }, 'action:unknown'],
    [{ action: 'message.send', chat: null, content: { text: 'x' } }, 'chat:type'],
    [{ action: 'message.send', chat: { iface: 'fake' }, content: { text: 'x' } }, 'chat.chatId:required'],
    [{ action: 'message.send', chat: ref }, 'content:required'],
    [{ action: 'message.send', chat: ref, content: { text: 5 } }, 'content.text:type'],
    [{ action: 'message.send', chat: ref, content: { attachments: 'a.png' } }, 'content.attachments:type'],
    [{ action: 'message.edit', message: ref, content: { text: 'x' } }, 'message.messageId:required'],
    [{ action: 'message.delete', message: { ...messageRef, messageId: 9 } }, 'message.messageId:type'],
    [{ action: 'message.react.add', message: messageRef }, 'emoji:required'],
    [{ action: 'chat.typing', chat: {} }, 'chat.iface:required'],
    [{ action: 'command.result', replyRef: 'i1' }, 'text:required'],
    [{ action: 'command.result', replyRef: 'i1', text: 'x', ephemeral: 'yes' }, 'ephemeral:type'],
  ];
  for (const [action, reason] of cases) assert.deepEqual(validateAction(action), { ok: false, reason }, reason);
});

test("validateAction: what the content holds and whose the target is stay the adapter's checks", () => {
  // Empty text, a foreign interface and null parts are well-formed actions; the port refuses them by its own codes.
  assert.equal(
    validateAction({
      action: 'message.send',
      chat: { iface: 'elsewhere', chatId: 'c1' },
      content: { text: '' },
    }).ok,
    true
  );
  assert.equal(
    validateAction({
      action: 'message.send',
      chat: ref,
      content: { text: 'x', replyTo: null, attachments: null },
    }).ok,
    true
  );
});

test('validateEvent: membership and voice events need their root, member and change', () => {
  const member = EVENTS['membership.changed'];
  const voice = EVENTS['voice.changed'];
  assert.deepEqual([...MEMBERSHIP_CHANGES], ['joined', 'left', 'updated']);
  const { member: _m, ...left } = { ...member, change: 'left' };
  assert.deepEqual(validateEvent(left), { ok: true });
  assert.deepEqual(validateEvent({ ...member, change: 'banned' }), { ok: false, reason: 'change:unknown' });
  assert.deepEqual(validateEvent({ ...member, placeId: undefined }), { ok: false, reason: 'placeId:required' });
  assert.deepEqual(validateEvent({ ...member, member: { id: 'u1', name: null } }), {
    ok: false,
    reason: 'member.bot:required',
  });
  assert.deepEqual(validateEvent({ ...voice, chatId: null, previousId: 'v1' }), { ok: true });
  assert.deepEqual(validateEvent({ ...voice, chatId: undefined }), {
    ok: false,
    reason: 'chatId:required',
  });
  assert.deepEqual(validateEvent({ ...voice, muted: 'yes' }), { ok: false, reason: 'muted:type' });
  assert.deepEqual(validateEvent({ ...voice, accountId: '' }), { ok: false, reason: 'accountId:type' });
});

test('validateEvent: a thread chat names its parent, and a parentId that is no id is refused', () => {
  assert.deepEqual(validateEvent(messageEvent({ chat: { ...chat, kind: 'thread', parentId: 'c0' } })), {
    ok: true,
  });
  assert.deepEqual(validateEvent(messageEvent({ chat: { ...chat, parentId: 7 } })), {
    ok: false,
    reason: 'chat.parentId:type',
  });
});

// The kinds presence.changed, presence.snapshot, chat.changed, connection.changed and root.changed, and the optional
// fields of voice.changed, Author and membership.changed.member.

type Json = Record<string, unknown>;

const eventsChat = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general', topic: null, category: null };

const activity = { kind: 'playing', name: 'Chess', details: 'Endgame', state: 'Winning' };

const presence = {
  accountId: 'u1',
  name: 'Eleni',
  status: 'online',
  activities: [activity],
};

const voice = {
  placeId: 'g1',
  accountId: 'u1',
  name: 'Eleni',
  chatId: 'v1',
  previousId: null,
  muted: false,
  deafened: false,
  streaming: false,
  camera: false,
};

const presenceChanged: Json = {
  kind: 'presence.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:presence:u1:1000',
  ...presence,
};

const presenceSnapshot: Json = {
  kind: 'presence.snapshot',
  iface: 'discord',
  at: 1000,
  id: 'discord:presence-snapshot:g1:1000',
  voice: [voice],
  presence: [presence],
};

const chatChanged: Json = {
  kind: 'chat.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:chat:c1:created:1000',
  chat: eventsChat,
  change: 'created',
};

const connectionChanged: Json = {
  kind: 'connection.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:connection:lost:1000',
  state: 'lost',
};

const without = (event: Json, key: string): Json => {
  const copy = { ...event };
  delete copy[key];
  return copy;
};

const refusal = (reason: string) => ({ ok: false, reason });

test('accepts a presence.changed event in its documented shape', () => {
  assert.deepEqual(validateEvent(presenceChanged), { ok: true });
});

test('accepts a presence.changed event with a null name and no activities', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, name: null, activities: [] }), { ok: true });
});

test('accepts every presence status and every activity kind', () => {
  for (const status of ['online', 'idle', 'dnd', 'offline', 'unknown'])
    assert.deepEqual(validateEvent({ ...presenceChanged, status }), { ok: true }, status);
  for (const kind of ['playing', 'streaming', 'listening', 'watching', 'competing', 'other'])
    assert.deepEqual(validateEvent({ ...presenceChanged, activities: [{ ...activity, kind }] }), { ok: true }, kind);
});

test('refuses a presence.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'accountId', 'name', 'status', 'activities'])
    assert.deepEqual(validateEvent(without(presenceChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a presence.changed event with an empty user id or a non-string name', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, accountId: '' }), refusal('accountId:type'));
  assert.deepEqual(validateEvent({ ...presenceChanged, name: 5 }), refusal('name:type'));
});

test('refuses a presence status outside the five known ones', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, status: 'invisible' }), refusal('status:unknown'));
});

test('refuses an activity of an unknown kind', () => {
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [{ ...activity, kind: 'custom' }] }),
    refusal('activities.0.kind:unknown')
  );
});

test('refuses an activity missing a field, with the index of the activity', () => {
  const second = without(activity, 'details');
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [activity, second] }),
    refusal('activities.1.details:required')
  );
  assert.deepEqual(
    validateEvent({ ...presenceChanged, activities: [{ ...activity, name: 7 }] }),
    refusal('activities.0.name:type')
  );
});

test('refuses activities that are not a list', () => {
  assert.deepEqual(validateEvent({ ...presenceChanged, activities: 'playing' }), refusal('activities:type'));
});

test('accepts a presence.snapshot event in its documented shape', () => {
  assert.deepEqual(validateEvent(presenceSnapshot), { ok: true });
});

test('accepts an empty presence.snapshot', () => {
  assert.deepEqual(validateEvent({ ...presenceSnapshot, voice: [], presence: [] }), { ok: true });
});

test('refuses a presence.snapshot event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'voice', 'presence'])
    assert.deepEqual(validateEvent(without(presenceSnapshot, key)), refusal(`${key}:required`), key);
});

test('refuses a presence.snapshot whose lists are not lists', () => {
  assert.deepEqual(validateEvent({ ...presenceSnapshot, voice: {} }), refusal('voice:type'));
  assert.deepEqual(validateEvent({ ...presenceSnapshot, presence: null }), refusal('presence:type'));
});

test('refuses a snapshot presence entry with an unknown status, with its index', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, presence: [presence, { ...presence, status: 'away' }] }),
    refusal('presence.1.status:unknown')
  );
});

test('refuses a snapshot presence entry with an unknown activity kind', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, presence: [{ ...presence, activities: [{ ...activity, kind: 'x' }] }] }),
    refusal('presence.0.activities.0.kind:unknown')
  );
});

test('refuses a snapshot voice entry missing its user, with its index', () => {
  assert.deepEqual(
    validateEvent({ ...presenceSnapshot, voice: [voice, without(voice, 'accountId')] }),
    refusal('voice.1.accountId:required')
  );
});

test('accepts a chat.changed event for each change', () => {
  for (const change of ['created', 'updated', 'deleted'])
    assert.deepEqual(validateEvent({ ...chatChanged, change }), { ok: true }, change);
});

test('refuses a chat.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'chat', 'change'])
    assert.deepEqual(validateEvent(without(chatChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a chat.changed event with an unknown change', () => {
  assert.deepEqual(validateEvent({ ...chatChanged, change: 'archived' }), refusal('change:unknown'));
});

test('checks the chat of a chat.changed event like any other chat', () => {
  assert.deepEqual(
    validateEvent({ ...chatChanged, chat: { ...eventsChat, kind: 'forum' } }),
    refusal('chat.kind:unknown')
  );
});

test('accepts a connection.changed event for each state', () => {
  for (const state of ['lost', 'resumed'])
    assert.deepEqual(validateEvent({ ...connectionChanged, state }), { ok: true }, state);
});

test('refuses a connection.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'state'])
    assert.deepEqual(validateEvent(without(connectionChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a connection.changed event with an unknown state', () => {
  assert.deepEqual(validateEvent({ ...connectionChanged, state: 'closed' }), refusal('state:unknown'));
});

test('refuses a new kind with a non-finite time', () => {
  assert.deepEqual(validateEvent({ ...connectionChanged, at: Number.NaN }), refusal('at:type'));
});

// The optional fields added to existing kinds.

const voiceChanged: Json = {
  kind: 'voice.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:voice:g1:u1:1000',
  placeId: 'g1',
  accountId: 'u1',
  chatId: 'v1',
  previousId: null,
};

test('accepts voice.changed with and without a name and a camera flag', () => {
  assert.deepEqual(validateEvent(voiceChanged), { ok: true });
  assert.deepEqual(validateEvent({ ...voiceChanged, name: 'Eleni', camera: true }), { ok: true });
  assert.deepEqual(validateEvent({ ...voiceChanged, name: null }), { ok: true });
});

test('refuses a voice.changed name that is not a string and a camera that is not a boolean', () => {
  assert.deepEqual(validateEvent({ ...voiceChanged, name: 5 }), refusal('name:type'));
  assert.deepEqual(validateEvent({ ...voiceChanged, camera: 'on' }), refusal('camera:type'));
});

const author = { id: 'u1', name: 'Eleni', self: false, bot: false };

function messageWithAuthor(extra: Json): Json {
  return {
    kind: 'message.received',
    iface: 'discord',
    at: 1000,
    id: 'discord:message:m1',
    chat: eventsChat,
    message: {
      id: 'm1',
      author: { ...author, ...extra },
      content: 'hello',
      at: 1000,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

test('accepts an author avatar with a hash and a url, with nulls, and with none', () => {
  assert.deepEqual(validateEvent(messageWithAuthor({})), { ok: true });
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: 'a1b2', url: 'https://cdn.example/a1b2.png' } })),
    {
      ok: true,
    }
  );
  assert.deepEqual(validateEvent(messageWithAuthor({ avatar: { hash: null, url: null } })), { ok: true });
});

test('refuses a malformed author avatar, naming the field', () => {
  assert.deepEqual(validateEvent(messageWithAuthor({ avatar: 'a1b2' })), refusal('message.author.avatar:type'));
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: 5, url: null } })),
    refusal('message.author.avatar.hash:type')
  );
  assert.deepEqual(
    validateEvent(messageWithAuthor({ avatar: { hash: null } })),
    refusal('message.author.avatar.url:required')
  );
});

const membershipChanged: Json = {
  kind: 'membership.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:member:g1:u1:joined:1000',
  placeId: 'g1',
  accountId: 'u1',
  change: 'joined',
  member: { id: 'u1', name: 'Eleni', bot: false },
};

test('accepts a membership member avatar with a hash and a url, with nulls, and with none', () => {
  assert.deepEqual(validateEvent(membershipChanged), { ok: true });
  const withAvatar = (avatar: unknown) => ({
    ...membershipChanged,
    member: { ...(membershipChanged.member as Json), avatar },
  });
  assert.deepEqual(validateEvent(withAvatar({ hash: 'a1b2', url: 'https://cdn.example/a1b2.png' })), { ok: true });
  assert.deepEqual(validateEvent(withAvatar({ hash: null, url: null })), { ok: true });
});

test('refuses a malformed membership member avatar, naming the field', () => {
  const withAvatar = (avatar: unknown) => ({
    ...membershipChanged,
    member: { ...(membershipChanged.member as Json), avatar },
  });
  assert.deepEqual(validateEvent(withAvatar(7)), refusal('member.avatar:type'));
  assert.deepEqual(validateEvent(withAvatar({ hash: null, url: 3 })), refusal('member.avatar.url:type'));
});

test('still validates every event of the replay fixture basic-chat.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../../fixtures/events/basic-chat.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(text) as { iface: string; events: Array<Json> };
  assert.ok(fixture.events.length > 0);
  for (const event of fixture.events) {
    const full = { iface: fixture.iface, ...event };
    assert.deepEqual(validateEvent(full), { ok: true }, String(event.id));
  }
});

// The root of an interface joined, found at its start, or left (`root.changed`).

const rootChanged: Json = {
  kind: 'root.changed',
  iface: 'discord',
  at: 1000,
  id: 'discord:root:g7:joined:1000',
  root: { id: 'g7', name: 'Gamma' },
  change: 'joined',
};

test('accepts a root.changed event for each change', () => {
  // Catches: the core refusing the event that tells it a root joined, so the core never learns of the root.
  for (const change of ['joined', 'present', 'left'])
    assert.deepEqual(validateEvent({ ...rootChanged, change }), { ok: true }, change);
});

test('refuses a root.changed event missing a required field, naming the field', () => {
  for (const key of ['iface', 'id', 'root', 'change'])
    assert.deepEqual(validateEvent(without(rootChanged, key)), refusal(`${key}:required`), key);
});

test('refuses a root.changed event with an unknown change or a root with no id', () => {
  // Catches: a root with no id written as a served root, or a guessed change acted on.
  assert.deepEqual(validateEvent({ ...rootChanged, change: 'banned' }), refusal('change:unknown'));
  assert.deepEqual(validateEvent({ ...rootChanged, root: { id: '', name: 'Gamma' } }), refusal('root:type'));
});

// The moment the bot joined the root (`joinedAt`, milliseconds since the epoch, optional). Its bad value is refused
// with `joinedAt:type`, as every other optional field of an event is (`name:type` of a voice event).
test('a root.changed event takes a joinedAt number or none, and refuses any other joinedAt', () => {
  // Catches: a text or a NaN written to the root's place as the day the persona joined, or the core refusing the event of a
  // platform that does tell when the bot joined.
  assert.deepEqual(validateEvent({ ...rootChanged, joinedAt: 1790000000000 }), { ok: true });
  assert.deepEqual(validateEvent(rootChanged), { ok: true });
  for (const joinedAt of ['2026-10-03', null, Number.NaN, true])
    assert.deepEqual(validateEvent({ ...rootChanged, joinedAt }), refusal('joinedAt:type'), String(joinedAt));
});

/** A member's message with `content` and the custom emoji of `emojis`. */
const emojiMessage = (content: string, emojis: Array<Json>): Json => ({
  kind: 'message.received',
  iface: 'fake',
  at: 1000,
  id: 'fake:message:m1',
  chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' },
  message: {
    id: 'm1',
    author: { id: 'u1', name: 'Eleni', self: false, bot: false },
    content,
    at: 1000,
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis,
    reactions: [],
  },
  addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
});

const KEKW: Json = { id: '900', name: 'kekw', animated: false, url: 'https://cdn.example.invalid/900.png' };

// An emoji and a sticker go by a stable name of the engine.
test('refuses a message whose <emoji:ID> token names no entry of its emojis', () => {
  assert.deepEqual(validateEvent(emojiMessage('ha <emoji:900>', [KEKW])), { ok: true });
  assert.equal(validateEvent(emojiMessage('ha <emoji:901>', [KEKW])).ok, false);
});

// The read actions: references go through the same reference check as every action, id lists must hold ids, `limit`
// is an integer from 1 to 10,000, one anchor at most, finite times, at most 25 viewers, at most 50 texts of at most
// 2,000 characters.

const CHAT = { iface: 'fake', chatId: 'c1' };

const MESSAGE = { iface: 'fake', chatId: 'c1', messageId: 'm1' };

type Row = { name: string; action: Record<string, unknown>; reason?: string };

const GOOD: ReadonlyArray<Row> = [
  { name: 'chat info', action: { action: 'chat.info', chat: CHAT } },
  {
    name: 'chat info with audience and viewers',
    action: { action: 'chat.info', chat: CHAT, audience: true, viewers: ['u1', 'u2'] },
  },
  { name: 'chats list', action: { action: 'chats.list', placeId: 'g1' } },
  {
    name: 'history of the newest lines',
    action: { action: 'messages.history', chat: CHAT, limit: 50 },
  },
  {
    name: 'history before a message with a floor',
    action: { action: 'messages.history', chat: CHAT, limit: 10, before: 'm1', since: 1000 },
  },
  {
    name: 'history at the largest limit',
    action: { action: 'messages.history', chat: CHAT, limit: 10000 },
  },
  { name: 'member info', action: { action: 'member.info', placeId: 'g1', accountId: 'u1' } },
  { name: 'member info of a private chat', action: { action: 'member.info', placeId: null, accountId: 'u1' } },
  { name: 'emoji list', action: { action: 'emoji.list', placeId: 'g1' } },
  { name: 'link parse', action: { action: 'links.parse', texts: ['https://x/y', 'plain'] } },
  { name: 'reactors', action: { action: 'message.reactors', message: MESSAGE, emoji: '🔥', limit: 10 } },
];

const BAD: ReadonlyArray<Row> = [
  { name: 'chat info without a reference', action: { action: 'chat.info' } },
  {
    name: 'chat info with a reference without an interface',
    action: { action: 'chat.info', chat: { chatId: 'c1' } },
  },
  {
    name: 'chat info with viewers that are not ids',
    action: { action: 'chat.info', chat: CHAT, viewers: ['u1', ''] },
  },
  {
    name: 'chat info with 26 viewers',
    action: {
      action: 'chat.info',
      chat: CHAT,
      viewers: Array.from({ length: 26 }, (_, n) => `u${n}`),
    },
  },
  { name: 'chats list with an empty root', action: { action: 'chats.list', placeId: '' } },
  { name: 'history without a limit', action: { action: 'messages.history', chat: CHAT } },
  {
    name: 'history with a limit of zero',
    action: { action: 'messages.history', chat: CHAT, limit: 0 },
  },
  {
    name: 'history past the largest limit',
    action: { action: 'messages.history', chat: CHAT, limit: 10001 },
  },
  {
    name: 'history with a fractional limit',
    action: { action: 'messages.history', chat: CHAT, limit: 2.5 },
  },
  {
    name: 'history with two anchors',
    action: { action: 'messages.history', chat: CHAT, limit: 5, before: 'm1', after: 'm2' },
    reason: 'history:anchors',
  },
  {
    name: 'history with before and around',
    action: { action: 'messages.history', chat: CHAT, limit: 5, before: 'm1', around: 'm2' },
    reason: 'history:anchors',
  },
  {
    name: 'history with a floor that is not finite',
    action: { action: 'messages.history', chat: CHAT, limit: 5, since: Infinity },
  },
  { name: 'member info without a member', action: { action: 'member.info', placeId: 'g1' } },
  {
    name: 'reactors for a reference without a message id',
    action: { action: 'message.reactors', message: CHAT, emoji: '🔥', limit: 10 },
  },
  { name: 'link parse with 51 texts', action: { action: 'links.parse', texts: Array.from({ length: 51 }, () => 'x') } },
  { name: 'link parse with a text of 2001 characters', action: { action: 'links.parse', texts: ['x'.repeat(2001)] } },
  { name: 'link parse with a text that is not a string', action: { action: 'links.parse', texts: [7] } },
];

for (const row of GOOD) {
  test(`accepts a well-formed read: ${row.name}`, () => {
    assert.deepEqual(validateAction(row.action), { ok: true });
  });
}

for (const row of BAD) {
  test(`refuses a malformed read: ${row.name}`, () => {
    const verdict = validateAction(row.action);
    assert.equal(verdict.ok, false);
    if (row.reason !== undefined) assert.equal('reason' in verdict ? verdict.reason : null, row.reason);
  });
}

test('accepts a limit of one and exactly 25 viewers and 50 texts of 2000 characters', () => {
  const viewers = Array.from({ length: 25 }, (_, n) => `u${n}`);
  const texts = Array.from({ length: 50 }, () => 'x'.repeat(2000));
  assert.equal(validateAction({ action: 'messages.history', chat: CHAT, limit: 1 }).ok, true);
  assert.equal(validateAction({ action: 'chat.info', chat: CHAT, viewers }).ok, true);
  assert.equal(validateAction({ action: 'links.parse', texts }).ok, true);
});

// The wire shape of a dialog (src/protocol/validate.ts): a command.requested that answers a question names its dialog,
// and a command.result of status ask carries its question.

const SECRET = 'sk-or-v1-SECRETVALUE-9999';

test('a command.requested with an answer needs its dialog, and a command.result of status ask carries its question', () => {
  const base = {
    kind: 'command.requested',
    iface: 'cli',
    at: 1,
    id: 'cli:command:r1',
    chat: { id: 'cli:dm:owner', kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
    name: 'keys.add',
    args: { name: 'core-1' },
    requester: { id: 'owner', name: 'owner', roles: [], owner: true },
    replyRef: 'r1',
  };
  assert.equal(validateEventOfModule({ ...base, dialogId: 'd1', answer: SECRET }).ok, true);
  assert.equal(
    validateEventOfModule({ ...base, dialogId: 'd1', answer: '' }).ok,
    true,
    'a blank answer takes the default'
  );
  assert.equal(validateEventOfModule({ ...base, answer: SECRET }).ok, false, 'an answer with no dialog');
  assert.equal(validateEventOfModule({ ...base, dialogId: 'd1' }).ok, false, 'a dialog with no answer');
  const ask = {
    action: 'command.result',
    replyRef: 'r1',
    text: 'value?',
    status: 'ask',
    dialogId: 'd1',
    prompt: 'value?',
    secret: true,
  };
  assert.equal(validateActionOfModule(ask).ok, true);
  assert.equal(validateActionOfModule({ ...ask, secret: 'yes' }).ok, false);
});

// What an adapter declares about a place beyond its id: the authority it belongs to and the place that contains it, of
// any kind and at any depth. `kind` says what sort of chat it is and containment says where it sits: a channel in
// a category stays a channel. Discord's objects end inside its adapter (interfaces/discord/collect.ts).

const NOW = Date.parse('2026-11-05T12:00:00Z');

function eventIn(chat: Record<string, unknown>, id = 'm1'): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: 'other',
    at: NOW,
    id: `other:message:${id}`,
    chat,
    message: {
      id,
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: 'hello',
      at: NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

test('the door refuses a parent kind or an authority that is not a name', () => {
  // Bug: a malformed declaration crosses the door and is stored as a place key.
  const room = { id: 'c1', kind: 'channel', rootId: 'g1' };
  assert.equal(validateEvent(eventIn(room)).ok, true);
  for (const bad of [{ parentKind: 7 }, { parentKind: '' }, { authorityId: 7 }, { authorityId: '' }])
    assert.equal(validateEvent(eventIn({ ...room, ...bad })).ok, false, JSON.stringify(bad));
  assert.equal(validateEvent(eventIn({ ...room, parentId: 'x', parentKind: 'category' })).ok, true);
});
