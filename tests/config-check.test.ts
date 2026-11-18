// The checks over the settings of PR 7c (src/config/check.ts). `checkConfig` lists the keys of a local layer the
// schema does not know, at the first segment it does not know, and the keys whose value has none of the schema's
// types. A map's keys are free. The checks run over small schemas. `/config check` in the owner's chat and
// `neptunia doctor` report what
// `checkConfig` finds in the live local layer, and the core starts with such a layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkConfig } from '../src/config/check.ts';
import type { SchemaEntry } from '../src/config/schema.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { folders, runCli, startUnitsCore, withRig } from './fixtures/core-units.ts';
import { tempDir } from './fixtures/tmp.ts';

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

// ---- /config check -------------------------------------------------------------------------------------------------

function desk(privateDir: string, config: Record<string, unknown>): ReturnType<typeof createConsole> {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => T0,
  };
  return createConsole(deps);
}

function localLayer(local: Record<string, unknown>): string {
  const dir = tempDir('nep-config-check-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(local));
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

test('/config check names a chain and a provider route of a model role that does not exist, and fails', async () => {
  // Catches: a chain under the retired role `humanizer.linter` or a provider route `<model>@humanizer.writer` or
  // `<model>@search` sits in a map the schema leaves free, so the check passes a route that no request reads.
  const chain = [{ via: 'api', key: 'k', model: 'x/m', effort: null }];
  const local = {
    models: { routes: { 'humanizer.linter': chain, linter: chain, editor: chain } },
    llm: {
      providerByModel: {
        'x/@humanizer.writer': { only: ['p'] },
        'x/@search': { only: ['p'] },
        'x/@editor': { only: ['p'] },
        'x/': { only: ['p'] },
      },
    },
  };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.text.split('\n'), [
    'models.routes.humanizer.linter: unknown key',
    'llm.providerByModel.x/@humanizer.writer: unknown key',
    'llm.providerByModel.x/@search: unknown key',
  ]);
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

test('neptunia doctor warns about an unknown key and a key of the wrong type in config/config.json', async () => {
  const dirs = folders({});
  fs.rmSync(path.join(dirs.privateDir, 'config', 'config.json'));
  fs.mkdirSync(path.join(dirs.privateDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.privateDir, 'config', 'config.json'),
    JSON.stringify({ llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } })
  );
  fs.writeFileSync(
    path.join(dirs.privateDir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'core-1', value: 'sk-or-test-not-a-real-key' }], extra: {}, roles: {} }),
    {
      mode: 0o600,
    }
  );
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
