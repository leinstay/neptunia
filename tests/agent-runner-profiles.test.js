// Tests for src/agent-runner/profiles.js: the generated OpenCode config (the
// V1 shape of release v1.19.3) for each profile -- the agent's prompt, step
// cap, model and cost, the permission map (deny-all first, then the profile's
// allows), the bash allow-list order (catch-all deny first, specifics after,
// so the last match wins), and the withheld-path denies added only in a
// filtered scope. Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEB, SERVER, profileOf, SERVER_SHELL_ALLOW } from '../src/agent-runner/profiles.js';

test('profileOf: web, server, and nothing else', () => {
  assert.equal(profileOf('web'), WEB);
  assert.equal(profileOf('server'), SERVER);
  assert.equal(profileOf('nope'), null);
});

test('web config: agent prompt, model, cost, step cap, search absent from config', () => {
  const cfg = WEB.buildConfig({ systemPrompt: 'be careful', providerModel: 'openrouter/x-ai/grok-4.7', steps: 25, scope: 'core', cost: { input: 2, output: 6 }, toolResultChars: 6000 });
  assert.equal(cfg.model, 'openrouter/x-ai/grok-4.7');
  const agent = cfg.agent['errand-web'];
  assert.equal(agent.prompt, 'be careful');
  assert.equal(agent.steps, 25);
  assert.equal(agent.mode, 'primary');
  assert.deepEqual(cfg.provider.openrouter.models['x-ai/grok-4.7'].cost, { input: 2, output: 6 });
  assert.equal(cfg.tool_output.max_bytes, 6000);
  assert.equal(cfg.websearch, undefined, 'v1.19.3 has no websearch config key');
});

test('web permission: web tools allowed, edit/write/task/question denied, bash allow-list', () => {
  const p = WEB.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-web'].permission;
  assert.equal(p.websearch, 'allow');
  assert.equal(p.webfetch, 'allow');
  assert.equal(p.read, 'allow');
  assert.equal(p.edit, 'deny');
  assert.equal(p.write, 'deny');
  assert.equal(p.task, 'deny');
  assert.equal(p.question, 'deny');
  assert.equal(p.external_directory, 'deny');
  // bash: the catch-all deny is first so a specific allow (last match) wins
  const keys = Object.keys(p.bash);
  assert.equal(keys[0], '*');
  assert.equal(p.bash['*'], 'deny');
  assert.equal(p.bash['curl *'], 'allow');
});

test('server permission: read tools allowed, no network tools, read-only bash', () => {
  const p = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission;
  assert.equal(p.read, 'allow');
  assert.equal(p.grep, 'allow');
  assert.equal(p.list, 'allow');
  assert.equal(p.webfetch, 'deny');
  assert.equal(p.websearch, 'deny');
  assert.equal(p.bash['*'], 'deny');
  assert.equal(p.bash['cat *'], 'allow');
  assert.equal(p.bash['systemctl status *'], 'allow');
  assert.equal(p.bash.rm, undefined);
  // every allow-listed command is present
  for (const cmd of SERVER_SHELL_ALLOW) assert.equal(p.bash[cmd], 'allow', cmd);
});

test('filtered scope: path tools gain withheld denies, core does not', () => {
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission;
  assert.equal(core.read, 'allow');
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission;
  assert.equal(typeof dm.read, 'object');
  // allow first, then the denies (last match wins -> a withheld path is denied)
  const keys = Object.keys(dm.read);
  assert.equal(keys[0], '*');
  assert.equal(dm.read['*'], 'allow');
  assert.equal(dm.read['/var/www'], 'deny');
  assert.equal(dm.read['**/.env'], 'deny');
});

test('defaults: limits, daily, model, env names', () => {
  assert.deepEqual(WEB.defaultLimits, { steps: 25, usd: 0.5, seconds: 300 });
  assert.deepEqual(SERVER.defaultLimits, { steps: 20, usd: 0.2, seconds: 120 });
  assert.deepEqual(WEB.defaultDaily, { tasks: 40, usd: 8 });
  assert.ok(WEB.envNames.includes('OPENROUTER_AGENT_KEY'));
  assert.ok(WEB.envNames.includes('PROXY_URL'));
  assert.deepEqual([...SERVER.envNames], ['OPENROUTER_AGENT_KEY']);
  assert.equal(WEB.defaultSearchProvider, 'exa');
});
