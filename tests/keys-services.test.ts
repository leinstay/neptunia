// src/keys/services.ts: the optional service credentials of keys.json, set and read by the owner's commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { readKeys, serviceCredential, writeKeys } from '../src/keys/file.ts';
import { serviceCommand } from '../src/keys/services.ts';
import { scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const VALUE = 'AIzaSyEXAMPLE-wxyz';

test('a service key reaches its consumer, is stored at 600 and shows only its ending', async () => {
  // Bug: the setter writes where `serviceCredential` does not read, or the list shows the key back in the chat.
  const dir = tempDir('nep-services-');
  const set = await serviceCommand(dir, 'keys.service.set', { name: 'youtube' }, scriptedDialog([VALUE]).dialog);
  assert.equal(set.status, 'ok');
  assert.equal(serviceCredential(dir, 'youtube'), VALUE);
  assert.equal(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777, 0o600);
  const { text } = await serviceCommand(dir, 'keys.service.list', {}, null);
  assert.equal(text.includes(VALUE), false);
  assert.match(text, /youtube: set, ends in wxyz/);
  assert.match(text, /brave: not set/);
});

test('the service keys survive a write of the rest of the store', async () => {
  // Bug: `/keys core add` rewrites keys.json from its known sections, and the service keys silently disappear.
  const dir = tempDir('nep-services-');
  await serviceCommand(dir, 'keys.service.set', { name: 'youtube' }, scriptedDialog([VALUE]).dialog);
  writeKeys(dir, readKeys(dir));
  assert.equal(serviceCredential(dir, 'youtube'), VALUE);
});

test('clearing one service key leaves the others and the model keys', async () => {
  // Bug: clearing the YouTube key takes the model keys or another service with it.
  const dir = tempDir('nep-services-');
  fs.writeFileSync(
    path.join(dir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'main', value: 'sk' }], services: { youtube: VALUE, brave: 'b' } })
  );
  await serviceCommand(dir, 'keys.service.clear', { name: 'youtube' }, null);
  assert.equal(serviceCredential(dir, 'youtube'), null);
  assert.equal(serviceCredential(dir, 'brave'), 'b');
  assert.equal(readKeys(dir).core[0]?.value, 'sk');
});

test('an unknown service and a set without a dialog are refused and write nothing', async () => {
  // Bug: a typo stores a key no consumer reads, or the value ends up on a command line.
  const dir = tempDir('nep-services-');
  assert.equal((await serviceCommand(dir, 'keys.service.set', { name: 'nope' }, null)).status, 'invalid');
  assert.equal((await serviceCommand(dir, 'keys.service.set', { name: 'youtube' }, null)).status, 'invalid');
  assert.equal(fs.existsSync(path.join(dir, 'keys.json')), false);
});

test('the chat parses the service commands', () => {
  // Bug: the table lacks the command the setup step names.
  for (const line of ['/keys service list', '/keys service set youtube', '/keys service clear youtube']) {
    const parsed = parseCommandLine(line);
    assert.match(JSON.stringify(parsed), /keys\.service\./, line);
  }
});
