// The push-right check of her self-development (src/selfimprovement/repository.ts): gh present, logged in under her own gh
// home, and allowed to push to `selfimprovement.repository`. The gh runner is a fake that answers from a table and records
// what it was asked; nothing reaches GitHub. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPOSITORY_FAILURES,
  checkRepository,
  ghConfigDir,
  ghEnv,
  repositoryOfRemote,
} from '../src/selfimprovement/repository.ts';
import type { GhAnswer, GhRunner } from '../src/selfimprovement/repository.ts';
import { labelsFileOf } from '../src/config/labels.ts';

const ROOT = path.join(import.meta.dirname, '..');

const LABELS = {
  selfimprovement: {
    check: {
      'gh-missing': 'gh is not on PATH',
      'gh-logged-out': 'gh is not logged in',
      'no-push': 'no push right on {repository}: fork it and name the fork',
      'repository-unset': 'selfimprovement.repository is unset',
      failed: 'gh could not answer',
    },
  },
};

type Fake = { gh: GhRunner; calls: Array<ReadonlyArray<string>> };

/** A gh that answers `auth status` and `api ...` from the two given answers. */
function fakeGh(auth: GhAnswer, api: GhAnswer): Fake {
  const calls: Array<ReadonlyArray<string>> = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    return Promise.resolve(args[0] === 'auth' ? auth : api);
  };
  return { gh, calls };
}

const answer = (code: number, stdout = '', stderr = ''): GhAnswer => ({ found: true, code, stdout, stderr });
const LOGGED_IN = answer(0, '', 'Logged in to github.com account her-login');
const repoJson = (push: unknown): GhAnswer =>
  answer(0, JSON.stringify({ full_name: 'fork-owner/engine', permissions: { admin: false, push, pull: true } }));

test('a repository her login can push to is ok, after the login check and one api call on that repository', async () => {
  // Catches: the check asks about another repository than the setting names, or skips the login check.
  const { gh, calls } = fakeGh(LOGGED_IN, repoJson(true));
  const found = await checkRepository('fork-owner/engine', gh, LABELS);
  assert.deepEqual(found, { code: 'ok', repository: 'fork-owner/engine' });
  assert.deepEqual(calls, [
    ['auth', 'status'],
    ['api', 'repos/fork-owner/engine'],
  ]);
});

test('a repository she can only read is no-push, and its line names the repository', async () => {
  // Catches: read access passes the check, and the first beat fails at git push instead of pausing.
  const { gh } = fakeGh(LOGGED_IN, repoJson(false));
  const found = await checkRepository('upstream/engine', gh, LABELS);
  assert.equal(found.code, 'no-push');
  assert.equal('line' in found ? found.line : '', 'no push right on upstream/engine: fork it and name the fork');
});

test('an api answer without permissions is no-push', async () => {
  // Catches: a missing permissions field (a token without repo scope) reads as a push right.
  const { gh } = fakeGh(LOGGED_IN, answer(0, JSON.stringify({ full_name: 'upstream/engine' })));
  assert.equal((await checkRepository('upstream/engine', gh, LABELS)).code, 'no-push');
});

test('no gh on PATH is gh-missing', async () => {
  // Catches: a missing binary reads as a logged-out login, and the owner runs gh auth login on a gh that is not there.
  const { gh, calls } = fakeGh({ found: false }, { found: false });
  const found = await checkRepository('fork-owner/engine', gh, LABELS);
  assert.equal(found.code, 'gh-missing');
  assert.equal(calls.length, 1);
});

test('a gh that is not logged in is gh-logged-out and asks the api nothing', async () => {
  // Catches: the api call runs without a login and its 404 reads as "no push right", sending the owner to fork for nothing.
  const { gh, calls } = fakeGh(answer(1, '', 'You are not logged into any GitHub hosts.'), repoJson(true));
  const found = await checkRepository('fork-owner/engine', gh, LABELS);
  assert.equal(found.code, 'gh-logged-out');
  assert.deepEqual(calls, [['auth', 'status']]);
});

test('an unset repository is repository-unset and runs no gh at all', async () => {
  // Catches: an unset setting falls back to some remote, so pull requests open against a repository nobody named.
  const { gh, calls } = fakeGh(LOGGED_IN, repoJson(true));
  assert.equal((await checkRepository(null, gh, LABELS)).code, 'repository-unset');
  assert.deepEqual(calls, []);
});

test('a repository that is not owner/name is repository-unset', async () => {
  // Catches: a URL or a bare name lands in "gh api repos/..." and asks about the wrong path.
  for (const bad of ['engine', 'https://github.com/fork-owner/engine', 'a/b/c', ''])
    assert.equal(
      (await checkRepository(bad, fakeGh(LOGGED_IN, repoJson(true)).gh, LABELS)).code,
      'repository-unset',
      bad
    );
});

test('a failing api call is failed and its line carries nothing gh printed', async () => {
  // Catches: gh's error text, which can hold a host, a login or a token hint, is echoed into the setup line or the journal.
  const { gh } = fakeGh(LOGGED_IN, answer(1, 'SECRET-OUT', 'HTTP 502 gho_SECRETTOKEN'));
  const found = await checkRepository('fork-owner/engine', gh, LABELS);
  assert.equal(found.code, 'failed');
  const line = 'line' in found ? found.line : '';
  assert.equal(line, 'gh could not answer');
  assert.equal(/SECRET/.test(line), false);
});

test('an api answer that is not JSON is failed', async () => {
  // Catches: a proxy page or a truncated answer throws out of the beat, or reads as a push right.
  const { gh } = fakeGh(LOGGED_IN, answer(0, '<html>bad gateway</html>'));
  assert.equal((await checkRepository('fork-owner/engine', gh, LABELS)).code, 'failed');
});

test('every failure code has a one-line label in the shipped owner labels', () => {
  // Catches: a refusal shows an empty line or the bare code because its label was never added.
  const file = labelsFileOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8')));
  const check = (file.owner.selfimprovement as { check?: Record<string, unknown> } | undefined)?.check ?? {};
  assert.deepEqual([...REPOSITORY_FAILURES].sort(), [
    'failed',
    'gh-logged-out',
    'gh-missing',
    'no-push',
    'repository-unset',
  ]);
  for (const code of REPOSITORY_FAILURES) {
    const label = check[code];
    assert.match(typeof label === 'string' ? label : '', /^[^\n]*\S[^\n]*$/, code);
  }
  assert.ok(String(check['no-push']).includes('{repository}'));
});

test('her gh home is subharness/gh under the private folder, and ghEnv sets it without touching the given env', () => {
  // Catches: gh runs under the installing user's own login (~/.config/gh), so her pull requests are his.
  assert.equal(ghConfigDir('/p'), path.join('/p', 'subharness', 'gh'));
  const env = { PATH: '/usr/bin', GH_CONFIG_DIR: '/home/him/.config/gh' };
  const made = ghEnv('/p', env);
  assert.equal(made.GH_CONFIG_DIR, path.join('/p', 'subharness', 'gh'));
  assert.equal(made.PATH, '/usr/bin');
  assert.equal(env.GH_CONFIG_DIR, '/home/him/.config/gh');
});

test('repositoryOfRemote reads owner/name from https and ssh remotes of github.com', () => {
  // Catches: the ssh form or the .git suffix is not understood, so setup offers no default or a name ending in .git.
  for (const url of [
    'https://github.com/example/engine.git',
    'https://github.com/example/engine',
    'git@github.com:example/engine.git',
    'ssh://git@github.com/example/engine.git',
    'https://github.com/example/engine.git\n',
  ])
    assert.equal(repositoryOfRemote(url), 'example/engine', JSON.stringify(url));
});

test('repositoryOfRemote is null for a remote it cannot read', () => {
  // Catches: a local path or garbage becomes the offered default and the check asks gh about it.
  for (const url of ['', '/srv/git/engine.git', 'not a url', 'https://github.com/example'])
    assert.equal(repositoryOfRemote(url), null, JSON.stringify(url));
});
