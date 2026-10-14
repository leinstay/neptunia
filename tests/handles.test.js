// Tests for src/behavior/handles.js: handles derived from the user id (stable, unique within a
// request, a profiled member never moved by one in view), the people directory's entries and
// text, and `@handle` -> `<@id>` in the persona's output. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLE_DIGITS, HANDLE_PREFIX, assignHandles, directoryEntries, handleOf, renderDirectory, resolveHandles } from '../src/behavior/handles.js';

// Two ids whose four-digit handles collide (found by search; see the derivation in handles.js).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

const DIRECTORY_LABELS = {
  directory: {
    lead: 'DIRECTORY LEAD',
    line: '{handle} = {names}',
    lineAliases: '{handle} = {names} / {aliases}',
  },
};

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
  assert.deepEqual([...ids].map((id) => backward.get(id)), [...ids].map((id) => forward.get(id)));
});

test('assignHandles: of two ids sharing a handle the older keeps it, the newer takes one more digit', () => {
  assert.equal(handleOf(OLDER), handleOf(NEWER), 'the fixture ids collide');
  const handles = assignHandles({ profiled: [NEWER, OLDER] });
  assert.equal(handles.get(OLDER), handleOf(OLDER));
  assert.equal(handles.get(NEWER), handleOf(NEWER, HANDLE_DIGITS + 1));
});

test('assignHandles: a member only in view never moves a profiled member\'s handle', () => {
  const handles = assignHandles({ profiled: [NEWER], inView: [OLDER, NEWER, '1'] });
  assert.equal(handles.get(NEWER), handleOf(NEWER), 'the profiled member keeps the short form');
  assert.equal(handles.get(OLDER), handleOf(OLDER, HANDLE_DIGITS + 1), 'the passer-by takes one more digit');
  assert.equal(handles.get('1'), handleOf('1'));
  assert.equal(handles.size, 3, 'a profiled id in view is placed once');
});

test('assignHandles: blank and missing ids are skipped', () => {
  assert.deepEqual([...assignHandles({ profiled: ['', null, undefined], inView: [] }).keys()], []);
  assert.equal(assignHandles().size, 0);
});

test('directoryEntries: names and open aliases sorted, never the persona or a member with no name', () => {
  const profiles = [
    { id: '30', names: ['Zoé', 'Ana'], aliases: [{ name: 'Zo' }, { name: 'Ana' }, { name: 'Old', validTo: '2026-01-01' }] },
    { id: '10', names: ['Ἀλκμήνη'], aliases: [] },
    { id: '99', names: ['Self'], aliases: [] },
    { id: '40', names: [], aliases: [] },
    { id: '50', names: ['  Léo \n Martin '], aliases: [{ name: 'Léo' }] },
    null,
  ];
  assert.deepEqual(directoryEntries(profiles, { selfId: '99' }), [
    { id: '30', names: ['Ana', 'Zoé'], aliases: ['Zo'] },
    { id: '50', names: ['Léo Martin'], aliases: ['Léo'] },
    { id: '10', names: ['Ἀλκμήνη'], aliases: [] },
  ]);
});

test('directoryEntries: the stored order of names and aliases never changes the entries', () => {
  const one = directoryEntries([{ id: '1', names: ['Bea', 'Ada'], aliases: [{ name: 'y' }, { name: 'x' }] }]);
  const two = directoryEntries([{ id: '1', names: ['Ada', 'Bea'], aliases: [{ name: 'x' }, { name: 'y' }] }]);
  assert.deepEqual(one, two);
});

test('renderDirectory: the lead, then one line per member with the exact @handle and quoted names', () => {
  const entries = [
    { id: '1', names: ['Ana "the" Great'], aliases: ['Ani'] },
    { id: '2', names: ['Ἀλκμήνη'], aliases: [] },
    { id: '3', names: ['Nobody'], aliases: [] },
  ];
  const handles = new Map([
    ['1', 'uaaaa'],
    ['2', 'ubbbb'],
  ]);
  assert.equal(
    renderDirectory(entries, handles, DIRECTORY_LABELS),
    ['DIRECTORY LEAD', '@uaaaa = "Ana \\"the\\" Great" / "Ani"', '@ubbbb = "Ἀλκμήνη"'].join('\n'),
  );
});

test('renderDirectory: no line label or no line gives nothing; no aliases label falls back to the line', () => {
  const entries = [{ id: '1', names: ['Ana'], aliases: ['Ani'] }];
  const handles = new Map([['1', 'uaaaa']]);
  assert.equal(renderDirectory(entries, handles, {}), '');
  assert.equal(renderDirectory([], handles, DIRECTORY_LABELS), '');
  assert.equal(renderDirectory(entries, handles, { directory: { line: '{handle} {names}' } }), '@uaaaa "Ana"');
});

test('resolveHandles: an exact @handle becomes a mention; names and look-alikes stay text', () => {
  const ids = new Map([
    ['uaaaa', '111111111111111111'],
    ['ubbbb', '222222222222222222'],
  ]);
  const result = resolveHandles('@uaaaa γεια, @ubbbb! @uaaaa @Ana mail@uaaaa @uaaaab @uaaaaά', ids);
  assert.equal(result.text, '<@111111111111111111> γεια, <@222222222222222222>! <@111111111111111111> @Ana mail@uaaaa @uaaaab @uaaaaά');
  assert.deepEqual(result.userIds, ['111111111111111111', '222222222222222222']);
  assert.equal(result.unknown, 1, 'only @uaaaab is a handle nobody has');
});

test('resolveHandles: a handle inside a URL is part of the address; @everyone is never a handle', () => {
  const ids = new Map([['uaaaa', '111111111111111111']]);
  const result = resolveHandles('https://example.com/@uaaaa @everyone @here @uaaaa', ids);
  assert.equal(result.text, 'https://example.com/@uaaaa @everyone @here <@111111111111111111>');
  assert.deepEqual(result.userIds, ['111111111111111111']);
  assert.equal(result.unknown, 0);
});

test('resolveHandles: no map resolves nothing', () => {
  assert.deepEqual(resolveHandles('@uaaaa', null), { text: '@uaaaa', userIds: [], unknown: 1 });
});
