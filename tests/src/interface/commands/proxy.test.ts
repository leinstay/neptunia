// The `proxy` command group, declared once in src/interface/commands/table.ts for the CLI and `/nep`:
// `set` asks the URL in the chat's masked question, `on` and `off` write `proxy.enabled` to the persona's settings
// file, `status` says where the engine stands, `test` probes the stored proxy, and `useragent` writes
// `proxy.userAgent` and the `.curlrc` of every harness home. No reply ever carries the login, the password or the
// address. `set` also hands the URL to each interface in its own `credentials.json`, since an interface runs as a
// user that cannot read keys.json. Temp dirs, a scripted dialog and a fake probe; nothing goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../../../../src/config/files.ts';
import { proxyCommand } from '../../../../src/interface/commands/proxy.ts';
import type { ProxyCommandDeps } from '../../../../src/interface/commands/proxy.ts';
import { serviceCredential } from '../../../../src/keys/file.ts';
import { subharnessPlace } from '../../../../src/subharness/place.ts';
import { readLocalConfig } from '../../../../src/tools/operations/shared.ts';
import { scriptedDialog } from '../../../fixtures/keys-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

const PROXY = 'socks5h://login-x7:pass-word-q9@proxy.example:31080';

const SECRET_PARTS = ['login-x7', 'pass-word-q9', 'proxy.example', '31080'];

const AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

function rig(answer = true, route: 'off' | 'proxy' | 'direct' = 'proxy') {
  const dataDir = tempDir('nep-proxy-cmd-');
  const probed: Array<string> = [];
  const deps: ProxyCommandDeps = {
    dataDir,
    probe: (url) => {
      probed.push(url);
      return Promise.resolve(answer);
    },
    route: () => route,
  };
  const run = (name: string, args: Record<string, unknown> = {}, answers: Array<string> | null = null) =>
    proxyCommand(deps, name, args, answers === null ? null : scriptedDialog(answers).dialog);
  return { dataDir, probed, run };
}

const settings = (dataDir: string): { proxy?: Record<string, unknown> } => readLocalConfig(localConfigPath(dataDir));

function assertNoSecret(text: string, label: string): void {
  for (const part of SECRET_PARTS) assert.equal(text.includes(part), false, `${label} shows ${part}`);
}

test('set stores the URL as the proxy service and the reply shows none of it', async () => {
  // Catches: the command writes another name than the engine reads, or echoes the credentials into the chat log.
  const { dataDir, run } = rig();
  const answer = await run('proxy.set', {}, [PROXY]);
  assert.equal(answer.status, 'ok');
  assert.equal(serviceCredential(dataDir, 'proxy'), PROXY);
  assertNoSecret(answer.text, 'set');
});

test('set refuses a value with no usable scheme, host or port and writes nothing', async () => {
  // Catches: a typo is stored and the engine fails every request through it, or the refusal quotes the value.
  const { dataDir, run } = rig();
  for (const bad of [
    '',
    'proxy.example:31080',
    'ftp://login-x7:pass-word-q9@proxy.example:31080',
    'socks5h://login-x7:pass-word-q9@proxy.example',
  ]) {
    const answer = await run('proxy.set', {}, [bad]);
    assert.equal(answer.status, 'invalid', bad);
    assertNoSecret(answer.text, `refusal of ${bad}`);
  }
  assert.equal(serviceCredential(dataDir, 'proxy'), null);
});

test('set without a chat to ask in is refused', async () => {
  // Catches: a shell line with the URL as an argument, which lands in the shell history.
  const { dataDir, run } = rig();
  assert.equal((await run('proxy.set', {}, null)).status, 'invalid');
  assert.equal(serviceCredential(dataDir, 'proxy'), null);
});

test('on needs a stored URL; on and off then write the switch to the settings file', async () => {
  // Catches: `proxy on` with nothing stored reports success and the engine stays direct without a word.
  const { dataDir, run } = rig();
  const early = await run('proxy.on');
  assert.equal(early.status, 'not_configured');
  assert.notEqual(settings(dataDir).proxy?.enabled, true);
  await run('proxy.set', {}, [PROXY]);
  assert.equal((await run('proxy.on')).status, 'ok');
  assert.equal(settings(dataDir).proxy?.enabled, true);
  assert.equal((await run('proxy.off')).status, 'ok');
  assert.equal(settings(dataDir).proxy?.enabled, false);
});

test('status says on and the route the engine takes, never the URL', async () => {
  // Catches: reply reads only the switch, so the owner sees "on" while every request goes direct after a failure.
  const { run } = rig(true, 'direct');
  await run('proxy.set', {}, [PROXY]);
  await run('proxy.on');
  const reply = await run('proxy.status');
  assert.equal(reply.status, 'ok');
  assert.match(reply.text, /\bon\b/);
  assert.match(reply.text, /direct/);
  assertNoSecret(reply.text, 'status');
});

test('test probes the stored URL and answers ok or failed without the URL', async () => {
  // Catches: the probe goes to a cached or default address, or a failure prints the proxy's address.
  const good = rig(true);
  await good.run('proxy.set', {}, [PROXY]);
  const passed = await good.run('proxy.test');
  assert.deepEqual(good.probed, [PROXY]);
  assert.equal(passed.status, 'ok');
  assertNoSecret(passed.text, 'test ok');
  const bad = rig(false);
  await bad.run('proxy.set', {}, [PROXY]);
  const failed = await bad.run('proxy.test');
  assert.equal(failed.status, 'failed');
  assertNoSecret(failed.text, 'test failed');
});

test('test with no URL stored sends no probe', async () => {
  // Catches: the probe runs on an empty value and reports a network error instead of the missing setting.
  const { probed, run } = rig();
  assert.equal((await run('proxy.test')).status, 'not_configured');
  assert.deepEqual(probed, []);
});

test('useragent writes the setting and the .curlrc of every installed harness home, and a bare useragent removes them', async () => {
  // Catches: curl in a harness keeps its own user agent, or a cleared agent leaves the old `.curlrc` behind.
  const { dataDir, run } = rig();
  for (const backend of ['claude', 'opencode'] as const)
    fs.mkdirSync(subharnessPlace(dataDir, backend).dir, { recursive: true });
  assert.equal((await run('proxy.useragent', { value: AGENT })).status, 'ok');
  assert.equal(settings(dataDir).proxy?.userAgent, AGENT);
  for (const backend of ['claude', 'opencode'] as const) {
    const file = path.join(subharnessPlace(dataDir, backend).dir, 'home', '.curlrc');
    assert.equal(fs.readFileSync(file, 'utf8'), `user-agent = "${AGENT}"\n`, backend);
  }
  assert.equal(fs.existsSync(path.join(subharnessPlace(dataDir, 'codex').dir, 'home', '.curlrc')), false);
  assert.equal((await run('proxy.useragent', {})).status, 'ok');
  assert.equal(fs.existsSync(path.join(subharnessPlace(dataDir, 'claude').dir, 'home', '.curlrc')), false);
});
