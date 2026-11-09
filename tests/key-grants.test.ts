// Tests for src/llm/key-grants.ts: the reset moment of a key's grant and the balance left since it. The clock is a
// fixed instant; the spend comes from a fake of the usage records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreKeyBalances, keyBalances, lastResetMs } from '../src/llm/key-grants.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { SECRET } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const at = (iso: string): number => Date.parse(iso);
const T0 = Date.parse('2026-11-02T09:00:00Z');

test('lastResetMs: the reset day of this month once it has begun, else the one of the month before', () => {
  assert.equal(lastResetMs(at('2026-11-20T10:00:00Z'), 15), at('2026-11-15T00:00:00Z'));
  assert.equal(lastResetMs(at('2026-11-10T10:00:00Z'), 15), at('2026-10-15T00:00:00Z'));
  assert.equal(lastResetMs(at('2027-01-03T10:00:00Z'), 15), at('2026-12-15T00:00:00Z'), 'across the new year');
});

test('lastResetMs: at the day boundary the new grant has begun, one millisecond before it has not', () => {
  assert.equal(lastResetMs(at('2026-11-15T00:00:00Z'), 15), at('2026-11-15T00:00:00Z'));
  // Bug caught: the boundary read as still the old period, so the balance showed the spend of a grant already renewed.
  assert.equal(lastResetMs(at('2026-11-15T00:00:00Z') - 1, 15), at('2026-10-15T00:00:00Z'));
});

test('lastResetMs: a reset day past the end of a short month falls on its last day', () => {
  assert.equal(lastResetMs(at('2026-02-28T12:00:00Z'), 31), at('2026-02-28T00:00:00Z'));
  assert.equal(lastResetMs(at('2026-03-10T12:00:00Z'), 31), at('2026-02-28T00:00:00Z'));
  assert.equal(lastResetMs(at('2028-03-10T12:00:00Z'), 31), at('2028-02-29T00:00:00Z'), 'leap year');
  assert.equal(lastResetMs(at('2026-05-02T12:00:00Z'), 31), at('2026-04-30T00:00:00Z'));
  assert.equal(lastResetMs(at('2026-03-31T00:00:00Z'), 31), at('2026-03-31T00:00:00Z'));
});

test('keyBalances: the grant minus the spend since the reset day, null for a key with no entry, bad entries ignored', () => {
  const asked: Array<string> = [];
  const rows = keyBalances({
    keys: {
      OPENROUTER_CORE_KEY: { grant: 200, resetDay: 15 },
      OPENROUTER_BAD: { grant: 'lots', resetDay: 15 },
      OPENROUTER_LATE: { grant: 10, resetDay: 32 },
    },
    names: ['OPENROUTER_CORE_KEY', 'OPENROUTER_CORE_BACKUP_KEY', 'OPENROUTER_BAD', 'OPENROUTER_LATE'],
    now: at('2026-11-20T10:00:00Z'),
    spentSince: (name, day) => {
      asked.push(`${name} ${day}`);
      return 38.5;
    },
  });
  assert.deepEqual(rows[0], { name: 'OPENROUTER_CORE_KEY', left: 161.5, grant: 200, resetDay: 15 });
  assert.deepEqual(
    rows.slice(1).map((row) => row.left),
    [null, null, null]
  );
  assert.deepEqual(asked, ['OPENROUTER_CORE_KEY 2026-11-15'], 'only a configured key is summed, from its reset day');
});

test('keyBalances: a spend past the grant reads negative, and no llm.keys at all leaves every key unconfigured', () => {
  const over = keyBalances({
    keys: { OPENROUTER_CORE_KEY: { grant: 5, resetDay: 1 } },
    names: ['OPENROUTER_CORE_KEY'],
    now: at('2026-11-20T10:00:00Z'),
    spentSince: () => 7,
  });
  assert.equal(over[0]?.left, -2);
  assert.deepEqual(keyBalances({ keys: undefined, names: ['OPENROUTER_X'], now: 0, spentSince: () => 0 }), [
    { name: 'OPENROUTER_X', left: null, grant: null, resetDay: null },
  ]);
});

test('coreKeyBalances: the spend recorded under a key name is taken off its grant', () => {
  const store = createKeyStore({ privateDir: tempDir('key-grants-') });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  store.addCore({ name: 'core-1', value: SECRET, grant: 100, resetDay: 1 });
  const spent: Record<string, number> = { 'core-1': 5 };
  const llm = {
    keyNames: (role: string) => ring.names(role),
    keyGrants: () => ring.grants(),
  };
  const usage = { keyCost: (name: string) => spent[name] ?? 0 };
  const [row] = coreKeyBalances({ llm, usage, now: T0 });
  // Bug caught: a grant shown in full although the key has spent part of it.
  assert.equal(row?.left, 95);
});
