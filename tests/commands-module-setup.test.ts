// src/interface/commands/table.ts rows of src/interface/commands/module-setup.ts: the owner's commands over a module's setup contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { MODULE_ACTIONS } from '../src/interface/commands/module-setup.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import type { Dialog } from '../src/keys/commands.ts';
import { tempDir } from './fixtures/tmp.ts';

test('every action of the contract has its command, and the chat parses the targeted commands of both module kinds', () => {
  // Bug: the table lacks a command the setup promises, so the owner cannot change one value without the whole walk.
  // Changed: the interface comes before its command, by the owner's decision of 2026-11-11.
  for (const [line, name] of [
    ['/interfaces discord setup', 'interfaces.setup'],
    ['/interfaces discord settings', 'interfaces.settings'],
    ['/interfaces discord set token', 'interfaces.set'],
    ['/interfaces discord clear token', 'interfaces.clear'],
    ['/interfaces discord add servers 111', 'interfaces.add'],
    ['/interfaces discord remove servers 111', 'interfaces.remove'],
    ['/skills setup gifs', 'skills.setup'],
    ['/skills settings gifs', 'skills.settings'],
    ['/skills set gifs key', 'skills.set'],
    ['/skills clear gifs key', 'skills.clear'],
  ]) {
    const parsed = parseCommandLine(line);
    assert.equal(typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : parsed, name, line);
  }
});

test('the actions the console routes are the ones the table offers', () => {
  // Bug: an action of the contract has no row, so `moduleCommand` can never reach it from the chat.
  for (const action of MODULE_ACTIONS) {
    const words = action === 'setup' || action === 'settings' ? 'gifs' : 'gifs key value';
    assert.match(JSON.stringify(parseCommandLine(`/skills ${action} ${words}`)), new RegExp(`skills\\.${action}`));
  }
});

test('a finished interface setup ends with its settings and opens no pairing', async () => {
  // The owner removed owner pairing on 2026-11-11. Catches: the setup still opening pairing on the interface, or asking
  // for a phrase after its last setting. A pairing handed to the console is a recorder that must stay untouched.
  const dir = tempDir('nep-module-setup-end-');
  const opened: Array<string> = [];
  const asked: Array<string> = [];
  const base = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_HERE', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: {}, prompts: { labels: { pairing: { ask: 'zeta-pairing-question {iface}' } } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.parse('2026-11-11T12:00:00Z'),
  } satisfies Omit<ConsoleDeps, 'pairing'>;
  const deps = {
    ...base,
    pairing: {
      open: (iface: string) => {
        opened.push(iface);
        return 'opened';
      },
      approve: () => Promise.resolve({ text: 'paired', status: 'ok' }),
    },
  };
  const desk = createConsole(deps);
  const dialog: Dialog = {
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(question.toLowerCase().includes('token') ? 'token-value' : '');
    },
  };
  const parsed = parseCommandLine('/interfaces discord setup');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const answer = await desk.run(parsed.name, parsed.args, { id: 'owner' }, dialog);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(opened, []);
  assert.equal(
    asked.some((question) => question.includes('zeta-pairing-question')),
    false
  );
});
