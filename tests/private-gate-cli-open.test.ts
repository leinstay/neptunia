// The owner's command line stays open while `dm.enabled` is false (docs/cli.md under Access): the gate lets
// his lines through, and the missed-answer recovery of a line in his chat (src/pipeline/private-gate.ts) follows the
// same rule. A direct chat of another interface stays closed. Synthetic ids, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateGate } from '../src/pipeline/private-gate.ts';
import type { PrivateLine } from '../src/pipeline/private-gate.ts';
import type { ChatInfo } from '../src/protocol/adapter.ts';
import { wrongly } from './fixtures/loose-types.ts';

type Recovery = { allow: (channel: ChatInfo, trigger: PrivateLine) => Promise<boolean> };

/** The recovery the gate hands the missed-answer registry, built over a config with direct chats off. */
function recoveryWithDmOff(): Recovery {
  let recovery: Recovery | null = null;
  createPrivateGate(
    wrongly<Parameters<typeof createPrivateGate>[0]>({
      hot: { config: { dm: { enabled: false } } },
      store: { getUser: () => null },
      rootsOf: () => [],
      missed: {
        setPrivateRecovery: (given: Recovery) => {
          recovery = given;
        },
      },
    })
  );
  assert.ok(recovery, 'the gate hands over a recovery');
  return recovery;
}

const chatOf = (iface: string, id: string): ChatInfo =>
  wrongly<ChatInfo>({ id, kind: 'dm', rootId: null, iface, name: 'x', partnerId: 'owner' });

const line: PrivateLine = { id: 'm1', placeId: 'cli:dm:owner', authorId: 'owner', ts: 0 };

test("allows a recovery turn in the owner's command line while direct chats are off", async () => {
  // Bug: a line of his the pipeline missed was never recovered, though the gate had let it through.
  assert.equal(await recoveryWithDmOff().allow(chatOf('cli', 'cli:dm:owner'), line), true);
});

test('refuses a recovery turn in a direct chat of another interface while direct chats are off', async () => {
  assert.equal(
    await recoveryWithDmOff().allow(chatOf('fake', 'd1'), { ...line, placeId: 'd1', authorId: 'u1' }),
    false
  );
});
