// Leaving the owner chat: Ctrl-C and a SIGINT end it the same way and give the terminal back. The chat draws inline (no
// alternate screen), so leaving means raw mode off, the cursor shown, bracketed paste off, mouse tracking off when it
// was on, the input stream released, the cursor on a fresh line below the last frame, and the process exiting 0 as it
// does on the normal quit. Each case runs in a child process (tests/fixtures/chat-leave-harness.ts) over a fake terminal,
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
function leave(how: 'key' | 'signal', mouse: boolean): Promise<Ended> {
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
      if (how === 'signal' && !signalled && out.includes('ready\n')) {
        signalled = true;
        child.kill('SIGINT');
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
      assert.equal(ended.report?.raw.at(-1), false, 'the chat did not return to its caller before the process ended');
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
      assert.equal(lastSwitch(report.writes, '?1049'), null, 'the chat draws inline: no alternate screen');
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

    // Bug: the last frame ended with no newline, so the shell prompt was drawn at the end of the chat's footer line.
    test(`${name} leaves the cursor on a fresh line below the last frame`, async () => {
      const { report } = await leave(how, mouse);
      assert.ok(report, 'no report: the chat did not return');
      assert.match(visible(report.writes), /Ctrl\+R search[^\n]*\n$/, 'the footer line is the last thing on screen');
    });
  }
}
