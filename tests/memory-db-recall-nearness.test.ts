// src/memory/db/recall.ts: proximity breaks a tie of relevance and excludes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { groupContext, groupScope } from '../src/memory/db/scope.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { fixture } from './fixtures/memory-db-recall.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;

test('an equal hit in the current place comes first, and a stronger hit on another interface keeps its lead', () => {
  // Bug: place proximity excludes a remote hit, or lets a weak local line outrank a better answer from elsewhere.
  const env = fixture();
  try {
    const here = channelPlaceId('discord', 'here');
    const far = channelPlaceId('other', 'far');
    env.say({
      native: 'far-equal',
      iface: 'other',
      at: NOW - DAY,
      text: 'ενα σπιτι',
      place: far,
      scope: groupScope('other'),
    });
    env.say({ native: 'near-equal', at: NOW - 5 * DAY, text: 'ενα σπιτι', place: here, scope: groupScope('discord') });
    env.say({
      native: 'far-strong',
      iface: 'other',
      at: NOW - 9 * DAY,
      text: 'ενα σπιτι δασκαλου',
      place: far,
      scope: groupScope('other'),
    });
    env.stem();
    fillEnvAudiences(env);
    const found = search(env.db, {
      ctx: { ...groupContext('discord'), audienceColumn: true, destination: here },
      plan: { forms: ['σπιτι', 'δασκαλου'], phrases: [], who: [], from: null, to: null, places: [] },
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0 },
    });
    assert.deepEqual(
      found.hits.map((hit) => hit.messageId),
      ['far-strong', 'near-equal', 'far-equal']
    );
  } finally {
    env.done();
  }
});
