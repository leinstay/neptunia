// src/skills/package.ts with src/skills/load.ts: a skill's scripts are part of its version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '../src/skills/load.ts';
import { argsProblem, scriptManifest, snapshotDir } from '../src/skills/package.ts';
import { tempDir } from './fixtures/tmp.ts';

const TEXT = '---\nname: gif-search\ndescription: find a gif\ntools: [skill.run]\n---\n\nRun search.ts.\n';

function rig() {
  const root = tempDir('nep-skill-package-');
  const dir = path.join(root, 'gif-search');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), TEXT);
  fs.writeFileSync(path.join(dir, 'scripts', 'search.ts'), 'one');
  fs.writeFileSync(
    path.join(dir, 'setup.json'),
    JSON.stringify({
      settings: [],
      scripts: {
        'search.ts': { args: { q: { type: 'string', required: true } }, credentials: ['token'] },
      },
    })
  );
  const hashOf = () => loadSkills({ trackedDir: path.join(root, 'none'), localDir: root }).skills[0]?.contentHash ?? '';
  return { dir, hashOf };
}

test('an edited script is a new version, and the earlier version keeps its exact bytes', () => {
  // Bug: an activated skill silently runs a script someone edited afterwards.
  const { dir, hashOf } = rig();
  const before = hashOf();
  fs.writeFileSync(path.join(dir, 'scripts', 'search.ts'), 'two');
  const after = hashOf();
  assert.notEqual(after, before);
  assert.equal(fs.readFileSync(path.join(snapshotDir(dir, before), 'scripts', 'search.ts'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(snapshotDir(dir, after), 'scripts', 'search.ts'), 'utf8'), 'two');
});

test('a skill that is its text alone keeps the hash of its text', () => {
  // Bug: every existing prose skill turns into a new candidate at the upgrade and loses its active version.
  const root = tempDir('nep-skill-package-');
  fs.mkdirSync(path.join(root, 'gif-search'));
  fs.writeFileSync(path.join(root, 'gif-search', 'SKILL.md'), TEXT);
  const skill = loadSkills({ trackedDir: path.join(root, 'none'), localDir: root }).skills[0];
  assert.equal(skill?.contentHash, createHash('sha256').update(TEXT).digest('hex'));
  assert.equal(fs.existsSync(path.join(root, 'gif-search', '.versions')), false);
});

test('a script takes only the arguments its manifest declares, with their types', () => {
  // Bug: a model's stray or mistyped argument reaches a script that trusts its input.
  const { dir } = rig();
  const manifest = scriptManifest(dir, 'search.ts');
  if (manifest === null) throw new Error('the fixture declares the script');
  assert.equal(argsProblem(manifest, { q: 'cat' }), null);
  assert.match(argsProblem(manifest, {}) ?? '', /q is required/);
  assert.match(argsProblem(manifest, { q: 1 }) ?? '', /q must be a string/);
  assert.match(argsProblem(manifest, { q: 'x', path: '/etc' }) ?? '', /unknown argument path/);
  assert.equal(scriptManifest(dir, 'other.ts'), null);
});
