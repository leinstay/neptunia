// The effective config of a local file written before the rename: the settings and the grants it carries under the old
// names (`skills.*`, `features.skills`, `features.skillsDiscovery`, the grant on `skills.describe`) must mean what they
// meant. The file is loaded the way a start loads it (src/config.js#readConfig) over a config.json that has only the new
// names, and the functions that read the settings answer what the owner set: the tool transport, the tool loop's bounds,
// safe mode, the switches, and the names of the tools granted to the persona. The shape is that of a production local
// file: a few settings under `skills`, a switch off, grants for her user id on tools and on the tool `skills.describe`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { loopSettings } from '../src/behavior/turn.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

type Settings = Record<string, unknown>;
type Registry = Map<string, object>;
type Tools = {
  transportOf: (config: Settings) => 'native' | 'text';
  safeModeOn: (config: Settings) => boolean;
  skillsOn: (config: Settings) => boolean;
  discoveryOn: (config: Settings) => boolean;
  grantedSkillNames: (input: { config: Settings; selfId: string; registry: Registry }) => Array<string>;
  skillRegistry: () => Registry;
};

await import('../src/tools/impl/index.ts');
const toolCalls = (await import('../src/tools/tool-calls.ts')) as Pick<Tools, 'transportOf'>;
const access = (await import('../src/tools/access.ts')) as Pick<Tools, 'safeModeOn' | 'skillsOn'>;
const discovery = (await import('../src/tools/discovery.ts')) as Pick<Tools, 'grantedSkillNames' | 'discoveryOn'>;
const registry = (await import('../src/tools/registry.ts')) as Pick<Tools, 'skillRegistry'>;

const SELF = 'self-1';
const grant = { everyone: false, roles: [], users: [SELF] };

/** A checkout whose config.json has the new names only, and a private folder with `local` as config.local.json. */
function load(local: Settings): Settings {
  const root = tempDir('nep-effective-');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      features: { tools: true, toolsDiscovery: true, innerLife: false, intentions: false },
      tools: {
        safeMode: false,
        transport: 'native',
        loop: { maxSteps: 3, timeBudgetMs: 20_000, maxCallsPerStep: 4, stepReserveTokens: 6000 },
      },
      bot: { owners: [], access: {} },
    })
  );
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify(local));
  return readConfig(root, { privateDir: root }) as Settings;
}

const granted = (config: Settings): Array<string> =>
  discovery.grantedSkillNames({ config, selfId: SELF, registry: registry.skillRegistry() });

/** The file as a deployment wrote it before the rename, and the same file written with the new names. */
const OLD_SHAPED = {
  skills: { transport: 'text', loop: { maxSteps: 5, timeBudgetMs: 30_000 }, resultMaxChars: 3000 },
  features: { skillsDiscovery: false },
  bot: {
    owners: ['o1'],
    access: { 'skills.describe': grant, 'message.edit': grant, 'memory.restore': grant },
  },
};
const NEW_SHAPED = {
  tools: { transport: 'text', loop: { maxSteps: 5, timeBudgetMs: 30_000 }, resultMaxChars: 3000 },
  features: { toolsDiscovery: false },
  bot: {
    owners: ['o1'],
    access: { 'tools.describe': grant, 'message.edit': grant, 'memory.restore': grant },
  },
};

test('reads the transport an old local file sets', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  assert.equal(toolCalls.transportOf(result), 'text');
});

test('reads the loop bounds an old local file sets and keeps the shipped ones it does not set', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  const loop = loopSettings(result);
  assert.deepEqual(
    [loop.maxSteps, loop.timeBudgetMs, loop.maxCallsPerStep, loop.stepReserveTokens],
    [5, 30_000, 4, 6000]
  );
});

test('lists the tools granted to her under their new names, leaving out the one no grant opens for her', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  assert.deepEqual(granted(result), ['message.edit', 'tools.describe']);
});

test('reads the discovery switch an old local file turns off', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  assert.equal(discovery.discoveryOn(result), false);
});

test('reads safe mode and the tools switch an old local file turns on and off', async () => {
  const { result } = await withCapturedLogs(() => load({ skills: { safeMode: true }, features: { skills: false } }));
  assert.equal(access.safeModeOn(result), true);
  assert.equal(access.skillsOn(result), false);
  assert.deepEqual(granted(result), []);
});

test('leaves safe mode off and the tools on when the old file says nothing of them', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  assert.equal(access.safeModeOn(result), false);
  assert.equal(access.skillsOn(result), true);
});

test('gives the same config as the file written by hand with the new names', async () => {
  const old = await withCapturedLogs(() => load(OLD_SHAPED));
  const written = await withCapturedLogs(() => load(NEW_SHAPED));
  assert.deepEqual(old.result, written.result);
});
