// src/setup/modules.ts and its commands: one contract and one store for the settings of an interface or a skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { interfaceCredential } from '../src/config/files.ts';
import { moduleCommand } from '../src/interface/commands/module-setup.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { moduleDir, moduleValues, readModuleSettings, setModuleValue } from '../src/setup/modules.ts';
import type { ModuleKind } from '../src/setup/modules.ts';
import { scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'TOKENVALUE.abcd';
const DISCORD_LIKE = {
  settings: [
    { key: 'token', question: 'The token', kind: 'secret', required: true },
    { key: 'servers', question: 'The servers', kind: 'list', required: false },
    { key: 'greeting', question: 'The greeting', kind: 'text', required: false },
  ],
};

function rig(kind: ModuleKind = 'interface') {
  const base = tempDir('nep-modules-');
  const rootDir = path.join(base, 'engine');
  const dataDir = path.join(base, 'data');
  const code =
    kind === 'interface' ? path.join(rootDir, 'interfaces', 'chatty') : path.join(dataDir, 'skills', 'chatty');
  fs.mkdirSync(code, { recursive: true });
  fs.writeFileSync(path.join(code, 'setup.json'), JSON.stringify(DISCORD_LIKE));
  const where = { rootDir, dataDir, kind };
  const ref = { ...where, name: 'chatty' };
  const run = (
    action: Parameters<typeof moduleCommand>[1],
    args: Record<string, string> = {},
    answers: Array<string> = []
  ) => moduleCommand(where, action, { name: 'chatty', ...args }, scriptedDialog(answers).dialog);
  return { rootDir, dataDir, code, ref, run };
}

test('a secret is stored at 600 for the interface, read by the runtime reader, and only its ending is shown', async () => {
  // Bug: setup writes the token where the interface runner does not read it, or shows it back in the chat.
  const { ref, run, dataDir } = rig();
  await run('set', { key: 'token' }, [SECRET]);
  const file = path.join(moduleDir(ref), 'credentials.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(interfaceCredential(dataDir, 'chatty'), SECRET);
  const { text } = await run('settings');
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /token: set, ends in abcd/);
});

test('a secret typed on the command line is refused, so it never reaches the chat history', async () => {
  // Bug: `/interface set x token VALUE` leaves the value in the input history and the journal of commands.
  const { ref, run } = rig();
  const answer = await run('set', { key: 'token', value: SECRET });
  assert.equal(answer.status, 'invalid');
  assert.equal(fs.existsSync(path.join(moduleDir(ref), 'credentials.json')), false);
});

test('several servers are added and removed one at a time without repeating the list', async () => {
  // Bug: adding a second server replaces the first, or removing one forgets the others.
  const { run } = rig();
  await run('add', { key: 'servers', value: '111' });
  await run('add', { key: 'servers', value: '222' });
  await run('add', { key: 'servers', value: '222' });
  assert.match((await run('settings')).text, /servers: 111 222/);
  await run('remove', { key: 'servers', value: '111' });
  assert.match((await run('settings')).text, /servers: 222/);
  assert.match((await run('remove', { key: 'servers', value: '999' })).text, /999 is not in servers/);
});

test('the walk and the targeted commands read and write the same values', async () => {
  // Bug: `setup` and `/interface set` keep two stores, so a value set one way is not seen the other way.
  const { ref, run } = rig();
  await run('setup', {}, [SECRET, '111 222', 'hello there']);
  const settings = readModuleSettings(ref);
  if (settings === null) throw new Error('the fixture declares settings');
  assert.deepEqual(
    moduleValues(ref, settings).map((row) => row.value),
    ['set, ends in abcd', '111 222', 'hello there']
  );
  // An empty answer keeps what is stored.
  await run('setup', {}, ['', '', '']);
  await run('clear', { key: 'greeting' });
  const after = moduleValues(ref, settings);
  assert.deepEqual(
    after.map((row) => row.value),
    ['set, ends in abcd', '111 222', null]
  );
});

test('a walk names a required value that is still missing', async () => {
  // Bug: setup reports success with no token, and the interface fails only at its first start.
  const { run } = rig();
  assert.match((await run('setup', {}, ['', '', ''])).text, /still required: token/);
});

test('a skill stores its settings in its own folder through the same contract', async () => {
  // Bug: a skill's credential lands in the shared key store and leaves the skill's folder.
  const { dataDir, run } = rig('skill');
  await run('set', { key: 'token' }, [SECRET]);
  await run('set', { key: 'greeting', value: 'hello' });
  assert.equal(fs.existsSync(path.join(dataDir, 'keys.json')), false);
  const dir = path.join(dataDir, 'skills', 'chatty');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { greeting: 'hello' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')), { token: SECRET });
});

test('removing the code of a module keeps its values, the memory and every stored result', async () => {
  // Bug: removing a module's code wipes what it stored, or the commands crash on a missing package.
  const { code, ref, run, dataDir } = rig();
  await run('set', { key: 'greeting', value: 'hello' });
  const memory = path.join(dataDir, 'memory.db');
  fs.writeFileSync(memory, 'stored');
  fs.rmSync(code, { recursive: true });
  assert.equal(readModuleSettings(ref), null);
  const answer = await run('settings');
  assert.equal(answer.status, 'invalid');
  assert.match(answer.text, /declares no setup\.json/);
  assert.equal(fs.readFileSync(memory, 'utf8'), 'stored');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(moduleDir(ref), 'config.json'), 'utf8')), {
    greeting: 'hello',
  });
});

test('a name that leaves the module folders and a key the module does not declare are refused', async () => {
  // Bug: `../..` as a module name writes settings outside the persona root, or a typo stores a dead key.
  const { rootDir, dataDir, ref, run } = rig();
  const escaped = await moduleCommand({ rootDir, dataDir, kind: 'skill' }, 'settings', { name: '../..' }, null);
  assert.equal(escaped.status, 'invalid');
  assert.equal((await run('set', { key: 'nope', value: 'x' })).status, 'invalid');
  assert.equal(fs.existsSync(path.join(moduleDir(ref), 'config.json')), false);
  assert.throws(() => setModuleValue(ref, DISCORD_LIKE.settings as never, 'nope', 'x'), /no setting/);
});

test('the chat parses the targeted commands of both module kinds', () => {
  // Bug: the table lacks a command the setup promises, so the owner cannot change one value without the whole walk.
  for (const [line, name] of [
    ['/interface setup discord', 'interface.setup'],
    ['/interface settings discord', 'interface.settings'],
    ['/interface set discord token', 'interface.set'],
    ['/interface clear discord token', 'interface.clear'],
    ['/interface add discord servers 111', 'interface.add'],
    ['/interface remove discord servers 111', 'interface.remove'],
    ['/skills setup gifs', 'skills.setup'],
    ['/skills settings gifs', 'skills.settings'],
    ['/skills set gifs key', 'skills.set'],
    ['/skills clear gifs key', 'skills.clear'],
  ]) {
    const parsed = parseCommandLine(line);
    assert.equal(typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : parsed, name, line);
  }
});
