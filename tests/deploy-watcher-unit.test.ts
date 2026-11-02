// The watcher's systemd units (deploy/neptunia-watcher.timer and .service), read as text, without systemd: the timer
// fires at 00:00 UTC, and the service runs `neptunia watcher run` once, as a user of its own, with the node of the
// server. Each fact is a line a deployment would get wrong silently.
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
      unit.set(section, unit.get(section) ?? new Map());
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
