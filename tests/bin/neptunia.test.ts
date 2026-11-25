// A real `neptunia` process (bin/neptunia.ts): what only a child proves. The argv the shell hands it reaches the
// handler byte for byte and never meets a shell, a request that needs a person at a terminal ends at once with what to
// do instead, the dispatcher's first word picks the handler, and the exit code and the streams say how it ended. Exit
// codes: 0 success with the answer on stdout, 1 an operational failure with the reason on stderr, 2 bad syntax with
// the reason on stderr.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { COMMANDS_LINE } from '../../bin/neptunia-request.ts';
import {
  startUnitsCore,
  withRig,
  ANSWER,
  query,
  runCli,
  CLI_CLIENT,
  addClient,
  folders,
  spawnCli,
  until,
  BIN,
  REPO,
  settle,
} from '../fixtures/core-units.ts';
import type { Dirs, Exit } from '../fixtures/core-units.ts';
import { cliFolders, handled, runChild, startRecordingCore, withRecordingCore } from '../fixtures/recording-core.ts';
import type { RecordingCore, Reply, Received } from '../fixtures/recording-core.ts';
import { syntheticPng } from '../fixtures/synthetic-png.ts';
import { chainsOf } from '../fixtures/chains.ts';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tempDir } from '../fixtures/tmp.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { lockPathOf, openMemoryDb } from '../../src/memory/db/open.ts';
import { fakeVendor } from '../fixtures/fake-vendor.ts';
import { writeKeysFile } from '../fixtures/keys-file.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** How long a request with nobody to answer it may take (ms), a child's start included. */
const PROMPTLY = 8000;

/** A value that a shell, a line split or a re-quoting would change or run: `$(...)` would create `canary`. */
const nasty = (canary: string): string => `a "b" \`c\` $(touch ${canary}) $HOME 'd' \\e`;

/** What a line split or a trim would change: runs of spaces, a tab, a newline, both ends, and Greek. */
const SPACED = '  lead  double\ttab\nnewline κουνέλι trail ';

const SECRET = 'sk-or-v1-zeta-SECRETVALUE-0001';
const SECRET_QUESTION = 'zeta-key-value:';

// What a child alone can prove. One recording core serves them; each test sets what it answers.
describe('a real neptunia at its boundaries, over one recording core', () => {
  let dirs: Dirs;
  let core: RecordingCore;
  let answer: () => Reply | null = () => null;

  before(async () => {
    dirs = cliFolders();
    core = await startRecordingCore(dirs, (command) => answer() ?? handled(command));
  });

  after(async () => {
    await core.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  /** The recording core emptied, answering with `reply` or with `handled <name>`. */
  function fresh(reply: () => Reply | null = () => null): void {
    core.commands.length = 0;
    core.lines.length = 0;
    answer = reply;
  }

  test('a hostile value reaches the handler whole from a real argv, and no shell runs it', async () => {
    // Catches: the process re-quotes or joins its argv, or a shell sees the value on the way to the socket.
    fresh();
    const canary = join(dirs.root, 'canary');
    const text = `${nasty(canary)}${SPACED}`;
    // The writes of lore are place-qualified.
    const run = await runChild(dirs, ['memory', 'places', 'lore', 'add', 'g1', 'The Tower', 'tower, spire', text]);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, [
      { name: 'memory.places.lore.add', args: { place: 'g1', title: 'The Tower', keys: 'tower, spire', text } },
    ]);
    assert.equal(existsSync(canary), false, 'no shell ran the value');
  });

  /**
   * The environment that records every module the child resolves into `imports`. The list of a run is never empty, so
   * an empty list means the hook did not run and the assertion on Ink means nothing.
   */
  function importProbe(): { env: NodeJS.ProcessEnv; imports(): Array<string> } {
    const log = join(dirs.root, 'imports');
    const probe = join(dirs.root, 'probe.mjs');
    rmSync(log, { force: true });
    writeFileSync(
      probe,
      `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    appendFileSync(${JSON.stringify(log)}, specifier + '\\n');
    return next(specifier, context);
  },
});
`
    );
    return {
      env: { NODE_OPTIONS: `--import=${probe}` },
      imports: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    };
  }

  const PANELS: ReadonlyArray<{ what: string; argv: ReadonlyArray<string> }> = [
    { what: 'the chat with no arguments', argv: [] },
    { what: '-p /setup', argv: ['-p', '/setup'] },
    { what: 'neptunia clear', argv: ['clear'] },
  ];

  for (const { what, argv } of PANELS) {
    test(`${what} with no terminal and an open input explains itself at once, with no Ink, line or command`, async () => {
      // Catches: the request waits on a pipe nobody writes to, tries Ink, or answers nothing at all.
      fresh();
      const probe = importProbe();
      // The plain chat over a pipe is asked for by name; a request that did not ask for it gets the explanation.
      const env = { ...probe.env, NEPTUNIA_PLAIN_CHAT: undefined };
      const run = await runChild(dirs, argv, { env, open: true, ms: PROMPTLY });
      assert.equal(run.code, 2, `${run.stderr.slice(0, 200)}${run.stdout.slice(0, 200)}`);
      assert.equal(run.stdout, '');
      assert.ok(run.stderr.includes(COMMANDS_LINE), 'the explanation names the table');
      assert.deepEqual(core.commands, []);
      assert.deepEqual(core.lines, [], 'no model turn');
      const imports = probe.imports();
      assert.ok(imports.length > 0, 'the import probe ran');
      assert.deepEqual(
        imports.filter((one) => one === 'ink' || one.endsWith('interfaces/cli/index.ts')),
        [],
        'Ink is not loaded'
      );
    });
  }

  /** The environment of a child whose stdout says it is a terminal, as a shell at a terminal runs it. */
  function terminalStdout(): NodeJS.ProcessEnv {
    const preload = join(dirs.root, 'tty.mjs');
    writeFileSync(preload, 'process.stdout.isTTY = true;\n');
    return { NODE_OPTIONS: `--import=${preload}` };
  }

  for (const argv of [['clear'], ['-p', '/clear']]) {
    test(`neptunia ${argv.join(' ')} at a terminal is refused with exit 2 and reaches no core`, async () => {
      // Catches: the shell form answers nothing and exits 0, so the owner thinks something was cleared (only the
      // chat has a screen to clear).
      fresh();
      const run = await runChild(dirs, argv, { env: terminalStdout(), ms: PROMPTLY });
      assert.equal(run.code, 2, `${run.stderr.slice(0, 200)}${run.stdout.slice(0, 200)}`);
      assert.ok(run.stderr.includes('clear'), 'the refusal names the command');
      assert.deepEqual(core.commands, []);
    });
  }

  test('a secret given as a word exits 2 from a real argv, reaches no core and is not echoed', async () => {
    // Catches: the process prints the refused argv back, or sends the command before it is refused.
    fresh();
    const run = await runChild(dirs, ['keys', 'add', 'k1', SECRET]);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, []);
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });

  test('a secret question with no terminal exits 1 at once, names the channel and leaves stdin unread', async () => {
    // Catches: the question waits on a pipe that stays open, or whatever is on the pipe is sent as the key value.
    fresh(() => ({
      status: 'ask',
      text: SECRET_QUESTION,
      dialogId: 'dialog-1',
      prompt: SECRET_QUESTION,
      secret: true,
    }));
    const run = await runChild(dirs, ['keys', 'add', 'k1'], { input: `${SECRET}\n`, open: true, ms: PROMPTLY });
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes(SECRET_QUESTION), 'the missing input is named');
    assert.ok(run.stderr.includes('--secret-stdin'), run.stderr.slice(0, 200));
    assert.equal(core.commands.length, 1, 'stdin was not sent as the answer');
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });

  test('the real handler stores a token given through --secret-stdin, and prints none of it', async () => {
    // Catches: the channel parses but the real dialog broker never gets the answer, or the value is echoed.
    await withRig({}, async ({ dirs: rig, llm, cores }) => {
      cores.push(await startUnitsCore(rig, llm, () => T0));
      // A service key stands for the real handler behind the dialog.
      const run = await runChild(rig, ['keys', 'service', 'set', 'youtube', '--secret-stdin'], {
        input: `${SECRET}\n`,
      });
      assert.equal(run.code, 0, run.stderr.slice(0, 200));
      const file = join(rig.privateDir, 'keys.json');
      assert.equal(
        (JSON.parse(readFileSync(file, 'utf8')) as { services?: { youtube?: string } }).services?.youtube,
        SECRET
      );
      assert.equal((run.stdout + run.stderr).includes(SECRET), false);
    });
  });

  test('interface run cli exits 2, says to run neptunia and connects to no core', async () => {
    // Catches: the unit runner starting the owner's terminal chat as a unit with no terminal, since the package
    // exports start(host).
    fresh();
    const before = core.connections();
    const run = await runChild(dirs, ['interface', 'run', 'cli'], { ms: PROMPTLY });
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('run neptunia'), run.stderr);
    assert.equal(core.connections(), before, 'no link was opened');
  });
});

const count = (text: string, part: string): number => text.split(part).length - 1;

// What a child alone can prove. One recording core serves them; each test sets what it answers.
describe('a real neptunia dispatching through one recording core', () => {
  let dirs: Dirs;
  let core: RecordingCore;
  let answer: () => Reply | null = () => null;

  before(async () => {
    dirs = cliFolders();
    core = await startRecordingCore(dirs, (command) => answer() ?? handled(command));
  });

  after(async () => {
    await core.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  /** The recording core emptied, answering with `reply` or with `handled <name>`. */
  function fresh(reply: () => Reply | null = () => null): void {
    core.commands.length = 0;
    core.lines.length = 0;
    answer = reply;
  }

  test('interface list reaches the management family: the answer alone on stdout, exit 0', async () => {
    // Catches: the first word `interface` stays the runner's, a result goes to stderr, or a log line joins what a script reads.
    fresh();
    const run = await runChild(dirs, ['interfaces', 'list']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(run.stdout, 'handled interfaces.list\n');
    assert.equal(run.stderr, '');
    assert.deepEqual(core.commands, [{ name: 'interfaces.list', args: {} }]);
    assert.deepEqual(core.lines, [], 'a management command is no line of the chat');
  });

  test('a command answered failed exits 1 with the reason on stderr and nothing on stdout', async () => {
    // Catches: a script reads a refusal on stdout as a result, or the handler's refusal is taken for bad syntax.
    fresh(() => ({ status: 'failed', text: 'zeta-refusal-reason' }));
    const run = await runChild(dirs, ['rules', 'remove', '9']);
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('zeta-refusal-reason'), run.stderr.slice(0, 200));
  });

  test('a word the table does not know exits 2 with the usage and the table, and connects to no core', async () => {
    // Catches: an unknown word becomes a prompt to the persona, or spends a connection before it is refused.
    fresh();
    const connections = core.connections();
    const run = await runChild(dirs, ['hello', 'there', 'how', 'are', 'you']);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('usage:'), run.stderr.slice(0, 200));
    assert.ok(run.stderr.includes(COMMANDS_LINE), 'the usage names the table');
    assert.equal(core.connections(), connections);
  });

  test('a line the table refuses exits 2 with its reason on stderr and sends nothing', async () => {
    // Catches: a refusal exits 1 as if a command had failed, or goes on to the core.
    fresh();
    const run = await runChild(dirs, ['usage', '90d']);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('90d'), run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, []);
  });

  test('-p with blank text is a usage error and no turn', async () => {
    // Catches: an empty prompt goes to the model.
    fresh();
    const run = await runChild(dirs, ['-p', '   ']);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.deepEqual(core.lines, []);
  });

  test('neptunia doctor live runs the doctor with the core asked for its probes', async () => {
    // Catches: the table's `/doctor live` has no direct spelling because the native doctor only reads --live.
    fresh();
    const run = await runChild(dirs, ['doctor', 'live']);
    assert.equal(run.stderr.startsWith('neptunia: usage:'), false, run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, [{ name: 'doctor.live', args: {} }]);
  });

  test('neptunia services status <unit> keeps its form and runs systemctl with that unit', async () => {
    // Catches: `service` is rerouted to a form that does not exist, so the units cannot be read.
    fresh();
    const bin = join(dirs.root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "zeta-systemctl $*"\nexit 3\n', { mode: 0o755 });
    const run = await runChild(dirs, ['services', 'status', 'zeta.service'], { env: { PATH: bin } });
    assert.ok(run.stdout.includes('zeta-systemctl status zeta.service'), run.stdout);
    assert.equal(run.code, 3, "systemctl's exit code is the command's");
    assert.deepEqual(core.commands, []);
  });

  test('-p with text is one turn of the persona, even when it opens with a table word: the reply on stdout, and it ends', async () => {
    // Catches: the slash is optional, so a sentence that opens with a table word runs that command, or the child waits on
    // an input nobody closes.
    const text = 'rules list say "hi" `now` $(echo zeta71)';
    await withRig({}, async ({ dirs: rig, llm, cores }) => {
      cores.push(await startUnitsCore(rig, llm, () => T0));
      const run = await runChild(rig, ['-p', text], { open: true });
      assert.equal(run.code, 0, run.stderr.slice(0, 200));
      assert.equal(count(run.stdout, ANSWER), 1, run.stdout);
      assert.equal(llm.requests.length, 1, 'one turn');
      assert.ok(
        JSON.stringify(llm.requests[0]).includes(JSON.stringify(text).slice(1, -1)),
        'the whole text reached the persona'
      );
      assert.deepEqual(
        query(
          rig,
          'SELECT s.kind, p.id AS place FROM sources s JOIN places p ON p.id = s.place_id WHERE s.text = ?',
          text
        ),
        [{ kind: 'seen', place: 'cli:dm:owner' }]
      );
    });
  });

  test('a rule added directly is stored whole and -p /rules list reads it, with no model and nothing in memory', async () => {
    // Catches: the value is cut or re-quoted on its way into the rules, or a management command becomes a prompt.
    const rule = 'a "b" `c` $(d) zeta71';
    await withRig({}, async ({ dirs: rig, llm, cores }) => {
      cores.push(await startUnitsCore(rig, llm, () => T0));
      const added = await runCli(rig, ['rules', 'add', rule]);
      assert.equal(added.code, 0, added.stderr.slice(0, 200));
      const listed = await runCli(rig, ['-p', '/rules list']);
      assert.equal(listed.code, 0, listed.stderr.slice(0, 200));
      assert.ok(listed.stdout.includes(rule), listed.stdout);
      assert.equal(llm.requests.length, 0);
      assert.deepEqual(query(rig, "SELECT kind FROM sources WHERE text LIKE '%zeta71%'"), []);
    });
  });
});

const CAPTION = 'Explain this chart, quince-staging.';

test('a command with no core listening exits 1 with the reason on stderr and nothing on stdout', async () => {
  // Bug: the command line hangs on a missing socket, or prints an empty answer and exits 0.
  const dirs = folders();
  addClient(dirs.privateDir, CLI_CLIENT);
  const run = await runCli(dirs, ['memory', 'users', 'list']);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('no core listens'), run.stderr);
});

test('an image that cannot be staged is refused before the core sees the caption', async () => {
  // Bug: a text file named .png sends an empty image part and a turn over nothing.
  await withRig(
    { config: { models: { routes: chainsOf({ vision: 'example/vision-model' }) } } },
    async ({ dirs, llm, clis, cores }) => {
      cores.push(await startUnitsCore(dirs, llm));
      const file = join(dirs.root, 'not-an-image.png');
      writeFileSync(file, 'not-an-image');
      const cli = spawnCli(dirs, ['-p', CAPTION, '--attach', file]);
      clis.push(cli);
      const exit = await cli.exited;
      assert.notEqual(exit.code, 0);
      assert.notEqual(cli.stderr(), '', 'the failure is said');
      assert.equal(cli.stdout().includes(CAPTION), false);
      assert.equal(llm.requests.length, 0, 'no model request');
      assert.deepEqual(query(dirs, 'SELECT text FROM sources WHERE text = ?', CAPTION), [], 'no stored line');
      // A good image staged after the refusal still reaches the core: the refusal left no half-open state behind.
      const good = join(dirs.root, 'chart.png');
      writeFileSync(good, syntheticPng(3));
      const sent = spawnCli(dirs, ['-p', CAPTION, '--attach', good]);
      clis.push(sent);
      assert.deepEqual(await sent.exited, { code: 0, signal: null });
    }
  );
});

const VISION = { models: { routes: chainsOf({ vision: 'example/vision-model' }) } };

const visionRequests = (llm: { requests: Array<unknown>; options: Array<unknown> }): Array<string> =>
  llm.requests.flatMap((request, index) =>
    (llm.options[index] as { role?: string } | null)?.role === 'vision' ? [JSON.stringify(request)] : []
  );

test("a caption with an image reaches the persona's turn, and the vision request carries exactly the bytes of the file", async () => {
  // Bug: the chip says ready and the wire carries a reference no reader of the core can open.
  const png = syntheticPng(77);
  await withRig({ config: VISION }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const file = join(dirs.root, 'chart $(example).png');
    writeFileSync(file, png);
    const cli = spawnCli(dirs, ['-p', 'Explain this chart.', '--attach', file]);
    clis.push(cli);
    await until(
      () => visionRequests(llm).some((request) => request.includes(png.toString('base64'))),
      () => `the vision request; stderr:\n${cli.stderr().slice(-1000)}`
    );
    assert.deepEqual(await cli.exited, { code: 0, signal: null });
    assert.ok(cli.stdout().includes(ANSWER), 'the reply is printed');
    const caption = query(dirs, 'SELECT text FROM sources WHERE text = ?', 'Explain this chart.');
    assert.equal(caption.length, 1, 'the caption is one stored line');
    const stored = JSON.stringify(query(dirs, 'SELECT * FROM sources'));
    assert.equal(
      stored.includes(png.toString('base64')),
      false,
      'memory keeps the identity of the image, not its bytes'
    );
  });
});

// ---- neptunia doctor -----------------------------------------------------------------------------------------------

test('neptunia doctor warns about an unknown key and a key of the wrong type in config/config.json', async () => {
  const dirs = folders({});
  fs.rmSync(path.join(dirs.privateDir, 'config', 'config.json'));
  fs.mkdirSync(path.join(dirs.privateDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.privateDir, 'config', 'config.json'),
    JSON.stringify({ llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } })
  );
  fs.writeFileSync(
    path.join(dirs.privateDir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'core-1', value: 'sk-or-test-not-a-real-key' }], extra: {}, roles: {} }),
    {
      mode: 0o600,
    }
  );
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed: unknown = JSON.parse(run.stdout);
  const checks =
    typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'checks'))
      ? (Reflect.get(parsed, 'checks') as Array<{ name: string; status: string; detail: string }>)
      : [];
  const config = checks.find((check) => check.name === 'config');
  assert.equal(config?.status, 'warn');
  const detail = config?.detail ?? '';
  assert.ok(detail.includes('llm.maxRequestsPerDay'), detail);
  assert.ok(detail.includes('nosuch'), detail);
});

type Check = { name: string; status: string; detail: string };

async function doctorChecks(local: Record<string, unknown>): Promise<Array<Check>> {
  const dirs = folders({});
  for (const [name, profile] of Object.entries(local)) {
    fs.mkdirSync(path.join(dirs.dataDir, 'agents', name), { recursive: true });
    if (profile !== null)
      fs.writeFileSync(path.join(dirs.dataDir, 'agents', name, 'profile.json'), JSON.stringify(profile));
  }
  fs.writeFileSync(
    path.join(dirs.privateDir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'core-1', value: 'sk-or-test-not-a-real-key' }], extra: {}, roles: {} }),
    { mode: 0o600 }
  );
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed: unknown = JSON.parse(run.stdout);
  return typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'checks'))
    ? (Reflect.get(parsed, 'checks') as Array<Check>)
    : [];
}

test('neptunia doctor fails its agents check on a local profile with a bad value, naming the agent and the key', async () => {
  // Bug: a broken local profile stops the core at start, and the doctor says nothing before the owner restarts.
  // Changed: a local folder overlays a tracked agent alone, so the broken profile is the scout's overlay.
  const check = (await doctorChecks({ scout: { limits: { steps: 0 } } })).find((entry) => entry.name === 'agents');
  assert.equal(check?.status, 'fail');
  assert.ok((check?.detail ?? '').includes('"scout"'), check?.detail);
});

test('neptunia doctor passes its agents check when a local folder holds no profile', async () => {
  // Bug: the check fails on a folder an older version left, which is no agent.
  const check = (await doctorChecks({ leftover: null })).find((entry) => entry.name === 'agents');
  assert.equal(check?.status, 'ok');
});

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
    env: { ...process.env, NEPTUNIA_DATA_DIR: dirs.dataDir, ...extra },
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
      const piece = readable.read(16 * 1024) as Buffer | null;
      if (piece !== null) pieces.push(piece);
      setTimeout(tick, 20);
    };
    setTimeout(tick, 1500);
  });
}

const LARGE_ANSWERS: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['a direct command', ['rules', 'list']],
  ['-p with a slash command', ['-p', '/rules list']],
  // Changed: `neptunia tasks` is gone with the board's command line (maintainer, 2026-11-16).
];

for (const [name, argv] of LARGE_ANSWERS) {
  test(`${name} delivers an answer past the pipe size whole to a slow reader`, async () => {
    // Catches: the process exits before the stdout pipe drains, so `| jq` gets the first 65536 bytes and exit 0.
    reply = { status: 'ok', text: BIG };
    const { child, exited } = spawnPiped(argv);
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

type Tools = { env: NodeJS.ProcessEnv; calls: (tool: string) => Array<string>; config: string };

/** A PATH of recording fakes; `journalctl` exits with `journal.code` and prints `journal.stderr`. */
function tools(journal: { code: number; stderr: string } = { code: 0, stderr: '' }): Tools {
  const bin = tempDir('nep-cli-tools-');
  const config = tempDir('nep-cli-xdg-');
  const write = (tool: string, tail: string): void =>
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\n/bin/echo "$*" >> '${bin}/${tool}.log'\n${tail}\n`, {
      mode: 0o755,
    });
  write('npm', 'exit 1');
  write('systemctl', 'exit 0');
  write('journalctl', `/bin/echo '${journal.stderr}' >&2\nexit ${journal.code}`);
  return {
    config,
    env: { PATH: bin, HOME: tempDir('nep-cli-home-'), XDG_CONFIG_HOME: config },
    calls: (tool) => {
      const log = path.join(bin, `${tool}.log`);
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    },
  };
}

// The chat

test('a plain chat whose core is down returns setup-required and names the service, with no reinstall', async () => {
  // Catches: a stopped core sent through setup, or a bare "no core listens" with no readiness behind it.
  const dirs = cliFolders();
  const { env } = tools();
  const run = await runChild(dirs, [], { env, open: true, ms: 8000 });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes('setup-required'), run.stderr);
  assert.ok(run.stderr.includes('neptunia services start'), run.stderr);
});

const READY = {
  model: {
    selection: 'openrouter:vendor/core',
    check: { selection: 'openrouter:vendor/core', ok: true, code: null, at: 1 },
  },
  memory: { service: 'ok', writer: 'ok' },
};

const answering =
  (body: unknown) =>
  (command: Received): Reply =>
    command.name === 'status.readiness'
      ? { status: 'ok', text: JSON.stringify(body) }
      : { status: 'ok', text: `handled ${command.name}` };

test('a plain chat over a ready core asks readiness once, opens and takes the line', async () => {
  // Catches: a gate that never opens, or a health read repeated for every line.
  await withRecordingCore(answering(READY), async ({ dirs, core }) => {
    const { env, config } = tools();
    fs.mkdirSync(path.join(config, 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(config, 'systemd', 'user', 'neptunia-core.service'), '[Unit]\n');
    fs.writeFileSync(
      path.join(dirs.dataDir, 'clients.json'),
      JSON.stringify({ cli: { kind: 'cli', tokenFile: 'clients/cli.token', permissions: [] } })
    );
    const run = await runChild(dirs, [], { env, input: 'hello\n', ms: 8000 });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(core.lines, ['hello']);
    assert.equal(core.commands.filter((one) => one.name === 'status.readiness').length, 1);
  });
});

test('doctor stays reachable while setup is incomplete and reports readiness with its repair', async () => {
  // Catches: the gate covering the commands an owner repairs with, or the failure visible only to the chat.
  const dirs = folders();
  const { env } = tools();
  const run = await runChild(dirs, ['doctor', '--json'], { env });
  const { checks } = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const check = checks.find((one) => one.name === 'readiness');
  assert.equal(check?.status, 'fail');
  assert.ok(check?.detail.includes('neptunia setup'), check?.detail);
  assert.equal(run.stderr.includes('setup-required'), false);
});

test('/logs goes through the scope in a real process, and a journal it cannot read exits 1 with the reason', async () => {
  // Catches: the journal module tested alone while bin/neptunia.ts keeps its own journalctl call.
  const dirs = folders();
  const stderr = 'Failed to connect to bus: No medium found';
  const { env, calls } = tools({ code: 1, stderr });
  const run = await runChild(dirs, ['logs', 'errors'], { env: { ...env, NEPTUNIA_UNIT_SCOPE: 'user' } });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes(stderr), run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(calls('journalctl'), ['--user -u neptunia-core.service --no-pager -p err']);
});

/** An interface the local layer names, so `/interfaces list` prints a name no label holds. */
const MARKED = { interfaces: { zeta71: { enabled: true } } };

/** The stdout lines that are log entries of src/log.ts, which a script reading the answer must never get. */
const logLines = (stdout: string): Array<string> => stdout.split('\n').filter((line) => line.startsWith('{"level"'));

// A DM place has no native id (src/memory/db/ids.ts): its id is `<iface>:dm:<partner>`, and the
// chat's events name the partner `owner`.
test('a line typed in the chat reaches the persona, their reply is printed once, and the line is kept in the cli dm', async () => {
  await withRig({}, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('hello from the console');
    await until(
      () => chat.stdout().includes(ANSWER),
      () => `the persona's reply in the chat; stderr:\n${chat.stderr().slice(-2000)}`
    );
    assert.equal(llm.requests.length, 1, 'one turn for the line');
    assert.ok(JSON.stringify(llm.requests[0]).includes('hello from the console'), 'the request carries the line');
    assert.deepEqual(
      query(
        dirs,
        `SELECT s.kind, s.scope_kind, s.scope_iface, p.id AS place
         FROM sources s JOIN places p ON p.id = s.place_id WHERE s.text = ?`,
        'hello from the console'
      ),
      [{ kind: 'seen', scope_kind: 'dm', scope_iface: 'cli', place: 'cli:dm:owner' }]
    );
    assert.deepEqual(
      query(
        dirs,
        `SELECT DISTINCT s.scope_kind FROM sources s JOIN places p ON p.id = s.place_id WHERE p.id = ?`,
        'cli:dm:owner'
      ).map((row) => row.scope_kind),
      ['dm'],
      'every line of the chat is dm-scoped'
    );
    await settle();
    assert.equal(count(chat.stdout(), ANSWER), 1, 'the reply is printed once');
    chat.end();
    assert.deepEqual(await chat.exited, { code: 0, signal: null }, 'the end of the input ends the chat');
  });
});

// Case 2 of PR D.
test("a command's answer is printed but never reaches the persona's memory or next request", async () => {
  await withRig({ config: MARKED }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('/interfaces list');
    await until(
      () => chat.stdout().includes('zeta71'),
      () => `the command's answer; stderr:\n${chat.stderr().slice(-2000)}`
    );
    assert.equal(llm.requests.length, 0, 'a command runs no turn');
    chat.type('what is new');
    await until(() => chat.stdout().includes(ANSWER), 'the reply to the line after the command');
    assert.equal(llm.requests.length, 1);
    const request = JSON.stringify(llm.requests[0]);
    assert.ok(request.includes('what is new'));
    assert.equal(request.includes('zeta71'), false, "the command's answer is not in the persona's request");
    assert.equal(request.includes('/interfaces'), false, "the command is not in the persona's request");
    assert.deepEqual(
      query(dirs, "SELECT kind FROM sources WHERE text LIKE '%zeta71%' OR text LIKE '%/interfaces%'"),
      [],
      "neither the command nor its answer is a line of the persona's memory"
    );
  });
});

// Case 3 of PR D.
test('-p prints the answer of one command alone and exits 0', async () => {
  await withRig({ config: MARKED }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/interfaces list']);
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    assert.ok(run.stdout.includes('zeta71'), 'the answer names the interface of the local layer');
    assert.deepEqual(logLines(run.stdout), [], 'no log line on stdout');
  });
});

// Case 3 of PR D, the error path.
test('-p exits 2 for a command the table does not know', async () => {
  // A line the command table refuses is bad syntax, which exits 2 by the CLI's return codes; 1 is an operational failure.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/no-such-command']);
    assert.equal(run.code, 2, run.stderr.slice(-2000));
  });
});

/** Whether the local settings hold `zeta71` enabled: what `/interfaces zeta71 enable` and `disable` write. */
const zetaEnabled = (dirs: Dirs): unknown => {
  const config = JSON.parse(readFileSync(join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    interfaces?: { zeta71?: { enabled?: unknown } };
  };
  const zeta = config.interfaces?.zeta71;
  return zeta?.enabled;
};

/** The names `/interfaces list` prints, the first word of each of its lines. */
const listedNames = (stdout: string): Array<string> =>
  stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name !== '');

test('the interface comes before its command in the shell and in -p, and the bare family lists them all', async () => {
  // Catches: `neptunia interfaces` and `-p /interfaces` reading two grammars, or
  // `disable` and `enable` changing an interface other than the one named.
  await withRig({ config: MARKED }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    for (const args of [['-p', '/interfaces'], ['-p', '/interfaces list'], ['interfaces']]) {
      const run = await runCli(dirs, args);
      assert.equal(run.code, 0, `${args.join(' ')}: ${run.stderr.slice(-2000)}`);
      assert.ok(run.stdout.includes('zeta71'), `${args.join(' ')}: ${run.stdout}`);
    }
    const disabled = await runCli(dirs, ['-p', '/interfaces zeta71 disable']);
    assert.equal(disabled.code, 0, disabled.stderr.slice(-2000));
    assert.equal(zetaEnabled(dirs), false);
    const enabled = await runCli(dirs, ['interfaces', 'zeta71', 'enable']);
    assert.equal(enabled.code, 0, enabled.stderr.slice(-2000));
    assert.equal(zetaEnabled(dirs), true);
    assert.equal(llm.requests.length, 0, 'a command runs no turn');
  });
});

test('a name that is no interface, every form with the command first and every removed command exit 2', async () => {
  // The old order has no alias, and pairing, accept and remove are gone with it.
  // Catches: an old or removed line still run, read with the command word as an interface's name, or a mistyped name
  // answered without the list of what exists.
  await withRig({ config: MARKED }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const list = await runCli(dirs, ['-p', '/interfaces list']);
    assert.equal(list.code, 0, list.stderr.slice(-2000));
    const names = listedNames(list.stdout);
    assert.ok(names.includes('zeta71'), list.stdout);
    for (const args of [
      ['-p', '/interfaces zeta72 enable'],
      ['interfaces', 'zeta72', 'invite'],
      ['interfaces', 'zeta72'],
    ]) {
      const run = await runCli(dirs, args);
      assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr.slice(-2000)}`);
      for (const name of names) assert.ok(run.stderr.includes(name), `${args.join(' ')} lists ${name}: ${run.stderr}`);
    }
    for (const line of [
      '/interfaces invite zeta71',
      '/interfaces roots zeta71',
      '/interfaces roots accept zeta71 g7',
      '/interfaces roots remove zeta71 g7',
      '/interfaces setup zeta71',
      '/interfaces disable zeta71',
      '/interfaces pair open zeta71',
      '/interfaces zeta71 pair',
      '/interfaces zeta71 accept g7',
      '/interfaces zeta71 remove g7',
    ]) {
      for (const args of [['-p', line], line.slice(1).split(' ')]) {
        const run = await runCli(dirs, args);
        assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr.slice(-2000)}`);
      }
    }
    assert.equal(zetaEnabled(dirs), true, 'the old disable changed nothing');
    assert.equal(llm.requests.length, 0, 'no refused line became a turn');
  });
});

test('the chat reads the interface before its command and answers a name that is no interface with the list', async () => {
  // Catches: the chat parsing the family in the old order while the shell takes the new, or a refused line sent to
  // the persona as text.
  await withRig({ config: MARKED }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    await until(() => chat.stdout().trim() !== '', 'the chat header');
    await settle();
    assert.equal(chat.stdout().includes('zeta71'), false, 'the header names no unconnected interface');
    chat.type('/interfaces zeta72 enable');
    await until(
      () => chat.stdout().includes('zeta71'),
      () => `the list of interfaces; stdout:\n${chat.stdout().slice(-2000)}`
    );
    chat.type('/interfaces zeta71 disable');
    await until(() => zetaEnabled(dirs) === false, 'zeta71 disabled from the chat');
    assert.equal(llm.requests.length, 0, 'no command became a turn');
  });
});

// Case 3 of PR D, the status card without a live probe.
test('-p "/status" answers without asking any model', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/status']);
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    assert.notEqual(run.stdout.trim(), '');
    assert.equal(llm.requests.length, 0, '/status probes no model');
  });
});

// Case 3 of PR D, the core down.
// A usage error ends `neptunia` with 2, so 1 tells a script that the command did not reach a core.
test('-p exits 1 without waiting when no core listens', async () => {
  await withRig({}, async ({ dirs }) => {
    const run = await runCli(dirs, ['-p', '/status'], 10000);
    assert.equal(run.code, 1, run.stderr.slice(-2000));
  });
});

type neptuniaCliCheck = { name: string; status: string };

/** The checks of `neptunia doctor --json`: one JSON object `{ checks: [{ name, status }] }` on stdout. */
function checksOf(stdout: string): Map<string, string> {
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(parsed !== null && typeof parsed === 'object' && Array.isArray(Reflect.get(parsed, 'checks')));
  const checks = Reflect.get(parsed, 'checks') as Array<neptuniaCliCheck>;
  return new Map(checks.map((check) => [check.name, check.status]));
}

const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Folders with the cli client, a canonical key store holding a key, and a memory database written and closed: no core runs. */
function coreDown(): { dirs: Dirs; db: string; key: string; token: string } {
  const dirs = folders({});
  addClient(dirs.privateDir, CLI_CLIENT);
  const key = 'sk-or-test-zeta-not-a-real-key';
  const keys = createKeyStore({ privateDir: dirs.dataDir });
  keys.add({ name: 'core-1', value: key });
  mkdirSync(dirs.dataDir, { recursive: true });
  const db = join(dirs.dataDir, 'memory.db');
  openMemoryDb(db).close();
  const token = readFileSync(join(dirs.privateDir, 'clients', 'cli.token'), 'utf8').trim();
  return { dirs, db, key, token };
}

// Case 4 of PR D.
test('doctor with the core down reports it once, in readiness, and the database sound, and changes nothing', async () => {
  // Changed: the core down was reported three times, as `socket`, `readiness` and a skipped `runtime` (CLI audit
  // 2026-11-09); `readiness` names it and its repair alone.
  const { dirs, db, key, token } = coreDown();
  const before = digestOf(db);
  const run = await runCli(dirs, ['doctor', '--json']);
  assert.equal(run.code, 1, 'a failed check ends doctor with 1');
  const checks = checksOf(run.stdout);
  assert.equal(checks.get('readiness'), 'fail');
  assert.equal(checks.has('socket'), false);
  assert.equal(checks.has('runtime'), false);
  assert.equal(checks.get('database'), 'ok');
  assert.equal(checks.get('tokens'), 'ok');
  for (const name of ['node', 'binaries', 'config', 'local-layer', 'keys'])
    assert.ok(checks.has(name), `doctor checks ${name}`);
  assert.equal(digestOf(db), before, 'the database is read only');
  assert.equal(existsSync(lockPathOf(db)), false, 'doctor takes no writer lock');
  assert.equal(existsSync(join(dirs.dataDir, 'run')), false, 'doctor makes no socket folder');
  const printed = run.stdout + run.stderr;
  assert.equal(printed.includes(key), false, 'no key value is printed');
  assert.equal(printed.includes(token), false, 'no token is printed');
});

test('doctor counts a key store that holds only former extra keys as holding keys', async () => {
  // Catches: the keys check counting the old core list alone, so a store of named keys warns it holds no key.
  const dirs = folders({});
  addClient(dirs.privateDir, CLI_CLIENT);
  createKeyStore({ privateDir: dirs.dataDir }).add({ name: 'helpers', value: 'sk-or-test-helpers-not-real' });
  const run = await runCli(dirs, ['doctor', '--json']);
  assert.equal(checksOf(run.stdout).get('keys'), 'ok');
});

test('doctor warns in local-layer of a deployment prompt file at a retired path, naming the path that replaces it', async () => {
  // Catches: a deployment's own character card at its old path, which the engine does not read, left unreported.
  const { dirs } = coreDown();
  mkdirSync(join(dirs.privateDir, 'prompts'), { recursive: true });
  writeFileSync(join(dirs.privateDir, 'prompts', 'character-card.md'), 'own card\n');
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const layer = parsed.checks.find((check) => check.name === 'local-layer');
  assert.equal(layer?.status, 'warn');
  assert.ok(layer?.detail.includes('prompts/character-card.md'), layer?.detail);
  assert.ok(layer?.detail.includes('prompts/persona.md'), layer?.detail);
});

// Case 4 of PR D, the error path.
test('doctor reports a database that is not one as failed and leaves the file as it was', async () => {
  const { dirs, db } = coreDown();
  writeFileSync(db, 'this file is not a database\n');
  const before = digestOf(db);
  const run = await runCli(dirs, ['doctor', '--json']);
  assert.equal(run.code, 1);
  assert.equal(checksOf(run.stdout).get('database'), 'fail');
  assert.equal(digestOf(db), before);
});

// PR 7a: the command line holds no key, so with the core down the provider probes are skipped, never run.
test('doctor live with the core down reports the provider probes skipped and prints no key', async () => {
  // Changed: `live` is the one spelling; `--live` beside it named the same run twice (CLI audit 2026-11-09).
  const { dirs, key } = coreDown();
  const run = await runCli(dirs, ['doctor', 'live', '--json']);
  const checks = checksOf(run.stdout);
  assert.equal(checks.get('providers'), 'skipped');
  // Changed: `providers` says the core is down; no separate `socket` row repeats it.
  assert.equal(checks.has('socket'), false);
  assert.equal((run.stdout + run.stderr).includes(key), false, 'no key value is printed');
});

test('doctor --live is refused with exit 2, since live is its one spelling', async () => {
  // Catches: two spellings of one run kept apart in the docs, the tests and the table.
  const { dirs } = coreDown();
  const run = await runCli(dirs, ['doctor', '--live']);
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
});

test('doctor reports the model roles and the harnesses in routes alone, with no roles or features check', async () => {
  // Catches: a role with no route and a subharness that is off each reported twice, once in `routes` and once in a
  // check of its own (CLI audit 2026-11-09).
  const { dirs } = coreDown();
  const run = await runCli(dirs, ['doctor', '--json']);
  const checks = checksOf(run.stdout);
  assert.ok(checks.has('routes'));
  assert.equal(checks.has('roles'), false);
  assert.equal(checks.has('features'), false);
});

/** The first JSON line the runner answers on `socket` to one `ping`. */
function ping(socket: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let buffer = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('the runner never answered the ping'));
    }, 5000);
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.on('connect', () => conn.write(`${JSON.stringify({ op: 'ping' })}\n`));
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      conn.end();
      resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
    });
  });
}

// Case 9 of PR D.
test('errand-runner --unit scout serves the scout on the socket of its user unit and stops on SIGTERM', async () => {
  // Changed: a runner serves a unit, and its socket and out folder derive from the unit's name.
  const dirs = folders({});
  const runtime = join(dirs.root, 'run');
  const socket = join(runtime, 'neptunia-agent-scout', 'sock');
  const env = { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(dirs.root, 'state') };
  fs.mkdirSync(join(runtime, 'neptunia-agent-scout'), { recursive: true });
  const runner = spawnCli(dirs, ['errand-runner', '--unit', 'scout'], env);
  try {
    await until(() => existsSync(socket) || runner.child.exitCode !== null, 'the runner socket');
    assert.ok(existsSync(socket), `the runner listens; stderr:\n${runner.stderr().slice(-2000)}`);
    const pong = await ping(socket);
    assert.equal(pong.event, 'pong');
    assert.equal(pong.unit, 'scout');
    runner.child.kill('SIGTERM');
    assert.deepEqual(await runner.exited, { code: 0, signal: null });
  } finally {
    await runner.kill();
  }
});

// PR 1, sources without an enable step: what only a real `neptunia` process proves about the account commands. They run
// with no core, stdout carries the result and stderr the reason, and the exit code says which: 0 logged in or done, 1 an
// operational answer. The vendor CLI and npm are fakes; PATH holds nothing else.

/** PATH with a recording `npm` and nothing else; what a retired or a read command must never reach. */
function npmPath(): { env: NodeJS.ProcessEnv; npmCalls: () => string } {
  const bin = tempDir('nep-cli-path-');
  const log = path.join(bin, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n/bin/echo "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  return {
    env: { PATH: bin, HOME: tempDir('nep-cli-home-') },
    npmCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

test('neptunia subharness claude status answers on stdout with no core, exit 0 when logged in', async () => {
  // Catches: the account commands tied to a core socket, so a broken core cannot be repaired from a shell.
  const dirs = cliFolders();
  fakeVendor(dirs.privateDir, 'claude', { loggedIn: true });
  const { env } = npmPath();
  const logged = await runChild(dirs, ['subharness', 'claude', 'status'], { env });
  assert.equal(logged.code, 0, logged.stderr);
  assert.notEqual(logged.stdout, '');
  assert.equal(logged.stderr, '');
});

test('neptunia subharness codex login with no terminal and no install exits 1, names the need and installs nothing', async () => {
  // Catches: a hang on the install question, or a silent install from a script.
  const dirs = cliFolders();
  const { env, npmCalls } = npmPath();
  const run = await runChild(dirs, ['subharness', 'codex', 'login'], { env, open: true, ms: 8000 });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes('codex'), run.stderr);
  assert.ok(run.stderr.includes('install'), run.stderr);
  assert.equal(npmCalls(), '');
  assert.equal(fs.existsSync(path.join(dirs.privateDir, 'subharness', 'codex')), false);
});

// `neptunia doctor` carries the `routes` check of src/setup/route-health.ts: every part checked for real on what it runs
// on. The provider here is an address that refuses every connection, so nothing leaves the machine
// and a core key reads as unreachable.

const VALUE = 'sk-or-v1-doctor-routes-secret';

test('doctor fails the routes check when the core key cannot be reached, and prints no key value', async () => {
  // Catches: a doctor that reads the keys from disk and calls them fine without asking the provider.
  const dirs = folders({ llm: { baseUrl: 'http://127.0.0.1:9/api/v1' } });
  writeKeysFile(dirs.privateDir, { core: [{ name: 'core-1', value: VALUE }] });
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const check = parsed.checks.find((one) => one.name === 'routes');
  assert.equal(check?.status, 'fail');
  assert.ok(check.detail.includes('core-1'), check.detail);
  assert.equal((run.stdout + run.stderr).includes(VALUE), false);
});

let online: Dirs;

let offline: Dirs;

let neptuniaNamingCore: RecordingCore;

let bin: string;

let unitLog: string;

let journalLog: string;

const LOCAL = { PATH: '' };

before(async () => {
  online = cliFolders();
  neptuniaNamingCore = await startRecordingCore(online, handled);
  offline = cliFolders();
  bin = join(offline.root, 'bin');
  unitLog = join(offline.root, 'units.log');
  journalLog = join(offline.root, 'journal.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${unitLog}"\necho "zeta-systemctl $*"\nexit 3\n`, {
    mode: 0o755,
  });
  writeFileSync(join(bin, 'journalctl'), `#!/bin/sh\necho "$*" >> "${journalLog}"\necho zeta-journal\nexit 0\n`, {
    mode: 0o755,
  });
  LOCAL.PATH = bin;
});

after(async () => {
  await neptuniaNamingCore.close();
  rmSync(online.root, { recursive: true, force: true });
  rmSync(offline.root, { recursive: true, force: true });
});

/** The core emptied, and the fakes' logs. */
function fresh(): void {
  neptuniaNamingCore.commands.length = 0;
  neptuniaNamingCore.lines.length = 0;
  rmSync(unitLog, { force: true });
  rmSync(journalLog, { force: true });
}

const run = (dirs: Dirs, argv: ReadonlyArray<string>): ReturnType<typeof runChild> =>
  runChild(dirs, argv, { env: { PATH: LOCAL.PATH } });

for (const argv of [
  ['-p', '/services frobnicate'],
  ['-p', '/servicess list'],
  ['services', 'frobnicate'],
]) {
  test(`neptunia ${argv.join(' ')} is refused with exit 2 and never becomes a prompt`, async () => {
    // Catches: a mistyped command of the new family reaches the model as a line of the chat.
    fresh();
    const connections = neptuniaNamingCore.connections();
    const done = await run(online, argv);
    assert.equal(done.code, 2, done.stderr.slice(0, 300));
    assert.deepEqual(neptuniaNamingCore.lines, []);
    assert.deepEqual(neptuniaNamingCore.commands, []);
    assert.equal(neptuniaNamingCore.connections(), connections);
  });
}

// ---- logs ------------------------------------------------------------------------------------------------------------

test('neptunia logs errors still reads the core journal at priority err', async () => {
  // Catches: the journal's filters lost on the way to journalctl.
  fresh();
  const done = await run(offline, ['logs', 'errors']);
  assert.equal(done.code, 0, done.stderr.slice(0, 300));
  assert.ok(done.stdout.includes('zeta-journal'), done.stdout);
  assert.match(readFileSync(journalLog, 'utf8'), /-p err/);
});

// ---- secrets ---------------------------------------------------------------------------------------------------------

// Changed: `/interfaces token set` is gone (the interface's own `token` setting takes it), so the secret leaf is `keys add`.
for (const argv of [['-p', '/keys add zeta71 sekret-71']]) {
  test(`neptunia ${argv.slice(0, -1).join(' ')} <value> refuses a token on the command line and never echoes it`, async () => {
    // Catches: the renamed family takes the token as an argument, or a refusal prints it into a log or a terminal.
    fresh();
    const connections = neptuniaNamingCore.connections();
    const done = await run(online, argv);
    assert.equal(done.code, 2, done.stderr.slice(0, 300));
    assert.equal((done.stdout + done.stderr).includes('sekret-71'), false);
    assert.ok(done.stderr.includes('--secret-stdin'), 'the refusal points at stdin as the way to give it');
    assert.deepEqual(neptuniaNamingCore.commands, []);
    assert.equal(neptuniaNamingCore.connections(), connections);
  });
}

const ROOT = path.join(import.meta.dirname, '..', '..');

test('neptunia setup with an unknown option exits 2 and creates nothing', () => {
  // Bug: the entry point runs the install with whatever it was given.
  const dir = tempDir('nep-setup-bin-');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'neptunia.ts'), 'setup', '--bogus'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      NEPTUNIA_DATA_DIR: path.join(dir, 'd'),
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.deepEqual(fs.readdirSync(dir), []);
});
