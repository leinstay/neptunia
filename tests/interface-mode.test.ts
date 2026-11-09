// Tests for src/interface/mode.ts: the owner's switch of one interface, the list of configured interfaces and the
// drain time, all read from the `interfaces` settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredInterfaces, drainMs, interfaceEnabled } from '../src/interface/mode.ts';

test('an interface is enabled unless its settings say false', () => {
  const config = { interfaces: { off: { enabled: false }, on: { enabled: true }, bare: {} } };
  assert.equal(interfaceEnabled(config, 'off'), false);
  assert.equal(interfaceEnabled(config, 'on'), true);
  assert.equal(interfaceEnabled(config, 'bare'), true);
  assert.equal(interfaceEnabled(config, 'unnamed'), true);
});

test('lists the interface objects in file order and skips the shared keys and a leftover string', () => {
  const config = { interfaces: { drainMs: 5, mode: 'units', discord: { enabled: true }, chatty: {} } };
  assert.deepEqual(configuredInterfaces(config), ['discord', 'chatty']);
});

test('lists nothing when the settings have no interfaces', () => {
  assert.deepEqual(configuredInterfaces({}), []);
});

test('drain time is the setting when it is a non-negative number and the default otherwise', () => {
  assert.equal(drainMs({ interfaces: { drainMs: 250 } }), 250);
  assert.equal(drainMs({ interfaces: { drainMs: 0 } }), 0);
  assert.equal(drainMs({ interfaces: { drainMs: -1 } }), 10_000);
  assert.equal(drainMs({ interfaces: { drainMs: 'soon' } }), 10_000);
  assert.equal(drainMs({}), 10_000);
});
