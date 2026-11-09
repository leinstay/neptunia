// The engine proxy's store (stage Z): one service `proxy` in keys.json, a plain proxy URL with its login and password,
// which `serviceCredential` reads for every consumer. Temp dirs only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceCredential } from '../src/keys/file.ts';
import { SERVICES, serviceCommand } from '../src/keys/services.ts';
import { scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
test('the service list names proxy and no longer names videoProxy', () => {
  // Catches: the old name stays settable, so a value lands where no consumer reads it.
  assert.equal(Object.hasOwn(SERVICES, 'proxy'), true);
  assert.equal(Object.hasOwn(SERVICES, 'videoProxy'), false);
});

test('a proxy set through the service dialog is what serviceCredential reads under proxy', async () => {
  // Catches: the setter and the reader disagree on the name, so the engine never sees the proxy the owner entered.
  const dir = tempDir('nep-proxy-store-');
  const set = await serviceCommand(dir, 'keys.service.set', { name: 'proxy' }, scriptedDialog([PROXY]).dialog);
  assert.equal(set.status, 'ok');
  assert.equal(serviceCredential(dir, 'proxy'), PROXY);
  assert.equal(set.text.includes('pass-word'), false);
});
