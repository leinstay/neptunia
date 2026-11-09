// `/mnemonic` (src/interface/commands/table.ts, console.ts): the owner's command that shows the language of the
// phrase-code word list and switches it through `config.set` of `bot.mnemonic`. A recording `runOp` and a synthetic
// config only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

type Call = { op: string; args: Record<string, unknown>; context: Record<string, unknown> };

function deskOf(mnemonic: unknown): { run: ReturnType<typeof createConsole>['run']; calls: Array<Call> } {
  const calls: Array<Call> = [];
  const dir = tempDir('nep-mnemonic-');
  const deps: ConsoleDeps = {
    runOp: (op, args, context) => {
      calls.push({ op, args, context });
      return Promise.resolve({ status: 'ok', code: '', summary: 'set', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { mnemonic } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.parse('2026-11-09T12:00:00Z'),
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    startWatcher: () => null,
  };
  const desk = createConsole(deps);
  return { run: (...given) => desk.run(...given), calls };
}

test('parses /mnemonic with no language, en or ru, and refuses another language', () => {
  assert.deepEqual(parseCommandLine('/mnemonic'), { ok: true, name: 'mnemonic', args: {} });
  assert.deepEqual(parseCommandLine('/mnemonic ru'), { ok: true, name: 'mnemonic', args: { language: 'ru' } });
  assert.equal(parseCommandLine('/mnemonic en').ok, true);
  assert.equal(parseCommandLine('/mnemonic de').ok, false);
});

test('shows the language the setting holds and changes nothing', async () => {
  const { run, calls } = deskOf('ru');
  const answer = await run('mnemonic', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /ru/);
  assert.deepEqual(calls, []);
});

test('shows en while the setting holds no language', async () => {
  const { run } = deskOf(undefined);
  const answer = await run('mnemonic', {}, { id: 'owner-1' });
  assert.match(answer.text, /en/);
});

test('switches the language through config.set of bot.mnemonic as the owner', async () => {
  const { run, calls } = deskOf('en');
  const answer = await run('mnemonic', { language: 'ru' }, { id: 'owner-1' });
  assert.equal(answer.status, 'ok');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.op, 'config.set');
  assert.deepEqual(call?.args, { path: 'bot.mnemonic', value: 'ru' });
  assert.equal(call?.context.asOwner, true);
});

test('reports a switch that config.set refused', async () => {
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'failed', code: 'x', summary: 'could not write', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { mnemonic: 'en' } } },
    privateDir: tempDir('nep-mnemonic-'),
    dataDir: tempDir('nep-mnemonic-'),
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    startWatcher: () => null,
  });
  const answer = await desk.run('mnemonic', { language: 'ru' }, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
});
