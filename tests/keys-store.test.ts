// Tests for src/keys/store.ts: the named keys of keys.json in the private folder, read at the moment of use, mode 600,
// and no value in any listing or error. The file system is a temp folder; nothing is mocked.
// Changed: keys.json holds named keys alone under `keys` (spec 2026-11-09-model-routes, slice 4), so the core list, the
// extra keys and their bindings are gone from the store.
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
const written = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

test('a listing shows each key by name and last four characters in file order, and never a value', () => {
  const { store } = setup();
  store.add({ name: 'main', value: SECRET });
  store.add({ name: 'helpers', value: SECRET_2 });
  assert.deepEqual(store.list(), [
    { name: 'main', last4: 'WXYZ' },
    { name: 'helpers', last4: 'ABCD' },
  ]);
  assert.deepEqual(store.names(), ['main', 'helpers']);
  // Bug caught: a listing that returns the stored rows as they are, value included.
  assert.ok(!JSON.stringify(store.list()).includes('SECRETVALUE'), 'no part of a value but its last four characters');
});

test('keys.json is mode 600 after the first write, and a file loosened by hand is tightened by the next write', () => {
  const { store, file } = setup();
  store.add({ name: 'main', value: SECRET });
  assert.equal(modeOf(file), 0o600);
  // Bug caught: the mode given at creation only, so a file that was 644 once stays readable by every user.
  fs.chmodSync(file, 0o644);
  store.add({ name: 'sim', value: SECRET_2 });
  assert.equal(modeOf(file), 0o600);
});

test('every read goes to the file: a second store on the folder sees a key added by the first at once', () => {
  const { store, privateDir } = setup();
  const other = createKeyStore({ privateDir });
  assert.deepEqual(other.names(), []);
  store.add({ name: 'main', value: SECRET });
  // Bug caught: a value cached in the process, so a key added from the chat is not used until a restart.
  assert.deepEqual(other.names(), ['main']);
  assert.equal(other.valueOf('main'), SECRET);
  fs.writeFileSync(path.join(privateDir, KEYS_FILE), JSON.stringify({ keys: {} }));
  assert.deepEqual(other.names(), [], 'an edit of the file by hand is read at the next use too');
});

test('removing a key takes it out and leaves the others in their order; an unknown name is refused', () => {
  const { store } = setup();
  store.add({ name: 'one', value: SECRET });
  store.add({ name: 'two', value: SECRET_2 });
  store.add({ name: 'three', value: SECRET_3 });
  store.remove('two');
  assert.deepEqual(store.names(), ['one', 'three']);
  assert.equal(store.valueOf('two'), null);
  // Bug caught: a removal of a name the file lacks that rewrites the file or answers as if it removed one.
  assert.throws(() => store.remove('two'), { code: 'unknown-key' });
});

test('a name is used once, and a bad name or value is refused without echoing it', () => {
  const { store, file } = setup();
  store.add({ name: 'main', value: SECRET });
  assert.throws(() => store.add({ name: 'main', value: SECRET_2 }), { code: 'duplicate-name' });
  const pasted = `second ${SECRET_3}`;
  // Bug caught: a key pasted after the name landing in an error message, then in the log.
  assert.throws(
    () => store.add({ name: pasted, value: SECRET_3 }),
    (err: unknown) => err instanceof KeysError && err.code === 'bad-name' && !err.message.includes('SECRETVALUE')
  );
  assert.throws(
    () => store.add({ name: 'second', value: `${SECRET_3} extra` }),
    (err: unknown) => err instanceof KeysError && err.code === 'bad-value' && !err.message.includes('SECRETVALUE')
  );
  assert.throws(() => store.add({ name: 'second', value: '  ' }), { code: 'bad-value' });
  assert.deepEqual(store.names(), ['main'], 'a refused add writes nothing');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRETVALUE-0003'));
});

test('a file that does not parse is an unreadable-file error that holds none of its content', () => {
  const { store, file } = setup();
  fs.writeFileSync(file, `{"keys":{"main":"${SECRET}"`, { mode: 0o600 });
  // Bug caught: the JSON parser's message quoting the text around the error, with the key in it.
  assert.throws(
    () => store.list(),
    (err: unknown) => err instanceof KeysError && err.code === 'unreadable-file' && !err.message.includes('SECRETVALUE')
  );
});

test('a file that still holds the core list or the extra section is refused as old-layout, value unread', () => {
  const { store, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ core: [{ name: 'main', value: SECRET }], extra: { sim: SECRET_2 } }));
  // Bug caught: a file the migration missed read as holding no key, so every role loses its key without a word.
  assert.throws(
    () => store.names(),
    (err: unknown) => err instanceof KeysError && err.code === 'old-layout' && !err.message.includes('SECRETVALUE')
  );
  assert.throws(() => store.valueOf('main'), { code: 'old-layout' });
});

test('a write keeps the service credentials and the management key and drops the routing and unread sections', () => {
  const { store, file } = setup();
  const services = { youtube: 'yt-SECRET' };
  const kept = { services, management: 'mgmt-SECRET' };
  const dropped = { roles: {}, subharness: { key: null }, simulation: { key: 'sim' }, variables: { main: 'x' } };
  fs.writeFileSync(file, JSON.stringify({ keys: {}, ...kept, ...dropped }), { mode: 0o600 });
  // Bug caught: the store rewriting the file from its own section and dropping the service credentials.
  store.add({ name: 'main', value: SECRET });
  assert.deepEqual(written(file), { ...kept, keys: { main: SECRET } });
});

test('a folder with no keys.json lists nothing and holds no key', () => {
  const { store, file } = setup();
  assert.deepEqual(store.list(), []);
  assert.equal(store.valueOf('main'), null);
  assert.equal(fs.existsSync(file), false, 'reading creates no file');
});
