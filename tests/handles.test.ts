// Tests for src/behavior/handles.ts: handles derived from the user id (stable, unique within a
// request, a profiled member never moved by one in view) and `@handle` -> `<@id>` in the persona's output. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLE_DIGITS, HANDLE_PREFIX, assignHandles, handleOf, resolveHandles } from '../src/behavior/handles.ts';
import { wrongly } from './fixtures/loose-types.ts';

// Two ids whose four-digit handles collide (found by search; see the derivation in handles.js).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

test('handleOf: the prefix and four base-36 digits, the same for the same id every time', () => {
  const handle = handleOf('123456789012345678');
  assert.match(handle, new RegExp(`^${HANDLE_PREFIX}[0-9a-z]{${HANDLE_DIGITS}}$`));
  assert.equal(handleOf('123456789012345678'), handle);
  assert.notEqual(handleOf('123456789012345679'), handle);
  assert.match(handleOf('123456789012345678', 6), /^u[0-9a-z]{6}$/);
});

test('assignHandles: one handle per id, unique, whatever the order the ids come in', () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(300000000000000000n + BigInt(i) * 104729n));
  const forward = assignHandles({ profiled: ids });
  const backward = assignHandles({ profiled: [...ids].reverse() });
  assert.equal(forward.size, ids.length);
  assert.equal(new Set(forward.values()).size, ids.length, 'no handle given twice');
  assert.deepEqual(
    [...ids].map((id) => backward.get(id)),
    [...ids].map((id) => forward.get(id))
  );
});

test('assignHandles: of two ids sharing a handle the older keeps it, the newer takes one more digit', () => {
  assert.equal(handleOf(OLDER), handleOf(NEWER), 'the fixture ids collide');
  const handles = assignHandles({ profiled: [NEWER, OLDER] });
  assert.equal(handles.get(OLDER), handleOf(OLDER));
  assert.equal(handles.get(NEWER), handleOf(NEWER, HANDLE_DIGITS + 1));
});

test("assignHandles: a member only in view never moves a profiled member's handle", () => {
  const handles = assignHandles({ profiled: [NEWER], inView: [OLDER, NEWER, '1'] });
  assert.equal(handles.get(NEWER), handleOf(NEWER), 'the profiled member keeps the short form');
  assert.equal(handles.get(OLDER), handleOf(OLDER, HANDLE_DIGITS + 1), 'the passer-by takes one more digit');
  assert.equal(handles.get('1'), handleOf('1'));
  assert.equal(handles.size, 3, 'a profiled id in view is placed once');
});

test('assignHandles: blank and missing ids are skipped', () => {
  assert.deepEqual([...assignHandles({ profiled: wrongly(['', null, undefined]), inView: [] }).keys()], []);
  assert.equal(assignHandles().size, 0);
});

test('resolveHandles: an exact @handle becomes a mention; names and look-alikes stay text', () => {
  const ids = new Map([
    ['uaaaa', '111111111111111111'],
    ['ubbbb', '222222222222222222'],
  ]);
  const result = resolveHandles('@uaaaa γεια, @ubbbb! @uaaaa @Ana mail@uaaaa @uaaaab @uaaaaά', ids);
  assert.equal(
    result.text,
    '<@111111111111111111> γεια, <@222222222222222222>! <@111111111111111111> @Ana mail@uaaaa @uaaaab @uaaaaά'
  );
  assert.deepEqual(result.accountIds, ['111111111111111111', '222222222222222222']);
  assert.equal(result.unknown, 1, 'only @uaaaab is a handle nobody has');
});

test('resolveHandles: a handle inside a URL is part of the address; @everyone is never a handle', () => {
  const ids = new Map([['uaaaa', '111111111111111111']]);
  const result = resolveHandles('https://example.com/@uaaaa @everyone @here @uaaaa', ids);
  assert.equal(result.text, 'https://example.com/@uaaaa @everyone @here <@111111111111111111>');
  assert.deepEqual(result.accountIds, ['111111111111111111']);
  assert.equal(result.unknown, 0);
});

test('resolveHandles: no map resolves nothing', () => {
  assert.deepEqual(resolveHandles('@uaaaa', wrongly(null)), { text: '@uaaaa', accountIds: [], unknown: 1 });
});
