import { test } from 'node:test';
import assert from 'node:assert/strict';

import { opensPrivate } from '../src/memory/open-private.ts';

test('opens her private memory when context.memory.openPrivate is true', () => {
  assert.equal(opensPrivate({ context: { memory: { openPrivate: true } } }), true);
});

test('keeps her private memory split when context.memory.openPrivate is anything but true', () => {
  // Bug: a truthy string from a hand-edited config opens every direct chat to every place.
  for (const value of ['true', 1, false, undefined])
    assert.equal(opensPrivate({ context: { memory: { openPrivate: value } } }), false);
  assert.equal(opensPrivate({}), false);
});
