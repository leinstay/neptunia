// Tests for src/interface/door.js: the one event door -- validation at the boundary, idempotent
// ids (at-least-once delivery), failed handlers retried by redelivery, derived ids of the core's
// own events, the bounded memory of ids, and the envelope form answered by acks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor, eventIdOf } from '../src/interface/door.js';
import { envelope } from '../src/protocol.js';

const quiet = () => {
  const lines = [];
  return { lines, info: (...a) => lines.push(['info', ...a]), warn: (...a) => lines.push(['warn', ...a]) };
};

const reaction = (id = 'fake:reaction:1') => ({
  kind: 'reaction.changed', iface: 'fake', at: 1, id, conversation: { id: 'c1', kind: 'channel' },
  messageId: 'm1', emoji: { name: '\u{1F389}' }, userId: 'u1', added: true,
});

test('door: an event reaches the handler of its kind once; the same id again is a duplicate', async () => {
  const got = [];
  const door = createEventDoor({ handlers: { 'reaction.changed': (event) => { got.push(event.id); return 'done'; } }, log: quiet() });
  assert.deepEqual(await door.submit(reaction()), { status: 'ok', id: 'fake:reaction:1', result: 'done' });
  assert.deepEqual(await door.submit(reaction()), { status: 'duplicate', id: 'fake:reaction:1' });
  assert.deepEqual(await door.submit(reaction('fake:reaction:2')), { status: 'ok', id: 'fake:reaction:2', result: 'done' });
  assert.deepEqual(got, ['fake:reaction:1', 'fake:reaction:2']);
});

test('door: a malformed event is invalid, logged by kind and reason only, and never handled', async () => {
  const log = quiet();
  let called = 0;
  const door = createEventDoor({ handlers: { 'reaction.changed': () => { called += 1; } }, log });
  const bad = { ...reaction(), userId: 7, secret: 'private words' };
  assert.deepEqual(await door.submit(bad), { status: 'invalid', id: null, reason: 'userId:type' });
  assert.deepEqual(await door.submit(null), { status: 'invalid', id: null, reason: 'event:type' });
  assert.equal(called, 0);
  assert.deepEqual(log.lines[0], ['warn', 'interface: invalid event', { kind: 'reaction.changed', reason: 'userId:type' }]);
  assert.equal(JSON.stringify(log.lines).includes('private words'), false);
});

test('door: a kind without a handler is unhandled and not remembered', async () => {
  const door = createEventDoor({ handlers: {}, log: quiet() });
  assert.deepEqual(await door.submit(reaction()), { status: 'unhandled', id: 'fake:reaction:1' });
  assert.equal(door.seen('fake:reaction:1'), false);
});

test('door: a handler that throws is failed and not remembered, so a redelivery runs it again', async () => {
  let calls = 0;
  const door = createEventDoor({
    handlers: { 'reaction.changed': () => { calls += 1; if (calls === 1) throw new Error('boom'); return calls; } },
    log: quiet(),
  });
  assert.deepEqual(await door.submit(reaction()), { status: 'failed', id: 'fake:reaction:1', reason: 'handler-threw' });
  assert.deepEqual(await door.submit(reaction()), { status: 'ok', id: 'fake:reaction:1', result: 2 });
  assert.equal((await door.submit(reaction())).status, 'duplicate');
});

test('door: the same id while its handler still runs is a duplicate', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const door = createEventDoor({ handlers: { 'reaction.changed': async () => { calls += 1; await gate; } }, log: quiet() });
  const first = door.submit(reaction());
  assert.equal((await door.submit(reaction())).status, 'duplicate');
  release();
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
});

test('door: the core\'s own events get derived ids: an errand end by task and status, a tick by time', async () => {
  const seen = [];
  const door = createEventDoor({ handlers: { 'task.completed': (e) => seen.push(e.taskId), 'scheduler.tick': () => seen.push('tick') }, log: quiet() });
  const done = { kind: 'task.completed', at: 5, taskId: 't1', status: 'done', guildId: 'g1' };
  assert.equal(eventIdOf(done), 'task.completed:t1:done');
  assert.equal((await door.submit(done)).status, 'ok');
  assert.equal((await door.submit({ ...done, at: 9 })).status, 'duplicate', 'the same end delivered twice');
  assert.equal((await door.submit({ ...done, status: 'failed' })).status, 'ok', 'another end of the same task');
  assert.equal(eventIdOf({ kind: 'scheduler.tick', at: 7 }), 'scheduler.tick:7');
  assert.equal((await door.submit({ kind: 'scheduler.tick', at: 7 })).status, 'ok');
  assert.equal(eventIdOf({ kind: 'reaction.changed' }), null);
  assert.deepEqual(seen, ['t1', 't1', 'tick']);
});

test('door: only the newest `capacity` ids are remembered', async () => {
  const door = createEventDoor({ handlers: { 'reaction.changed': () => {} }, capacity: 2, log: quiet() });
  for (const id of ['a', 'b', 'c']) await door.submit(reaction(id));
  assert.equal(door.seen('a'), false);
  assert.equal(door.seen('b'), true);
  assert.equal(door.seen('c'), true);
  assert.equal((await door.submit(reaction('a'))).status, 'ok', 'an id past the memory is handled again');
});

test('door: envelopes -- hello and ping are acked, an event envelope is acked by its outcome, the rest is invalid', async () => {
  const door = createEventDoor({ handlers: { 'reaction.changed': () => {} }, log: quiet() });
  const ack = (replyTo, status, reason) => ({ v: 1, id: `ack:${replyTo}`, type: 'ack', replyTo, body: reason ? { status, reason } : { status } });
  assert.deepEqual(await door.receive(envelope('hello', { iface: 'fake' }, { id: 'h1' })), ack('h1', 'ok'));
  assert.deepEqual(await door.receive(envelope('ping', {}, { id: 'p1' })), ack('p1', 'ok'));
  const event = reaction();
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'ok'));
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'duplicate'));
  assert.deepEqual(await door.receive(envelope('action', { action: 'conversation.typing', conversation: { iface: 'fake', conversationId: 'c1' } }, { id: 'x1' })), ack('x1', 'invalid', 'type:not-inbound'));
  assert.deepEqual(await door.receive(envelope('event', { ...event, userId: '' }, { id: 'e2' })), ack('e2', 'invalid', 'body.userId:type'));
  assert.deepEqual(await door.receive({ id: 'z', type: 'nope' }), ack('z', 'invalid', 'v:unsupported'));
  assert.deepEqual(await door.receive(null), ack('unknown', 'invalid', 'envelope:type'));
});
