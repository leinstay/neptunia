// scripts/lib/simulation-llm.ts beyond the spec of tests/scripts-simulation-llm.test.ts: the tool bridge a script
// serves on its own socket for a core step with tools, the route read once at the start, and the helper roles on the
// simulation key while the route is stored. The spawn is a fake that plays the MCP process's side of the socket
// (src/subharness/tool-bridge.ts, `bridgePeer`); no CLI starts, no model is asked, no key is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { simulationLlm } from '../scripts/lib/cli.ts';
import { connectSocket, MAX_FRAME_BYTES } from '../src/protocol/wire.ts';
import { bridgePeer } from '../src/subharness/tool-bridge.ts';
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
const FINAL = '<msg>Still on.</msg>';
const TOOLS = [
  { type: 'function', function: { name: 'memory.search', description: 'search', parameters: { type: 'object' } } },
];
const ROUTE = { backend: 'claude', model: 'claude-sonnet-5-5', effort: null };

const se = (event: object) => ({ type: 'stream_event', event });
const CLAUDE_EVENTS = [
  se({ type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } }),
  se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FINAL } }),
  se({ type: 'content_block_stop', index: 0 }),
  se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
  se({ type: 'message_stop' }),
  { type: 'result', subtype: 'success', is_error: false, result: FINAL, num_turns: 1 },
];

type McpServer = { args: Array<string> };

/** The value after `flag` in the MCP server's argv. */
const argOf = (args: Array<string>, flag: string): string => args[args.indexOf(flag) + 1] ?? '';

/**
 * A spawn whose run first does what `bin/neptunia-mcp.ts` does (reads the token file, connects to the socket of the
 * `--mcp-config`, lists the tools), then answers with one finished message. `listed` holds the names the bridge gave.
 */
function bridgeSpawn() {
  const children: Array<SubscriptionChild> = [];
  const listed: Array<string> = [];
  const sockets: Array<string> = [];
  const spawn = (child: SubscriptionChild): SubscriptionProcess => {
    children.push(child);
    const config = JSON.parse(argOf(child.args, '--mcp-config')) as { mcpServers: { nep: McpServer } };
    const { args } = config.mcpServers.nep;
    const socketPath = argOf(args, '--socket');
    sockets.push(socketPath);
    const token = fs.readFileSync(argOf(args, '--token-file'), 'utf8').trim();
    const peerDone = connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES }).then(async (transport) => {
      const tools = await bridgePeer(transport, token).list();
      for (const tool of tools) listed.push((tool as { function: { name: string } }).function.name);
      transport.close();
    });
    const queue = CLAUDE_EVENTS.map((event) => JSON.stringify(event));
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await peerDone;
          const line = queue.shift();
          return line === undefined ? { value: undefined, done: true } : { value: line, done: false };
        },
      }),
    };
    return { lines, exited: peerDone.then(() => 0), kill: () => {} };
  };
  return { spawn, children, listed, sockets };
}

/** A persona folder with the simulation key and the stored route, and the deps of a script over it. */
function rig() {
  const dir = tempDir('nep-simulation-bridge-');
  writeKeysFile(dir, {
    extra: { sim: SIM },
    simulation: { key: 'sim' },
    subharness: { key: null, modes: {}, core: null, simulation: ROUTE },
  });
  fakeVendor(dir, 'claude', { loggedIn: true });
  const fake = bridgeSpawn();
  const directKeys: Array<string> = [];
  const deps = {
    env: { NEPTUNIA_DATA_DIR: dir } as Record<string, string>,
    createDirect: (apiKey: string) => {
      directKeys.push(apiKey);
      return {
        complete: (): Promise<CompleteResult> =>
          Promise.resolve({ text: '<msg>from the api</msg>', usage: {}, estimated: 0 }),
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
    spawn: fake.spawn,
    workDir: tempDir('nep-simulation-bridge-work-'),
    hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/persona' },
  };
  return { dir, deps, directKeys, ...fake };
}

test("a core step with tools on the route reaches the script's own bridge, which lists the step's tools", async () => {
  // Catches: the script handing the CLI a socket nobody listens on, so her tools never reach a replay on the route.
  const { deps, listed, sockets } = rig();
  const sim = simulationLlm('replay-cli', deps);
  const answer = await sim.llm.complete(FIRST, { role: 'core', purpose: 'reply', tools: TOOLS });
  assert.equal(answer.text, FINAL);
  assert.deepEqual(listed, ['memory.search']);
  await sim.close();
  assert.equal(fs.existsSync(sockets[0] ?? ''), false);
});

test('the route stays as the script read it when the record is cleared during the run', async () => {
  // Catches: the route read again per request, so a replay switches to the paid key halfway through its run.
  const { dir, deps, children, directKeys } = rig();
  const sim = simulationLlm('replay-cli', deps);
  writeKeysFile(dir, {
    extra: { sim: SIM },
    simulation: { key: 'sim' },
    subharness: { key: null, modes: {}, core: null, simulation: null },
  });
  await sim.llm.complete(FIRST, { role: 'core', purpose: 'reply', tools: TOOLS });
  assert.equal(children.length, 1);
  assert.deepEqual(directKeys, []);
  await sim.close();
});

test('a request of another role on the route spends the simulation key while one is set', async () => {
  // Catches: a helper request (the analyzer, a describer) sent to the CLI, or refused although the key is set.
  const { deps, children, directKeys } = rig();
  const sim = simulationLlm('replay-cli', deps);
  const answer = await sim.llm.complete(FIRST, { role: 'analyzer', purpose: 'analyze' });
  assert.equal(answer.text, '<msg>from the api</msg>');
  assert.deepEqual(directKeys, [SIM]);
  assert.equal(children.length, 0);
});
