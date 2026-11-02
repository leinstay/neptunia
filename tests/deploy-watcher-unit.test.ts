// The watcher's systemd units (deploy/neptunia-watcher.timer and .service), read as text, without systemd: the timer
// fires at 00:00 UTC, and the service runs `neptunia watcher run` once, as a user of its own, with the node of the
// server. The two errand agent units (neptunia-agent-scout.service and neptunia-agent-server.service) are read the same
// way: they run Codex as the user that holds its login. Each fact is a line a deployment would get wrong silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = path.join(fileURLToPath(new URL('..', import.meta.url)), 'deploy');

type Unit = Map<string, Map<string, Array<string>>>;

/** An INI unit file as section -> key -> values; comments and blank lines dropped. */
function parseUnit(name: string): Unit {
  const unit: Unit = new Map();
  let section = '';
  for (const raw of fs.readFileSync(path.join(DEPLOY, name), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head !== null) {
      section = head[1] ?? '';
      unit.set(section, unit.get(section) ?? new Map<string, Array<string>>());
      continue;
    }
    const eq = line.indexOf('=');
    assert.ok(eq > 0 && section !== '', `a line outside a section or without "=": ${line}`);
    const key = line.slice(0, eq);
    const values = unit.get(section)?.get(key) ?? [];
    unit.get(section)?.set(key, [...values, line.slice(eq + 1)]);
  }
  return unit;
}

const one = (unit: Unit, section: string, key: string): string | undefined => unit.get(section)?.get(key)?.[0];

test('the timer fires once a day at midnight UTC and is installed with the timers', () => {
  const timer = parseUnit('neptunia-watcher.timer');
  const calendar = one(timer, 'Timer', 'OnCalendar') ?? '';
  assert.match(calendar, /00:00(:00)?/);
  assert.match(calendar, /UTC/);
  assert.equal(calendar.includes('*-*-*') || calendar === 'daily UTC', true, 'every day');
  assert.equal(one(timer, 'Install', 'WantedBy'), 'timers.target');
});

test('the timer starts the watcher service, by default or by name', () => {
  const timer = parseUnit('neptunia-watcher.timer');
  const target = one(timer, 'Timer', 'Unit') ?? 'neptunia-watcher.service';
  assert.equal(target, 'neptunia-watcher.service');
  assert.ok(fs.existsSync(path.join(DEPLOY, 'neptunia-watcher.service')));
});

test('the service is a oneshot, so the timer skips a day whose run is still going', () => {
  assert.equal(one(parseUnit('neptunia-watcher.service'), 'Service', 'Type'), 'oneshot');
});

test("the service runs neptunia watcher run with the server's node, from the checkout", () => {
  const service = parseUnit('neptunia-watcher.service');
  const start = one(service, 'Service', 'ExecStart') ?? '';
  assert.match(start, /^\/opt\/node\/bin\/node\s+\S*bin\/neptunia\.ts\s+watcher\s+run$/);
  assert.ok((one(service, 'Service', 'WorkingDirectory') ?? '').startsWith('/'));
});

test("the service runs as an agent user: not root and not the core's user, which holds the keys and the memory", () => {
  const user = one(parseUnit('neptunia-watcher.service'), 'Service', 'User') ?? '';
  assert.notEqual(user, '');
  assert.notEqual(user, 'root');
  assert.notEqual(user, 'neptunia-bot');
});

test('the service does not restart itself after a failed run: one run a day', () => {
  const restart = one(parseUnit('neptunia-watcher.service'), 'Service', 'Restart');
  assert.ok(restart === undefined || restart === 'no');
});

const AGENT_UNITS = ['neptunia-agent-scout.service', 'neptunia-agent-server.service'];

test('the agent units run as the user that holds the Codex login, in the group of the core socket', () => {
  // Bug: a unit left on a retired agent user starts without a Codex login and every task fails.
  for (const name of AGENT_UNITS) {
    const service = parseUnit(name);
    assert.equal(one(service, 'Service', 'User'), 'neptunia', name);
    assert.equal(one(service, 'Service', 'Group'), 'neptunia-discord-interface', name);
  }
});

test('the agent units write nothing of the home, and keep the system read-only', () => {
  // Bug: ProtectHome=yes hides the Codex binary and its login, or a wide write path opens the home to the agent.
  // Changed for spec 2026-11-02 PR 5: the template binds no ~/.codex; setup binds the backend's private-layer folder.
  for (const name of AGENT_UNITS) {
    const service = parseUnit(name);
    assert.equal(one(service, 'Service', 'ProtectSystem'), 'strict', name);
    assert.equal(one(service, 'Service', 'ProtectHome'), 'tmpfs', name);
    assert.equal(service.get('Service')?.get('BindPaths'), undefined, name);
    assert.deepEqual(service.get('Service')?.get('BindReadOnlyPaths'), ['/home/neptunia/.local'], name);
    assert.equal(one(service, 'Service', 'ReadWritePaths'), undefined, name);
    assert.equal(one(service, 'Service', 'NoNewPrivileges'), 'yes', name);
    assert.equal(one(service, 'Service', 'PrivateTmp'), 'yes', name);
  }
});

test("the agent units' PATH reaches codex and node", () => {
  // Bug: systemd's default PATH has neither, so the runner fails every task with backend-missing.
  for (const name of AGENT_UNITS) {
    const dirs = (one(parseUnit(name), 'Service', 'Environment') ?? '').replace(/^PATH=/, '').split(':');
    assert.ok(dirs.includes('/home/neptunia/.local/bin'), name);
    assert.ok(dirs.includes('/opt/node/bin'), name);
  }
});

test('the server unit holds no ambient capability, which bubblewrap refuses, and allows the netlink socket it needs', () => {
  // Bug: an ambient capability makes every Codex command fail with "Unexpected capabilities but not setuid".
  const service = parseUnit('neptunia-agent-server.service');
  assert.equal(one(service, 'Service', 'AmbientCapabilities'), undefined);
  assert.equal(one(service, 'Service', 'CapabilityBoundingSet'), 'CAP_DAC_READ_SEARCH');
  assert.match(one(service, 'Service', 'RestrictAddressFamilies') ?? '', /\bAF_NETLINK\b/);
});

test('the server unit denies all addresses but the resolver and the ranges of the Cloudflare hosts Codex talks to', () => {
  // Bug: a widened allow-list lets the read-only agent reach private networks or the metadata address.
  const service = parseUnit('neptunia-agent-server.service');
  assert.equal(one(service, 'Service', 'IPAddressDeny'), 'any');
  const allowed = service.get('Service')?.get('IPAddressAllow') ?? [];
  assert.ok(allowed.includes('127.0.0.53/32'));
  assert.ok(!allowed.some((entry) => /^(0\.0\.0\.0|10\.|169\.254\.)/.test(entry)));
});
