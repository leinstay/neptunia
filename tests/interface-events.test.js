// Tests of the neutral inbound event model (src/interface/events.js): origin, events, envelope,
// idempotent ids. Pure functions: no fakes needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_VERSION, EVENT_TYPES, ENVELOPE_TYPES, CHAT_TYPES,
  eventId, createDedupe, normalizeOrigin, normalizeEvent, validateEvent,
  normalizeEnvelope, validateEnvelope, eventEnvelope, ackFor,
} from '../src/interface/events.js';

const ORIGIN = { iface: 'fake', chatType: 'channel', place: 'c1', community: 'g1' };
const AUTHOR = { id: 'u1', name: 'Ζήνων', self: false, bot: false };
const base = (type, extra) => ({ id: `fake:${type}:1`, type, at: 1000, origin: ORIGIN, ...extra });
const created = (extra = {}) => base('message.created', { message: { id: 'm1', author: AUTHOR, text: 'καλημέρα', ...extra } });

test('the event and envelope types are the specified ones', () => {
  assert.deepEqual([...EVENT_TYPES], [
    'message.created', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed',
    'member.joined', 'member.left', 'voice.state',
  ]);
  assert.deepEqual([...ENVELOPE_TYPES], ['hello', 'event', 'ack', 'action', 'action_result', 'ping']);
  assert.deepEqual([...CHAT_TYPES], ['dm', 'group', 'channel', 'thread', 'none']);
  assert.equal(ENVELOPE_VERSION, 1);
});

test('origin: a channel origin is filled with null and false defaults', () => {
  const result = normalizeOrigin(ORIGIN);
  assert.deepEqual(result, {
    ok: true,
    origin: {
      iface: 'fake', chatType: 'channel', place: 'c1', parent: null, thread: null, community: 'g1',
      replyToAuthor: null, replyExpected: false, meta: {},
    },
  });
});

test('origin: a thread takes its own place as the thread and keeps its parent', () => {
  const { origin } = normalizeOrigin({ iface: 'fake', chatType: 'thread', place: 't1', parent: 'c1' });
  assert.equal(origin.thread, 't1');
  assert.equal(origin.parent, 'c1');
  assert.equal(normalizeOrigin({ iface: 'fake', chatType: 'channel', place: 'c1', thread: 't9' }).origin.thread, 't9');
});

test('origin: reply-to author and reply expectation are carried', () => {
  const { origin } = normalizeOrigin({
    ...ORIGIN, replyToAuthor: { id: 'me', name: '', self: true }, replyExpected: true, meta: { placeName: 'general', slowmode: 5 },
  });
  assert.deepEqual(origin.replyToAuthor, { id: 'me', name: null, self: true });
  assert.equal(origin.replyExpected, true);
  assert.deepEqual(origin.meta, { placeName: 'general', slowmode: 5 });
});

test('origin: none needs no place; every other chat type does', () => {
  assert.equal(normalizeOrigin({ iface: 'core', chatType: 'none' }).ok, true);
  for (const chatType of ['dm', 'group', 'channel', 'thread']) {
    assert.deepEqual(normalizeOrigin({ iface: 'fake', chatType }), { ok: false, reason: 'origin.place:required' });
  }
});

test('origin: bad shapes name the field', () => {
  const reason = (patch) => normalizeOrigin({ ...ORIGIN, ...patch }).reason;
  assert.equal(normalizeOrigin(null).reason, 'origin:required');
  assert.equal(reason({ iface: ' ' }), 'origin.iface:required');
  assert.equal(reason({ chatType: 'voice' }), 'origin.chatType:unknown');
  assert.equal(reason({ parent: 5 }), 'origin.parent:type');
  assert.equal(reason({ replyToAuthor: {} }), 'origin.replyToAuthor.id:required');
  assert.equal(reason({ replyToAuthor: { id: 'a', self: 'yes' } }), 'origin.replyToAuthor.self:type');
  assert.equal(reason({ replyExpected: 'yes' }), 'origin.replyExpected:type');
  assert.equal(reason({ meta: { fn() {} } }), 'origin.meta:type');
  assert.equal(reason({ meta: [] }), 'origin.meta:type');
});

test('origin: unknown keys are dropped and meta is copied', () => {
  const meta = { a: 1 };
  const { origin } = normalizeOrigin({ ...ORIGIN, raw: { client: {} }, meta });
  assert.equal('raw' in origin, false);
  assert.notEqual(origin.meta, meta);
});

test('message.created normalises with defaults', () => {
  const { ok, event } = normalizeEvent(created());
  assert.equal(ok, true);
  assert.deepEqual(event.message, {
    id: 'm1', author: AUTHOR, text: 'καλημέρα', at: null, replyToId: null,
    mentions: { self: false, userIds: [], placeIds: [] }, attachments: [],
  });
  assert.equal(event.origin.place, 'c1');
});

test('message.created needs a text (empty is fine) and a valid author', () => {
  assert.equal(normalizeEvent(created({ text: '' })).ok, true);
  assert.equal(normalizeEvent(created({ text: undefined })).reason, 'message.text:required');
  assert.equal(normalizeEvent(created({ author: { name: 'x' } })).reason, 'message.author.id:required');
  assert.equal(normalizeEvent(created({ author: null })).reason, 'message.author:required');
  assert.equal(normalizeEvent(created({ replyToId: 3 })).reason, 'message.replyToId:type');
  assert.equal(normalizeEvent(created({ mentions: { userIds: ['a', 2] } })).reason, 'message.mentions.userIds:type');
  assert.equal(normalizeEvent(created({ attachments: ['x'] })).reason, 'message.attachments:type');
});

test('message.edited: partial edits may omit the text, whole ones may not', () => {
  const edit = (message, extra = {}) => base('message.edited', { message, ...extra });
  assert.equal(normalizeEvent(edit({ id: 'm1', author: AUTHOR }, { partial: true })).ok, true);
  assert.equal(normalizeEvent(edit({ id: 'm1', author: AUTHOR })).reason, 'message.text:required');
  const { event } = normalizeEvent(edit({ id: 'm1', author: AUTHOR, text: 'new' }));
  assert.equal(event.partial, undefined);
  assert.equal(normalizeEvent(created()).event.partial, undefined);
  assert.equal(normalizeEvent({ ...created(), partial: true }).reason, 'partial:unsupported');
});

test('message.deleted carries only the message id', () => {
  const { event } = normalizeEvent(base('message.deleted', { message: { id: 'm1', text: 'leaked' } }));
  assert.deepEqual(event.message, { id: 'm1' });
  assert.equal(normalizeEvent(base('message.deleted', { message: {} })).reason, 'message.id:required');
});

test('reactions need a message, an emoji (name or id) and an actor', () => {
  const reaction = (type, extra) => base(type, { messageId: 'm1', emoji: { name: '👍' }, actor: AUTHOR, ...extra });
  const added = normalizeEvent(reaction('reaction.added'));
  assert.deepEqual(added.event.emoji, { name: '👍', id: null });
  assert.equal(normalizeEvent(reaction('reaction.removed', { emoji: { id: 'e9' } })).ok, true);
  assert.equal(normalizeEvent(reaction('reaction.added', { emoji: {} })).reason, 'emoji:required');
  assert.equal(normalizeEvent(reaction('reaction.added', { messageId: '' })).reason, 'messageId:required');
  assert.equal(normalizeEvent(reaction('reaction.added', { actor: undefined })).reason, 'actor:required');
});

test('membership events need a member and may have no place', () => {
  const origin = { iface: 'fake', chatType: 'none', community: 'g1' };
  const joined = normalizeEvent({ ...base('member.joined', { member: AUTHOR }), origin });
  assert.equal(joined.ok, true);
  assert.equal(joined.event.origin.place, null);
  assert.equal(normalizeEvent(base('member.left', {})).reason, 'member:required');
});

test('voice.state needs a change of place', () => {
  const voice = (extra) => base('voice.state', { member: AUTHOR, from: null, to: 'v1', ...extra });
  const { event } = normalizeEvent(voice({ muted: true }));
  assert.deepEqual([event.from, event.to, event.muted, event.deafened, event.streaming], [null, 'v1', true, false, false]);
  assert.equal(normalizeEvent(voice({ from: 'v1', to: null })).ok, true);
  assert.equal(normalizeEvent(voice({ from: 'v1', to: 'v1' })).reason, 'to:unchanged');
  assert.equal(normalizeEvent(voice({ from: null, to: null })).reason, 'to:required');
  assert.equal(normalizeEvent(voice({ muted: 'y' })).reason, 'muted:type');
});

test('events: the common fields are checked', () => {
  assert.equal(normalizeEvent(null).reason, 'event:required');
  assert.equal(normalizeEvent({ ...created(), type: 'message.sent' }).reason, 'type:unknown');
  assert.equal(normalizeEvent({ ...created(), id: '' }).reason, 'id:required');
  assert.equal(normalizeEvent({ ...created(), at: NaN }).reason, 'at:type');
  assert.equal(normalizeEvent({ ...created(), at: '5' }).reason, 'at:type');
  assert.equal(normalizeEvent({ ...created(), origin: undefined }).reason, 'origin:required');
});

test('events: normalising is idempotent and drops platform extras', () => {
  const once = normalizeEvent({ ...created({ client: {} }), raw: { discord: true } }).event;
  assert.equal('raw' in once, false);
  assert.equal('client' in once.message, false);
  assert.deepEqual(normalizeEvent(once).event, once);
  for (const sample of [
    base('message.deleted', { message: { id: 'm1' } }),
    base('message.edited', { message: { id: 'm1', author: AUTHOR }, partial: true }),
    base('voice.state', { member: AUTHOR, to: 'v1' }),
    base('reaction.added', { messageId: 'm1', emoji: { name: 'x' }, actor: AUTHOR }),
  ]) {
    const first = normalizeEvent(sample).event;
    assert.deepEqual(normalizeEvent(first).event, first);
  }
});

test('validateEvent answers ok or a reason and never throws', () => {
  assert.deepEqual(validateEvent(created()), { ok: true });
  assert.deepEqual(validateEvent('nope'), { ok: false, reason: 'event:required' });
  for (const junk of [undefined, 5, [], () => {}, { origin: 5 }]) assert.equal(validateEvent(junk).ok, false);
});

test('eventId is deterministic and refuses unusable parts', () => {
  assert.equal(eventId('discord', 'message.created', 'm1'), 'discord:message.created:m1');
  assert.equal(eventId('discord', 'message.created', 'm1'), eventId('discord', 'message.created', ' m1 '));
  assert.equal(eventId('discord', 'message.edited', 'm1', 1700), 'discord:message.edited:m1:1700');
  assert.notEqual(eventId('a', 'message.created', 'm1'), eventId('b', 'message.created', 'm1'));
  assert.equal(eventId('', 'message.created', 'm1'), null);
  assert.equal(eventId('d', 'message.sent', 'm1'), null);
  assert.equal(eventId('d', 'message.created'), null);
  assert.equal(eventId('d', 'message.created', ''), null);
  assert.equal(eventId('d', 'message.created', NaN), null);
});

test('createDedupe recognises redeliveries and forgets the oldest past its capacity', () => {
  const dedupe = createDedupe({ capacity: 2 });
  assert.equal(dedupe.seen('a'), false);
  assert.equal(dedupe.seen('a'), true);
  assert.equal(dedupe.seen('b'), false);
  assert.equal(dedupe.seen('c'), false);
  assert.equal(dedupe.size(), 2);
  assert.equal(dedupe.seen('a'), false);
  assert.equal(createDedupe({ capacity: -1 }).seen('x'), false);
});

test('envelope: an event envelope round-trips', () => {
  const event = normalizeEvent(created()).event;
  const envelope = eventEnvelope(event);
  assert.deepEqual(envelope, { v: 1, id: event.id, type: 'event', replyTo: null, body: { event } });
  assert.deepEqual(normalizeEnvelope(envelope), { ok: true, envelope });
  assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(envelope))), { ok: true });
});

test('envelope: a bad inner event is named under the body', () => {
  const bad = { v: 1, id: 'e1', type: 'event', body: { event: { ...created(), at: 'x' } } };
  assert.equal(normalizeEnvelope(bad).reason, 'body.event.at:type');
  assert.equal(normalizeEnvelope({ v: 1, id: 'e1', type: 'event', body: {} }).reason, 'body.event.event:required');
});

test('envelope: version, type, id and replyTo are checked', () => {
  const ping = { v: 1, id: 'p1', type: 'ping', body: {} };
  assert.equal(normalizeEnvelope({ ...ping, v: 2 }).reason, 'v:unsupported');
  assert.equal(normalizeEnvelope({ ...ping, v: undefined }).reason, 'v:unsupported');
  assert.equal(normalizeEnvelope({ ...ping, type: 'pong' }).reason, 'type:unknown');
  assert.equal(normalizeEnvelope({ ...ping, id: '' }).reason, 'id:required');
  assert.equal(normalizeEnvelope({ ...ping, replyTo: 4 }).reason, 'replyTo:type');
  assert.equal(normalizeEnvelope({ ...ping, body: 'x' }).reason, 'body:type');
  assert.equal(normalizeEnvelope(7).reason, 'envelope:required');
  assert.deepEqual(normalizeEnvelope(ping).envelope, { v: 1, id: 'p1', type: 'ping', replyTo: null, body: {} });
});

test('envelope: ack and action_result must name what they answer', () => {
  assert.equal(normalizeEnvelope({ v: 1, id: 'a1', type: 'ack', body: {} }).reason, 'replyTo:required');
  assert.equal(normalizeEnvelope({ v: 1, id: 'r1', type: 'action_result', body: { result: { status: 'ok' } } }).reason, 'replyTo:required');
  const ack = normalizeEnvelope({ v: 1, id: 'a1', type: 'ack', replyTo: ' e1 ', body: { junk: 1 } });
  assert.deepEqual(ack.envelope, { v: 1, id: 'a1', type: 'ack', replyTo: 'e1', body: {} });
});

test('envelope: hello, action and action_result bodies', () => {
  const hello = normalizeEnvelope({ v: 1, id: 'h1', type: 'hello', body: { iface: 'fake', capabilities: ['send'], token: 'x' } });
  assert.deepEqual(hello.envelope.body, { iface: 'fake', capabilities: ['send'] });
  assert.equal(normalizeEnvelope({ v: 1, id: 'h1', type: 'hello', body: {} }).reason, 'body.iface:required');
  assert.equal(normalizeEnvelope({ v: 1, id: 'h1', type: 'hello', body: { iface: 'f', capabilities: [1] } }).reason, 'body.capabilities:type');
  assert.equal(normalizeEnvelope({ v: 1, id: 'x1', type: 'action', body: { action: { action: 'send', text: 'hi' } } }).ok, true);
  assert.equal(normalizeEnvelope({ v: 1, id: 'x1', type: 'action', body: { action: {} } }).reason, 'body.action.action:required');
  assert.equal(normalizeEnvelope({ v: 1, id: 'x1', type: 'action', body: { action: { action: 'send', f() {} } } }).reason, 'body.action:type');
  assert.equal(normalizeEnvelope({ v: 1, id: 'r1', type: 'action_result', replyTo: 'x1', body: { result: { status: 'ok' } } }).ok, true);
  assert.equal(normalizeEnvelope({ v: 1, id: 'r1', type: 'action_result', replyTo: 'x1', body: { result: {} } }).reason, 'body.result.status:required');
});

test('envelope: ping may carry a time; a bad one is refused', () => {
  assert.equal(normalizeEnvelope({ v: 1, id: 'p1', type: 'ping', body: { at: 5 } }).envelope.body.at, 5);
  assert.equal(normalizeEnvelope({ v: 1, id: 'p1', type: 'ping', body: { at: 'x' } }).reason, 'body.at:type');
});

test('ackFor is deterministic, so a repeated ack is the same ack', () => {
  const ack = ackFor({ id: 'e1' });
  assert.deepEqual(ack, { v: 1, id: 'ack:e1', type: 'ack', replyTo: 'e1', body: {} });
  assert.deepEqual(ackFor({ id: 'e1' }), ack);
  assert.equal(validateEnvelope(ack).ok, true);
});

test('the module imports nothing', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/interface/events.js', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/[^\x00-\x7f]/.test(source), false);
});
