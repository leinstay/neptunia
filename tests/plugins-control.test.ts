// The owner's switch of a plugin (src/plugins/control.ts): enable writes the client entry and the token and starts the
// unit, disable takes them back, setup reports the env keys. The settings, the units and the core's registry are
// stand-ins the test records; the client files are real, read back through the core's own principal lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPluginControl, unitOf } from '../src/plugins/control.ts';
import type { PluginControl } from '../src/plugins/control.ts';
import { loadPrincipals, principalOfToken } from '../src/interface/principals.ts';
import { ECHO_DIR, recordingUnits } from './fixtures/plugin-rig.ts';
import type { UnitLog } from './fixtures/plugin-rig.ts';
import { tempDir } from './fixtures/tmp.js';

type Rig = {
  control: PluginControl;
  privateDir: string;
  units: UnitLog;
  enabled: Set<string>;
  disabled: Array<string>;
  connected: Set<string>;
};

function rig(options: { failStart?: boolean; inProcess?: boolean } = {}): Rig {
  const root = tempDir('nep-control-');
  const privateDir = path.join(root, 'private');
  const trackedDir = path.join(root, 'plugins');
  fs.mkdirSync(privateDir);
  fs.cpSync(ECHO_DIR, path.join(trackedDir, 'echo'), { recursive: true });
  const units = recordingUnits({ failStart: options.failStart === true });
  const enabled = new Set<string>();
  const disabled: Array<string> = [];
  const connected = new Set<string>();
  const control = createPluginControl({
    folders: () => ({ trackedDir, localDir: path.join(root, 'plugins.local') }),
    privateDir,
    isEnabled: (name) => enabled.has(name),
    setEnabled: (name, on) => void (on ? enabled.add(name) : enabled.delete(name)),
    connected: (name) => connected.has(name),
    toolsOf: (name) => (connected.has(name) ? ['echo.say'] : []),
    units,
    unitsMode: () => options.inProcess !== true,
    onDisabled: (name) => disabled.push(name),
  });
  return { control, privateDir, units, enabled, disabled, connected };
}

const tokenFile = (privateDir: string, name: string): string => path.join(privateDir, 'clients', `${name}.token`);

test('lists the echo plugin as off and not connected before anyone enables it', () => {
  const { control } = rig();
  assert.deepEqual(
    control.list().map(({ name, layer, enabled, connected, tools }) => ({ name, layer, enabled, connected, tools })),
    [{ name: 'echo', layer: 'tracked', enabled: false, connected: false, tools: [] }]
  );
});

test('enable writes a plugin client and its token, switches the plugin on and starts its unit', async () => {
  const { control, privateDir, units, enabled } = rig();
  assert.deepEqual(await control.enable('echo'), { ok: true, changed: true });
  assert.equal(enabled.has('echo'), true);
  assert.deepEqual(units.started, [unitOf('echo')]);
  const entry = loadPrincipals(privateDir)?.find((client) => client.name === 'echo');
  assert.equal(entry?.kind, 'plugin');
  assert.equal(entry?.iface, null);
  assert.equal(fs.statSync(tokenFile(privateDir, 'echo')).mode & 0o777, 0o600);
  const token = fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8').trim();
  assert.equal(principalOfToken(token, { privateDir, boot: null })?.name, 'echo');
});

test('a second enable keeps the token and reports that nothing changed', async () => {
  const { control, privateDir } = rig();
  await control.enable('echo');
  const first = fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8');
  assert.deepEqual(await control.enable('echo'), { ok: true, changed: false });
  assert.equal(fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8'), first);
});

test('enable of a name no plugin has writes nothing and starts nothing', async () => {
  const { control, privateDir, units, enabled } = rig();
  assert.deepEqual(await control.enable('nope'), { ok: false, code: 'unknown-plugin' });
  assert.equal(enabled.size, 0);
  assert.deepEqual(units.started, []);
  assert.equal(loadPrincipals(privateDir), null);
});

test('a unit that does not start is reported, and the entry, the token and the switch stay for a retry', async () => {
  const { control, privateDir, enabled } = rig({ failStart: true });
  assert.deepEqual(await control.enable('echo'), { ok: false, code: 'unit-failed' });
  assert.equal(enabled.has('echo'), true);
  assert.ok(fs.existsSync(tokenFile(privateDir, 'echo')));
});

test('disable stops the unit, revokes the token, switches the plugin off and tells the core to forget it', async () => {
  const { control, privateDir, units, enabled, disabled } = rig();
  await control.enable('echo');
  const token = fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8').trim();
  assert.deepEqual(await control.disable('echo'), { ok: true, changed: true });
  assert.equal(enabled.has('echo'), false);
  assert.deepEqual(units.stopped, [unitOf('echo')]);
  assert.equal(fs.existsSync(tokenFile(privateDir, 'echo')), false);
  assert.equal(principalOfToken(token, { privateDir, boot: null }), null);
  assert.deepEqual(disabled, ['echo']);
});

test('disable of a plugin that is off changes nothing, and of an unknown name is refused', async () => {
  const { control, disabled } = rig();
  assert.deepEqual(await control.disable('echo'), { ok: true, changed: false });
  assert.deepEqual(await control.disable('nope'), { ok: false, code: 'unknown-plugin' });
  assert.deepEqual(disabled, []);
});

test('an enable after a disable writes a new token', async () => {
  const { control, privateDir } = rig();
  await control.enable('echo');
  const first = fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8');
  await control.disable('echo');
  await control.enable('echo');
  assert.notEqual(fs.readFileSync(tokenFile(privateDir, 'echo'), 'utf8'), first);
});

test('list shows an enabled, connected plugin with its registered tools', async () => {
  const { control, connected } = rig();
  await control.enable('echo');
  connected.add('echo');
  const [row] = control.list();
  assert.deepEqual([row?.enabled, row?.connected, row?.tools], [true, true, ['echo.say']]);
});

test('setup names each env key the manifest lists as missing, then as set once the unit env file holds a value', () => {
  const { control, privateDir } = rig();
  assert.deepEqual(control.setup('echo'), { name: 'echo', env: [{ key: 'ECHO_PREFIX', state: 'missing' }] });
  fs.mkdirSync(path.join(privateDir, 'clients'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'clients', 'echo.env'), 'ECHO_PREFIX=say: \n');
  assert.deepEqual(control.setup('echo')?.env, [{ key: 'ECHO_PREFIX', state: 'set' }]);
  fs.writeFileSync(path.join(privateDir, 'clients', 'echo.env'), 'ECHO_PREFIX=\n');
  assert.deepEqual(control.setup('echo')?.env, [{ key: 'ECHO_PREFIX', state: 'missing' }]);
  assert.equal(control.setup('nope'), null);
});

test('enable refuses while the core runs its interface in process, and writes nothing and starts nothing', async () => {
  const { control, privateDir, units, enabled } = rig({ inProcess: true });
  assert.deepEqual(await control.enable('echo'), { ok: false, code: 'inprocess-mode' });
  assert.equal(enabled.size, 0);
  assert.deepEqual(units.started, []);
  assert.equal(loadPrincipals(privateDir), null);
});
