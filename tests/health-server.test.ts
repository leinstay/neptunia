// Tests for the server part of `/health` (src/health/server.ts#serverHealth) over a fake probe: a unit that is down,
// a disk that is nearly full, a firewall that is off, and a machine without `ufw`. The machine itself is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverHealth } from '../src/health/server.ts';
import type { ServerProbe } from '../src/health/server.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const GB = 1024 ** 3;

/** A healthy machine: half the disk free, a low load, every unit active, a backup of last night, ufw active. */
function probe(change: Partial<ServerProbe> = {}): ServerProbe {
  return {
    disk: () => Promise.resolve({ path: '/opt/neptunia/data', freeBytes: 50 * GB, totalBytes: 100 * GB }),
    load: () => ({ one: 0.2, five: 0.3, fifteen: 0.3, cpus: 4 }),
    units: () =>
      Promise.resolve([
        { name: 'neptunia-core.service', active: true },
        { name: 'neptunia-interface@discord.service', active: true },
      ]),
    lastBackup: () => ({ name: '2026-10-31-030000-memory' }),
    firewall: () => Promise.resolve({ active: true }),
    ...change,
  };
}

test('a healthy machine reports ok', async () => {
  assert.equal((await serverHealth(probe(), { now: NOW })).status, 'ok');
});

test('a unit that is not active fails the server part and is named', async () => {
  const health = await serverHealth(
    probe({
      units: () =>
        Promise.resolve([
          { name: 'neptunia-core.service', active: true },
          { name: 'neptunia-interface@zeta71.service', active: false },
        ]),
    }),
    { now: NOW }
  );
  assert.equal(health.status, 'fail');
  assert.ok(health.text.includes('neptunia-interface@zeta71.service'));
});

test('a disk with less than a tenth free is not ok', async () => {
  const health = await serverHealth(
    probe({ disk: () => Promise.resolve({ path: '/opt/neptunia/data', freeBytes: 1 * GB, totalBytes: 100 * GB }) }),
    { now: NOW }
  );
  assert.notEqual(health.status, 'ok');
  assert.equal(health.disk.freeBytes, 1 * GB);
});

test('a firewall that exists and is inactive is not ok', async () => {
  const health = await serverHealth(probe({ firewall: () => Promise.resolve({ active: false }) }), { now: NOW });
  assert.notEqual(health.status, 'ok');
  assert.deepEqual(health.firewall, { active: false });
});

test('a machine without ufw reports no firewall and stays ok', async () => {
  const health = await serverHealth(probe({ firewall: () => Promise.resolve(null) }), { now: NOW });
  assert.equal(health.firewall, null);
  assert.equal(health.status, 'ok');
});
