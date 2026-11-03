// Tests for src/keys/import.ts and scripts/keys-import.ts: the one-time move of the OPENROUTER_* variables of a .env,
// the llm.keyByRole map and the llm.keys grants into keys.json. The report names things and never holds a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../src/config/files.ts';
import { importKeys } from '../src/keys/import.ts';
import { createKeyStore, KEYS_FILE } from '../src/keys/store.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV = {
  OPENROUTER_CORE_KEY: 'v-core-main-AAA1',
  OPENROUTER_CORE_BACKUP_KEY: 'v-core-backup-BBB2',
  OPENROUTER_ERRAND_KEY: 'v-errand-CCC3',
  OPENROUTER_MEMORY_KEY: 'v-memory-DDD4',
  OPENROUTER_DEV_KEY: 'v-dev-EEE5',
  OPENROUTER_SIM_KEY: 'v-sim-FFF6',
  OPENROUTER_BLANK_KEY: '  ',
  DISCORD_TOKEN: 'v-discord-GGG7',
};
const CONFIG = {
  llm: {
    keyByRole: {
      drawing: 'OPENROUTER_ERRAND_KEY',
      memory: 'OPENROUTER_MEMORY_KEY',
      scout: 'OPENROUTER_ERRAND_KEY',
      thinker: 'OPENROUTER_DEV_KEY',
      vision: 'OPENROUTER_GONE_KEY',
    },
    keys: {
      OPENROUTER_CORE_KEY: { grant: 200, resetDay: 22 },
      OPENROUTER_CORE_BACKUP_KEY: { grant: 100, resetDay: 1 },
    },
  },
};

function fresh() {
  const privateDir = tempDir('keys-import-');
  return { privateDir, store: createKeyStore({ privateDir }) };
}

test('the core variables become core-1 and core-2 with their grants, in the default order', () => {
  const { store } = fresh();
  const report = importKeys({ env: ENV, config: CONFIG, store });
  assert.deepEqual(report.core, ['core-1', 'core-2']);
  assert.deepEqual(store.list().core, [
    { name: 'core-1', last4: 'AAA1', grant: 200, resetDay: 22 },
    { name: 'core-2', last4: 'BBB2', grant: 100, resetDay: 1 },
  ]);
  assert.equal(store.valueOf('core-1'), ENV.OPENROUTER_CORE_KEY);
});

test('an explicit llm.keyByRole.core list sets the order and takes the grants of the variable each key came from', () => {
  const { store } = fresh();
  const config = { llm: { ...CONFIG.llm, keyByRole: { core: ['OPENROUTER_CORE_BACKUP_KEY', 'OPENROUTER_CORE_KEY'] } } };
  importKeys({ env: ENV, config, store });
  // Bug caught: the default order used whatever the config says, so the backup becomes the primary and the grants swap.
  assert.deepEqual(store.list().core, [
    { name: 'core-1', last4: 'BBB2', grant: 100, resetDay: 1 },
    { name: 'core-2', last4: 'AAA1', grant: 200, resetDay: 22 },
  ]);
});

test('other OPENROUTER_*_KEY variables become extra keys named after the variable, and base roles are bound to them', () => {
  const { store } = fresh();
  const report = importKeys({ env: ENV, config: CONFIG, store });
  assert.deepEqual(
    store
      .list()
      .extra.map((row) => row.name)
      .sort(),
    ['dev', 'errand', 'memory', 'sim']
  );
  assert.deepEqual(
    report.bound.sort((a, b) => a.role.localeCompare(b.role)),
    [
      { role: 'drawing', name: 'errand' },
      { role: 'memory', name: 'memory' },
    ]
  );
  assert.equal(store.boundTo('drawing'), 'errand');
  assert.equal(store.boundTo('memory'), 'memory');
});

test('errand and development roles and unset variables are skipped by name, and the key behind them stays', () => {
  const { store } = fresh();
  const report = importKeys({ env: ENV, config: CONFIG, store });
  const skipped = report.skipped.map((row) => row.what);
  assert.ok(skipped.includes('scout') && skipped.includes('thinker'), 'bound in the subharness, not here');
  assert.ok(skipped.includes('vision'), 'its variable is not set');
  assert.equal(store.boundTo('scout'), null);
  assert.equal(store.boundTo('vision'), null);
  assert.equal(store.valueOf('dev'), ENV.OPENROUTER_DEV_KEY, 'the dev key is kept as an extra key');
  // A blank variable is not a key.
  assert.equal(
    report.extra.some((row) => row.from === 'OPENROUTER_BLANK_KEY'),
    false
  );
});

test('a variable that is not an OpenRouter key never enters the store', () => {
  const { store, privateDir } = fresh();
  importKeys({ env: ENV, config: CONFIG, store });
  // Bug caught: importing the whole .env, so the Discord token is copied into a file the model keys live in.
  const written = fs.readFileSync(path.join(privateDir, KEYS_FILE), 'utf8');
  assert.ok(!written.includes('GGG7'));
});

test('the report holds names only, never a value', () => {
  const { store } = fresh();
  const report = importKeys({ env: ENV, config: CONFIG, store });
  const printed = JSON.stringify(report);
  for (const value of Object.values(ENV).filter((v) => v.trim() !== '')) assert.ok(!printed.includes(value), value);
});

test('a second import over a store that holds a key is refused and changes nothing', () => {
  const { store, privateDir } = fresh();
  importKeys({ env: ENV, config: CONFIG, store });
  const before = fs.readFileSync(path.join(privateDir, KEYS_FILE), 'utf8');
  // Bug caught: running the import twice appending every key again, or overwriting keys the owner changed from the chat.
  assert.throws(() => importKeys({ env: { OPENROUTER_CORE_KEY: 'v-other' }, config: {}, store }), {
    code: 'store-not-empty',
  });
  assert.equal(fs.readFileSync(path.join(privateDir, KEYS_FILE), 'utf8'), before);
});

test('with no keyByRole and no backup variable the core is the one main key', () => {
  const { store } = fresh();
  const report = importKeys({ env: { OPENROUTER_CORE_KEY: 'v-only-ZZZ9' }, config: {}, store });
  assert.deepEqual(report.core, ['core-1']);
  assert.deepEqual(store.list().core, [{ name: 'core-1', last4: 'ZZZ9', grant: null, resetDay: null }]);
});

test('the script reads .env and the local config of the private folder, writes keys.json mode 600 and prints names only', () => {
  const privateDir = tempDir('keys-import-script-');
  fs.writeFileSync(
    path.join(privateDir, '.env'),
    Object.entries(ENV)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  );
  const configFile = localConfigPath(privateDir);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({ llm: { keyByRole: { drawing: 'OPENROUTER_ERRAND_KEY' }, keys: CONFIG.llm.keys } })
  );
  const run = () =>
    spawnSync(process.execPath, ['scripts/keys-import.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NEPTUNIA_PRIVATE_DIR: privateDir, NEPTUNIA_DATA_DIR: privateDir },
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(privateDir, KEYS_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const store = createKeyStore({ privateDir });
  assert.deepEqual(
    store.list().core.map((row) => [row.name, row.grant]),
    [
      ['core-1', 200],
      ['core-2', 100],
    ]
  );
  assert.equal(store.boundTo('drawing'), 'errand');
  const printed = `${first.stdout}${first.stderr}`;
  for (const value of Object.values(ENV).filter((v) => v.trim() !== ''))
    assert.ok(!printed.includes(value), 'no value printed');
  assert.ok(printed.includes('core-1') && printed.includes('errand'), 'it names what it moved');
  const second = run();
  assert.equal(second.status, 1, 'a second run is refused');
});
