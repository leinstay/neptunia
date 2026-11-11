// The owner's roots commands (src/interface/commands/interfaces-roots.ts): each of `/interfaces invite`, `roots`,
// `roots accept` and `roots remove` reaches its own method of the core's joining with the interface and the root it
// names, any other command passes by, and a console with no joining answers without throwing. The joining is a recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootsCommand } from '../src/interface/commands/interfaces-roots.ts';
import type { JoiningAnswer, RootJoining } from '../src/interface/root-joining.ts';

function recorder(): { joining: RootJoining; calls: Array<string> } {
  const calls: Array<string> = [];
  const ok = (call: string): JoiningAnswer => {
    calls.push(call);
    return { text: call, status: 'ok' };
  };
  const joining: RootJoining = {
    rootChanged: () => null,
    isOpen: () => false,
    rows: () => [],
    invite: (iface) => Promise.resolve(ok(`invite ${iface}`)),
    roots: (iface) => ok(`roots ${iface}`),
    accept: (iface, root) => ok(`accept ${iface} ${root}`),
    remove: (iface, root) => ok(`remove ${iface} ${root}`),
  };
  return { joining, calls };
}

test('each roots command reaches its own operation with the interface and the root it names', async () => {
  // Catches: an accept run as a remove, or the root of `/interfaces roots accept chatnet g7` dropped on the way.
  const { joining, calls } = recorder();
  await rootsCommand(joining, 'interfaces.invite', { name: 'chatnet' });
  await rootsCommand(joining, 'interfaces.roots', { name: 'chatnet' });
  await rootsCommand(joining, 'interfaces.roots.accept', { name: 'chatnet', root: 'g7' });
  await rootsCommand(joining, 'interfaces.roots.remove', { name: 'chatnet', root: 'g8' });
  assert.deepEqual(calls, ['invite chatnet', 'roots chatnet', 'accept chatnet g7', 'remove chatnet g8']);
});

test('another command passes by, and a console with no joining refuses the roots commands', async () => {
  // Catches: `/interfaces remove` (a settings item) swallowed as a roots remove, or a throw where no core runs.
  const { joining, calls } = recorder();
  assert.equal(rootsCommand(joining, 'interfaces.remove', { name: 'chatnet' }), null);
  assert.deepEqual(calls, []);
  const refused = await rootsCommand(null, 'interfaces.invite', { name: 'chatnet' });
  assert.equal(refused?.status, 'failed');
});
