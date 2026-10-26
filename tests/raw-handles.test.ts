// Tests for the handles of a message event (src/behavior/raw-handles.ts): where the pipeline finds the platform
// objects of an event that carries them and what it gets for one that does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRawOf, handlesOf } from '../src/behavior/raw-handles.ts';

test('defaultRawOf gives the message and the previous message of an event that carries both', () => {
  const raw = { id: 'new' };
  const rawPrevious = { id: 'old' };
  const handles = defaultRawOf({ raw, rawPrevious });
  assert.equal(handles?.message, raw);
  assert.equal(handles?.previous, rawPrevious);
});

test('defaultRawOf gives a null previous message when the event has no rawPrevious', () => {
  const raw = { id: 'new' };
  assert.deepEqual(defaultRawOf({ raw }), { message: raw, previous: null });
});

test('defaultRawOf gives null for an event without raw', () => {
  assert.equal(defaultRawOf({}), null);
});

test('handlesOf gives an undefined message and a null previous when rawOf knows nothing of the event', () => {
  const handles = handlesOf(() => null, { id: 'e1' });
  assert.equal(handles.message, undefined);
  assert.equal(handles.previous, null);
});

test('handlesOf returns what rawOf knows for the event', () => {
  const known = { message: { id: 'm' }, previous: null };
  assert.equal(
    handlesOf((event) => (event.id === 'e1' ? known : null), { id: 'e1' }),
    known
  );
});

test('handlesOf does not call rawOf for a missing event', () => {
  const asked: Array<string> = [];
  const rawOf = (event: { id: string }): null => {
    asked.push(event.id);
    return null;
  };
  assert.equal(handlesOf(rawOf, null).message, undefined);
  assert.equal(handlesOf(rawOf, undefined).message, undefined);
  assert.deepEqual(asked, []);
});
