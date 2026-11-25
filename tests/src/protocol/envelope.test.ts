// Tests for src/protocol/envelope.ts, through src/protocol/index.ts: the frame of every message on the link, the hello
// with its self and its roots, and the refusal of a bad envelope with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_TYPES, ackOf, envelope, validateEnvelope } from '../../../src/protocol/index.ts';

const chat = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'γενικά', topic: null, category: null };
const ref = { iface: 'fake', chatId: 'c1' };
const messageRef = { iface: 'fake', chatId: 'c1', messageId: 'm1' };

// One event and one action of the validator's sample tables, which the envelopes below carry.
const EVENTS = {
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
};

const ACTION_SAMPLES = {
  'message.send': {
    action: 'message.send',
    chat: ref,
    content: { text: 'γεια', replyTo: messageRef },
  },
};

// A hello names who the persona is on the interface and the root it serves.
const HELLO_BODY = {
  iface: 'discord',
  self: { id: 'bot1', name: 'Νέπτυν' },
  root: { id: 'g1', name: 'Alpha' },
};

test('envelope: a hello without self is refused', () => {
  const body = { ...HELLO_BODY, self: undefined };
  const verdict = validateEnvelope(envelope('hello', body, { id: 'h1' }));
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /self/);
});

test('envelope: a hello whose self has no id or no name is refused', () => {
  for (const self of [{ name: 'Νέπτυν' }, { id: 'bot1' }, { id: '', name: 'x' }, 'bot1', null]) {
    const verdict = validateEnvelope(envelope('hello', { ...HELLO_BODY, self }, { id: 'h1' }));
    assert.equal(verdict.ok, false, JSON.stringify(self));
    assert.match(String(verdict.reason), /self/);
  }
});

test('envelope: a hello for an interface with no root carries null and is valid', () => {
  assert.deepEqual(validateEnvelope(envelope('hello', { ...HELLO_BODY, root: null }, { id: 'h1' })), {
    ok: true,
  });
});

test('envelope: a hello whose root is not an id and a name is refused', () => {
  for (const root of [{ name: 'Alpha' }, { id: '', name: 'Alpha' }, 'g1']) {
    const verdict = validateEnvelope(envelope('hello', { ...HELLO_BODY, root }, { id: 'h1' }));
    assert.equal(verdict.ok, false, JSON.stringify(root));
    assert.match(String(verdict.reason), /root/);
  }
});

test('envelope: every type validates in its documented body, and a bad one is refused with a reason', () => {
  // The list holds `cancel`, the envelope that names an action to cancel, and no envelope of a tool.
  assert.deepEqual([...ENVELOPE_TYPES], ['hello', 'event', 'ack', 'action', 'action_result', 'ping', 'cancel']);
  const event = EVENTS['reaction.changed'];
  const valid = [
    envelope('hello', { ...HELLO_BODY, capabilities: ['message.send'], resume: null }, { id: 'h1' }),
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
  const cases: Array<[unknown, string]> = [
    [null, 'envelope:type'],
    [{ ...valid[0], v: 2 }, 'v:unsupported'],
    [{ ...valid[0], id: '' }, 'id:type'],
    [{ ...valid[0], type: 'event2' }, 'type:unknown'],
    [{ ...valid[0], replyTo: 3 }, 'replyTo:type'],
    [{ ...valid[2], replyTo: null }, 'replyTo:required'],
    [{ ...valid[0], body: null }, 'body:type'],
    [{ ...valid[0], body: { iface: '' } }, 'body.iface:type'],
    [{ ...valid[1], body: { ...event, accountId: '' } }, 'body.accountId:type'],
    [{ ...valid[2], body: { status: 'maybe' } }, 'body.status:unknown'],
    [{ ...valid[3], body: { action: 'message.nuke' } }, 'body.action:unknown'],
    [{ ...valid[4], body: {} }, 'body.status:type'],
    [{ ...valid[5], body: { at: 'now' } }, 'body.at:type'],
  ];
  for (const [value, reason] of cases) assert.deepEqual(validateEnvelope(value), { ok: false, reason }, reason);
});

// A root of a hello may carry the moment the bot joined it (`joinedAt`, optional, milliseconds since the epoch). A
// value of another type refuses the hello with the body's own reason, as a bad `root` or `roots` does.
test('envelope: a hello takes a joinedAt number on a root or none, and refuses any other joinedAt', () => {
  // Catches: a text or NaN stored as the day the persona joined, taken from a careless interface.
  const roots = [
    { id: 'g1', name: 'Alpha', joinedAt: 1790000000000 },
    { id: 'g2', name: 'Beta' },
  ];
  assert.deepEqual(validateEnvelope(envelope('hello', { ...HELLO_BODY, roots }, { id: 'h1' })), { ok: true });
  const root = { id: 'g1', name: 'Alpha', joinedAt: 1790000000000 };
  assert.deepEqual(validateEnvelope(envelope('hello', { ...HELLO_BODY, root }, { id: 'h1' })), { ok: true });
  for (const joinedAt of ['2026-10-03', null, Number.NaN]) {
    const bad = { id: 'g1', name: 'Alpha', joinedAt };
    const one = validateEnvelope(envelope('hello', { ...HELLO_BODY, root: bad }, { id: 'h1' }));
    assert.deepEqual(one, { ok: false, reason: 'body.root:type' }, String(joinedAt));
    const many = validateEnvelope(envelope('hello', { ...HELLO_BODY, roots: [bad] }, { id: 'h1' }));
    assert.deepEqual(many, { ok: false, reason: 'body.roots:type' }, String(joinedAt));
  }
});
