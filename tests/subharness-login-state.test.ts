// src/subharness/login-state.ts: the core's record of whether the last real run of a role through its harness lost its
// login, read by the chat's header (src/interface/commands/status-brief.ts). It is fed by the runs themselves, so it
// sends no request of its own. The owner asked for it on 2026-11-08: with her core on a harness he must see that its
// auth did not drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginState, runOutcomeOf } from '../src/subharness/login-state.ts';

test('a run that lost its login marks the role on that harness, and its next answered run clears it', () => {
  // Catches: a header that keeps showing error after the owner logged in again and her next turn answered.
  const logins = createLoginState();
  logins.ran('core', 'claude', 'login');
  assert.equal(logins.lost('core', 'claude'), true);
  logins.ran('core', 'claude', 'ok');
  assert.equal(logins.lost('core', 'claude'), false);
});

test('a run that failed for another reason leaves the login state as it was', () => {
  // Catches: a spent window or a crash read as a lost login, or one that clears a lost login no run has proven back.
  const logins = createLoginState();
  logins.ran('memory', 'claude', 'failed');
  assert.equal(logins.lost('memory', 'claude'), false);
  logins.ran('memory', 'claude', 'login');
  logins.ran('memory', 'claude', 'failed');
  assert.equal(logins.lost('memory', 'claude'), true);
});

test('a lost login of one role or one harness marks neither another role nor another harness', () => {
  // Catches: the memory writer's lost login shown on the core line, or a core moved to codex still shown as logged out.
  const logins = createLoginState();
  logins.ran('core', 'claude', 'login');
  assert.equal(logins.lost('memory', 'claude'), false);
  assert.equal(logins.lost('core', 'codex'), false);
});

test('the codes of a lost login read as login, every other failure as failed', () => {
  // Catches: the memory writer's not-logged-in or the core's subscription-login missed, so the header never says error.
  assert.equal(runOutcomeOf(Object.assign(new Error('x'), { code: 'subscription-login' })), 'login');
  assert.equal(runOutcomeOf(Object.assign(new Error('x'), { code: 'not-logged-in' })), 'login');
  assert.equal(runOutcomeOf(Object.assign(new Error('x'), { code: 'subscription-exhausted' })), 'failed');
  assert.equal(runOutcomeOf('not an error'), 'failed');
});
