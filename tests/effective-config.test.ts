// The effective config of a local file written before the rename: the settings and the grants it carries under the old
// names (`skills.*`, `features.skills`, `features.skillsDiscovery`, the grant on `skills.describe`) must mean what they
// meant. The file is loaded the way a start loads it (src/config.js#readConfig) over a config.json that has only the new
// names, and the functions that read the settings answer what the owner set: the tool transport, the tool loop's bounds,
// safe mode, the switches, and the names of the tools granted to the persona. The shape is that of a production local
// file: a few settings under `skills`, a switch off, grants for her user id on tools and on the tool `skills.describe`.
// A second production-shaped file carries the errand and intention names of an earlier release: grants on `task.*` and
// `intent.*`, a stale `memory.refresh.*` grant, `agents.resultRetrySeconds` and the `agents.scout`, `agents.server` and
// `agents.ledger` sections. It gives the tools granted to her under the new names, the `errands.*` settings and the
// agent settings the old files gave, so her errand tools stay open after the deploy.
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
import { agentSettings } from '../src/agent-runner/profiles.js';

type Settings = Record<string, unknown>;
const SELF = 'self-1';
const grant = { everyone: false, roles: [], users: [SELF] };

/** A checkout whose config.json has the new names only, and a private folder with `local` as config.local.json. */
function load(local: Settings, features: Settings = {}): Settings {
  const root = tempDir('nep-effective-');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      features: { tools: true, toolsDiscovery: true, innerLife: false, intentions: false, ...features },
      errands: ERRAND_DEFAULTS,
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

/** The errand settings config.json carries, the ones every errand reads. */
const ERRAND_DEFAULTS = {
  opencodePath: '/opt/opencode/bin/opencode',
  toolResultChars: 6000,
  keepFilesHours: 24,
  recentLines: 6,
  maxOpen: 3,
  resultMaxChars: 3000,
  unreadShown: 5,
  resultRetrySeconds: 30,
  resultCooldownSeconds: 60,
};

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

/** A production-shaped local file written before the errand and intention names. */
const ERRAND_ERA = {
  bot: {
    owners: ['o1'],
    access: {
      'task.run': grant,
      'task.status': grant,
      'task.read': grant,
      'intent.set': grant,
      'intent.update': grant,
      'intent.list': grant,
      'message.edit': grant,
      'memory.refresh.user': grant,
    },
  },
  agents: {
    resultRetrySeconds: 45,
    ledger: { socket: null },
    scout: {
      enabled: true,
      cost: { input: 3, output: 9 },
      socket: '/run/neptunia-agent-scout/sock',
      limits: { steps: 30 },
      search: { provider: 'tavily' },
    },
    server: { enabled: true },
  },
};

test('lists the errand and intention tools of an old local file under their new names, the stale grant gone', async () => {
  const { result } = await withCapturedLogs(() => load(ERRAND_ERA, { intentions: true }));
  assert.deepEqual(granted(result), [
    'errand.read',
    'errand.run',
    'errand.status',
    'intention.list',
    'intention.set',
    'intention.update',
    'message.edit',
  ]);
});

test('reads the errand settings of an old local file from errands, the shared ones it overrides included', async () => {
  const { result } = await withCapturedLogs(() => load(ERRAND_ERA));
  assert.deepEqual(result.errands, { ...ERRAND_DEFAULTS, resultRetrySeconds: 45 });
});

test('reads the agent settings of an old local file as the old merged config gave them', async () => {
  const { result } = await withCapturedLogs(() => load(ERRAND_ERA));
  assert.deepEqual(agentSettings('scout', result), {
    enabled: true,
    cost: { input: 3, output: 9 },
    socket: '/run/neptunia-agent-scout/sock',
    out: '/var/lib/neptunia-agent-scout/out',
    limits: { steps: 30, seconds: 300 },
    daily: { tasks: 40 },
    searchProvider: 'tavily',
  });
  assert.deepEqual(agentSettings('server', result), {
    enabled: true,
    cost: { input: 2, output: 6 },
    socket: '/run/neptunia-agent-server/sock',
    out: '/var/lib/neptunia-agent-server/out',
    limits: { steps: 20, seconds: 120 },
    daily: { tasks: 40 },
    searchProvider: null,
  });
  // This line said the old file's `agents.ledger` section loads as it was. PR 6e drops `agents.ledger.socket`, which
  // nothing reads after the cutover, at load as config-migrate does.
  assert.equal(Object.hasOwn(result.agents as Settings, 'ledger'), false);
});

test('gives the same config as the file written by hand with the new names', async () => {
  const written = {
    bot: {
      owners: ['o1'],
      access: {
        'errand.run': grant,
        'errand.status': grant,
        'errand.read': grant,
        'intention.set': grant,
        'intention.update': grant,
        'intention.list': grant,
        'message.edit': grant,
      },
    },
    errands: { resultRetrySeconds: 45 },
    agents: {
      ledger: { socket: null },
      scout: {
        enabled: true,
        cost: { input: 3, output: 9 },
        socket: '/run/neptunia-agent-scout/sock',
        limits: { steps: 30 },
        searchProvider: 'tavily',
      },
      server: { enabled: true },
    },
  };
  const old = await withCapturedLogs(() => load(ERRAND_ERA));
  const hand = await withCapturedLogs(() => load(written));
  assert.deepEqual(old.result, hand.result);
});
