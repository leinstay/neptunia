// The config keys the tools rename moved (src/config-moves.ts): the settings that were under `skills.*`, the two feature
// switches `features.skills` and `features.skillsDiscovery`, and the owner's grant on the tool `skills.describe`. A
// config written with the old keys must keep meaning what it meant, so `moveConfigKeys` writes each old key under its
// new name, and the loader (src/config.js#readConfig) does it to the local file before that file is laid over
// config.json: an old key then overrides the shipped default of its new name, and a move is one warning line per load.
// `tools/config-migrate.mjs` shows (`--dry-run`) or writes (`--apply`) the same moves on a copy of a local file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';
import { moveConfigKeys } from '../src/config-moves.ts';

type Settings = Record<string, unknown>;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRANT = { everyone: false, roles: [], users: ['self-1'] };

const LOOP = { maxSteps: 5, timeBudgetMs: 1000, maxCallsPerStep: 2, stepReserveTokens: 100 };
const SETTINGS: Array<[string, unknown]> = [
  ['safeMode', true],
  ['resultMaxChars', 3000],
  ['markTextMaxChars', 120],
  ['destructiveCooldownMinutes', 5],
  ['callTimeoutMs', 90_000],
  ['transport', 'text'],
  ['loop', LOOP],
];

for (const [key, value] of SETTINGS) {
  test(`moves skills.${key} to tools.${key}`, () => {
    const { config, moved } = moveConfigKeys({ skills: { [key]: value } });
    assert.deepEqual(config, { tools: { [key]: value } });
    assert.deepEqual(moved, [{ from: `skills.${key}`, to: `tools.${key}` }]);
  });
}

test('moves the two feature switches, a false one included', () => {
  const { config } = moveConfigKeys({ features: { skills: false, skillsDiscovery: false, diary: true } });
  assert.deepEqual(config, { features: { tools: false, toolsDiscovery: false, diary: true } });
});

test('moves a false safe mode and keeps it false', () => {
  assert.deepEqual(moveConfigKeys({ skills: { safeMode: false } }).config, { tools: { safeMode: false } });
});

test('moves the grant on skills.describe, whose name holds a dot, and leaves the other grants alone', () => {
  const other = { everyone: true, roles: [], users: [] };
  const { config, moved } = moveConfigKeys({
    bot: { owners: ['o1'], access: { 'skills.describe': GRANT, 'message.edit': other } },
  });
  assert.deepEqual(config, { bot: { owners: ['o1'], access: { 'tools.describe': GRANT, 'message.edit': other } } });
  assert.deepEqual(moved, [{ from: 'bot.access.skills.describe', to: 'bot.access.tools.describe' }]);
});

test('leaves every key it does not move exactly where it was', () => {
  const given = {
    bot: { owners: ['o1'] },
    features: { diary: true },
    diary: { channelId: 'c9' },
    recall: { maxPerDay: 3 },
  };
  const { config, moved, shadowed } = moveConfigKeys(given);
  assert.deepEqual(config, given);
  assert.deepEqual([moved, shadowed], [[], []]);
});

test('moves an empty config to an empty config', () => {
  assert.deepEqual(moveConfigKeys({}), { config: {}, moved: [], shadowed: [] });
});

test('removes the old section once everything in it has moved', () => {
  const { config } = moveConfigKeys({ skills: { safeMode: true, loop: { maxSteps: 2 } } });
  assert.equal(Object.hasOwn(config, 'skills'), false);
});

test('lets the new key win when both are present, and reports the old one as shadowed', () => {
  const { config, moved, shadowed } = moveConfigKeys({
    skills: { transport: 'text', safeMode: true },
    tools: { transport: 'native' },
  });
  assert.deepEqual(config, { tools: { transport: 'native', safeMode: true } });
  assert.deepEqual(moved, [{ from: 'skills.safeMode', to: 'tools.safeMode' }]);
  assert.deepEqual(shadowed, [{ from: 'skills.transport', to: 'tools.transport' }]);
});

test('merges a loop section key by key, the new keys winning', () => {
  const { config } = moveConfigKeys({
    skills: { loop: { maxSteps: 5, maxCallsPerStep: 3 } },
    tools: { loop: { maxSteps: 2 } },
  });
  assert.deepEqual(config, { tools: { loop: { maxSteps: 2, maxCallsPerStep: 3 } } });
});

test('moves nothing the second time', () => {
  const first = moveConfigKeys({
    skills: { safeMode: true },
    features: { skills: false },
    bot: { access: { 'skills.describe': GRANT } },
  });
  const second = moveConfigKeys(first.config);
  assert.deepEqual(second, { config: first.config, moved: [], shadowed: [] });
});

test('does not change the config it is given', () => {
  const given = { skills: { safeMode: true, loop: { maxSteps: 2 } }, features: { skills: true } };
  const copy = structuredClone(given);
  moveConfigKeys(given);
  assert.deepEqual(given, copy);
});

test('leaves a skills value that is not a section alone', () => {
  assert.deepEqual(moveConfigKeys({ skills: null }).config, { skills: null });
  assert.deepEqual(moveConfigKeys({ skills: 'on' }).config, { skills: 'on' });
});

// ---- the loader ----------------------------------------------------------------------------------------------

/** A checkout whose config.json has the tools defaults and a private folder whose config.local.json is `local`. */
function deployment(local: Settings | null) {
  const root = tempDir('nep-moves-');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      features: { tools: true, toolsDiscovery: true, diary: true },
      tools: { safeMode: false, transport: 'native', loop: { maxSteps: 3, maxCallsPerStep: 4 } },
      bot: { owners: [], access: {} },
    })
  );
  if (local !== null) fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify(local));
  return root;
}

const warnings = (logs: Array<Record<string, unknown>>) => logs.filter((entry) => entry.level === 'warn');

test('lets an old key of the local file override the shipped default of its new name', async () => {
  const root = deployment({ skills: { safeMode: true, loop: { maxSteps: 7 } }, features: { skills: false } });
  const { result } = await withCapturedLogs(() => readConfig(root, { privateDir: root }) as Settings);
  const tools = result.tools as Settings;
  assert.equal(tools.safeMode, true);
  assert.deepEqual(tools.loop, { maxSteps: 7, maxCallsPerStep: 4 });
  assert.equal((result.features as Settings).tools, false);
  assert.equal(Object.hasOwn(result, 'skills'), false);
});

test('says so in one warning line per load, however many keys moved', async () => {
  const root = deployment({
    skills: { safeMode: true, transport: 'text' },
    features: { skills: true },
    bot: { access: { 'skills.describe': GRANT } },
  });
  const { logs } = await withCapturedLogs(() => readConfig(root, { privateDir: root }));
  assert.equal(warnings(logs).length, 1);
});

test('says nothing when the local file has no old key, or there is no local file', async () => {
  const written = await withCapturedLogs(() => readConfig(deployment({ tools: { safeMode: true } })));
  const absent = await withCapturedLogs(() => readConfig(deployment(null)));
  assert.deepEqual([warnings(written.logs).length, warnings(absent.logs).length], [0, 0]);
});

// ---- tools/config-migrate.mjs -------------------------------------------------------------------------------

/** Runs the migration tool on `file` with `flags`; the tool reads and writes nothing else. */
function migrate(flags: Array<string>, file: string | null) {
  const run = spawnSync(
    process.execPath,
    ['tools/config-migrate.mjs', ...flags, ...(file === null ? [] : ['--file', file])],
    { cwd: ROOT, encoding: 'utf8' }
  );
  return { code: run.status, out: run.stdout, err: run.stderr };
}

function localCopy(local: Settings): string {
  const dir = tempDir('nep-migrate-');
  const file = path.join(dir, 'config.local.json');
  fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
  return file;
}

test('shows each move as `from -> to` on a dry run and changes no byte of the file', () => {
  const file = localCopy({ skills: { safeMode: true }, features: { skillsDiscovery: false }, bot: { owners: ['o1'] } });
  const before = fs.readFileSync(file, 'utf8');
  const run = migrate(['--dry-run'], file);
  assert.equal(run.code, 0);
  assert.equal(run.out.includes('skills.safeMode -> tools.safeMode'), true);
  assert.equal(run.out.includes('features.skillsDiscovery -> features.toolsDiscovery'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('writes the moved keys into the file on --apply and leaves everything else as it was', () => {
  const file = localCopy({ skills: { safeMode: true }, bot: { owners: ['o1'] }, diary: { channelId: 'c9' } });
  const run = migrate(['--apply'], file);
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    tools: { safeMode: true },
    bot: { owners: ['o1'] },
    diary: { channelId: 'c9' },
  });
});

test('finds nothing to move in a file it already migrated', () => {
  const file = localCopy({ skills: { safeMode: true } });
  migrate(['--apply'], file);
  const settled = fs.readFileSync(file, 'utf8');
  const again = migrate(['--apply'], file);
  assert.equal(again.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), settled);
  assert.equal(again.out.includes('->'), false);
});

test('refuses to run without --dry-run or --apply, and touches nothing', () => {
  const file = localCopy({ skills: { safeMode: true } });
  const before = fs.readFileSync(file, 'utf8');
  const run = migrate([], file);
  assert.equal(run.code, 1);
  assert.equal(run.err.includes('--apply') && run.err.includes('--dry-run'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
