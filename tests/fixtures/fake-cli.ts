#!/usr/bin/env node
// A stub that mimics the outputs of `codex exec` and `claude -p` for tests/agent-backend-*.test.ts. It is run as the
// backend's binary and never talks to a provider. `codex exec` is told apart by its first argument `exec`; the
// final message goes to the file after `-o`, and stdout carries a banner, the message and the `tokens used` line.
// `claude -p` prints the final message to stdout. The brief is read from stdin, else from the last argument that is
// no flag. The behaviour comes from the environment the backend was given:
//   FAKE_MODE  ok (default), report (the final message is a JSON of argv, stdin, cwd and env), fail (exit 3, no
//              final message), silent (exit 0, no final message), hang (a grandchild and this process sleep; the
//              grandchild's pid is written to FAKE_PID_FILE)
//   FAKE_FINAL the final message in mode ok
//   FAKE_TOKENS the number printed after `tokens used` (default 17,065)
//   FAKE_TOKENS_ON  stderr: the banner and the `tokens used` block go to stderr, as the real codex prints them
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const codex = argv[0] === 'exec';
const outIndex = argv.indexOf('-o');
const outFile = outIndex >= 0 ? argv[outIndex + 1] : undefined;
const mode = process.env.FAKE_MODE ?? 'ok';

let stdin = '';
if (!process.stdin.isTTY) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
}

if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(grandchild.pid));
  setInterval(() => {}, 1000);
} else {
  let final = process.env.FAKE_FINAL ?? 'final message';
  if (mode === 'report') {
    const flagless = argv.filter((arg) => !arg.startsWith('-'));
    final = JSON.stringify({ argv, stdin, last: flagless[flagless.length - 1] ?? '', cwd: process.cwd(), env: process.env });
  }
  if (mode === 'fail') {
    process.stderr.write('ERROR: stub failure\n');
    process.exit(3);
  }
  if (mode === 'silent') process.exit(0);
  if (codex) {
    if (outFile) fs.writeFileSync(outFile, final);
    const block = `tokens used\n${process.env.FAKE_TOKENS ?? '17,065'}\n`;
    if (process.env.FAKE_TOKENS_ON === 'stderr') {
      process.stderr.write(`OpenAI Codex v0.164.0\n--------\nuser\n${stdin}\ncodex\n${final}\n${block}`);
      process.stdout.write(`${final}\n`);
    } else {
      process.stdout.write(`Reading additional input from stdin...\nOpenAI Codex v0.164.0\n--------\nuser\n${stdin}\ncodex\n${final}\n${block}${final}\n`);
    }
  } else {
    process.stdout.write(`${final}\n`);
  }
}
