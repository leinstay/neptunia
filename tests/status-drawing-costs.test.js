// The drawing agent on the owner's `/nep status` card (stage 3b): `costs.agents` lists it with its
// runs and dollars from the task records, `costs.base` has no row for the pictures (they are the
// drawing agent's spend, never counted twice), and `keys.base` has no line for the agents' key
// when the drawing role is on it, nor does the main key's rolling sum count the pictures. Over a
// real task store in a temp directory and a fake usage accumulator; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createTaskStore } from '../src/errands/store.js';
import { usageTap, createUsage } from '../src/ops/usage.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-18T12:00:00Z');

const COSTS = {
  keyLead: 'main',
  simKeyLead: 'sim',
  simKeyNotSet: 'sim: not set',
  roleKeyLead: '{roles} key',
  roleSeparator: '+',
  keyLimitPlain: '{lead} {spent}/{limit}',
  partSeparator: ' | ',
  role: '{role}: {requests} req {cost}',
  byRoleEmpty: 'none',
  agentLine: '{agent}: {parts}',
  agentWindow: '{window} {runs}r {in}/{out} {usd}',
  agentWindows: { today: 'D', last7: 'W', last30: 'M' },
  agentNoRuns: '{agent}: none',
  agentEstimate: 'est.',
};

function setup() {
  const config = {
    bot: { owners: ['42'] },
    llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50, keyByRole: { web: 'OPENROUTER_AGENT_KEY', drawing: 'OPENROUTER_AGENT_KEY' } },
    agents: { maxOpen: 3, drawing: { daily: { tasks: 100, usd: 5 } } },
  };
  const hot = { config, prompts: { labels: { status: { costs: COSTS } } }, promptSources: {}, rootDir: tempDir('nep-status-drawing-') };
  const tasks = createTaskStore({ dataDir: tempDir('nep-status-drawing-data-'), guildId: 'g1', now: () => NOW, config: () => config });
  for (const usd of [0.03, 0.02]) {
    const { task } = tasks.add({ agent: 'drawing', goal: 'a scene', requester: { userId: null, kind: 'persona' }, origin: {}, scope: 'group' });
    tasks.start(task.id);
    tasks.finish(task.id, { status: 'done', result: { text: '' }, usage: { input: 40, output: 1000, usd, steps: 1, seconds: 3 } });
  }
  // The accumulator the status card reads: a voice request and a picture's `images: generated` line.
  const usage = createUsage({ dataDir: tempDir('nep-status-drawing-usage-'), now: () => NOW });
  const tap = usageTap(usage);
  tap({ msg: 'llm: usage', role: 'core', promptTokens: 100, completionTokens: 10, cost: 0.4 });
  tap({ msg: 'images: generated', cost: 0.03 });
  const reads = [];
  const llm = {
    roleKeys: () => [{ roles: ['drawing', 'web'] }],
    async keyInfo(options) {
      reads.push(options.role ?? 'main');
      return { ok: true, status: 200, json: { data: { limit: 30, limit_remaining: 30 } } };
    },
  };
  const errands = { store: (guildId) => (guildId === 'g1' ? tasks : null) };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const env = createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', llm, errands, usage });
  const card = async (field) => (await runOp('status.show', { field }, { env, guildId: 'g1', userId: '42', roleIds: [] })).data.embeds[0].fields[0].value.split('\n');
  return { card, reads };
}

test('status: costs.agents lists the drawing agent with its runs and dollars; costs.base has no row for the pictures', async () => {
  const { card } = setup();
  const { result } = await withCapturedLogs(async () => ({ agents: await card('costs.agents'), base: await card('costs.base') }));
  const drawing = result.agents.find((line) => line.startsWith('drawing:'));
  assert.equal(drawing, 'drawing: D 2r 80/2.0k 0.05 | W 2r 80/2.0k 0.05 | M 2r 80/2.0k 0.05');
  assert.equal(result.agents.at(-1), 'est.');
  assert.deepEqual(result.base, ['core: 1 req 0.40'], 'no drawing row: nothing counts twice');
});

test('status: keys.base leaves the agents\' key out when the drawing role is on it, and never reads it', async () => {
  const { card, reads } = setup();
  const { result } = await withCapturedLogs(() => card('keys.base'));
  assert.deepEqual(result, ['main 0.00/30.00', 'sim: not set']);
  assert.deepEqual(reads, ['main'], 'the agents key (web and drawing) is not read');
});
