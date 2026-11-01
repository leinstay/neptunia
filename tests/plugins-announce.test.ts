// What the core tells her when a plugin's tools register (src/plugins/announce.ts): the tools not announced before,
// the wake that carries them, and the file that remembers what was announced so a reconnect raises none (spec test 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ABILITY_ADDED,
  abilityWake,
  fileAnnounceStore,
  forgetAbilities,
  newAbilities,
} from '../src/plugins/announce.ts';
import type { AnnounceStore } from '../src/plugins/announce.ts';
import { tempDir } from './fixtures/tmp.js';

const AT = Date.parse('2026-11-01T09:00:00Z');

function memoryStore(
  start: Record<string, Array<string>> = {}
): AnnounceStore & { value: Record<string, Array<string>> } {
  const held = { value: start };
  return {
    get value() {
      return held.value;
    },
    read: () => held.value,
    write: (next) => {
      held.value = next;
    },
  };
}

test('announces the tools a plugin registers the first time, sorted', () => {
  const store = memoryStore();
  assert.deepEqual(newAbilities({ plugin: 'echo', accepted: ['echo.say', 'echo.again'], store }), [
    'echo.again',
    'echo.say',
  ]);
});

test('announces nothing when the same tools register again, as a reconnect does', () => {
  const store = memoryStore();
  newAbilities({ plugin: 'echo', accepted: ['echo.say'], store });
  assert.equal(newAbilities({ plugin: 'echo', accepted: ['echo.say'], store }), null);
});

test('announces only the tool that is new when a plugin registers one more', () => {
  const store = memoryStore();
  newAbilities({ plugin: 'echo', accepted: ['echo.say'], store });
  assert.deepEqual(newAbilities({ plugin: 'echo', accepted: ['echo.say', 'echo.again'], store }), ['echo.again']);
});

test('announces nothing for a registration that accepted no tool', () => {
  assert.equal(newAbilities({ plugin: 'echo', accepted: [], store: memoryStore() }), null);
});

test('keeps the announcements of two plugins apart', () => {
  const store = memoryStore();
  newAbilities({ plugin: 'echo', accepted: ['echo.say'], store });
  assert.deepEqual(newAbilities({ plugin: 'other', accepted: ['other.say'], store }), ['other.say']);
});

test('announces again after a disable forgot the plugin, and leaves the other plugins as they were', () => {
  const store = memoryStore();
  newAbilities({ plugin: 'echo', accepted: ['echo.say'], store });
  newAbilities({ plugin: 'other', accepted: ['other.say'], store });
  forgetAbilities({ plugin: 'echo', store });
  assert.deepEqual(newAbilities({ plugin: 'echo', accepted: ['echo.say'], store }), ['echo.say']);
  assert.equal(newAbilities({ plugin: 'other', accepted: ['other.say'], store }), null);
});

test('the ability wake is a heartbeat wake with the cause and the tool names, bound to no place and no intention', () => {
  const wake = abilityWake({ at: AT, plugin: 'echo', tools: ['echo.say'] });
  assert.equal(ABILITY_ADDED, 'ability.added');
  assert.equal(wake.kind, 'heartbeat');
  assert.equal(wake.reason, 'ability.added');
  assert.deepEqual(wake.tools, ['echo.say']);
  assert.equal(wake.id, `inner.wake:heartbeat:ability:echo:${AT}`);
  assert.equal(wake.dueAt, AT);
  assert.equal(wake.channelId, null);
  assert.deepEqual(wake.intentionIds, []);
});

test('two plugins announced in the same millisecond get two wake ids', () => {
  const one = abilityWake({ at: AT, plugin: 'echo', tools: ['echo.say'] });
  const two = abilityWake({ at: AT, plugin: 'other', tools: ['other.say'] });
  assert.notEqual(one.id, two.id);
});

test('the file store keeps what was announced across a new store over the same folder', () => {
  const dir = tempDir('nep-announce-');
  newAbilities({ plugin: 'echo', accepted: ['echo.say'], store: fileAnnounceStore(dir) });
  assert.equal(newAbilities({ plugin: 'echo', accepted: ['echo.say'], store: fileAnnounceStore(dir) }), null);
  assert.ok(fs.existsSync(path.join(dir, 'plugins-announced.json')));
});

test('the file store reads a missing file and an unreadable one as nothing announced', () => {
  const dir = tempDir('nep-announce-');
  assert.deepEqual(fileAnnounceStore(dir).read(), {});
  fs.writeFileSync(path.join(dir, 'plugins-announced.json'), '{"echo":');
  assert.deepEqual(fileAnnounceStore(dir).read(), {});
});
