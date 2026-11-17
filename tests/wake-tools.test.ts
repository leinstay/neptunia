// What a heartbeat accepts (src/tools/wake-tools.ts): every call that only looks, as the tools' own definitions
// declare it, the errand calls and one intention change; every other call is refused with heartbeat-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsWake, wakeRefusalCode } from '../src/tools/wake-tools.ts';
import { JOBS, SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { CODE } from '../src/tools/codes.ts';

// Changed: memory.profile.read declares `read`, and a heartbeat takes every read since a heartbeat looks at whatever
// she wants before she decides; the call still refused here is a post.
// Bug caught: the heartbeat's set misses memory.read, or takes a post.
test('accepts memory.read in a heartbeat and refuses message.create', () => {
  assert.deepEqual(
    [wakeRefusalCode('heartbeat', 'memory.read'), wakeRefusalCode('heartbeat', 'message.create')],
    [null, CODE.HEARTBEAT_ONLY]
  );
});

// Bug caught: the heartbeat refuses the errand it is to wait for, or takes the errand for its decision and ends.
test('accepts errand.scout and errand.read in a heartbeat, and neither ends the wake', () => {
  assert.deepEqual(
    [
      wakeRefusalCode('heartbeat', 'errand.scout'),
      wakeRefusalCode('heartbeat', 'errand.read'),
      endsWake('heartbeat', 'errand.scout'),
      endsWake('heartbeat', 'errand.read'),
    ],
    [null, null, false, false]
  );
});

// Bug caught: a read tool, one added later among them, is refused in a heartbeat, or a tool that changes something
// outside her (a post, a reaction, a drawing, a setting) slips into the heartbeat's set.
test('a heartbeat takes every tool that declares read, the errand calls and the intention changes, and refuses the rest', () => {
  const decided = new Set([...JOBS, 'intention.set', 'intention.update', 'intention.cancel']);
  const wrong = SKILL_DEFINITIONS.filter(
    (definition) =>
      (wakeRefusalCode('heartbeat', definition.name) === null) !==
      (definition.effects === 'read' || decided.has(definition.name))
  ).map((definition) => definition.name);
  assert.deepEqual(wrong, []);
});
