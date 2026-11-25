// Tests for src/agent-runner/policy.ts: the scope default and the secret
// redaction (keys, tokens, assignments, SSH material, URL
// credentials). Pure; no I/O. Non-ASCII data is Greek/accented
// Latin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeOf,
  isFiltered,
  redactSecrets,
  redactorFor,
  containsSecret,
  REDACTED,
} from '../../../src/agent-runner/policy.ts';

test('scopeOf: known scope kept, anything else is the narrowest', () => {
  assert.equal(scopeOf({ scope: 'core' }), 'core');
  assert.equal(scopeOf({ scope: 'dm' }), 'dm');
  assert.equal(scopeOf({}), 'group');
  assert.equal(scopeOf(undefined), 'group');
  assert.equal(scopeOf({ scope: 'nope' }), 'group');
  assert.equal(isFiltered('core'), false);
  assert.equal(isFiltered('group'), true);
});

test('redactSecrets: assignments, prefixes, dotted tokens, hex, URL creds, SSH, key block', () => {
  assert.match(redactSecrets('OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef'), /OPENROUTER_API_KEY=\[redacted\]/);
  assert.match(redactSecrets('"password": "hunter2secretpass"'), /"password": \[redacted\]/);
  assert.match(redactSecrets('token xai-0123456789abcdefghij0123'), new RegExp(REDACTED.replace(/[[\]]/g, '\\$&')));
  assert.match(redactSecrets('aws AKIAIOSFODNN7EXAMPLE here'), /\[redacted\]/);
  assert.match(
    redactSecrets('jwt eyJhbGciOiJIUzI1NiwidHlwIjoiSldUI.aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb'),
    /\[redacted\]/
  );
  assert.match(redactSecrets('https://user:p4ssw0rd@example.org/x'), /https:\/\/\[redacted\]@example\.org/);
  assert.match(redactSecrets('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAexampleKEY me@host'), /ssh-ed25519 \[redacted\]/);
  assert.match(
    redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----'),
    /\[redacted\]/
  );
});

test('redactSecrets: ordinary text and paths survive', () => {
  const text = 'The café is on /srv/neptunia-dev/neptunia-core/src/index.js and θάλασσα.';
  assert.equal(redactSecrets(text), text);
});

test('containsSecret: true exactly when redactSecrets would change the text', () => {
  assert.equal(containsSecret(`OPENROUTER_API_KEY=sk-or-v1-${'ab12'.repeat(16)}`), true);
  assert.equal(containsSecret('The café is on /srv/neptunia-dev/neptunia-core/src/index.js and θάλασσα.'), false);
  assert.equal(containsSecret(''), false);
});

test('redactorFor: core passes text through, dm redacts', () => {
  assert.equal(redactorFor('core')('sk-or-v1-abcdef0123456789abcdef'), 'sk-or-v1-abcdef0123456789abcdef');
  assert.match(redactorFor('group')('sk-or-v1-abcdef0123456789abcdef'), /\[redacted\]/);
});
