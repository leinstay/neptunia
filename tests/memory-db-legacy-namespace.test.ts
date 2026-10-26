// Tests for the helpers of src/memory/db/legacy-namespace.ts: which interface a context, a row or a unit write names,
// the legacy namespace when it names none, and the interface a live option reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_IFACE,
  ifaceOrLegacy,
  liveIface,
  namedIface,
  withLiveIface,
} from '../src/memory/db/legacy-namespace.ts';

test('names the interface a source carries and nothing for one that carries none', () => {
  assert.equal(namedIface({ iface: 'fake' }), 'fake');
  assert.equal(namedIface({ iface: '' }), null);
  assert.equal(namedIface({ iface: 7 }), null);
  assert.equal(namedIface(null), null);
});

test('reads the interface from another key of a row', () => {
  assert.equal(namedIface({ scope_iface: 'cli' }, 'scope_iface'), 'cli');
  assert.equal(ifaceOrLegacy({ scope_iface: null }, 'scope_iface'), LEGACY_IFACE);
});

test('falls back to the legacy namespace for a source that names no interface', () => {
  assert.equal(ifaceOrLegacy({}), LEGACY_IFACE);
  assert.equal(ifaceOrLegacy({ iface: 'fake' }), 'fake');
});

test('reports the interface a live option answers, null for anything else', () => {
  assert.equal(
    liveIface(() => 'discord'),
    'discord'
  );
  assert.equal(
    liveIface(() => null),
    null
  );
  assert.equal(liveIface('discord'), null);
  assert.equal(liveIface(undefined), null);
});

test('stamps the live interface on a unit write that names none and keeps one that does', () => {
  assert.deepEqual(
    withLiveIface({ op: 'lines' }, () => 'fake'),
    { op: 'lines', iface: 'fake' }
  );
  assert.deepEqual(
    withLiveIface({ op: 'lines', iface: 'cli' }, () => 'fake'),
    { op: 'lines', iface: 'cli' }
  );
  assert.deepEqual(
    withLiveIface({ op: 'lines' }, () => null),
    { op: 'lines' }
  );
});
