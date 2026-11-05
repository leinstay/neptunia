// `gh` is the system's tool with its existing login: `spawnGh` and `checkRepository` run it with no config home of ours,
// and nothing of the engine names a gh home in the persona folder. A disposable fake `gh` on PATH records what it got.
// src/setup/persona-migration.ts is left out of the scan: it moves the files of an older layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { labelsFileOf } from '../src/config/labels.ts';
import * as repository from '../src/selfimprovement/repository.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const LABELS = labelsFileOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))).owner;

/** A folder with a fake `gh`, its record file, and the environment that finds it. */
function fakeGh(login: 'in' | 'out', over: Readonly<NodeJS.ProcessEnv> = {}) {
  const bin = tempDir('nep-gh-system-');
  const record = path.join(bin, 'record');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "config=\${GH_CONFIG_DIR-unset}" >> "${record}"
case "$1" in
  auth) [ "${login}" = in ] || { echo "not logged in" >&2; exit 1; } ;;
  api) echo '{"permissions":{"push":true}}' ;;
esac
`,
    { mode: 0o755 }
  );
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, ...over };
  return { env, recorded: () => fs.readFileSync(record, 'utf8').trim().split('\n') };
}

test('gh runs with no config home of ours', async () => {
  // Catches: the engine points gh at a folder in the persona, so the login the owner made on the system is not seen.
  const gh = fakeGh('in');
  const answer = await repository.spawnGh(gh.env)(['auth', 'status']);
  assert.deepEqual(answer, { found: true, code: 0, stdout: '', stderr: '' });
  assert.deepEqual(gh.recorded(), ['config=unset']);
});

test("a config home the system set for gh stays the system's", async () => {
  // Catches: the override survives as a default that replaces what the installing user chose.
  const gh = fakeGh('in', { GH_CONFIG_DIR: '/home/someone/.config/gh' });
  await repository.spawnGh(gh.env)(['auth', 'status']);
  assert.deepEqual(gh.recorded(), ['config=/home/someone/.config/gh']);
});

test('the check over the system gh answers ok with a login and a push right', async () => {
  // Catches: the check still needs a login made under a private gh home.
  const gh = fakeGh('in');
  assert.deepEqual(await repository.checkRepository('example/engine', repository.spawnGh(gh.env), LABELS), {
    code: 'ok',
    repository: 'example/engine',
  });
});

test('a logged-out system gh answers gh-logged-out, and an absent one gh-missing', async () => {
  // Catches: the failure codes change with the move, so the block loses its reason.
  const out = await repository.checkRepository('example/engine', repository.spawnGh(fakeGh('out').env), LABELS);
  assert.equal(out.code, 'gh-logged-out');
  const nowhere = tempDir('nep-gh-system-empty-');
  const missing = await repository.checkRepository('example/engine', repository.spawnGh({ PATH: nowhere }), LABELS);
  assert.equal(missing.code, 'gh-missing');
});

test('the helpers of the private gh home are gone', () => {
  // Catches: a caller keeps a way back to `<private>/subharness/gh`.
  assert.deepEqual(
    Object.keys(repository).filter((name) => ['ghConfigDir', 'ghEnv'].includes(name)),
    []
  );
});

test('the logged-out line sends the owner to the system login', () => {
  // Catches: the block tells someone to log in under a folder that no longer exists.
  const { selfimprovement } = LABELS as { selfimprovement: { check: Record<string, string> } };
  const line = selfimprovement.check['gh-logged-out'] ?? '';
  assert.match(line, /gh auth login/);
  assert.doesNotMatch(line, /subharness\/gh|GH_CONFIG_DIR/);
});

test('no code, unit, setting or document names the gh home or the development folder of the persona', () => {
  // Catches: docs or a unit that still send a person or a write path to the retired places.
  const RETIRED = ['subharness/gh', 'ghConfigDir', 'ghEnv', '.no-gh-login', 'data/development', '<data>/development'];
  const walk = (dir: string): Array<string> =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(relative) : [relative];
    });
  const files = ['bin', 'src', 'deploy', 'docs', 'config', 'agents', 'prompts']
    .flatMap(walk)
    .filter((file) => file !== path.join('src', 'setup', 'persona-migration.ts'));
  const named = files.flatMap((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return RETIRED.filter((word) => text.includes(word)).map((word) => `${file}: ${word}`);
  });
  assert.deepEqual(named, []);
});
