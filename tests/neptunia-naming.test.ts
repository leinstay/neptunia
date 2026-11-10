// What a real `neptunia` process does with the renamed commands (the command naming spec of 2026-11-04): a retired
// spelling ends with exit 2, names the new one and starts nothing, `neptunia services` reaches the unit verbs and the
// family, `/doctor watcher` reads the saved reports with no core and never opens the journal, and a secret never reaches
// the command line. The children share a recording core where the point is that nothing was sent to it (tests/fixtures/
// recording-core.ts), and a folder with no core where the point is that nothing is needed. `systemctl` and `journalctl`
// are fakes on an otherwise empty PATH that log every call, so "starts nothing" is a file that does not exist.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { cliFolders, handled, runChild, startRecordingCore } from './fixtures/recording-core.ts';
import type { RecordingCore } from './fixtures/recording-core.ts';
import type { Dirs } from './fixtures/core-units.ts';

let online: Dirs;
let offline: Dirs;
let core: RecordingCore;
let bin: string;
let unitLog: string;
let journalLog: string;

const LOCAL = { PATH: '' };

before(async () => {
  online = cliFolders();
  core = await startRecordingCore(online, handled);
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
  const reports = reportsDirOf(offline.privateDir, watcherDir({}));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, '2026-11-02.md'), '# older\n\nzeta-older\n');
  writeFileSync(join(reports, '2026-11-03.md'), '# newer\n\nzeta-newer\n');
  writeFileSync(join(reports, 'yesterday.md'), 'zeta-word\n');
  writeFileSync(join(reports, '..', 'x.md'), 'zeta-outside\n');
});

after(async () => {
  await core.close();
  rmSync(online.root, { recursive: true, force: true });
  rmSync(offline.root, { recursive: true, force: true });
});

/** The core emptied, and the fakes' logs. */
function fresh(): void {
  core.commands.length = 0;
  core.lines.length = 0;
  rmSync(unitLog, { force: true });
  rmSync(journalLog, { force: true });
}

const run = (dirs: Dirs, argv: ReadonlyArray<string>): ReturnType<typeof runChild> =>
  runChild(dirs, argv, { env: { PATH: LOCAL.PATH } });

/** Every file of `dir` with the hash of its bytes. */
function digest(dir: string): string {
  const rows: Array<string> = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        rows.push(`d ${relative(dir, path)}`);
        walk(path);
      } else {
        rows.push(`f ${relative(dir, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return rows.join('\n');
}

for (const argv of [
  ['-p', '/services frobnicate'],
  ['-p', '/servicess list'],
  ['services', 'frobnicate'],
]) {
  test(`neptunia ${argv.join(' ')} is refused with exit 2 and never becomes a prompt`, async () => {
    // Catches: a mistyped command of the new family reaches the model as a line of the chat.
    fresh();
    const connections = core.connections();
    const done = await run(online, argv);
    assert.equal(done.code, 2, done.stderr.slice(0, 300));
    assert.deepEqual(core.lines, []);
    assert.deepEqual(core.commands, []);
    assert.equal(core.connections(), connections);
  });
}

test('neptunia task is refused and names tasks, while neptunia tasks reaches the board and reports no core', async () => {
  // Catches: the board's shell family keeps the singular, or the plural is not wired and answers a usage.
  fresh();
  const singular = await run(offline, ['task', 'list']);
  assert.equal(singular.code, 2, singular.stderr.slice(0, 300));
  assert.ok(singular.stderr.includes('tasks'), singular.stderr.slice(0, 300));
  const plural = await run(offline, ['tasks', 'list']);
  assert.equal(plural.code, 1, plural.stderr.slice(0, 300));
  assert.ok(plural.stderr.startsWith('unavailable:'), plural.stderr.slice(0, 300));
});

test('neptunia services list answers with no core, lists the three mechanisms and changes nothing', async () => {
  // Catches: the list needs the core, lists a unit, or writes a setting or moves a timer while it reads.
  fresh();
  const before = digest(offline.dataDir);
  const done = await run(offline, ['services', 'list']);
  assert.equal(done.code, 0, done.stderr.slice(0, 300));
  for (const name of ['heartbeat', 'selfreflection', 'selfimprovement']) assert.ok(done.stdout.includes(name), name);
  assert.equal(digest(offline.dataDir), before);
  const calls = existsSync(unitLog) ? readFileSync(unitLog, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(
    calls.filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line)),
    []
  );
});

test('/services selfimprovement status gives the same answer from the chat line and from argv, with no core', async () => {
  // Catches: the two spellings of one command reach different handlers.
  // Changed: the watcher left the services (owner, 2026-11-09); selfimprovement, whose next time has no jitter, stands in.
  fresh();
  const direct = await run(offline, ['services', 'selfimprovement', 'status']);
  const line = await run(offline, ['-p', '/services selfimprovement status']);
  assert.equal(direct.code, 0, direct.stderr.slice(0, 300));
  assert.equal(line.code, 0, line.stderr.slice(0, 300));
  assert.equal(line.stdout, direct.stdout);
  assert.ok(direct.stdout.includes('selfimprovement'));
});

// ---- /doctor watcher -------------------------------------------------------------------------------------------------

// Changed: `/logs watcher` became `/doctor watcher` (owner, 2026-11-09). The reports here are day files from before run
// records, which the list numbers by their day.
for (const [argv, expected] of [
  [['doctor', 'watcher', 'read'], 'zeta-newer'],
  [['doctor', 'watcher', '1'], 'zeta-older'],
  [['-p', '/doctor watcher 1'], 'zeta-older'],
] as const) {
  test(`neptunia ${argv.join(' ')} prints the saved report with no core and never opens the journal`, async () => {
    // Catches: the report view needs the core, reads the journal, or writes while it reads.
    fresh();
    const before = digest(offline.dataDir);
    const done = await run(offline, argv);
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.ok(done.stdout.includes(expected), done.stdout.slice(0, 300));
    assert.equal(existsSync(journalLog), false, 'journalctl was not run');
    assert.equal(digest(offline.dataDir), before);
  });
}

for (const target of ['yesterday', '../x', '2026-11-02 extra', '2026-1-2']) {
  test(`neptunia doctor watcher "${target}" fails before it reads any report or the journal`, async () => {
    // Catches: a selector that is no number reads a file by name, or falls back to the journal.
    fresh();
    const done = await run(offline, ['doctor', 'watcher', target]);
    assert.notEqual(done.code, 0);
    assert.equal(done.stdout.includes('zeta-'), false, done.stdout.slice(0, 300));
    assert.equal(existsSync(journalLog), false, 'journalctl was not run');
  });
}

test('neptunia logs errors still reads the core journal at priority err', async () => {
  // Catches: the watcher view takes over the journal's filters.
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
    const connections = core.connections();
    const done = await run(online, argv);
    assert.equal(done.code, 2, done.stderr.slice(0, 300));
    assert.equal((done.stdout + done.stderr).includes('sekret-71'), false);
    assert.ok(done.stderr.includes('--secret-stdin'), 'the refusal points at stdin as the way to give it');
    assert.deepEqual(core.commands, []);
    assert.equal(core.connections(), connections);
  });
}
