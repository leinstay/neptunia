// The checks over the settings of PR 7c (src/config/check.ts). `checkConfig` lists the keys of a local layer the
// schema does not know, at the first segment it does not know, and the keys whose value has none of the schema's
// types. A map's keys are free. `checkReaders` lists the keys whose reader module does not exist or does not read
// them: a module reads a key when its source holds the dotted key, or holds both the key's first and its last segment
// as whole words. The checks run over small schemas and temporary trees, and once over the real tree, where every key
// of the schema has a reader that reads it. `/config check` in the owner's chat and `neptunia doctor` report what
// `checkConfig` finds in the live local layer, and the core starts with such a layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkConfig, checkReaders } from '../src/config/check.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import type { SchemaEntry } from '../src/config/schema.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { folders, runCli, startUnitsCore, withRig } from './fixtures/core-units.ts';
import { ROOT } from './fixtures/private-layer.ts';
import { tempDir } from './fixtures/tmp.js';

const T0 = Date.parse('2026-10-31T12:00:00Z');

const SCHEMA: ReadonlyArray<SchemaEntry> = [
  { key: 'llm.timeoutMs', types: ['number'], reader: 'src/a.js', default: 1000, text: 'the timeout' },
  { key: 'llm.provider', types: ['string', 'null'], reader: 'src/a.js', default: null, text: 'the provider' },
  { key: 'bot.access', types: ['map'], reader: 'src/a.js', default: {}, text: 'the grants' },
  { key: 'bot.owners', types: ['array'], reader: 'src/a.js', default: [], text: 'the owners' },
];

// ---- checkConfig ---------------------------------------------------------------------------------------------------

test('finds nothing in an empty local layer', () => {
  assert.deepEqual(checkConfig({}, SCHEMA), []);
});

test('finds nothing in a layer that sets known keys to values of their types', () => {
  const local = { llm: { timeoutMs: 5, provider: 'zeta' }, bot: { owners: ['1'] } };
  assert.deepEqual(checkConfig(local, SCHEMA), []);
});

test('reports a key the schema does not know inside a known section', () => {
  assert.deepEqual(checkConfig({ llm: { nosuch: 1 } }, SCHEMA), [{ key: 'llm.nosuch', kind: 'unknown' }]);
});

test('reports an unknown section once, at the section', () => {
  assert.deepEqual(checkConfig({ nosuch: { a: 1, b: { c: 2 } } }, SCHEMA), [{ key: 'nosuch', kind: 'unknown' }]);
});

test('reports a string where a number belongs', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: 'fast' } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports an array where a number belongs', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: [1] } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports null for a key whose types do not hold null', () => {
  assert.deepEqual(checkConfig({ llm: { timeoutMs: null } }, SCHEMA), [{ key: 'llm.timeoutMs', kind: 'type' }]);
});

test('reports a number where a section belongs', () => {
  assert.deepEqual(checkConfig({ llm: 5 }, SCHEMA), [{ key: 'llm', kind: 'type' }]);
});

test('takes any key inside a map, dots included', () => {
  const local = { bot: { access: { 'voice.say': { users: ['1'] }, 'web.search': { everyone: true } } } };
  assert.deepEqual(checkConfig(local, SCHEMA), []);
});

// ---- checkReaders --------------------------------------------------------------------------------------------------

function tree(files: Record<string, string>): string {
  const dir = tempDir('nep-readers-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const entry = (key: string, reader: string): SchemaEntry => ({ key, types: ['number'], reader, default: 1, text: key });

test('takes a reader whose source holds the dotted key', () => {
  const root = tree({ 'src/a.js': 'const ms = config.llm.timeoutMs;\n' });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/a.js')], root), []);
});

test('takes a reader that names the section and destructures the last segment', () => {
  const root = tree({ 'src/a.js': 'const { retries } = hot.config.llm ?? {};\n' });
  assert.deepEqual(checkReaders([entry('llm.retries', 'src/a.js')], root), []);
});

test('reports a reader whose source names the last segment but never the section', () => {
  const root = tree({ 'src/a.js': 'const retries = settings.retries;\n' });
  assert.deepEqual(checkReaders([entry('llm.retries', 'src/a.js')], root), [
    { key: 'llm.retries', reader: 'src/a.js', kind: 'not-read' },
  ]);
});

test('reports a reader whose source holds the key only inside a longer word', () => {
  const root = tree({ 'src/a.js': 'const x = config.llm.retriesMax;\n' });
  assert.deepEqual(checkReaders([entry('llm.retries', 'src/a.js')], root), [
    { key: 'llm.retries', reader: 'src/a.js', kind: 'not-read' },
  ]);
});

test('reports a reader module that does not exist', () => {
  const root = tree({ 'src/a.js': 'config.llm.timeoutMs\n' });
  assert.deepEqual(checkReaders([entry('llm.timeoutMs', 'src/gone.js')], root), [
    { key: 'llm.timeoutMs', reader: 'src/gone.js', kind: 'no-module' },
  ]);
});

test('every key of the schema has a reader module that reads it', () => {
  assert.deepEqual(checkReaders(CONFIG_SCHEMA, ROOT), []);
});

// ---- /config check -------------------------------------------------------------------------------------------------

function desk(privateDir: string, config: Record<string, unknown>): ReturnType<typeof createConsole> {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => T0,
  };
  return createConsole(deps);
}

function localLayer(local: Record<string, unknown>): string {
  const dir = tempDir('nep-config-check-');
  fs.mkdirSync(path.join(dir, 'config.local'));
  fs.writeFileSync(path.join(dir, 'config.local', 'config.json'), JSON.stringify(local));
  return dir;
}

test('/config check is a command of the table', () => {
  assert.deepEqual(parseCommandLine('/config check'), { ok: true, name: 'config.check', args: {} });
});

test('/config check names an unknown key and a key of the wrong type, and fails', async () => {
  const local = { llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes('llm.maxRequestsPerDay'), answer.text);
  assert.ok(answer.text.includes('nosuch'), answer.text);
});

test('/config check of a clean local layer answers ok', async () => {
  const local = { llm: { maxRequestsPerDay: 4000 } };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
});

// Spec case 4 end to end: the core starts on a local layer the schema refuses, and the chat's check names both keys.
test('the core starts on a local layer with an unknown key and a wrong type, and /config check names both', async () => {
  const config = { llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } };
  await withRig({ config }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/config check']);
    assert.equal(run.code, 1, run.stderr.slice(-2000));
    const printed = run.stdout + run.stderr;
    assert.ok(printed.includes('llm.maxRequestsPerDay'), printed.slice(-2000));
    assert.ok(printed.includes('nosuch'), printed.slice(-2000));
  });
});

// ---- neptunia doctor -----------------------------------------------------------------------------------------------

test('neptunia doctor warns about an unknown key and a key of the wrong type in config.local/config.json', async () => {
  const dirs = folders({});
  fs.rmSync(path.join(dirs.privateDir, 'config.local.json'));
  fs.mkdirSync(path.join(dirs.privateDir, 'config.local'));
  fs.writeFileSync(
    path.join(dirs.privateDir, 'config.local', 'config.json'),
    JSON.stringify({ llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } })
  );
  fs.writeFileSync(path.join(dirs.privateDir, '.env'), 'OPENROUTER_CORE_KEY=sk-or-test-not-a-real-key\n', {
    mode: 0o600,
  });
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed: unknown = JSON.parse(run.stdout);
  const checks =
    typeof parsed === 'object' && parsed !== null && Array.isArray(Reflect.get(parsed, 'checks'))
      ? (Reflect.get(parsed, 'checks') as Array<{ name: string; status: string; detail: string }>)
      : [];
  const config = checks.find((check) => check.name === 'config');
  assert.equal(config?.status, 'warn');
  const detail = config?.detail ?? '';
  assert.ok(detail.includes('llm.maxRequestsPerDay'), detail);
  assert.ok(detail.includes('nosuch'), detail);
});
