// What a `neptunia` child does with an answer larger than a pipe holds (64 KiB on Linux). The command line is meant
// for `| jq`, so the bytes a reader receives must equal the answer however slowly it reads, the exit code must still
// tell success from refusal, and a reader that goes away (`| head -1`) ends the child without a stack trace. One
// recording core answers; the children are real.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { BIN, REPO } from './fixtures/core-units.ts';
import type { Dirs, Exit } from './fixtures/core-units.ts';
import { cliFolders, startRecordingCore } from './fixtures/recording-core.ts';
import type { RecordingCore, Reply } from './fixtures/recording-core.ts';

/** Four times what a pipe holds, as one JSON document, the shape a script pipes into `jq`. */
const BIG = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ row: i, text: 'x'.repeat(40) })));
const ANSWER_BYTES = Buffer.byteLength(BIG) + 1;

let dirs: Dirs;
let core: RecordingCore;
let reply: Reply = { status: 'ok', text: BIG };

before(async () => {
  dirs = cliFolders();
  core = await startRecordingCore(dirs, () => reply);
});

after(async () => {
  await core.close();
  rmSync(dirs.root, { recursive: true, force: true });
});

function spawnPiped(
  argv: ReadonlyArray<string>,
  extra: NodeJS.ProcessEnv = {}
): { child: ChildProcess; exited: Promise<Exit> } {
  const child = spawn(process.execPath, [BIN, ...argv], {
    cwd: REPO,
    env: { ...process.env, NEPTUNIA_PRIVATE_DIR: dirs.privateDir, NEPTUNIA_DATA_DIR: dirs.dataDir, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<Exit>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

/**
 * Reads a stream as a slow consumer does: nothing for a while, then 16 KiB every 20 ms. The listener is attached at
 * once, because a child's stream nobody listens to is drained and thrown away when the child exits.
 */
function readSlowly(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const readable = stream as NodeJS.ReadableStream & { read(size: number): Buffer | null };
  return new Promise((resolve) => {
    const pieces: Array<Buffer> = [];
    let ended = false;
    stream.on('readable', () => undefined);
    stream.once('end', () => {
      ended = true;
      resolve(Buffer.concat(pieces));
    });
    const tick = (): void => {
      if (ended) return;
      const piece = readable.read(16 * 1024);
      if (piece !== null) pieces.push(piece);
      setTimeout(tick, 20);
    };
    setTimeout(tick, 1500);
  });
}

const LARGE_ANSWERS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['a direct command', ['rules', 'list']],
  ['-p with a slash command', ['-p', '/rules list']],
  ['a tasks command', ['tasks', 'list']],
];

for (const [name, argv] of LARGE_ANSWERS) {
  test(`${name} delivers an answer past the pipe size whole to a slow reader`, async () => {
    // Catches: the process exits before the stdout pipe drains, so `| jq` gets the first 65536 bytes and exit 0.
    reply = { status: 'ok', text: BIG };
    const { child, exited } = spawnPiped(argv, { NEPTUNIA_TASK_TOKEN: 'recording-core-token' });
    let errText = '';
    child.stderr!.on('data', (chunk: Buffer) => (errText += chunk.toString()));
    const [received, exit] = await Promise.all([readSlowly(child.stdout!), exited]);
    assert.equal(exit.code, 0, errText.slice(0, 300));
    assert.equal(received.length, ANSWER_BYTES);
    assert.equal((JSON.parse(received.toString()) as Array<unknown>).length, 6000);
  });
}

test('a refusal with a large reason still exits 1, the whole reason on stderr and nothing on stdout', async () => {
  // Catches: flushing the answer changes the exit code, or the refusal text is cut on a pipe.
  reply = { status: 'failed', text: BIG };
  const { child, exited } = spawnPiped(['rules', 'remove', '9']);
  const [errText, out, exit] = await Promise.all([readSlowly(child.stderr!), readSlowly(child.stdout!), exited]);
  assert.equal(exit.code, 1);
  assert.equal(out.length, 0);
  assert.ok(errText.toString().includes(BIG.slice(-100)), 'the end of the reason arrived');
});

test('a reader that closes the pipe early ends the child without a stack trace', async () => {
  // Catches: `neptunia ... | head -1` prints an unhandled EPIPE error with a stack, or hangs.
  reply = { status: 'ok', text: BIG };
  const { child, exited } = spawnPiped(['rules', 'list']);
  let errText = '';
  child.stderr!.on('data', (chunk: Buffer) => (errText += chunk.toString()));
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
  child.stdout!.destroy();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const exit = await exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, 'the child ended by itself');
  assert.doesNotMatch(errText, /EPIPE|\n\s+at /, errText.slice(0, 400));
});
