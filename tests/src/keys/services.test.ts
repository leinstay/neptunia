// src/keys/services.ts: the optional service credentials of keys.json, set and read by the owner's commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readKeys, serviceCredential, writeKeys } from '../../../src/keys/file.ts';
import { serviceCommand } from '../../../src/keys/services.ts';
import { scriptedDialog } from '../../fixtures/keys-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';

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
  // Bug: `/keys add` rewrites keys.json from its known sections, and the service keys silently disappear.
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
    // keys.json holds named keys under `keys`.
    JSON.stringify({ keys: { main: 'sk' }, services: { youtube: VALUE, brave: 'b' } })
  );
  await serviceCommand(dir, 'keys.service.clear', { name: 'youtube' }, null);
  assert.equal(serviceCredential(dir, 'youtube'), null);
  assert.equal(serviceCredential(dir, 'brave'), 'b');
  assert.equal(readKeys(dir).keys.main, 'sk');
});

test('an unknown service and a set without a dialog are refused and write nothing', async () => {
  // Bug: a typo stores a key no consumer reads, or the value ends up on a command line.
  const dir = tempDir('nep-services-');
  assert.equal((await serviceCommand(dir, 'keys.service.set', { name: 'nope' }, null)).status, 'invalid');
  assert.equal((await serviceCommand(dir, 'keys.service.set', { name: 'youtube' }, null)).status, 'invalid');
  assert.equal(fs.existsSync(path.join(dir, 'keys.json')), false);
});

// The engine proxy's store: one service `proxy` in keys.json, a plain proxy URL with its login and password,
// which `serviceCredential` reads for every consumer. Temp dirs only, no network.

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';

test('a proxy set through the service dialog is what serviceCredential reads under proxy', async () => {
  // Catches: the setter and the reader disagree on the name, so the engine never sees the proxy the owner entered.
  const dir = tempDir('nep-proxy-store-');
  const set = await serviceCommand(dir, 'keys.service.set', { name: 'proxy' }, scriptedDialog([PROXY]).dialog);
  assert.equal(set.status, 'ok');
  assert.equal(serviceCredential(dir, 'proxy'), PROXY);
  assert.equal(set.text.includes('pass-word'), false);
});
