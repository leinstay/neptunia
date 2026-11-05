// src/conversation/sessions.ts: durable conversation sessions over stored source lines. A session is a view with a
// lineage. The store fake holds the lines and session rows; its lines are never written by the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationSessions } from '../src/conversation/sessions.ts';
import type { ConversationStore, SessionRow, SourceLine } from '../src/conversation/sessions.ts';

const LINES: ReadonlyArray<SourceLine> = [
  { id: 's1', placeId: 'cli:dm:owner', at: 10, who: 'owner', text: 'First   question\nwith a second line' },
  { id: 's2', placeId: 'cli:dm:owner', at: 20, who: 'her', text: 'First answer' },
  { id: 's3', placeId: 'cli:dm:owner', at: 30, who: 'owner', text: 'Second question' },
  { id: 's4', placeId: 'cli:dm:owner', at: 40, who: 'her', text: 'Second answer' },
];

function storeOf(lines: ReadonlyArray<SourceLine> = LINES) {
  const rows: Array<SessionRow> = [];
  const store: ConversationStore = {
    lines: (placeId) => lines.filter((line) => line.placeId === placeId),
    sessions: () => rows,
    saveSession: (row) => void rows.push(row),
  };
  return { store, rows };
}

function serviceOver(store: ConversationStore) {
  let serial = 0;
  return createConversationSessions({
    store,
    now: () => 5000,
    newId: () => `id${(serial += 1)}-${store.sessions().length}`,
  });
}

const ok = <T extends { ok: boolean }>(answer: T): Extract<T, { ok: true }> => {
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer as Extract<T, { ok: true }>;
};

test('a session is listed with a name taken from the first owner line, the same every time, and no model involved', () => {
  // Bug: a helper model names sessions, or the name changes between two reads.
  const { store } = storeOf();
  const service = serviceOver(store);
  ok(service.open({ placeId: 'cli:dm:owner' }));
  const [first] = service.list();
  assert.ok(first?.name.startsWith('First question'));
  assert.equal(first?.name.includes('\n'), false);
  assert.deepEqual(service.list(), service.list());
});

test('an empty place gets a session with a fixed preview, and no place lists nothing', () => {
  // Bug: a session with no lines throws where it takes the first line.
  const { store } = storeOf();
  const service = serviceOver(store);
  assert.deepEqual(service.list(), []);
  ok(service.open({ placeId: 'cli:dm:empty' }));
  assert.equal(service.list().length, 1);
});

test('after a restart a resumed session reads its stored lines by their original source ids', () => {
  // Bug: resume copies the conversation into new rows, and provenance points at the copy.
  const { store } = storeOf();
  const opened = ok(serviceOver(store).open({ placeId: 'cli:dm:owner' }));
  const again = serviceOver(store);
  const resumed = ok(again.resume(opened.session.id));
  assert.deepEqual(
    resumed.lines.map((line) => line.id),
    ['s1', 's2', 's3', 's4']
  );
  assert.equal(resumed.session.id, opened.session.id);
});

test('resuming an unknown session is refused with nothing written', () => {
  // Bug: a typo opens a fresh empty session the owner takes for the old one.
  const { store, rows } = storeOf();
  const service = serviceOver(store);
  const answer = service.resume('unknown');
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.code, 'unknown-session');
  assert.deepEqual(rows, []);
});

test('a branch at a boundary shows the lines up to it, keeps the lineage, and leaves the sources untouched', () => {
  // Bug: a branch deletes the later lines, or forgets where it came from.
  const { store } = storeOf();
  const service = serviceOver(store);
  const root = ok(service.open({ placeId: 'cli:dm:owner' }));
  const branch = ok(
    service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k1', authority: root.authority })
  );
  assert.equal(branch.session.parentId, root.session.id);
  assert.equal(branch.session.boundarySourceId, 's2');
  assert.deepEqual(
    ok(service.inspect(branch.session.id, branch.authority)).lines.map((line) => line.id),
    ['s1', 's2']
  );
  assert.deepEqual(
    ok(service.inspect(root.session.id, root.authority)).lines.map((line) => line.id),
    ['s1', 's2', 's3', 's4']
  );
  assert.deepEqual(store.lines('cli:dm:owner'), LINES);
});

test('a branch states that memory stays continuous', () => {
  // Bug: the picker promises a branch that forgets what she learned after the boundary.
  const { store } = storeOf();
  const service = serviceOver(store);
  const root = ok(service.open({ placeId: 'cli:dm:owner' }));
  const branch = ok(
    service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k1', authority: root.authority })
  );
  assert.equal(branch.memory, 'continuous');
});

test('a boundary that is not in the lineage is refused', () => {
  // Bug: a missing boundary silently branches the whole conversation.
  const { store, rows } = storeOf();
  const service = serviceOver(store);
  const root = ok(service.open({ placeId: 'cli:dm:owner' }));
  const before = rows.length;
  const answer = service.branch({
    from: root.session.id,
    boundary: 'missing',
    requestKey: 'k1',
    authority: root.authority,
  });
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.code, 'unknown-boundary');
  assert.equal(rows.length, before);
});

test('a branch of a branch cannot reach past its parent boundary', () => {
  // Bug: a child session's branch selects a line its parent does not show.
  const { store } = storeOf();
  const service = serviceOver(store);
  const root = ok(service.open({ placeId: 'cli:dm:owner' }));
  const child = ok(
    service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k1', authority: root.authority })
  );
  const answer = service.branch({
    from: child.session.id,
    boundary: 's4',
    requestKey: 'k2',
    authority: child.authority,
  });
  assert.equal(answer.ok, false);
});

test('a repeated branch request gives the same session', () => {
  // Bug: a double Enter or a reconnect creates two identical branches.
  const { store, rows } = storeOf();
  const service = serviceOver(store);
  const root = ok(service.open({ placeId: 'cli:dm:owner' }));
  const one = ok(
    service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k1', authority: root.authority })
  );
  const count = rows.length;
  const two = ok(
    service.branch({ from: root.session.id, boundary: 's2', requestKey: 'k1', authority: root.authority })
  );
  assert.equal(two.session.id, one.session.id);
  assert.equal(rows.length, count);
});

test('the authority of one session opens no other session', () => {
  // Bug: any issued token reads every conversation.
  const { store } = storeOf([...LINES, { id: 'x1', placeId: 'other:dm:p', at: 1, who: 'owner', text: 'Elsewhere' }]);
  const service = serviceOver(store);
  const one = ok(service.open({ placeId: 'cli:dm:owner' }));
  const two = ok(service.open({ placeId: 'other:dm:p' }));
  const read = service.inspect(two.session.id, one.authority);
  assert.equal(read.ok, false);
  assert.equal(!read.ok && read.code, 'forbidden');
  const branched = service.branch({
    from: two.session.id,
    boundary: 'x1',
    requestKey: 'k',
    authority: one.authority,
  });
  assert.equal(branched.ok, false);
});
