// Tests for src/keys/store.ts: keys.json in the private folder, read at the moment of use, mode 600, and no value in
// any listing or error. The file system is a temp folder; nothing is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeyStore, KeysError, KEYS_FILE } from '../src/keys/store.ts';
import { tempDir } from './fixtures/tmp.ts';
import { SECRET, SECRET_2, SECRET_3 } from './fixtures/keys-rig.ts';

function setup() {
  const privateDir = tempDir('keys-store-');
  return { privateDir, file: path.join(privateDir, KEYS_FILE), store: createKeyStore({ privateDir }) };
}

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

test('a listing shows name, last four characters, grant and reset day, and never a value', () => {
  const { store } = setup();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  store.addExtra({ name: 'sim', value: SECRET_2 });
  const listing = store.list();
  assert.deepEqual(listing.core, [{ name: 'core-1', last4: 'WXYZ', grant: 200, resetDay: 22 }]);
  assert.deepEqual(listing.extra, [{ name: 'sim', last4: 'ABCD', roles: [] }]);
  // Bug caught: a listing that returns the stored rows as they are, value included.
  const printed = JSON.stringify(listing);
  assert.ok(!printed.includes('SECRETVALUE'), 'no part of a value but its last four characters');
});

test('keys.json is mode 600 after the first write, and a file loosened by hand is tightened by the next write', () => {
  const { store, file } = setup();
  store.addCore({ name: 'core-1', value: SECRET });
  assert.equal(modeOf(file), 0o600);
  // Bug caught: the mode given at creation only, so a file that was 644 once stays readable by every user.
  fs.chmodSync(file, 0o644);
  store.addExtra({ name: 'sim', value: SECRET_2 });
  assert.equal(modeOf(file), 0o600);
});

test('every read goes to the file: a second store on the folder sees a key added by the first at once', () => {
  const { store, privateDir } = setup();
  const other = createKeyStore({ privateDir });
  assert.deepEqual(other.coreNames(), []);
  store.addCore({ name: 'core-1', value: SECRET });
  // Bug caught: a value cached in the process, so a key added from the chat is not used until a restart.
  assert.deepEqual(other.coreNames(), ['core-1']);
  assert.equal(other.valueOf('core-1'), SECRET);
  fs.writeFileSync(path.join(privateDir, KEYS_FILE), JSON.stringify({ core: [], extra: {}, roles: {} }));
  assert.deepEqual(other.coreNames(), [], 'an edit of the file by hand is read at the next use too');
});

test('core keys keep their order, and removing one reports how many are left', () => {
  const { store } = setup();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  store.addCore({ name: 'core-3', value: SECRET_3 });
  assert.deepEqual(store.coreNames(), ['core-1', 'core-2', 'core-3']);
  assert.deepEqual(store.removeCore('core-2'), { left: 2 });
  assert.deepEqual(store.coreNames(), ['core-1', 'core-3']);
  assert.deepEqual(store.removeCore('core-1'), { left: 1 });
  assert.deepEqual(store.removeCore('core-3'), { left: 0 });
  assert.deepEqual(store.list().core, []);
});

test('binding a name no extra key has is refused, and the binding stays empty', () => {
  const { store } = setup();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addExtra({ name: 'sim', value: SECRET_2 });
  // Bug caught: a typo in the name binding the role to nothing, so the role goes out on no key at all.
  assert.throws(() => store.bind('drawing', 'simm'), { code: 'unknown-key' });
  assert.throws(() => store.bind('drawing', 'core-1'), { code: 'unknown-key' }, 'a core key is not an extra key');
  assert.throws(() => store.bind('sorcery', 'sim'), { code: 'unknown-role' });
  assert.equal(store.boundTo('drawing'), null);
  store.bind('drawing', 'sim');
  assert.equal(store.boundTo('drawing'), 'sim');
  assert.deepEqual(store.list().extra, [{ name: 'sim', last4: 'ABCD', roles: ['drawing'] }]);
  store.unbind('drawing');
  assert.equal(store.boundTo('drawing'), null);
  assert.throws(() => store.unbind('drawing'), { code: 'not-bound' });
});

test('an extra key a role is bound to cannot be removed', () => {
  const { store } = setup();
  store.addExtra({ name: 'sim', value: SECRET_2 });
  store.bind('vision', 'sim');
  // Bug caught: removing the key and leaving a binding that names nothing.
  assert.throws(() => store.removeExtra('sim'), { code: 'key-in-use' });
  assert.equal(store.valueOf('sim'), SECRET_2);
  store.unbind('vision');
  store.removeExtra('sim');
  assert.equal(store.valueOf('sim'), null);
});

test('a name is unique across core and extra keys, and a bad name or value is refused without echoing it', () => {
  const { store, file } = setup();
  store.addCore({ name: 'core-1', value: SECRET });
  assert.throws(() => store.addExtra({ name: 'core-1', value: SECRET_2 }), { code: 'duplicate-name' });
  assert.throws(() => store.addCore({ name: 'core-1', value: SECRET_2 }), { code: 'duplicate-name' });
  const pasted = `core-2 ${SECRET_3}`;
  // Bug caught: a key pasted after the name landing in an error message, then in the log.
  assert.throws(
    () => store.addCore({ name: pasted, value: SECRET_3 }),
    (err: unknown) => err instanceof KeysError && err.code === 'bad-name' && !err.message.includes('SECRETVALUE')
  );
  assert.throws(
    () => store.addCore({ name: 'core-2', value: `${SECRET_3} extra` }),
    (err: unknown) => err instanceof KeysError && err.code === 'bad-value' && !err.message.includes('SECRETVALUE')
  );
  assert.throws(() => store.addCore({ name: 'core-2', value: '  ' }), { code: 'bad-value' });
  assert.throws(() => store.addCore({ name: 'core-2', value: SECRET_3, grant: 200 }), { code: 'bad-grant' });
  assert.throws(() => store.addCore({ name: 'core-2', value: SECRET_3, grant: 200, resetDay: 40 }), {
    code: 'bad-grant',
  });
  assert.deepEqual(store.coreNames(), ['core-1'], 'a refused add writes nothing');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRETVALUE-0003'));
});

test('a file that does not parse is an unreadable-file error that holds none of its content', () => {
  const { store, file } = setup();
  fs.writeFileSync(file, `{"core":[{"name":"core-1","value":"${SECRET}"`, { mode: 0o600 });
  // Bug caught: the JSON parser's message quoting the text around the error, with the key in it.
  assert.throws(
    () => store.list(),
    (err: unknown) => err instanceof KeysError && err.code === 'unreadable-file' && !err.message.includes('SECRETVALUE')
  );
});

test('a write keeps the sections of the file it does not own', () => {
  const { store, file } = setup();
  const sections = { subharness: { backend: 'codex', key: null, modes: { dev: 'sudo' } }, simulation: { key: 'sim' } };
  fs.writeFileSync(file, JSON.stringify({ core: [], extra: {}, roles: {}, ...sections }), { mode: 0o600 });
  // Bug caught: the store rewriting the file from its own three sections and dropping the next PR's settings.
  store.addCore({ name: 'core-1', value: SECRET });
  const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(written.subharness, sections.subharness);
  assert.deepEqual(written.simulation, sections.simulation);
});

test('a folder with no keys.json lists nothing and holds no key', () => {
  const { store, file } = setup();
  assert.deepEqual(store.list(), { core: [], extra: [] });
  assert.equal(store.valueOf('core-1'), null);
  assert.equal(fs.existsSync(file), false, 'reading creates no file');
});

// `setGrant` (spec 2026-11-02, follow-up 4): the grant of a stored core key changes without its value being typed again.

test('setting a grant on a core key keeps its value and its place in the list', () => {
  // Catches: the grant is set by removing and re-adding the key, which moves it off the primary place or loses the value.
  const { store } = setup();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  store.setGrant('core-1', { grant: 150, resetDay: 9 });
  assert.deepEqual(store.list().core, [
    { name: 'core-1', last4: 'WXYZ', grant: 150, resetDay: 9 },
    { name: 'core-2', last4: 'ABCD', grant: null, resetDay: null },
  ]);
  assert.equal(store.valueOf('core-1'), SECRET);
});

test('a null grant clears the grant and the reset day together', () => {
  // Catches: clearing leaves the reset day behind, and the week line counts a grant of zero dollars.
  const { store } = setup();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  store.setGrant('core-1', null);
  assert.deepEqual(store.list().core[0], { name: 'core-1', last4: 'WXYZ', grant: null, resetDay: null });
});

test('a grant for an extra key or an unknown name is unknown-key, and a reset day of 32 is bad-grant; nothing is written', () => {
  // Catches: a grant lands on an extra key the failover never uses, or a day no month has is saved.
  const { store, file } = setup();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  store.addExtra({ name: 'sim', value: SECRET_3 });
  const before = fs.readFileSync(file, 'utf8');
  const codeOf = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof KeysError ? err.code : 'other';
    }
  };
  assert.equal(
    codeOf(() => store.setGrant('sim', { grant: 10, resetDay: 1 })),
    'unknown-key'
  );
  assert.equal(
    codeOf(() => store.setGrant('core-9', { grant: 10, resetDay: 1 })),
    'unknown-key'
  );
  assert.equal(
    codeOf(() => store.setGrant('core-1', { grant: 10, resetDay: 32 })),
    'bad-grant'
  );
  assert.equal(
    codeOf(() => store.setGrant('core-1', { grant: -1, resetDay: 1 })),
    'bad-grant'
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
