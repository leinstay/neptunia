// Tests for src/memory/store.js#updateBuffered: a late embed folded over the
// buffered copy of a message (src/behavior/pipeline.js#onMessageUpdate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { tempDir } from './fixtures/tmp.js';

function tmpDataDir() {
  return tempDir('nep-store-buffer-');
}

function readBufferFile(dir, guildId) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'buffer.json'), 'utf8'));
}

test('updateBuffered: replaces the buffered message by id and marks dirty', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.pushBuffer('g1', { id: 'm1', content: 'first', links: [] }, 10);
  store.pushBuffer('g1', { id: 'm2', content: 'https://example.test/x', links: [] }, 10);
  store.pushBuffer('g1', { id: 'm3', content: 'third', links: [] }, 10);
  store.flush();

  const fresh = { id: 'm2', content: '', links: [{ kind: 'gif', name: 'Tenor', id: 'm2#e0', durationSec: null }] };
  assert.equal(store.updateBuffered('g1', fresh), true);
  assert.deepEqual(store.getBuffer('g1').map((m) => m.id), ['m1', 'm2', 'm3'], 'order and length kept');
  assert.deepEqual(store.getBuffer('g1')[1], fresh);

  store.flush();
  assert.deepEqual(readBufferFile(dir, 'g1')[1], fresh, 'the flush wrote the change: the file was dirty');
});

test('updateBuffered: false for an unknown id', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.pushBuffer('g1', { id: 'm1', content: 'first', links: [] }, 10);
  store.flush();

  assert.equal(store.updateBuffered('g1', { id: 'gone', content: 'x', links: [] }), false);
  assert.deepEqual(store.getBuffer('g1'), [{ id: 'm1', content: 'first', links: [] }]);
  assert.equal(store.updateBuffered('g1', { content: 'no id' }), false, 'a message without an id matches nothing');
});
