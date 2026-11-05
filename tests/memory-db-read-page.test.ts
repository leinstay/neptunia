// src/memory/db/read-page.ts: the paging every owner read of memory shares. A cursor is bound to what it pages and a bad one
// is refused, because a reader that starts over on a bad cursor leaves a script reading its first page forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimit, contextBinding, cursorOf, keysetPage, positionOf } from '../src/memory/db/read-page.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { wrongly } from './fixtures/loose-types.ts';

const BAD_CURSOR = { code: 'INSPECTION_BAD_CURSOR' };

test('a cursor gives its position back under its own binding', () => {
  const binding = { reader: 'x', filters: ['a'] };
  assert.deepEqual(positionOf(cursorOf(binding, ['p', 1]), binding), ['p', 1]);
});

test('no cursor is the first page', () => {
  assert.equal(positionOf(null, { reader: 'x' }), null);
});

test('a cursor under another binding is refused', () => {
  // Bug: a cursor minted over one filter pages through rows the listing never described.
  const cursor = cursorOf({ reader: 'x', filters: ['a'] }, 'p');
  assert.throws(() => positionOf(cursor, { reader: 'x', filters: ['b'] }), BAD_CURSOR);
});

for (const cursor of [
  'garbage',
  '',
  Buffer.from('[1]').toString('base64url'),
  Buffer.from('null').toString('base64url'),
]) {
  test(`the cursor ${JSON.stringify(cursor)} is refused and never starts over`, () => {
    assert.throws(() => positionOf(cursor, { reader: 'x' }), BAD_CURSOR);
  });
}

for (const limit of [0, -1, 1.5, Number.NaN, '5']) {
  test(`a limit of ${String(limit)} is refused`, () => {
    assert.throws(() => checkLimit(limit), { code: 'INSPECTION_BAD_LIMIT' });
  });
}

test('a context binds a cursor, and a call with no valid context is refused', () => {
  // Bug: `context?.internal !== false` reads a missing context as the owner.
  const owner = cursorOf(contextBinding(internalContext()), 'p');
  assert.throws(() => positionOf(owner, contextBinding(groupContext('zeta'))), BAD_CURSOR);
  assert.throws(() => contextBinding(wrongly<Context>({})));
});

test('a page read one past its limit says what it left out, and the last page ends', () => {
  const binding = { reader: 'x' };
  const part = keysetPage(['a', 'b', 'c'], 2, 3, binding, (item) => item);
  assert.deepEqual([part.items, part.truncated, part.reason, part.total], [['a', 'b'], true, 'page', 3]);
  assert.equal(positionOf(part.next, binding), 'b');
  const end = keysetPage(['c'], 2, 3, binding, (item) => item);
  assert.deepEqual([end.next, end.truncated, end.reason], [null, false, null]);
});
