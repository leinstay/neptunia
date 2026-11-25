// Tests for src/protocol/events.ts: the lists of event kinds the validator checks an inbound event against.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as events from '../../../src/protocol/events.ts';

/** Every exported constant that names one event kind, such as `MESSAGE_RECEIVED`. */
const kindConstants = Object.entries(events)
  .filter(([name, value]) => /^[A-Z_]+$/.test(name) && typeof value === 'string')
  .map(([, value]) => value as string);

test('EVENT_KINDS lists every kind constant once', () => {
  assert.equal(kindConstants.length, 13);
  assert.deepEqual([...events.EVENT_KINDS].sort(), [...kindConstants].sort());
});

test('CORE_KINDS holds the clock, errand and inner-life kinds, and every one is an event kind', () => {
  assert.deepEqual([...events.CORE_KINDS].sort(), ['errand.done', 'inner.wake', 'scheduler.tick']);
  for (const kind of events.CORE_KINDS) assert.ok(events.EVENT_KINDS.includes(kind), kind);
});
