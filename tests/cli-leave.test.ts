// Leaving the owner chat: Ctrl-C and a SIGINT end it the same way and give the terminal back. The chat draws on the
// alternate screen, so leaving means raw mode off, the cursor shown, bracketed paste off, mouse tracking off when it
// was on, the primary screen back with the chat's frames gone, the input stream released, and the process exiting 0 as
// it does on the normal quit. A SIGTERM and a crash give the terminal back too. Each case runs in a child process (tests/fixtures/chat-leave-harness.ts) over a fake terminal,
// because a SIGINT that nobody handles ends the process it is sent to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastSwitch, visible } from './fixtures/chat-leave-rig.ts';
import type { LeaveReport } from './fixtures/chat-leave-rig.ts';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chat-leave-harness.ts');

type Ended = { code: number | null; signal: NodeJS.Signals | null; report: LeaveReport | null; stderr: string };

/** Runs the chat in a child, ends it by `how`, and returns how the child ended and what it did to the terminal. */
function leave(how: 'key' | 'signal' | 'term' | 'crash', mouse: boolean): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, mouse ? '1' : '0', how], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the chat did not leave: ${stderr}`));
    }, 15_000);
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if ((how === 'signal' || how === 'term') && !signalled && out.includes('ready\n')) {
        signalled = true;
        child.kill(how === 'signal' ? 'SIGINT' : 'SIGTERM');
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = out.split('\n').find((one) => one.startsWith('{'));
      resolve({ code, signal, report: line === undefined ? null : (JSON.parse(line) as LeaveReport), stderr });
    });
  });
}

for (const how of ['key', 'signal'] as const) {
  for (const mouse of [false, true]) {
    const name = `${how === 'key' ? 'Ctrl-C' : 'a SIGINT'} ${mouse ? 'with' : 'without'} mouse tracking`;

    // Bug: a SIGINT ended the chat through the signal handler of the render library, which restored the cursor and
    // killed the process with the signal: no exit 0, and the mouse tracking the chat switched on stayed on.
    test(`${name} ends the chat with exit 0`, async () => {
      const ended = await leave(how, mouse);
      assert.equal(ended.signal, null, `ended by a signal: ${ended.signal}`);
      assert.equal(ended.code, 0, ended.stderr);
      // The lead: the report gets a name, so the read stays three segments deep (R.2).
      const report = ended.report;
      assert.equal(report?.raw.at(-1), false, 'the chat did not return to its caller before the process ended');
    });

    test(`${name} gives the terminal back`, async () => {
      const { report } = await leave(how, mouse);
      assert.ok(report, 'no report: the chat did not return');
      assert.equal(report.raw.at(-1), false, 'raw mode is left on');
      assert.ok(report.raw.includes(true), 'the chat never took raw mode, so this proves nothing');
      assert.equal(lastSwitch(report.writes, '?25'), 'on', 'the cursor stays hidden');
      assert.equal(lastSwitch(report.writes, '?2004'), 'off', 'bracketed paste stays on');
      assert.equal(lastSwitch(report.writes, '?1000'), mouse ? 'off' : null, 'mouse tracking stays on');
      assert.equal(lastSwitch(report.writes, '?1006'), mouse ? 'off' : null, 'mouse reporting stays on');
      // The chat drew inline until the owner asked for a static window: every animation frame then reached the
      // terminal's scrollback. It draws on the alternate screen, so leaving it is part of giving the terminal back.
      assert.equal(lastSwitch(report.writes, '?1049'), 'off', 'the alternate screen stays on');
    });

    test(`${name} releases the input stream`, async () => {
      const { report } = await leave(how, mouse);
      assert.ok(report, 'no report: the chat did not return');
      assert.equal(report.holds.at(-1), 'unref', 'stdin still holds the process open');
      assert.equal(
        report.holds.filter((one) => one === 'ref').length,
        report.holds.filter((one) => one === 'unref').length
      );
      assert.equal(report.dataListeners, 0, 'a data listener stays on stdin');
      if (mouse) assert.equal(report.paused, true, 'the real stdin is left flowing');
    });

    // The newline after the last frame kept the shell prompt off the chat's footer line while the chat drew inline. On
    // the alternate screen the frame leaves with the screen, and a newline written after it would push the prompt down.
    test(`${name} leaves the alternate screen after its last frame and writes nothing visible after it`, async () => {
      const { report } = await leave(how, mouse);
      assert.ok(report, 'no report: the chat did not return');
      const left = report.writes.lastIndexOf('\u001b[?1049l');
      assert.ok(left > 0, 'the chat never left the alternate screen');
      assert.match(visible(report.writes.slice(0, left)), /neptunia/, 'the header was drawn before leaving');
      assert.equal(visible(report.writes.slice(left)).trim(), '', 'text written to the primary screen after leaving');
    });
  }
}

for (const how of ['term', 'crash'] as const) {
  for (const mouse of [false, true]) {
    const name = `${how === 'term' ? 'a SIGTERM' : 'a crash'} ${mouse ? 'with' : 'without'} mouse tracking`;

    // Bug: only Ctrl-C and a SIGINT ran the chat's own teardown, so a SIGTERM or an uncaught error left mouse tracking
    // on, and the owner's shell printed a report for every click and wheel turn.
    test(`${name} gives the terminal back`, async () => {
      const { report, stderr } = await leave(how, mouse);
      assert.ok(report, `no report: ${stderr}`);
      assert.equal(lastSwitch(report.writes, '?1049'), 'off', 'the alternate screen stays on');
      assert.equal(lastSwitch(report.writes, '?25'), 'on', 'the cursor stays hidden');
      assert.equal(lastSwitch(report.writes, '?1000'), mouse ? 'off' : null, 'mouse tracking stays on');
      assert.equal(lastSwitch(report.writes, '?1006'), mouse ? 'off' : null, 'mouse reporting stays on');
    });
  }
}
