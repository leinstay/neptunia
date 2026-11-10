// Tests for the helpers of src/memory/db/live-iface.ts: which interface a context, a row or a write names, and the
// interface a live option reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveIface, namedIface, withLiveIface } from '../src/memory/db/live-iface.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

test('names the interface a source carries and nothing for one that carries none', () => {
  assert.equal(namedIface({ iface: 'fake' }), 'fake');
  assert.equal(namedIface({ iface: '' }), null);
  assert.equal(namedIface({ iface: 7 }), null);
  assert.equal(namedIface(null), null);
});

test('reads the interface from another key of a row', () => {
  assert.equal(namedIface({ scope_iface: 'cli' }, 'scope_iface'), 'cli');
  assert.equal(namedIface({ scope_iface: null }, 'scope_iface'), null);
});

test('reports the interface a live option answers, null for anything else', () => {
  assert.equal(
    liveIface(() => 'discord'),
    'discord'
  );
  assert.equal(
    liveIface(() => null),
    null
  );
  assert.equal(liveIface('discord'), null);
  assert.equal(liveIface(undefined), null);
});

test('stamps the live interface on a unit write that names none and keeps one that does', () => {
  assert.deepEqual(
    withLiveIface({ op: 'lines' }, () => 'fake'),
    { op: 'lines', iface: 'fake' }
  );
  assert.deepEqual(
    withLiveIface({ op: 'lines', iface: 'cli' }, () => 'fake'),
    { op: 'lines', iface: 'cli' }
  );
  assert.deepEqual(
    withLiveIface({ op: 'lines' }, () => null),
    { op: 'lines' }
  );
});

test('a write that names no interface keeps its row from every group', () => {
  // Bug: such a write was filed under the Discord namespace of the legacy files, so its row was shown to Discord's groups.
  const handle = freshMemoryDb();
  try {
    applyMemoryWrite(handle, { kind: 'gif-vector', itemId: 'item-1', model: null, vector: [0.6, 0.8] });
    const row = dbOf(handle).prepare("SELECT audience_id FROM vectors WHERE chunk_key = 'gif:item-1'").get();
    assert.equal(row?.audience_id, 'aud:internal');
  } finally {
    handle.close();
  }
});
