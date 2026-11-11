// The settings of an interface run in the core's process (src/interface/interface-settings.ts): the core's settings with
// the interface's own file over them, read again when that file changes, and the roots setting a package marks in its
// `setup.json`. Temporary folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterfaceSettings, listedRoots } from '../src/interface/interface-settings.ts';

function folders(): { rootDir: string; privateDir: string; file: string } {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'nep-iface-settings-'));
  const rootDir = path.join(base, 'root');
  const privateDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chatnet'), { recursive: true });
  fs.mkdirSync(path.join(privateDir, 'interfaces', 'chatnet'), { recursive: true });
  return { rootDir, privateDir, file: path.join(privateDir, 'interfaces', 'chatnet', 'config.json') };
}

const quietHot = (config: Record<string, unknown>) => ({ config, onReload: () => () => {} });

test('an interface in process reads its roots again when its own settings file changes, and hears of it', () => {
  // Catches: a root the core accepts written to the file while the interface in process keeps serving the old list.
  const { rootDir, privateDir, file } = folders();
  fs.writeFileSync(file, JSON.stringify({ servers: ['g1'] }));
  const settings = createInterfaceSettings({ rootDir, privateDir, name: 'chatnet', hot: quietHot({ base: 1 }) });
  const heard: Array<string> = [];
  settings.onChange((what) => void heard.push(what));
  assert.deepEqual(settings.read().servers, ['g1']);
  fs.writeFileSync(file, JSON.stringify({ servers: ['g1', 'g22'] }));
  assert.deepEqual(settings.read().servers, ['g1', 'g22']);
  assert.deepEqual(heard, ['config']);
});

test('the roots setting is read and written through the list its package marks, and is null where none is marked', () => {
  // Catches: an accepted root written to a setting the interface never reads, or into an interface with no roots list.
  const { rootDir, privateDir, file } = folders();
  const declare = (settings: Array<Record<string, unknown>>): void =>
    fs.writeFileSync(path.join(rootDir, 'interfaces', 'chatnet', 'setup.json'), JSON.stringify({ settings }));
  const roots = listedRoots({ rootDir, dataDir: privateDir });
  declare([{ key: 'servers', question: 'Servers', kind: 'list' }]);
  assert.equal(roots.read('chatnet'), null);
  declare([{ key: 'servers', question: 'Servers', kind: 'list', roots: true }]);
  roots.add('chatnet', 'g7');
  roots.add('chatnet', 'g8');
  roots.remove('chatnet', 'g7');
  assert.deepEqual(roots.read('chatnet'), ['g8']);
  assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: unknown }).servers, ['g8']);
});
