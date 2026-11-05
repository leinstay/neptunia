// src/behavior/private.ts#mergeProfiles when only the private layer exists: a person who spoke to the persona only in a DM
// has private memory and no public profile, and that memory reaches her. Plan 2026-11-04-cli-and-memory task 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfiles } from '../src/behavior/private.ts';

const PRIVATE_ONLY = {
  relationship: 'told only here',
  interests: [{ topic: 'chess', note: 'plays by mail' }],
  details: [{ id: 'd1', text: 'a private detail' }],
  episodes: [{ id: 'e1', date: '2026-11-01', what: 'a private event' }],
  affinity: { score: 7, reason: 'kind' },
};

test('a private profile with no public one reaches the merged view with its text unchanged', () => {
  // Bug: `mergeProfiles` answers the absent public profile, so private-only memory disappears from the DM.
  const merged = mergeProfiles(null, PRIVATE_ONLY);
  assert.equal(merged?.relationship, 'told only here');
  assert.deepEqual(merged?.details, PRIVATE_ONLY.details);
  assert.deepEqual(merged?.episodes, PRIVATE_ONLY.episodes);
  assert.deepEqual(merged?.interests, PRIVATE_ONLY.interests);
});

test('the merge keeps the private affinity as the effective one when no public attitude exists', () => {
  // Bug: the effective attitude reads as absent, so the private gate treats a known partner as a stranger.
  assert.equal(mergeProfiles(null, PRIVATE_ONLY)?.affinity?.score, 7);
});

test('no profile at all stays no profile', () => {
  // Bug: the private-only branch invents an empty profile for someone nobody knows.
  assert.equal(mergeProfiles(null, null), null);
  assert.equal(mergeProfiles(null, undefined), null);
});
