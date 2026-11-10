// What a heartbeat accepts (src/tools/wake-tools.ts) after the narrow reads of one subject merge into memory.read
// (slice 12 of the lookup loop): the heartbeat reads memory through memory.read and no longer takes the old names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeRefusalCode } from '../src/tools/wake-tools.ts';
import { CODE } from '../src/tools/codes.ts';

// Bug caught: the heartbeat's list keeps the old reads, so she is refused the one memory read she is offered.
test('accepts memory.read in a heartbeat and refuses memory.profile.read', () => {
  assert.deepEqual(
    [wakeRefusalCode('heartbeat', 'memory.read'), wakeRefusalCode('heartbeat', 'memory.profile.read')],
    [null, CODE.HEARTBEAT_ONLY]
  );
});
