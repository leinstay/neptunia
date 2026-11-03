// src/interface/commands/interface-token.ts: `interface token set <iface>` asks the owner for the platform token through
// the chat's secret prompt and writes `interfaces/<iface>/credentials.json`, the private JSON the interface reads, at mode 600.
// The token never reaches an answer or a log line. The private folder is a temp dir, the chat a scripted dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setInterfaceToken, tokenVariableOf } from '../src/interface/commands/interface-token.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const TOKEN = 'TOKENVALUE.Zm9vYmFy.abcdef-123456';

// Interface credentials use the prepared persona JSON contract, preserving other stored fields on rotation.
const envFile = (privateDir: string, iface: string): string =>
  path.join(privateDir, 'interfaces', iface, 'credentials.json');
const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

test('the token variable of an interface is its name in capitals with _TOKEN', () => {
  // Catches: the file is written under a variable the Discord package never reads, so the unit starts without a token.
  assert.equal(tokenVariableOf('discord'), 'DISCORD_TOKEN');
  assert.equal(tokenVariableOf('my-chat'), 'MY_CHAT_TOKEN');
});

test('the token is asked as a secret and written to interfaces/<iface>/credentials.json at mode 600', async () => {
  // Catches: the token is echoed while typed, or the file is left readable by every user of the machine.
  const privateDir = tempDir('iface-token-');
  const { dialog, asked } = scriptedDialog([`${TOKEN}\n`]);
  const answer = await setInterfaceToken({ privateDir, iface: 'discord', dialog });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(
    asked.map((one) => one.secret),
    [true]
  );
  const file = envFile(privateDir, 'discord');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: TOKEN });
  assert.equal(modeOf(file), 0o600);
});

test('a second set replaces the token and keeps the other credential fields', async () => {
  // Catches: a rotation appends a second token, or wipes a credential field the owner put in the file by hand.
  const privateDir = tempDir('iface-token-');
  fs.mkdirSync(path.dirname(envFile(privateDir, 'discord')), { recursive: true });
  fs.writeFileSync(
    envFile(privateDir, 'discord'),
    JSON.stringify({ token: 'old-one', proxy: 'http://proxy.test:3128' }),
    {
      mode: 0o644,
    }
  );
  await setInterfaceToken({ privateDir, iface: 'discord', dialog: scriptedDialog([TOKEN]).dialog });
  assert.deepEqual(JSON.parse(fs.readFileSync(envFile(privateDir, 'discord'), 'utf8')), {
    token: TOKEN,
    proxy: 'http://proxy.test:3128',
  });
  assert.equal(modeOf(envFile(privateDir, 'discord')), 0o600);
});

test('a blank answer or one with a space writes nothing', async () => {
  // Catches: an aborted prompt (Ctrl-C answers blank) overwrites a working token with an empty one.
  const privateDir = tempDir('iface-token-');
  for (const typed of ['', 'two words']) {
    const answer = await setInterfaceToken({ privateDir, iface: 'discord', dialog: scriptedDialog([typed]).dialog });
    assert.equal(answer.status, 'invalid', JSON.stringify(typed));
  }
  assert.equal(fs.existsSync(envFile(privateDir, 'discord')), false);
});

test('without a dialog, or for a name that is no interface name, nothing is asked and nothing is written', async () => {
  // Catches: a name like ../.env makes the command write outside clients/, over the core's own secrets.
  const privateDir = tempDir('iface-token-');
  assert.equal((await setInterfaceToken({ privateDir, iface: 'discord', dialog: null })).status, 'invalid');
  const { dialog, asked } = scriptedDialog([TOKEN]);
  for (const iface of ['../.env', 'Discord', '']) {
    const answer = await setInterfaceToken({ privateDir, iface, dialog });
    assert.equal(answer.status, 'invalid', iface);
  }
  assert.deepEqual(asked, []);
  assert.equal(fs.existsSync(path.join(privateDir, '.env')), false);
  assert.equal(fs.existsSync(path.join(privateDir, 'clients')), false);
});

test('the token appears in no answer and no log line', async () => {
  // Catches: the answer or a log line confirms the save by quoting the token, and it ends up in the journal.
  const privateDir = tempDir('iface-token-');
  const { result, logs } = await withCapturedLogs(() =>
    setInterfaceToken({ privateDir, iface: 'discord', dialog: scriptedDialog([TOKEN]).dialog })
  );
  assert.equal(result.text.includes('TOKENVALUE'), false);
  assert.equal(JSON.stringify(logs).includes('TOKENVALUE'), false);
});

test('the table parses interface token set to its own command, not to an interface subcommand', () => {
  // Catches: the line reaches the Discord package as `/interface token set ...` and nothing writes the file.
  const parsed = parseCommandLine('/interface token set discord');
  assert.deepEqual(parsed.ok ? { name: parsed.name, args: parsed.args } : parsed.reason, {
    name: 'interface.token.set',
    args: { name: 'discord' },
  });
});

test('the console writes the token file for interface.token.set over its private folder', async () => {
  // Catches: the parsed command reaches the console and falls through to "no such command".
  const privateDir = tempDir('iface-token-');
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => null,
    selfId: () => null,
    hot: { config: {} },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
  };
  const answer = await createConsole(deps).run(
    'interface.token.set',
    { name: 'discord' },
    { id: 'owner' },
    scriptedDialog([TOKEN]).dialog
  );
  assert.equal(answer.status, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(envFile(privateDir, 'discord'), 'utf8')), { token: TOKEN });
});
