// The plugin folders (src/plugins/folders.ts): `plugins/` and `plugins.local/` read at each call, a local plugin
// replacing the tracked one whole, a broken plugin named and skipped without stopping the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlugins } from '../src/plugins/folders.ts';
import { ECHO_DIR, echoManifest } from './fixtures/plugin-rig.ts';
import { tempDir } from './fixtures/tmp.js';

function folders(): { trackedDir: string; localDir: string } {
  const root = tempDir('nep-plugins-');
  return { trackedDir: path.join(root, 'plugins'), localDir: path.join(root, 'plugins.local') };
}

function put(dir: string, name: string, manifest: object | string, skills: ReadonlyArray<string> = []): string {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  );
  for (const skill of skills) {
    fs.mkdirSync(path.join(folder, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(folder, 'skills', skill, 'SKILL.md'), '---\n---\n');
  }
  return folder;
}

const plain = (name: string, description = 'A plugin.'): object => ({ name, description, tools: [] });

test('loads the echo fixture from the tracked layer with its manifest and its skills folder', () => {
  const { trackedDir, localDir } = folders();
  fs.cpSync(ECHO_DIR, path.join(trackedDir, 'echo'), { recursive: true });
  const { plugins, problems } = loadPlugins({ trackedDir, localDir });
  assert.deepEqual(problems, []);
  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0]?.manifest, echoManifest());
  assert.equal(plugins[0]?.layer, 'tracked');
  assert.equal(plugins[0]?.dir, path.join(trackedDir, 'echo'));
  assert.equal(plugins[0]?.skillsDir, path.join(trackedDir, 'echo', 'skills'));
});

test('a local plugin replaces the tracked plugin of the same name whole', () => {
  const { trackedDir, localDir } = folders();
  put(trackedDir, 'alpha', plain('alpha', 'tracked one'));
  put(localDir, 'alpha', plain('alpha', 'local one'));
  const { plugins } = loadPlugins({ trackedDir, localDir });
  assert.deepEqual(
    plugins.map((plugin) => [plugin.manifest.name, plugin.layer, plugin.manifest.description]),
    [['alpha', 'local', 'local one']]
  );
});

test('lists plugins of both layers sorted by name', () => {
  const { trackedDir, localDir } = folders();
  put(trackedDir, 'zeta', plain('zeta'));
  put(localDir, 'beta', plain('beta'));
  assert.deepEqual(
    loadPlugins({ trackedDir, localDir }).plugins.map((plugin) => plugin.manifest.name),
    ['beta', 'zeta']
  );
});

test('missing folders hold nothing, and a folder with no plugin.json is neither a plugin nor a problem', () => {
  const { trackedDir, localDir } = folders();
  assert.deepEqual(loadPlugins({ trackedDir, localDir }), { plugins: [], problems: [] });
  fs.mkdirSync(path.join(trackedDir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(trackedDir, 'README.md'), 'loose file');
  assert.deepEqual(loadPlugins({ trackedDir, localDir }), { plugins: [], problems: [] });
});

test('a plugin.json that does not parse is a problem named by its folder and stops no other plugin', () => {
  const { trackedDir, localDir } = folders();
  put(trackedDir, 'broken', '{"name":');
  put(trackedDir, 'good', plain('good'));
  put(trackedDir, 'wrongname', plain('another'));
  const { plugins, problems } = loadPlugins({ trackedDir, localDir });
  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.name),
    ['good']
  );
  assert.deepEqual(problems, [
    { dir: 'broken', code: 'not-json' },
    { dir: 'wrongname', code: 'name-mismatch' },
  ]);
});

test('a plugin that declares a skill with no SKILL.md is a problem and no plugin', () => {
  const { trackedDir, localDir } = folders();
  put(trackedDir, 'gap', { ...plain('gap'), skills: ['gap-skill'] });
  put(trackedDir, 'whole', { ...plain('whole'), skills: ['whole-skill'] }, ['whole-skill']);
  const { plugins, problems } = loadPlugins({ trackedDir, localDir });
  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.name),
    ['whole']
  );
  assert.deepEqual(problems, [{ dir: 'gap', code: 'skill-missing' }]);
});

test('reads the folders anew at each call', () => {
  const { trackedDir, localDir } = folders();
  assert.equal(loadPlugins({ trackedDir, localDir }).plugins.length, 0);
  put(localDir, 'late', plain('late'));
  assert.equal(loadPlugins({ trackedDir, localDir }).plugins.length, 1);
});
