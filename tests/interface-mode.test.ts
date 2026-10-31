// Tests for src/interface/mode.ts: `interfaceMode(config)` reads `interfaces.mode`, which decides whether the entry
// (src/index.js) starts the interfaces in the core's process (`inprocess`) or leaves them to their units (`units`).
// A value outside the two must stop the start, because either silent guess starts the persona in the wrong shape: a
// core with no interface while the units are not installed, or a second Discord client beside a running unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interfaceMode } from '../src/interface/mode.ts';

test('reads inprocess and units as the setting names them', () => {
  assert.equal(interfaceMode({ interfaces: { mode: 'inprocess' } }), 'inprocess');
  assert.equal(interfaceMode({ interfaces: { mode: 'units' } }), 'units');
});

test('refuses a mode outside the list with an error that names both modes', () => {
  assert.throws(() => interfaceMode({ interfaces: { mode: 'unit' } }), /inprocess.*units|units.*inprocess/);
});
