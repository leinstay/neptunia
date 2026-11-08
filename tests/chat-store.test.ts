// src/chat/store.ts with the real service: the file a session lives in, across a restart, with no memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createChatSessions } from '../src/chat/sessions.ts';
import type { SourceLine } from '../src/chat/sessions.ts';
import { createChatStore } from '../src/chat/store.ts';
import { tempDir } from './fixtures/tmp.ts';

const LINES: Array<SourceLine> = [
  { id: 's1', placeId: 'p', at: 10, who: 'owner', text: 'one' },
  { id: 's2', placeId: 'p', at: 20, who: 'her', text: 'two' },
  { id: 's3', placeId: 'p', at: 30, who: 'owner', text: 'three' },
];

function rig(file: string, lines: Array<SourceLine> = LINES, clock = { at: 100 }) {
  let serial = 0;
  return createChatSessions({
    store: createChatStore({ file, readLines: (placeId) => lines.filter((one) => one.placeId === placeId) }),
    now: () => clock.at,
    newId: () => `id-${Date.now()}-${(serial += 1)}-${Math.random()}`,
  });
}

const open = (service: ReturnType<typeof rig>) => service.open({ placeId: 'p' });

test('a session and its branch survive a restart with their ids and lineage', () => {
  // Bug: the store keeps sessions in memory, and a restart loses the branch the owner was in.
  const file = path.join(tempDir('nep-sessions-'), 'cli', 'sessions.json');
  const first = rig(file);
  const root = open(first);
  const branch = first.branch({ from: root.session.id, boundary: 's1', requestKey: 'k', authority: root.authority });
  assert.ok(branch.ok);
  const again = rig(file);
  assert.equal(open(again).session.id, root.session.id, 'one root per place');
  const resumed = again.resume(branch.session.id);
  assert.ok(resumed.ok);
  assert.equal(resumed.session.parentId, root.session.id);
  assert.deepEqual(
    resumed.lines.map((line) => line.id),
    ['s1']
  );
});

test('saving a row twice replaces it', () => {
  // Bug: selecting a session appends a row each time, and the picker lists it twice.
  const file = path.join(tempDir('nep-sessions-'), 'sessions.json');
  const store = createChatStore({ file, readLines: () => [] });
  const row = {
    id: 'a',
    placeId: 'p',
    parentId: null,
    boundarySourceId: null,
    requestKey: null,
    authority: 't',
    createdAt: 1,
    spans: [],
  };
  store.saveSession(row);
  store.saveSession({ ...row, createdAt: 2 });
  assert.deepEqual(
    store.sessions().map((one) => one.createdAt),
    [2]
  );
});

test('a file that cannot be read throws, and is not written over', () => {
  // Bug: a damaged sessions file reads as empty, and the next save destroys it.
  const file = path.join(tempDir('nep-sessions-'), 'sessions.json');
  fs.writeFileSync(file, '{ not json');
  const store = createChatStore({ file, readLines: () => [] });
  assert.throws(() => store.sessions());
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('the file holds no line of the chat, only ids and times', () => {
  // Bug: a session copies what was said, and a second store of private lines grows beside memory.
  const file = path.join(tempDir('nep-sessions-'), 'sessions.json');
  const service = rig(file);
  const root = open(service);
  service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k', authority: root.authority });
  const stored = fs.readFileSync(file, 'utf8');
  assert.equal(stored.includes('three'), false);
  assert.equal(stored.includes('"two"'), false);
  assert.ok(stored.includes('s2'));
});

test('lines written while a branch is selected belong to it, and the root does not show them', () => {
  // Bug: a line said in a branch appears in the chat it branched from.
  const file = path.join(tempDir('nep-sessions-'), 'sessions.json');
  const clock = { at: 100 };
  const lines = [...LINES];
  const service = rig(file, lines, clock);
  const root = open(service);
  const branch = service.branch({ from: root.session.id, boundary: 's1', requestKey: 'k', authority: root.authority });
  assert.ok(branch.ok);
  service.select(branch.session.id);
  lines.push({ id: 's4', placeId: 'p', at: 150, who: 'owner', text: 'in the branch' });
  clock.at = 200;
  service.select(root.session.id);
  lines.push({ id: 's5', placeId: 'p', at: 250, who: 'owner', text: 'back at the root' });
  const inBranch = service.resume(branch.session.id);
  const inRoot = service.resume(root.session.id);
  assert.ok(inBranch.ok && inRoot.ok);
  assert.deepEqual(
    inBranch.lines.map((line) => line.id),
    ['s1', 's4']
  );
  assert.deepEqual(
    inRoot.lines.map((line) => line.id),
    ['s1', 's2', 's3', 's5']
  );
  assert.equal(service.current('p')?.id, root.session.id);
});
