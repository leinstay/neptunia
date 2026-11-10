// src/watcher/settings.ts: the watcher's settings, read from a config at the moment of use. The watcher runs only on
// `/doctor watcher run`, so it has no switch and no schedule (owner, 2026-11-09). Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watcherSettings } from '../src/watcher/settings.ts';

test('a degraded-route threshold that is no number of minutes reads as the default', () => {
  // Catches: a hand-edited "1h" or a negative number makes every route read as down at once, or never.
  const fallback = watcherSettings({}).degradedAfterMinutes;
  for (const bad of ['1h', -5, Number.NaN]) {
    assert.equal(
      watcherSettings({ watcher: { degradedAfterMinutes: bad } }).degradedAfterMinutes,
      fallback,
      String(bad)
    );
  }
  assert.equal(watcherSettings({ watcher: { degradedAfterMinutes: 15 } }).degradedAfterMinutes, 15);
});
