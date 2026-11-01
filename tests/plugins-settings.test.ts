// The readers of `plugins.<name>.enabled` and `plugins.callDeadlineMs` (src/plugins/settings.ts). Synthetic configs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginCallDeadlineMs, pluginEnabled } from '../src/plugins/settings.ts';

test('a plugin is off in an empty config, with no plugins section, and with a plugins section of the wrong type', () => {
  assert.equal(pluginEnabled({}, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: {} }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: 'on' }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: [{ echo: { enabled: true } }] }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: null }, 'echo'), false);
});

test('a plugin is on only when its own enabled is exactly true', () => {
  const config = { plugins: { echo: { enabled: true }, quiet: { enabled: false } } };
  assert.equal(pluginEnabled(config, 'echo'), true);
  assert.equal(pluginEnabled(config, 'quiet'), false);
  assert.equal(pluginEnabled(config, 'other'), false);
});

test('a truthy enabled that is not true leaves the plugin off', () => {
  for (const enabled of ['true', 1, 'yes', {}, [], null]) {
    assert.equal(
      pluginEnabled({ plugins: { echo: { enabled } } }, 'echo'),
      false,
      `enabled ${JSON.stringify(enabled)}`
    );
  }
});

test('a plugin entry that is not an object leaves the plugin off', () => {
  assert.equal(pluginEnabled({ plugins: { echo: true } }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: { echo: 'on' } }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: { echo: [] } }, 'echo'), false);
  assert.equal(pluginEnabled({ plugins: { echo: null } }, 'echo'), false);
});

test('the shared deadline key is never a plugin, even with an enabled beside it', () => {
  assert.equal(pluginEnabled({ plugins: { callDeadlineMs: { enabled: true } } }, 'callDeadlineMs'), false);
});

test('the call deadline is the configured number when it is positive', () => {
  assert.equal(pluginCallDeadlineMs({ plugins: { callDeadlineMs: 1234 } }), 1234);
  assert.equal(pluginCallDeadlineMs({ plugins: { callDeadlineMs: 1 } }), 1);
  assert.equal(pluginCallDeadlineMs({ plugins: { callDeadlineMs: 0.5 } }), 0.5);
});

test('the call deadline falls back to the same default for every missing or unusable value', () => {
  const fallback = pluginCallDeadlineMs({});
  assert.ok(fallback > 0 && Number.isFinite(fallback));
  const bad: Array<unknown> = [0, -1, -0, NaN, Infinity, -Infinity, '5000', null, true, {}, [5000]];
  for (const value of bad) {
    assert.equal(pluginCallDeadlineMs({ plugins: { callDeadlineMs: value } }), fallback, `value ${String(value)}`);
  }
  assert.equal(pluginCallDeadlineMs({ plugins: {} }), fallback);
  assert.equal(pluginCallDeadlineMs({ plugins: 'x' }), fallback);
  assert.equal(pluginCallDeadlineMs({ plugins: [] }), fallback);
});

test('a plugin named like the deadline key does not change the deadline', () => {
  const config = { plugins: { echo: { enabled: true, callDeadlineMs: 5 } } };
  assert.equal(pluginCallDeadlineMs(config), pluginCallDeadlineMs({}));
});
