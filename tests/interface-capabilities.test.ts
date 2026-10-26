// Tests for src/interface/capabilities.ts: what the core reads of a port's name and declared capabilities, with a
// default for a port that declares nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portIface, portLimit, portMessageUrl } from '../src/interface/capabilities.ts';

const TEMPLATE = {
  community: 'https://chat.example/{community}/{conversation}/{message}',
  direct: 'https://chat.example/me/{conversation}/{message}',
};

test('reads the limit a port declares in its capabilities', () => {
  const port = { iface: 'fake', capabilities: () => ({ maxFiles: 2, maxChars: 250 }) };
  assert.equal(portLimit(port, 'maxFiles', 10), 2);
  assert.equal(portLimit(port, 'maxChars', 2000), 250);
});

test('answers the fallback for a limit the port does not declare, declares as zero or declares as no number', () => {
  const port = { capabilities: () => ({ maxFiles: 0, maxChars: '250' }) };
  assert.equal(portLimit(port, 'maxFiles', 10), 10);
  assert.equal(portLimit(port, 'maxChars', 2000), 2000);
  assert.equal(portLimit(port, 'maxFileBytes', 7), 7);
});

test('answers the fallback for a port with no capabilities or none at all', () => {
  assert.equal(portLimit({ iface: 'cli' }, 'maxFiles', 10), 10);
  assert.equal(portLimit(null, 'maxFiles', 10), 10);
  assert.equal(portLimit({ capabilities: () => null }, 'maxFiles', 10), 10);
});

test('names the interface of a port, empty when it names none', () => {
  assert.equal(portIface({ iface: 'discord' }), 'discord');
  assert.equal(portIface({}), '');
  assert.equal(portIface(undefined), '');
});

test('reads the message address form of a port and answers null for a port that declares none or half of one', () => {
  assert.deepEqual(portMessageUrl({ capabilities: () => ({ messageUrl: TEMPLATE }) }), TEMPLATE);
  assert.equal(portMessageUrl({ capabilities: () => ({}) }), null);
  assert.equal(portMessageUrl({ capabilities: () => ({ messageUrl: { community: 'x' } }) }), null);
  assert.equal(portMessageUrl({ capabilities: () => ({ messageUrl: null }) }), null);
});
