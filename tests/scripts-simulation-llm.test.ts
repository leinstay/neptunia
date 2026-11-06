// scripts/lib/cli.ts#simulationLlm: the one place a paid script gets its llm. While keys.json stores the simulation's
// subscription route (`subharness.simulation`, src/subharness/subscription-path.ts), the script's core requests run
// through `claude` or `codex` and the simulation key is never read; with no stored route the script spends the
// simulation key through the direct client, as `simKey` always did. The spawn is a fake: no CLI starts, no model is
// asked, no key is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliError, simulationLlm } from '../scripts/lib/cli.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { SubscriptionChild, SubscriptionProcess } from '../src/subharness/subscription-client.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const SIM = 'sk-or-v1-sim-secret-0123456789';
const FIRST = [
  { role: 'system', content: 'You are the persona.' },
  { role: 'user', content: 'Is the trip still on?' },
];
const CORE = { role: 'core', purpose: 'reply', maxOutputTokens: 900 };
const FINAL = '<think>Yes.</think><msg>Still on.</msg>';

type Route = { backend: string; model: string; effort: string | null };

const se = (event: object) => ({ type: 'stream_event', event });

/** A spawn that answers every run with one finished Claude or Codex message, and keeps the child it was given. */
function fakeSpawn() {
  const children: Array<SubscriptionChild> = [];
  const spawn = (child: SubscriptionChild): SubscriptionProcess => {
    children.push(child);
    const events =
      child.args[0] === 'exec'
        ? [
            { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: FINAL } },
            { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 0, output_tokens: 8 } },
          ]
        : [
            se({ type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } }),
            se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FINAL } }),
            se({ type: 'content_block_stop', index: 0 }),
            se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
            se({ type: 'message_stop' }),
            { type: 'result', subtype: 'success', is_error: false, result: FINAL, num_turns: 1 },
          ];
    const queue = events.map((event) => JSON.stringify(event));
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const line = queue.shift();
          return Promise.resolve(line === undefined ? { value: undefined, done: true } : { value: line, done: false });
        },
      }),
    };
    return { lines, exited: Promise.resolve(0), kill: () => {} };
  };
  return { spawn, children };
}

/** A private dir whose keys.json holds the simulation key (or none) and the stored route (or none). */
function rig(options: { simulationKey?: string | null; route?: Route | null } = {}) {
  const dir = tempDir('nep-simulation-llm-');
  const key = options.simulationKey === undefined ? 'sim' : options.simulationKey;
  writeKeysFile(dir, {
    extra: key === null ? {} : { [key]: SIM },
    simulation: { key },
    subharness: { key: null, modes: {}, core: null, simulation: options.route ?? null },
  });
  for (const backend of ['claude', 'codex'] as const) fakeVendor(dir, backend, { loggedIn: true });
  const { spawn, children } = fakeSpawn();
  const directKeys: Array<string> = [];
  const directCalls: Array<unknown> = [];
  const deps = {
    env: { NEPTUNIA_DATA_DIR: dir } as Record<string, string>,
    createDirect: (apiKey: string) => {
      directKeys.push(apiKey);
      return {
        complete: (messages: unknown, opts?: unknown): Promise<CompleteResult> => {
          directCalls.push({ messages, opts });
          return Promise.resolve({ text: '<msg>from the api</msg>', usage: {}, estimated: 0 });
        },
      };
    },
    getConfig: () => ({
      llm: {
        maxRequestTokens: 50_000,
        maxRequestsPerDay: 5000,
        subscription: { fallback: false, thinking: false, holdMs: 45_000 },
      },
    }),
    state: { data: {}, markDirty: () => {} },
    spawn,
    workDir: tempDir('nep-simulation-llm-work-'),
    hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/persona' },
  };
  return { dir, deps, children, directKeys, directCalls };
}

const CLAUDE_SONNET: Route = { backend: 'claude', model: 'claude-sonnet-5-5', effort: null };

test("a stored Claude route sends the script's core request through claude with the route's model", async () => {
  // Catches: a replay that spends the simulation key although the owner put the simulation on the subscription.
  const { dir, deps, children, directKeys, directCalls } = rig({
    route: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
  });
  const sim = simulationLlm('replay-cli', deps);
  assert.equal(sim.route, 'subscription');
  const answer = await sim.llm.complete(FIRST, CORE);
  assert.equal(answer.text, FINAL);
  assert.equal(children.length, 1);
  const [child] = children;
  assert.equal(child.binary, subharnessPlace(dir, 'claude').binary);
  assert.equal(child.args[child.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(child.args[child.args.indexOf('--effort') + 1], 'low');
  assert.equal(directCalls.length, 0);
  assert.deepEqual(directKeys, []);
});

test("a stored Codex route sends the script's core request through codex with the route's model", async () => {
  // Catches: the backend of the record ignored, so a Codex route still starts claude or the API.
  const { dir, deps, children } = rig({ route: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } });
  const sim = simulationLlm('replay-cli', deps);
  const answer = await sim.llm.complete(FIRST, CORE);
  assert.equal(answer.text, FINAL);
  const [child] = children;
  assert.equal(child.binary, subharnessPlace(dir, 'codex').binary);
  assert.equal(child.args[0], 'exec');
  assert.equal(child.args[child.args.indexOf('-m') + 1], 'gpt-6.1-sol');
});

test('a script with the route stored runs while the simulation is off and holds no key', async () => {
  // Catches: simKey called first, so a script on the subscription still stops with "the simulation is off".
  const { deps, children } = rig({ simulationKey: null, route: CLAUDE_SONNET });
  const sim = simulationLlm('inner-week', deps);
  assert.equal(sim.route, 'subscription');
  await sim.llm.complete(FIRST, CORE);
  assert.equal(children.length, 1);
});

test('a request of another role on the route with no key is refused with simulation-off and starts nothing', async () => {
  // Catches: a helper-role request sent to the CLI, or to an API client built with an empty key.
  const { deps, children } = rig({ simulationKey: null, route: CLAUDE_SONNET });
  const sim = simulationLlm('replay-cli', deps);
  await assert.rejects(
    sim.llm.complete(FIRST, { role: 'memory', purpose: 'recall' }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'simulation-off'
  );
  assert.equal(children.length, 0);
});

test('with no route stored the script spends the simulation key through the direct client', async () => {
  // Catches: the helper always taking the subscription, or reading the wrong key, after "model set simulation api".
  const { deps, children, directKeys, directCalls } = rig({ route: null });
  const sim = simulationLlm('replay-cli', deps);
  assert.equal(sim.route, 'key');
  const answer = await sim.llm.complete(FIRST, CORE);
  assert.equal(answer.text, '<msg>from the api</msg>');
  assert.deepEqual(directKeys, [SIM]);
  assert.equal(directCalls.length, 1);
  assert.equal(children.length, 0);
});

test('with no route and the simulation off the script stops with a one-line CliError that names the tool', () => {
  // Catches: a script on neither route starting anyway, or a refusal with no tool name.
  const { deps, directKeys } = rig({ simulationKey: null, route: null });
  assert.throws(
    () => simulationLlm('recall-eval', deps),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.message.startsWith('recall-eval:'), err.message);
      assert.equal(err.message.includes('\n'), false);
      assert.equal(err.message.includes(SIM), false);
      return true;
    }
  );
  assert.deepEqual(directKeys, []);
});

test("the route's record is the simulation's, never the core's", async () => {
  // Catches: the helper reading subharness.core, so a replay draws from her live window.
  const { dir, deps, children } = rig({ route: null });
  writeKeysFile(dir, {
    extra: { sim: SIM },
    simulation: { key: 'sim' },
    subharness: {
      key: null,
      modes: {},
      core: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
      simulation: null,
    },
  });
  const sim = simulationLlm('replay-cli', deps);
  assert.equal(sim.route, 'key');
  await sim.llm.complete(FIRST, CORE);
  assert.equal(children.length, 0);
});
