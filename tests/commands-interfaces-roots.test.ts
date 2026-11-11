// The owner's roots commands (src/interface/commands/interfaces-roots.ts): `/interfaces <name> invite` and
// `/interfaces <name> list`, parsed by the chat's table, each reach their own method of the core's joining with the
// interface they name, any other command passes by, and a console with no joining answers without throwing. The
// joining is a recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootsCommand } from '../src/interface/commands/interfaces-roots.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { JoiningAnswer, RootJoining } from '../src/interface/root-joining.ts';

function recorder(): { joining: RootJoining; calls: Array<string> } {
  const calls: Array<string> = [];
  const ok = (call: string): JoiningAnswer => {
    calls.push(call);
    return { text: call, status: 'ok' };
  };
  // The joining after the owner's cut of 2026-11-11: no waiting state, so no `isOpen`, `accept` or `remove`.
  const joining: RootJoining = {
    rootChanged: () => null,
    rows: () => [],
    invite: (iface) => Promise.resolve(ok(`invite ${iface}`)),
    roots: (iface) => ok(`roots ${iface}`),
  };
  return { joining, calls };
}

/** One typed line, parsed by the table, handed to the roots commands. */
function typed(joining: RootJoining | null, line: string): Promise<JoiningAnswer> | null {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, `${line}: ${parsed.ok ? '' : parsed.reason}`);
  return rootsCommand(joining, parsed.name, parsed.args);
}

test('invite and list reach their own operation with the interface they name', async () => {
  // Catches: a list run as an invite, or the interface's name dropped on the way.
  // Changed: the lines name the interface before the command, and accept and remove are gone, by the owner's
  // decisions of 2026-11-11.
  const { joining, calls } = recorder();
  await typed(joining, '/interfaces chatnet invite');
  await typed(joining, '/interfaces chatnet list');
  assert.deepEqual(calls, ['invite chatnet', 'roots chatnet']);
});

test('another command passes by, and a console with no joining refuses the roots commands', async () => {
  // Catches: `/interfaces chatnet remove servers 111` (a settings item) swallowed by the roots commands, `/interfaces list`
  // (every interface) taken for the roots of one, or a throw where no core runs.
  const { joining, calls } = recorder();
  assert.equal(typed(joining, '/interfaces chatnet remove servers 111'), null);
  assert.equal(typed(joining, '/interfaces list'), null);
  assert.deepEqual(calls, []);
  const refused = await typed(null, '/interfaces chatnet invite');
  assert.equal(refused?.status, 'failed');
});
