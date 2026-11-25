// Tests for src/config/files.ts: the settings of an interface, its package's defaults under its local file, and the
// variable its token goes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as files from '../../../src/config/files.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { ROOT } from '../../fixtures/private-layer.ts';

const BASE_CONFIG = { pace: { settleMs: 500, settleMaxMs: 3000 }, llm: { retries: 2 } };

function write(dir: string, rel: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(value));
}

// ---- the settings of an interface -----------------------------------------------------------------------------------
// The prepared interface settings live in persona interfaces/<name>/config.json over the engine package defaults.

test("gives an interface its package's defaults over the core settings and its local file over both", () => {
  const root = tempDir('nep-iface-root-');
  write(root, 'interfaces/discord/config.json', { discord: { intents: { presences: false, members: false } } });
  const dir = tempDir('nep-iface-private-');
  write(dir, 'interfaces/discord/config.json', { discord: { intents: { members: true } } });
  const settings = files.readInterfaceConfig({ rootDir: root, privateDir: dir, name: 'discord', base: BASE_CONFIG });
  assert.deepEqual(settings, { ...BASE_CONFIG, discord: { intents: { presences: false, members: true } } });
});

test('gives an interface its extracted settings without unrelated core overrides', () => {
  const root = tempDir('nep-iface-root-');
  write(root, 'interfaces/discord/config.json', { discord: { intents: { presences: false, members: false } } });
  const dir = tempDir('nep-iface-private-');
  // Interface keys are extracted before runtime while unrelated settings stay in the core persona layer.
  write(dir, 'interfaces/discord/config.json', { discord: { intents: { presences: true } } });
  write(dir, 'config/config.json', { recall: { timeoutMs: 9 } });
  const settings = files.readInterfaceConfig({ rootDir: root, privateDir: dir, name: 'discord', base: {} });
  assert.deepEqual(settings, { discord: { intents: { presences: true, members: false } } });
});

test('the token variable of an interface is its name in capitals with _TOKEN', () => {
  // Catches: the token handed to the interface under a variable the Discord package never reads, so it starts without one.
  assert.equal(files.tokenVariableOf('discord'), 'DISCORD_TOKEN');
  assert.equal(files.tokenVariableOf('my-chat'), 'MY_CHAT_TOKEN');
});

// The tracked files at their old places would be a second copy the engine no longer reads, left to drift.
test('the checkout keeps the settings and the labels only under config/', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'config', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'config', 'labels.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'prompts', 'labels.json')), false);
});
