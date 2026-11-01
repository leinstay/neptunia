// Tests for src/behavior/spontaneous.ts: the turn someone asks her for in a channel. `force` runs it in the mode given,
// or lets the turn pick the mode from the channel (forcedMode: a topic of her own in an empty or quiet channel, else
// joining in). PR 7d: the spontaneous scheduler and the eavesdropping went with their switches; what stays is this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forcedMode, createSpontaneous } from '../src/behavior/spontaneous.ts';
import { refTo, useIface } from './fixtures/turn-world.ts';

// The conversations are held by a fake interface named `fake`.
useIface('fake');

const MINUTE = 60_000;

/** A turn runner that keeps the arguments of its last turn in `seen.args`. */
function recordingTurns() {
  const seen = { args: null };
  const turns = {
    runTurn: async (args) => {
      seen.args = args;
      return { outcome: 'spoke' };
    },
  };
  return { turns, seen };
}

test('force: forwards mode straight to turns.runTurn, with forced: true', async () => {
  const { turns, seen } = recordingTurns();
  const channel = { id: 'c1' };
  const result = await createSpontaneous({ turns }).force(refTo(channel), 'interject');
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(seen.args.conversation, refTo(channel));
  assert.equal(seen.args.mode, 'interject');
  assert.equal(seen.args.forced, true);
});

// PR 7d: the quiet time is the constant 90 minutes (`spontaneous.deadAfterMinutes` of production).
test('forcedMode: a turn someone asked for starts a topic in an empty or quiet channel, else joins in -- never nothing', () => {
  const now = 10 * 60 * MINUTE;
  assert.equal(forcedMode([], now), 'initiate');
  assert.equal(forcedMode([{ ts: now - 91 * MINUTE, self: false }], now), 'initiate');
  assert.equal(forcedMode([{ ts: now - 5 * MINUTE, self: false }], now), 'interject');
  // her own last line, or a lone line: still a turn, she was asked
  assert.equal(forcedMode([{ ts: now - 5 * MINUTE, self: true }], now), 'interject');
});

test('force: without a mode the turn picks it from the channel (forcedMode); the one who asked rides along as the requester', async () => {
  const { turns, seen } = recordingTurns();
  const spontaneous = createSpontaneous({ turns });
  const channel = { id: 'c1' };
  await spontaneous.force(refTo(channel), null, { requester: { id: '42', roleIds: [] } });
  assert.deepEqual([seen.args.mode, seen.args.forced, seen.args.requester], ['auto', true, { id: '42', roleIds: [] }]);
  assert.equal(seen.args.chooseMode([], Date.now()), 'initiate', 'an empty channel: a topic of her own');
  await spontaneous.force(refTo(channel), 'interject');
  assert.equal('requester' in seen.args, false, 'nobody asked: no requester');
});
