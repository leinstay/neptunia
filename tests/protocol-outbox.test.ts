// Tests for an interface's outbox (src/protocol/outbox.ts): the events it has sent the core and the core has not yet
// acknowledged, kept in the interface's own data folder. `push` numbers each event with the next `seq` of the
// principal, `pending` lists the unacknowledged ones oldest first, and `ack(seq)` drops every event up to the core's
// watermark. A full outbox refuses the new event and evicts nothing. A second outbox opened on the same folder, as
// after the interface restarts, holds what the first one held and never hands out a `seq` again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../src/protocol/outbox.ts';
import { tempDir } from './fixtures/tmp.js';

const event = (id: string): Record<string, unknown> => ({ kind: 'reaction.changed', iface: 'fake', at: 1, id });
const idsOf = (entries: ReadonlyArray<{ seq: number; event: Record<string, unknown> }>): Array<string> =>
  entries.map((entry) => `${entry.seq}:${String(entry.event.id)}`);

test('numbers events from 1 and lists the unacknowledged ones oldest first', () => {
  const outbox = createOutbox({ dir: tempDir('nep-outbox-'), capacity: 10 });
  assert.equal(outbox.push(event('e1')), 1);
  assert.equal(outbox.push(event('e2')), 2);
  assert.deepEqual(idsOf(outbox.pending()), ['1:e1', '2:e2']);
});

test('an ack drops every event up to its watermark and keeps the later ones', () => {
  const outbox = createOutbox({ dir: tempDir('nep-outbox-'), capacity: 10 });
  for (const id of ['e1', 'e2', 'e3']) outbox.push(event(id));
  outbox.ack(2);
  assert.deepEqual(idsOf(outbox.pending()), ['3:e3']);
});

test('the unacknowledged events survive a reopen of the same folder', () => {
  const dir = tempDir('nep-outbox-');
  const first = createOutbox({ dir, capacity: 10 });
  for (const id of ['e1', 'e2']) first.push(event(id));
  first.ack(1);
  assert.deepEqual(idsOf(createOutbox({ dir, capacity: 10 }).pending()), ['2:e2']);
});

test('a reopened outbox goes on numbering after the last seq, even when everything was acknowledged', () => {
  const dir = tempDir('nep-outbox-');
  const first = createOutbox({ dir, capacity: 10 });
  for (const id of ['e1', 'e2']) first.push(event(id));
  first.ack(2);
  assert.equal(createOutbox({ dir, capacity: 10 }).push(event('e3')), 3);
});

test('a full outbox refuses the next event with null and evicts none of the waiting ones', () => {
  const outbox = createOutbox({ dir: tempDir('nep-outbox-'), capacity: 2 });
  outbox.push(event('e1'));
  outbox.push(event('e2'));
  assert.equal(outbox.push(event('e3')), null);
  assert.equal(outbox.full(), true);
  assert.deepEqual(idsOf(outbox.pending()), ['1:e1', '2:e2']);
});

test('a refused event takes no seq: the next one queued after an ack gets the following number', () => {
  const outbox = createOutbox({ dir: tempDir('nep-outbox-'), capacity: 1 });
  outbox.push(event('e1'));
  outbox.push(event('e2'));
  outbox.ack(1);
  assert.equal(outbox.push(event('e3')), 2);
});

test('an ack below the watermark already taken changes nothing', () => {
  const outbox = createOutbox({ dir: tempDir('nep-outbox-'), capacity: 10 });
  for (const id of ['e1', 'e2', 'e3']) outbox.push(event(id));
  outbox.ack(2);
  outbox.ack(1);
  assert.deepEqual(idsOf(outbox.pending()), ['3:e3']);
});
