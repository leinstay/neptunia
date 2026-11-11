// The settings of an interface run in the core's process (src/interface/interface-settings.ts): the core's settings with
// the interface's own file over them, read again when that file changes. Temporary folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterfaceSettings } from '../src/interface/interface-settings.ts';

function folders(): { rootDir: string; privateDir: string; file: string } {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'nep-iface-settings-'));
  const rootDir = path.join(base, 'root');
  const privateDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chatnet'), { recursive: true });
  fs.mkdirSync(path.join(privateDir, 'interfaces', 'chatnet'), { recursive: true });
  return { rootDir, privateDir, file: path.join(privateDir, 'interfaces', 'chatnet', 'config.json') };
}

const quietHot = (config: Record<string, unknown>) => ({ config, onReload: () => () => {} });

test('an interface in process reads its settings again when its own settings file changes, and hears of it', () => {
  // Catches: a setting the owner changes written to the file while the interface in process keeps the old value.
  // Changed: the roots list is retired by the owner's decision of 2026-11-11, so a list setting stands in for it.
  const { rootDir, privateDir, file } = folders();
  fs.writeFileSync(file, JSON.stringify({ words: ['alpha'] }));
  const settings = createInterfaceSettings({ rootDir, privateDir, name: 'chatnet', hot: quietHot({ base: 1 }) });
  const heard: Array<string> = [];
  settings.onChange((what) => void heard.push(what));
  assert.deepEqual(settings.read().words, ['alpha']);
  fs.writeFileSync(file, JSON.stringify({ words: ['alpha', 'beta'] }));
  assert.deepEqual(settings.read().words, ['alpha', 'beta']);
  assert.deepEqual(heard, ['config']);
});
