// `agentSettings(name, config)` (src/agent-runner/profiles.js) is the one reader of an agent's settings for the core,
// the runner and the dispatcher: the tracked profile of the agent (`agents/<name>/profile.json`) with the deployment's
// override, `config.agents.<name>` of the live config, laid over it. It returns `{ enabled, cost, socket, out, limits,
// daily, searchProvider }` for a worker and the keys the profile has for a development agent, and null for a name that
// is no agent (`ledger` is a key of `agents`, not an agent). The values the profile alone gives are the ones
// `config.json` carried before the profile took them over, and an override lands field by field, a nested object
// merged key by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSettings } from '../src/agent-runner/profiles.js';

type Settings = Record<string, unknown> | null;

/** What `config.json` carried under `agents.<name>` before the profiles took the settings over, in the profile's shape. */
const OLD_DEFAULTS: Record<string, Record<string, unknown>> = {
  scout: {
    enabled: false,
    cost: { input: 2, output: 6 },
    socket: '/run/neptunia-agent-scout/sock',
    out: '/var/lib/neptunia-agent-scout/out',
    limits: { steps: 25, seconds: 300 },
    daily: { tasks: 40 },
    searchProvider: 'exa',
  },
  server: {
    enabled: false,
    cost: { input: 2, output: 6 },
    socket: '/run/neptunia-agent-server/sock',
    out: '/var/lib/neptunia-agent-server/out',
    limits: { steps: 20, seconds: 120 },
    daily: { tasks: 40 },
    searchProvider: null,
  },
};

const pick = (settings: Settings, keys: Array<string>): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, settings?.[key]]));

test('gives a worker the values config.json carried for it, from its profile alone', () => {
  assert.deepEqual(agentSettings('scout', {}), OLD_DEFAULTS.scout);
  assert.deepEqual(agentSettings('server', {}), OLD_DEFAULTS.server);
});

test('gives a development agent the price and the limits config.json carried for it', () => {
  assert.deepEqual(pick(agentSettings('thinker', {}), ['cost', 'limits']), {
    cost: { input: 4, output: 20 },
    limits: { steps: 400, minutes: 60 },
  });
  assert.deepEqual(pick(agentSettings('dev', {}), ['cost', 'limits']), {
    cost: { input: 2, output: 10 },
    limits: { steps: 300, minutes: 60 },
  });
});

test('lays a production-shaped override over the profile and equals the old merged value field by field', () => {
  // A deployment turns the scout on, sets its own socket and a higher step limit, and prices the server's tokens.
  const config = {
    agents: {
      scout: { enabled: true, socket: '/run/custom/scout.sock', limits: { steps: 30 } },
      server: { enabled: true, cost: { input: 1, output: 3 } },
    },
  };
  assert.deepEqual(agentSettings('scout', config), {
    ...OLD_DEFAULTS.scout,
    enabled: true,
    socket: '/run/custom/scout.sock',
    limits: { steps: 30, seconds: 300 },
  });
  assert.deepEqual(agentSettings('server', config), {
    ...OLD_DEFAULTS.server,
    enabled: true,
    cost: { input: 1, output: 3 },
  });
});

test('lets a local searchProvider win over the profile one, null included', () => {
  assert.equal(agentSettings('scout', { agents: { scout: { searchProvider: 'brave' } } })?.searchProvider, 'brave');
  assert.equal(agentSettings('scout', { agents: { scout: { searchProvider: null } } })?.searchProvider, null);
});

test('says null for agents.ledger and for a name no profile has', () => {
  const config = { agents: { ledger: { socket: '/run/ledger/sock' }, ghost: { enabled: true } } };
  assert.equal(agentSettings('ledger', config), null);
  assert.equal(agentSettings('ghost', config), null);
});

test('reads the override of the config it is given at each call', () => {
  const config: { agents: Record<string, Record<string, unknown>> } = { agents: { scout: { enabled: false } } };
  assert.equal(agentSettings('scout', config)?.enabled, false);
  config.agents.scout = { enabled: true };
  assert.equal(agentSettings('scout', config)?.enabled, true);
});
