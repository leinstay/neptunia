// src/watcher/settings.ts: the watcher's settings beside her three mechanics (spec 2026-11-02, "The watcher is a fourth
// ticking mechanic"): `watcher.enabled`, `watcher.schedule` (when it runs, UTC) and `watcher.dir`, read from a
// config at the moment of use. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watcherSettings } from '../src/watcher/settings.ts';

test('the switch and hour are configured while the report folder is canonical', () => {
  // Catches: the setup step writes watcher.schedule and the renderer reads another key, so the timer never moves.
  // Changed: `watcher.at` became `watcher.schedule`, read in its parsed form.
  const settings = watcherSettings({ watcher: { enabled: true, schedule: 'at 05:30', dir: '/srv/watch' } });
  // The selected data root supplies report placement, so watcher.dir cannot select another persona root.
  assert.deepEqual(
    [settings.enabled, settings.schedule, settings.dir],
    [true, { kind: 'at', at: ['05:30'] }, 'agents/watcher']
  );
});

test('an hour that is no HH:MM reads as no hour set', () => {
  // Catches: a hand-edited "5:30pm" reaches OnCalendar and systemd refuses the timer.
  // Changed: the same bad hours, now as the schedule that holds them.
  const fallback = watcherSettings({}).schedule;
  for (const bad of ['at 5:30pm', 'at 24:00', '', 530])
    assert.deepEqual(watcherSettings({ watcher: { schedule: bad } }).schedule, fallback, String(bad));
});

test('a switch that is not true reads as off', () => {
  // Catches: the string "false" from a hand edit reads as on, and the block of a stopped watcher reaches her wake.
  assert.equal(watcherSettings({ watcher: { enabled: 'false' } }).enabled, false);
});
