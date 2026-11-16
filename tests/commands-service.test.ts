// The `/services` family in the command table (src/interface/commands/table.ts), in the panels (bin/chat-panels.ts) and in
// the core's console (src/interface/commands/console.ts): the one public control of the two scheduled mechanics, what
// the parse refuses before anything runs, the controls it replaces, and that a /config read sees what `setup` saved.
// The tests assert on parsed names, arguments, files and the commands a refusal names, never on wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig } from '../src/config.ts';
import { checkConfig } from '../src/config/check.ts';
import { localConfigPath } from '../src/config/files.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NAMES = ['heartbeat', 'selfreflection'] as const;
const ACTIONS = ['setup', 'enable', 'disable', 'status'] as const;

for (const name of NAMES) {
  for (const action of ACTIONS) {
    test(`/services ${name} ${action} parses as service.${name}.${action}`, () => {
      // Catches: a name or an action of the family is missing from the table, so the chat answers "unknown command".
      assert.deepEqual(parseCommandLine(`/services ${name} ${action}`), {
        ok: true,
        name: `services.${name}.${action}`,
        args: {},
      });
    });
  }
}

test('setup takes --at and --every as flags', () => {
  // Catches: the value is read as a positional word, or the flag name differs from the one the docs and setup offer.
  assert.deepEqual(parseCommandLine('/services heartbeat setup --at 00:00,12:00'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { at: '00:00,12:00' },
  });
  assert.deepEqual(parseCommandLine('/services selfreflection setup --every 90m'), {
    ok: true,
    name: 'services.selfreflection.setup',
    args: { every: '90m' },
  });
});

test('heartbeat setup takes --jitter beside an interval, and alone', () => {
  // Catches: the jitter of the heartbeat has no way to be set once `/config` stops being the only door to it.
  assert.deepEqual(parseCommandLine('/services heartbeat setup --every 3h --jitter 30m'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { every: '3h', jitter: '30m' },
  });
  assert.deepEqual(parseCommandLine('/services heartbeat setup --jitter 0m'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { jitter: '0m' },
  });
});

for (const line of [
  // The modes exclude each other.
  '/services heartbeat setup --at 00:00 --every 6h',
  // Malformed and duplicate slots.
  '/services heartbeat setup --at 25:00',
  '/services heartbeat setup --at 7:00',
  '/services heartbeat setup --at 00:60',
  '/services heartbeat setup --at noon',
  '/services heartbeat setup --at 00:00,00:00',
  '/services heartbeat setup --at 00:00,',
  '/services heartbeat setup --at ,00:00',
  // Zero, negative and malformed intervals.
  '/services heartbeat setup --every 0h',
  '/services heartbeat setup --every 0m',
  '/services heartbeat setup --every -1h',
  '/services heartbeat setup --every 6',
  '/services heartbeat setup --every 1.5h',
  '/services heartbeat setup --every 1h30m',
  '/services heartbeat setup --every 6d',
  // Only the heartbeat has a jitter, only on an interval, and it is a duration of zero or more.

  '/services selfreflection setup --every 6h --jitter 5m',
  '/services heartbeat setup --at 06:00 --jitter 5m',
  '/services heartbeat setup --every 3h --jitter -5m',
  '/services heartbeat setup --every 3h --jitter soon',
  // Only setup takes a schedule.
  '/services heartbeat enable --every 3h',
  '/services heartbeat status --at 00:00',
  // No mechanic has the operations of one run.
  '/services heartbeat trigger',
  '/services selfreflection cancel',
  // A name or an action outside the family, and the verbs of the system units, which belong to the shell.
  // Changed: the watcher's lines are gone with the watcher (maintainer, 2026-11-16).
  '/services bogus status',
  '/services status',
  '/services restart',
  '/services',
]) {
  test(`the parse refuses "${line}"`, () => {
    // Catches: a line the handler would have to reject reaches it, so the chat and the shell can disagree on it.
    const parsed = parseCommandLine(line);
    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.reason.startsWith('unknown command'), false, 'the family itself is known');
  });
}

/** A console over a temporary private layer whose `/config` reads the files as the core's hot settings do. */
function consoleOver(ran: Array<string> = []): { dir: string; run: (line: string) => ReturnType<typeof runIn> } {
  const dir = tempDir('nep-service-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ran.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: {
      get config(): unknown {
        return readConfig(REPO, { privateDir: dir });
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.parse('2026-11-04T12:00:00Z'),
  };
  const desk = createConsole(deps);
  return { dir, run: (line) => runIn(desk, line) };
}

async function runIn(desk: ReturnType<typeof createConsole>, line: string) {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
}

test('what setup saves in the chat is what a /config read answers', async () => {
  // Catches: the family keeps a store of its own, so `/config` and `/services` show two different schedules.
  const { run } = consoleOver();
  const saved = await run('/services heartbeat setup --every 2h');
  assert.equal(saved.status, 'ok', saved.text);
  const read = await run('/config get heartbeat.schedule');
  assert.equal(read.status, 'ok', read.text);
  assert.equal(JSON.parse(read.text), 'every 2h');
});

// Changed: the mechanic is selfreflection, since selfimprovement is no service.
test('a schedule in the settings file, where /config set writes it, is what the family shows', async () => {
  // Catches: the family reads a copy of its own, so a change through the settings panel does not reach it.
  const { dir, run } = consoleOver();
  writeFileSync(localConfigPath(dir), JSON.stringify({ selfreflection: { schedule: 'at 05:00' } }));
  const status = await run('/services selfreflection status');
  assert.equal(status.status, 'ok', status.text);
  assert.match(status.text, /^schedule: at 05:00$/m);
});

test('enable and disable in the chat move the same flag a /config read answers', async () => {
  // Catches: the chat path writes through another handler than the shell, and the flag lands under another key.
  const { run } = consoleOver();
  assert.equal((await run('/services selfreflection disable')).status, 'ok');
  assert.equal(JSON.parse((await run('/config get selfreflection.enabled')).text), false);
  assert.equal((await run('/services selfreflection enable')).status, 'ok');
  assert.equal(JSON.parse((await run('/config get selfreflection.enabled')).text), true);
});

test('setup in the chat writes the local settings file and leaves the flag as it was', async () => {
  // Catches: `setup` also switches the mechanic on, so configuring a time starts wakes the owner did not ask for.
  const { dir, run } = consoleOver();
  writeFileSync(localConfigPath(dir), JSON.stringify({ heartbeat: { enabled: false } }));
  assert.equal((await run('/services heartbeat setup --at 06:00,18:00')).status, 'ok');
  const local: unknown = JSON.parse(readFileSync(localConfigPath(dir), 'utf8'));
  assert.deepEqual(local, { heartbeat: { enabled: false, schedule: 'at 06:00,18:00' } });
});

test('status in the chat runs no operation that reaches a model', async () => {
  // Catches: readiness is measured with a live probe, so reading the status spends a paid request.
  const ran: Array<string> = [];
  const { run } = consoleOver(ran);
  const status = await run('/services heartbeat status');
  assert.equal(status.status, 'ok', status.text);
  assert.match(status.text, /^enabled: (true|false)$/m);
  assert.deepEqual(
    ran.filter((op) => op !== 'inner.status'),
    []
  );
});

test('a failed setup in the chat writes nothing', async () => {
  // Catches: the handler trusts the table and a value that reached it by another route lands in the file.
  const { dir } = consoleOver();
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: {} },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
  });
  const answer = await desk.run('services.heartbeat.setup', { at: '25:00' }, { id: 'owner-1' });
  assert.equal(answer.status, 'invalid', answer.text);
  assert.equal(answer.text.includes('no such command'), false, answer.text);
  assert.equal(existsSync(localConfigPath(dir)), false);
});

test('the settings schema knows the schedule of each of the two', () => {
  // Catches: `/config check` and the doctor warn about the key the family itself writes.
  const settings = {
    heartbeat: { schedule: 'every 3h' },
    selfreflection: { schedule: 'at 09:00' },
  };
  assert.deepEqual(checkConfig(settings, CONFIG_SCHEMA), []);
});
