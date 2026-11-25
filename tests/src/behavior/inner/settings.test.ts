// The settings of the inner life (src/behavior/inner/settings.ts): one `<name>.schedule` reaching the scheduler of each
// mechanic, with the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerSettings } from '../../../../src/behavior/inner/settings.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

useIface('fake');

test('the heartbeat settings read the schedule and keep the jitter, and a schedule that means nothing is no setting', () => {
  // Catches: a hand-edited value gives the timer NaN minutes, and the heartbeat never falls due.
  const set = innerSettings({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }).heartbeat;
  assert.deepEqual(set.schedule, { kind: 'every', everyMinutes: 240 });
  assert.equal(set.jitterMinutes, 45);
  assert.deepEqual(
    innerSettings({ heartbeat: { schedule: 'sometimes' } }).heartbeat.schedule,
    innerSettings({}).heartbeat.schedule
  );
});
