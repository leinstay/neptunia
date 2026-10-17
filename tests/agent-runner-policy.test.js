// Tests for src/agent-runner/policy.js: the scope default, the withheld-path
// check over tool-call events (a read or a bash reader that opens a sensitive
// path is withheld in dm/group, a listing is not, core withholds nothing),
// and the secret redaction (keys, tokens, assignments, SSH material, URL
// credentials), and the withheld roots and globs built from the deployment's
// directories (src/paths.js). Pure; no I/O. Non-ASCII data is Greek/accented
// Latin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scopeOf, isFiltered, isWithheldPath, withheldInToolUse, redactSecrets, redactorFor, REDACTED,
  WITHHELD_ROOTS, WITHHELD_GLOBS, withheldRootsOf, withheldGlobsOf,
} from '../src/agent-runner/policy.js';
import { resolvePaths } from '../src/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('scopeOf: known scope kept, anything else is the narrowest', () => {
  assert.equal(scopeOf({ scope: 'core' }), 'core');
  assert.equal(scopeOf({ scope: 'dm' }), 'dm');
  assert.equal(scopeOf({}), 'group');
  assert.equal(scopeOf(undefined), 'group');
  assert.equal(scopeOf({ scope: 'nope' }), 'group');
  assert.equal(isFiltered('core'), false);
  assert.equal(isFiltered('group'), true);
});

test('isWithheldPath: roots, name components and env files', () => {
  assert.equal(isWithheldPath('/var/www/html/index.php'), true);
  assert.equal(isWithheldPath('/srv/git/repo.git'), true);
  assert.equal(isWithheldPath('/home/neptunia/project/.git/config'), true);
  assert.equal(isWithheldPath('/home/x/.ssh/id_ed25519'), true);
  assert.equal(isWithheldPath('/opt/app/.env'), true);
  assert.equal(isWithheldPath('/opt/app/.env.local'), true);
  assert.equal(isWithheldPath('/opt/app/config.local.json'), true);
  assert.equal(isWithheldPath('/etc/letsencrypt/live/x/privkey.pem'), true);
  assert.equal(isWithheldPath('/srv/neptunia-dev/neptunia-core/src/index.js'), false);
  assert.equal(isWithheldPath('/home/steam/servers'), false);
});

test('withheld roots and globs: the fixed ones, then the data directory and a private directory apart from the checkout', () => {
  const apart = resolvePaths({ rootDir: '/srv/app', env: { NEPTUNIA_PRIVATE_DIR: '/srv/site/etc', NEPTUNIA_DATA_DIR: '/srv/site/data' } });
  const roots = withheldRootsOf({ paths: apart });
  assert.deepEqual(roots.slice(-2), ['/srv/site/data', '/srv/site/etc']);
  assert.ok(roots.includes('/etc/neptunia'), '/etc/neptunia stays');
  assert.ok(!roots.some((root) => root.startsWith('/opt/neptunia')), 'no hard-coded deployment path');
  const globs = withheldGlobsOf({ paths: apart });
  for (const glob of ['/srv/site/data', '/srv/site/data/**', '/srv/site/etc', '/srv/site/etc/**', '/etc/neptunia/**', '**/data/guilds/**']) assert.ok(globs.includes(glob), glob);
  assert.ok(!globs.some((glob) => glob.startsWith('/srv/app')), 'the checkout itself is not withheld');

  const together = resolvePaths({ rootDir: '/srv/app', env: {} });
  assert.deepEqual(withheldRootsOf({ paths: together }).at(-1), '/srv/app/data', 'default: <root>/data, the private directory is the checkout');
  assert.ok(!withheldRootsOf({ paths: together }).includes('/srv/app'));

  const own = resolvePaths({ rootDir: ROOT });
  assert.deepEqual(WITHHELD_ROOTS, withheldRootsOf({ paths: own }), 'the module default: this checkout, resolved from the environment');
  assert.deepEqual(WITHHELD_GLOBS, withheldGlobsOf({ paths: own }));
  assert.equal(isWithheldPath(path.join(own.dataDir, 'guilds', '1', 'guild.json')), true);
});

test('withheldInToolUse: core withholds nothing', () => {
  assert.equal(withheldInToolUse({ tool: 'bash', input: { command: 'cat /var/www/x' } }, 'core'), null);
  assert.equal(withheldInToolUse({ tool: 'read', input: { path: '/opt/app/.env' } }, 'core'), null);
});

test('withheldInToolUse: a read of a withheld path is caught in dm/group', () => {
  assert.ok(withheldInToolUse({ tool: 'read', input: { filePath: '/opt/app/.env' } }, 'dm'));
  assert.ok(withheldInToolUse({ tool: 'read', input: { path: '/srv/neptunia-dev/.secrets/x' } }, 'group'));
  assert.equal(withheldInToolUse({ tool: 'read', input: { path: '/srv/neptunia-dev/neptunia-core/README.md' } }, 'dm'), null);
});

test('withheldInToolUse: bash reads are checked, listings are not', () => {
  assert.ok(withheldInToolUse({ tool: 'bash', input: { command: 'cat /home/x/.ssh/id_ed25519' } }, 'dm'));
  assert.ok(withheldInToolUse({ tool: 'bash', input: { command: 'grep token /opt/app/.env' } }, 'group'));
  // listing names of a directory is allowed even if it holds withheld things
  assert.equal(withheldInToolUse({ tool: 'bash', input: { command: 'ls -la /srv/neptunia-dev' } }, 'dm'), null);
  // a reader with no path (reads a pipe) is not blocked by path
  assert.equal(withheldInToolUse({ tool: 'bash', input: { command: 'ps aux | grep node' } }, 'dm'), null);
  // a listing with find and no -exec is allowed
  assert.equal(withheldInToolUse({ tool: 'bash', input: { command: 'find /srv -name "*.js"' } }, 'dm'), null);
});

test('withheldInToolUse: listing a withheld directory itself is withheld', () => {
  assert.ok(withheldInToolUse({ tool: 'list', input: { path: '/srv/git' } }, 'dm'));
  assert.equal(withheldInToolUse({ tool: 'list', input: { path: '/home' } }, 'dm'), null);
});

test('redactSecrets: assignments, prefixes, dotted tokens, hex, URL creds, SSH, key block', () => {
  assert.match(redactSecrets('OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef'), /OPENROUTER_API_KEY=\[redacted\]/);
  assert.match(redactSecrets('"password": "hunter2secretpass"'), /"password": \[redacted\]/);
  assert.match(redactSecrets('token xai-0123456789abcdefghij0123'), new RegExp(REDACTED.replace(/[[\]]/g, '\\$&')));
  assert.match(redactSecrets('aws AKIAIOSFODNN7EXAMPLE here'), /\[redacted\]/);
  assert.match(redactSecrets('jwt eyJhbGciOiJIUzI1NiwidHlwIjoiSldUI.aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb'), /\[redacted\]/);
  assert.match(redactSecrets('https://user:p4ssw0rd@example.org/x'), /https:\/\/\[redacted\]@example\.org/);
  assert.match(redactSecrets('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAexampleKEY me@host'), /ssh-ed25519 \[redacted\]/);
  assert.match(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----'), /\[redacted\]/);
});

test('redactSecrets: ordinary text and paths survive', () => {
  const text = 'The café is on /srv/neptunia-dev/neptunia-core/src/index.js and θάλασσα.';
  assert.equal(redactSecrets(text), text);
});

test('redactorFor: core passes text through, dm redacts', () => {
  assert.equal(redactorFor('core')('sk-or-v1-abcdef0123456789abcdef'), 'sk-or-v1-abcdef0123456789abcdef');
  assert.match(redactorFor('group')('sk-or-v1-abcdef0123456789abcdef'), /\[redacted\]/);
});
