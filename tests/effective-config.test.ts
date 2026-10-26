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
import '../src/tools/impl/index.ts';
import { transportOf } from '../src/tools/tool-calls.ts';
import { safeModeOn, skillsOn } from '../src/tools/access.ts';
import { discoveryOn, grantedSkillNames } from '../src/tools/discovery.ts';
import { skillRegistry } from '../src/tools/registry.ts';

type Settings = Record<string, unknown>;
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
  grantedSkillNames({ config, selfId: SELF, registry: skillRegistry() });

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
  assert.equal(transportOf(result), 'text');
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
  assert.equal(discoveryOn(result), false);
});

test('reads safe mode and the tools switch an old local file turns on and off', async () => {
  const { result } = await withCapturedLogs(() => load({ skills: { safeMode: true }, features: { skills: false } }));
  assert.equal(safeModeOn(result), true);
  assert.equal(skillsOn(result), false);
  assert.deepEqual(granted(result), []);
});

test('leaves safe mode off and the tools on when the old file says nothing of them', async () => {
  const { result } = await withCapturedLogs(() => load(OLD_SHAPED));
  assert.equal(safeModeOn(result), false);
  assert.equal(skillsOn(result), true);
});

test('gives the same config as the file written by hand with the new names', async () => {
  const old = await withCapturedLogs(() => load(OLD_SHAPED));
  const written = await withCapturedLogs(() => load(NEW_SHAPED));
  assert.deepEqual(old.result, written.result);
});
