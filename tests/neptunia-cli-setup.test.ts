// PR 2, one setup flow and readiness: what only a real `neptunia` process proves. A chat over pipes evaluates readiness
// first and returns setup-required rather than hanging; the retired setup words run nothing; `/logs` reads the journal of
// the scope `service` and setup resolve, whatever the manager then says. PATH holds fakes of `systemctl`, `journalctl` and
// `npm` and nothing else, so today's code that would act reaches only the fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unitScope } from '../src/service/manager.ts';
import { cliFolders, runChild, withRecordingCore } from './fixtures/recording-core.ts';
import type { Received, Reply } from './fixtures/recording-core.ts';
import { folders } from './fixtures/core-units.ts';

import { tempDir } from './fixtures/tmp.ts';

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

// Service scope

test('the user scope is found by the core unit, so setup, service and /logs agree before the watcher has a timer', () => {
  // Catches: the scope read from the watcher's timer alone, so a user install with no timer manages system units.
  const config = tempDir('nep-scope-');
  const env = { XDG_CONFIG_HOME: config };
  assert.equal(unitScope(env), 'system');
  fs.mkdirSync(path.join(config, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(config, 'systemd', 'user', 'neptunia-core.service'), '[Unit]\n');
  assert.equal(unitScope(env), 'user');
  assert.equal(unitScope({ ...env, NEPTUNIA_UNIT_SCOPE: 'system' }), 'system');
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
