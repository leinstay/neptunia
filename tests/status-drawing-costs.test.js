// Drawing on the owner's `/nep status` card: `costs.base` has its row from the usage accumulator
// (one Images API request is a base role), `costs.errands` has none, and `keys.base` has no line
// for the errands' key when the drawing role is on it. Over a
// real task store in a temp directory and a fake usage accumulator; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { createTaskStore } from '../src/errands/store.ts';
import { usageTap, createUsage } from '../src/tools/impl/usage.ts';
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
    llm: {
      maxRequestsPerDay: 10,
      probeTimeoutMs: 50,
      keyByRole: { scout: 'OPENROUTER_ERRAND_KEY', drawing: 'OPENROUTER_ERRAND_KEY' },
    },
    errands: { maxOpen: 3 },
  };
  const hot = {
    config,
    prompts: { labels: { status: { costs: COSTS } } },
    promptSources: {},
    rootDir: tempDir('nep-status-drawing-'),
  };
  const tasks = createTaskStore({
    dataDir: tempDir('nep-status-drawing-data-'),
    guildId: 'g1',
    now: () => NOW,
    config: () => config,
  });
  // The accumulator the status card reads: a voice request and a picture's `images: generated` line.
  const usage = createUsage({ dataDir: tempDir('nep-status-drawing-usage-'), now: () => NOW });
  const tap = usageTap(usage);
  tap({ msg: 'llm: usage', role: 'core', promptTokens: 100, completionTokens: 10, cost: 0.4 });
  tap({ msg: 'images: generated', cost: 0.03 });
  const reads = [];
  const llm = {
    roleKeys: () => [{ roles: ['drawing', 'scout'] }],
    async keyInfo(options) {
      reads.push(options.role ?? 'main');
      return { ok: true, status: 200, json: { data: { limit: 30, limit_remaining: 30 } } };
    },
  };
  const errands = { store: (guildId) => (guildId === 'g1' ? tasks : null) };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const env = createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', llm, errands, usage });
  const card = async (field) =>
    (
      await runOp('status.show', { field }, { env, guildId: 'g1', userId: '42', roleIds: [] })
    ).data.embeds[0].fields[0].value.split('\n');
  return { card, reads };
}

test("status: drawing's spend is a row of costs.base from the usage accumulator, never a line of costs.errands", async () => {
  const { card } = setup();
  const { result } = await withCapturedLogs(async () => ({
    errands: await card('costs.errands'),
    base: await card('costs.base'),
  }));
  assert.deepEqual(result.errands, ['scout: none', 'server: none', 'est.'], 'the pictures are not an errand');
  assert.deepEqual(result.base, ['core: 1 req 0.40', 'drawing: 1 req 0.03']);
});

test("status: keys.base leaves the agents' key out when the drawing role is on it, and never reads it", async () => {
  const { card, reads } = setup();
  const { result } = await withCapturedLogs(() => card('keys.base'));
  assert.deepEqual(result, ['main 0.00/30.00', 'sim: not set']);
  assert.deepEqual(reads, ['main'], 'the agents key (scout and drawing) is not read');
});
