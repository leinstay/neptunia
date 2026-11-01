// How a turn's tool calls become the uses of her skills (src/skills/uses.ts): `discovered` for every skill her request
// indexed, `read` on `skill.read`, `tried` for a call of the skill's tool after the read, `succeeded` when those calls
// all end ok, `corrected` when one failed and was called again, `declined` when she read it and called none. Pure
// functions over the turn's calls, fixed inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillUsesOfTurn } from '../src/skills/uses.ts';
import type { IndexedSkill, TurnCall } from '../src/skills/uses.ts';

const AT = Date.parse('2026-11-01T10:00:00Z');
const LOOK: IndexedSkill = { name: 'look-it-up', versionId: 'v-look', tools: ['web.search', 'web.read'] };
const PING: IndexedSkill = { name: 'ping-someone', versionId: 'v-ping', tools: ['pings.set'] };

const read = (name: string): TurnCall => ({ tool: 'skill.read', name, ok: true });
const call = (tool: string, ok = true): TurnCall => ({ tool, ok });

/** The `<skill>:<kind>` pairs of a turn's uses, sorted, so a test says what happened and not in which order. */
function kinds(index: ReadonlyArray<IndexedSkill>, calls: ReadonlyArray<TurnCall>): Array<string> {
  return skillUsesOfTurn({ turnId: 't1', at: AT, index, calls })
    .map((use) => `${use.skill}:${use.kind}`)
    .sort();
}

test('a skill that was indexed and not read is only discovered', () => {
  assert.deepEqual(kinds([LOOK, PING], [call('message.create')]), ['look-it-up:discovered', 'ping-someone:discovered']);
});

test('reading a skill and calling none of its tools is a decline', () => {
  assert.deepEqual(kinds([LOOK], [read('look-it-up'), call('message.create')]), [
    'look-it-up:declined',
    'look-it-up:discovered',
    'look-it-up:read',
  ]);
});

test('reading then calling its tools that all end ok is tried and succeeded', () => {
  assert.deepEqual(kinds([LOOK], [read('look-it-up'), call('web.search'), call('web.read'), call('message.create')]), [
    'look-it-up:discovered',
    'look-it-up:read',
    'look-it-up:succeeded',
    'look-it-up:tried',
  ]);
});

test('a failed call that is called again is corrected, tried and not succeeded', () => {
  assert.deepEqual(kinds([LOOK], [read('look-it-up'), call('web.search', false), call('web.search')]), [
    'look-it-up:corrected',
    'look-it-up:discovered',
    'look-it-up:read',
    'look-it-up:tried',
  ]);
});

test('a failed call never called again is tried and neither succeeded nor corrected', () => {
  assert.deepEqual(kinds([LOOK], [read('look-it-up'), call('web.search', false)]), [
    'look-it-up:discovered',
    'look-it-up:read',
    'look-it-up:tried',
  ]);
});

test('calls of the skill tools before the read do not count as tried', () => {
  assert.deepEqual(kinds([LOOK], [call('web.search'), read('look-it-up')]), [
    'look-it-up:declined',
    'look-it-up:discovered',
    'look-it-up:read',
  ]);
});

test('a second read in the same turn adds no second row of any kind', () => {
  const uses = skillUsesOfTurn({
    turnId: 't1',
    at: AT,
    index: [LOOK],
    calls: [read('look-it-up'), call('web.search'), read('look-it-up'), call('web.read')],
  });
  assert.equal(uses.filter((use) => use.kind === 'read').length, 1);
  assert.equal(uses.filter((use) => use.kind === 'tried').length, 1);
});

test('a read of a name her request did not index gives nothing, and no calls give only the discoveries', () => {
  assert.deepEqual(kinds([LOOK], [read('made-up-skill')]), ['look-it-up:discovered']);
  assert.deepEqual(kinds([], [read('look-it-up'), call('web.search')]), []);
});

test('each row names the turn, the version the request showed and the time of the turn', () => {
  const uses = skillUsesOfTurn({ turnId: 't-77', at: AT, index: [PING], calls: [] });
  assert.deepEqual(uses, [{ skill: 'ping-someone', versionId: 'v-ping', turnId: 't-77', kind: 'discovered', at: AT }]);
});
