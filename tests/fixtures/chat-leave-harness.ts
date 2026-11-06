// The process under tests/cli-leave.test.ts: the owner chat over a fake terminal, ended the way a terminal ends it.
// It does what runInkChat in bin/neptunia.ts does around the chat: waits for `runInteractive`, then exits 0.
//   argv: <mouse: 1|0> <how: key|signal>
// It prints `ready` once the first frame is drawn. With `key` it types Ctrl-C itself; with `signal` it waits for the
// SIGINT its parent sends. When `runInteractive` returns it prints the report as one JSON line and exits 0.
import { runInteractive } from '../../cli/index.ts';
import type { ChatEnv } from '../../cli/index.ts';
import { leaveRig } from './chat-leave-rig.ts';

const [mouse, how] = process.argv.slice(2);
const rig = leaveRig();
const env: ChatEnv = {
  title: 'neptunia',
  commands: [{ name: 'status', help: 'the short summary' }],
  history: [],
  still: true,
  mouse: mouse === '1',
  send: () => {},
  panelOf: () => Promise.resolve(null),
  subscribe: () => {},
  status: () => Promise.resolve(null),
  saveHistory: () => {},
  now: () => 1000,
};

const running = runInteractive(env, { stdin: rig.stdin, stdout: rig.stdout });
while (!rig.drawn()) await new Promise((resolve) => setTimeout(resolve, 10));
// Two turns of the event loop: the key handler is bound to the frame just drawn.
await new Promise((resolve) => setTimeout(resolve, 50));
process.stdout.write('ready\n');
if (how === 'key') rig.type('\u0003');
await running;
process.stdout.write(`${JSON.stringify(rig.report())}\n`);
process.exit(0);
