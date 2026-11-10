// Her core requests through a subscription CLI (docs/keys.md): the
// client in front of the direct OpenRouter client starts one `claude -p` or `codex exec` per turn, answers each step
// of the unchanged step loop from the CLI's stream, and carries her tool calls through the bridge. The spawn is a fake
// whose stdout the test writes event by event; the test also plays the MCP server, calling the bridge with the turn's
// token. The backends' binaries are the fake vendor's scripts and never run. No model is asked and no key is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSubscriptionClient } from '../src/subharness/subscription-client.ts';
import type { SubscriptionChild, SubscriptionProcess } from '../src/subharness/subscription-client.ts';
import { createToolBridge } from '../src/subharness/tool-bridge.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import '../src/tools/operations/index.ts';
import { appendStep } from '../src/behavior/tool-step.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { normalizeCalls } from '../src/tools/tool-calls.ts';
import { parseOutput } from '../src/llm/parse.ts';
import { DailyCapError, TokenLimitError, countLlmRequest, errorCodeOf } from '../src/llm/openrouter.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import type { UsageEntry } from '../src/tools/operations/usage.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

// ---- her request ---------------------------------------------------------------------------------------------------

const SYSTEM_PARTS = [
  { type: 'text', text: 'You are the persona.\n', cacheSegment: 'card' },
  { type: 'text', text: 'Think in <think>, speak in <msg>.' },
];
const SYSTEM_TEXT = 'You are the persona.\nThink in <think>, speak in <msg>.';
const USER_PARTS = [
  { type: 'text', text: 'The people here.\n', cacheSegment: 'profiles' },
  { type: 'text', text: '#3 Ann: is the trip still on?' },
];
const USER_TEXT = 'The people here.\n#3 Ann: is the trip still on?';
const FIRST = [
  { role: 'system', content: SYSTEM_PARTS },
  { role: 'user', content: USER_PARTS },
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'intention_update',
      description: 'Update an intention',
      parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
    },
  },
];

const REPLY = { role: 'core', purpose: 'reply', tools: TOOLS, toolChoice: 'auto', maxOutputTokens: 900 };

const STEP_ONE_TEXT = '<think>Ann asks about the trip. I mark the intention done first.</think>';
const FINAL_TEXT = '<think>Marked.</think><msg>Still on, I checked it off.</msg>';
const CALL_ARGS = { id: '7', status: 'done' };
const NOTE = 'Two new lines arrived while you worked.';

// ---- the rig -------------------------------------------------------------------------------------------------------

const MCP = { command: '/opt/node/bin/node', args: ['/app/bin/neptunia-mcp.ts'], socketPath: '/data/run/core.sock' };
const KEY_VALUE = 'sk-or-v1-never-leaves';
const HOLD_MS = 45_000;
/** A step that never resolves fails its test instead of hanging the file. */
const STEP_TIMEOUT = { timeout: 10_000 };

type Run = {
  child: SubscriptionChild;
  killed: boolean;
  push(event: object): void;
  end(code: number | null): void;
};

/** A spawn whose runs the test writes: each event becomes one stdout line, `end` closes stdout and exits. */
function fakeSpawn() {
  const runs: Array<Run> = [];
  const spawn = (child: SubscriptionChild): SubscriptionProcess => {
    const queue: Array<string> = [];
    let waiting: ((result: IteratorResult<string>) => void) | null = null;
    let done = false;
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    const run: Run = {
      child,
      killed: false,
      push(event) {
        const line = JSON.stringify(event);
        if (waiting === null) queue.push(line);
        else {
          const wake = waiting;
          waiting = null;
          wake({ value: line, done: false });
        }
      },
      end(code) {
        if (done) return;
        done = true;
        if (waiting !== null) {
          const wake = waiting;
          waiting = null;
          wake({ value: undefined, done: true });
        }
        exit(code);
      },
    };
    runs.push(run);
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const line = queue.shift();
          if (line !== undefined) return Promise.resolve({ value: line, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<string>>((resolve) => {
            waiting = resolve;
          });
        },
      }),
    };
    return {
      lines,
      exited,
      kill: () => {
        run.killed = true;
        run.end(null);
      },
    };
  };
  return { spawn, runs };
}

type Timer = { fn: () => void; ms: number; cleared: boolean };
type RouteRecord = NonNullable<KeysFile['subharness']['core']>;

/** The client over a temp private layer whose config.json names the `core` route as given. */
function rig(
  options: {
    core?: RouteRecord | null;
    installed?: Array<'codex' | 'claude'>;
    subscription?: { thinking?: boolean };
    llm?: { maxRequestTokens?: number; maxRequestsPerDay?: number };
  } = {}
) {
  const dir = tempDir('nep-subscription-client-');
  writeKeysFile(dir, {
    core: [{ name: 'core-1', value: 'sk-or-v1-never-leaves' }],
    subharness: {
      key: null,
      modes: {},
      core: options.core === undefined ? { backend: 'claude', model: 'claude-opus-4-6', effort: null } : options.core,
    },
  });
  for (const backend of options.installed ?? (['claude', 'codex'] as const))
    fakeVendor(dir, backend, { loggedIn: true });
  const workDir = tempDir('nep-subscription-work-');
  let tokens = 0;
  const bridge = createToolBridge({ token: () => `tok-${(tokens += 1)}` });
  const { spawn, runs } = fakeSpawn();
  const directCalls: Array<{ messages: unknown; options: unknown }> = [];
  const direct = {
    complete: (messages: unknown, options?: unknown): Promise<CompleteResult> => {
      directCalls.push({ messages, options });
      return Promise.resolve({ text: '<msg>from the api</msg>', usage: {}, estimated: 0 });
    },
  };
  const timers: Array<Timer> = [];
  const records: Array<UsageEntry> = [];
  const outcomes: Array<string> = [];
  const state = { data: {}, markDirty: () => {} };
  const llm = {
    baseUrl: 'https://openrouter.invalid/api/v1',
    timeoutMs: 120_000,
    retries: 0,
    maxRequestTokens: options.llm?.maxRequestTokens ?? 50_000,
    maxOutputTokens: 900,
    maxRequestsPerDay: options.llm?.maxRequestsPerDay ?? 5000,
    subscription: { thinking: false, holdMs: HOLD_MS, ...options.subscription },
  };
  const client = createSubscriptionClient({
    privateDir: dir,
    direct,
    bridge,
    spawn,
    mcp: MCP,
    workDir,
    getConfig: () => ({ llm }),
    state,
    now: () => Date.UTC(2026, 10, 6, 12),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      for (const timer of timers) if (timer === handle) timer.cleared = true;
    },
    hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/persona', OPENROUTER_CORE_KEY: KEY_VALUE },
    record: (entry) => {
      records.push(entry);
    },
    ran: (backend, outcome) => {
      outcomes.push(`${backend}:${outcome}`);
    },
  });
  return { dir, workDir, client, bridge, runs, directCalls, timers, records, state, outcomes };
}

/** Waits until `check` holds, a turn of the event loop at a time. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`never happened: ${what}`);
}

const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** The value of codex's `-c <key>=<value>` override, or undefined. */
const codexSetting = (args: ReadonlyArray<string>, key: string): string | undefined => {
  for (let i = 0; i < args.length - 1; i += 1)
    if (args[i] === '-c' && args[i + 1]?.startsWith(`${key}=`)) return args[i + 1]?.slice(key.length + 1);
  return undefined;
};

/** The command and args of the `nep` MCP server a run was given. */
function nepServer(child: SubscriptionChild): { command: string; args: Array<string> } {
  if (child.args[0] === 'exec') {
    return {
      command: JSON.parse(codexSetting(child.args, 'mcp_servers.nep.command') ?? 'null') as string,
      args: JSON.parse(codexSetting(child.args, 'mcp_servers.nep.args') ?? '[]') as Array<string>,
    };
  }
  const config = JSON.parse(valueAfter(child.args, '--mcp-config') ?? '{}') as {
    mcpServers?: { nep?: { command: string; args: Array<string> } };
  };
  return config.mcpServers?.nep ?? { command: '', args: [] };
}

// ---- the streams ---------------------------------------------------------------------------------------------------

const se = (event: object) => ({ type: 'stream_event', event });

type Usage = { input: number; written: number; read: number; output: number };
const USAGE: Usage = { input: 120, written: 400, read: 38_000, output: 60 };

/** One Claude model call as `--include-partial-messages` streams it: text and tool calls each split in two pieces. */
function claudeCall(call: {
  text?: string;
  tools?: Array<{ id: string; name: string; input: object }>;
  stop: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: Usage;
}): Array<object> {
  const usage = call.usage ?? USAGE;
  const events: Array<object> = [
    se({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: usage.input,
          cache_creation_input_tokens: usage.written,
          cache_read_input_tokens: usage.read,
          output_tokens: 1,
        },
      },
    }),
  ];
  let index = 0;
  if (call.text !== undefined) {
    const half = Math.floor(call.text.length / 2);
    events.push(se({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
    for (const piece of [call.text.slice(0, half), call.text.slice(half)])
      events.push(se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }));
    events.push(se({ type: 'content_block_stop', index }));
    index += 1;
  }
  for (const tool of call.tools ?? []) {
    const json = JSON.stringify(tool.input);
    const half = Math.floor(json.length / 2);
    events.push(
      se({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
      })
    );
    for (const piece of [json.slice(0, half), json.slice(half)])
      events.push(se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }));
    events.push(se({ type: 'content_block_stop', index }));
    index += 1;
  }
  events.push(se({ type: 'message_delta', delta: { stop_reason: call.stop }, usage: { output_tokens: usage.output } }));
  events.push(se({ type: 'message_stop' }));
  return events;
}

const claudeResult = (text: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  num_turns: 2,
});

const pushAll = (run: Run | undefined, events: ReadonlyArray<object>): void => {
  assert.ok(run, 'no run was started');
  for (const event of events) run.push(event);
};

/** Ends a Claude run with one final answer, so a test that looks at the start leaves nothing open. */
function finishClaude(run: Run | undefined, text = FINAL_TEXT): void {
  pushAll(run, [...claudeCall({ text, stop: 'end_turn' }), claudeResult(text)]);
  run?.end(0);
}

const codexAgent = (id: string, text: string) => ({
  type: 'item.completed',
  item: { id, type: 'agent_message', text },
});
const codexToolStarted = (id: string, tool: string, args: object) => ({
  type: 'item.started',
  item: { id, type: 'mcp_tool_call', server: 'nep', tool, arguments: args, status: 'in_progress' },
});
const codexToolDone = (id: string, tool: string, args: object, text: string) => ({
  type: 'item.completed',
  item: {
    id,
    type: 'mcp_tool_call',
    server: 'nep',
    tool,
    arguments: args,
    status: 'completed',
    result: { content: [{ type: 'text', text }] },
  },
});
const codexDone = (usage: { input: number; cached: number; output: number }) => ({
  type: 'turn.completed',
  usage: { input_tokens: usage.input, cached_input_tokens: usage.cached, output_tokens: usage.output },
});

/** The next step's messages as the step loop builds them after one call `id` and its result. */
const secondStep = (rawText: string, id: string, result: string, note = '') =>
  appendStep({
    transport: 'native',
    messages: FIRST,
    rawText,
    calls: [{ id, name: 'intention_update', apiName: 'intention_update', args: CALL_ARGS }],
    results: [{ text: result, status: 'ok' }],
    note,
  });

// ---- the command line ----------------------------------------------------------------------------------------------

test(
  'a Claude turn replaces the system prompt and runs with no built-in tools, no settings and no session file',
  STEP_TIMEOUT,
  async () => {
    // Catches: Claude Code's own system prompt or tools around hers, or a session file per turn in her home.
    const { dir, client, runs } = rig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' } });
    const asked = client.complete(FIRST, REPLY);
    await until(() => runs.length === 1, 'the run started');
    const { args, stdin, binary } = runs[0].child;
    assert.equal(binary, subharnessPlace(dir, 'claude').binary);
    assert.equal(args[0], '-p');
    assert.equal(valueAfter(args, '--system-prompt'), SYSTEM_TEXT);
    assert.equal(valueAfter(args, '--tools'), '');
    assert.equal(valueAfter(args, '--setting-sources'), '');
    assert.ok(args.includes('--no-session-persistence'), args.join(' '));
    assert.equal(valueAfter(args, '--model'), 'claude-opus-4-6');
    assert.equal(valueAfter(args, '--effort'), 'low');
    assert.equal(valueAfter(args, '--output-format'), 'stream-json');
    assert.ok(args.includes('--include-partial-messages'), args.join(' '));
    assert.ok(!args.includes('--dangerously-skip-permissions'), args.join(' '));
    assert.equal(stdin, USER_TEXT);
    finishClaude(runs[0]);
    await asked;
  }
);

test('a Claude turn offers her tools through the nep MCP server and nothing else', STEP_TIMEOUT, async () => {
  // Catches: tools from the home's settings loading beside hers, or the server started without the turn's socket and token.
  const { client, runs } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  const { args } = runs[0].child;
  assert.ok(args.includes('--strict-mcp-config'), args.join(' '));
  assert.equal(valueAfter(args, '--allowedTools'), 'mcp__nep__*');
  const nep = nepServer(runs[0].child);
  assert.equal(nep.command, MCP.command);
  assert.deepEqual(nep.args.slice(0, MCP.args.length), MCP.args);
  assert.equal(valueAfter(nep.args, '--socket'), MCP.socketPath);
  const tokenFile = valueAfter(nep.args, '--token-file') ?? '';
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'tok-1');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  finishClaude(runs[0]);
  await asked;
});

test(
  'a Claude turn runs with thinking off, the output cap, and no key of the core in its environment',
  STEP_TIMEOUT,
  async () => {
    // Catches: native thinking on her core (the owner's rule), an uncapped answer, or her OpenRouter key handed to the CLI.
    const { dir, client, runs } = rig();
    const asked = client.complete(FIRST, REPLY);
    await until(() => runs.length === 1, 'the run started');
    const { env } = runs[0].child;
    assert.equal(env.MAX_THINKING_TOKENS, '0');
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '900');
    assert.equal(env.CLAUDE_CONFIG_DIR, subharnessPlace(dir, 'claude').env.CLAUDE_CONFIG_DIR);
    assert.ok(!Object.values(env).includes(KEY_VALUE), 'a key value reached the child');
    assert.ok(!Object.keys(env).some((name) => name.startsWith('OPENROUTER')), Object.keys(env).join(' '));
    finishClaude(runs[0]);
    await asked;
  }
);

test('thinking stays on when the owner asks for it', STEP_TIMEOUT, async () => {
  // Catches: llm.subscription.thinking ignored, so the owner cannot try native thinking on the subscription.
  const { client, runs } = rig({ subscription: { thinking: true } });
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  // The lead: the first child gets a name (R.2).
  const firstChild = runs[0].child;
  assert.equal(firstChild.env.MAX_THINKING_TOKENS, undefined);
  finishClaude(runs[0]);
  await asked;
});

test('a core request without tools starts Claude with no MCP server', STEP_TIMEOUT, async () => {
  // Catches: an MCP server started for a request that offers no tools, so the model sees tools the turn did not grant.
  const { client, runs } = rig();
  const asked = client.complete(FIRST, { role: 'core', purpose: 'reply' });
  await until(() => runs.length === 1, 'the run started');
  const { args } = runs[0].child;
  assert.equal(args.includes('--mcp-config'), false);
  assert.equal(args.includes('--allowedTools'), false);
  assert.ok(args.includes('--strict-mcp-config'), args.join(' '));
  finishClaude(runs[0]);
  await asked;
});

test(
  'a Codex turn puts her system text in the instructions file, the user text alone on stdin, and no built-in tools',
  STEP_TIMEOUT,
  async () => {
    // Catches: the memory writer's way of prefixing the system text to stdin, which leaves Codex's own instructions in force.
    const { client, runs } = rig({ core: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } });
    const asked = client.complete(FIRST, REPLY);
    await until(() => runs.length === 1, 'the run started');
    const { args, stdin, env } = runs[0].child;
    assert.equal(args[0], 'exec');
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check'])
      assert.ok(args.includes(flag), `${flag} in ${args.join(' ')}`);
    assert.equal(valueAfter(args, '-m'), 'gpt-6.1-sol');
    assert.equal(codexSetting(args, 'model_reasoning_effort'), 'medium');
    const file = JSON.parse(codexSetting(args, 'model_instructions_file') ?? 'null') as string;
    assert.equal(fs.readFileSync(file, 'utf8'), SYSTEM_TEXT);
    assert.equal(stdin, USER_TEXT);
    assert.equal(codexSetting(args, 'features.shell_tool'), 'false');
    assert.equal(codexSetting(args, 'web_search'), '"disabled"');
    assert.ok(!Object.values(env).includes(KEY_VALUE), 'a key value reached the child');
    runs[0].push(codexAgent('item_0', FINAL_TEXT));
    runs[0].push(codexDone({ input: 30_000, cached: 27_000, output: 80 }));
    runs[0].end(0);
    await asked;
  }
);

test('a Codex turn approves the calls of the nep MCP server', STEP_TIMEOUT, async () => {
  // Catches: the prototype's first failure, `MCP tool call requires approval, but approval policy is never`.
  const { client, runs } = rig({ core: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  const { args } = runs[0].child;
  assert.equal(codexSetting(args, 'mcp_servers.nep.default_tools_approval_mode'), '"approve"');
  const nep = nepServer(runs[0].child);
  assert.equal(nep.command, MCP.command);
  assert.equal(valueAfter(nep.args, '--socket'), MCP.socketPath);
  runs[0].push(codexAgent('item_0', FINAL_TEXT));
  runs[0].push(codexDone({ input: 1, cached: 0, output: 1 }));
  runs[0].end(0);
  await asked;
});

// ---- the steps -----------------------------------------------------------------------------------------------------

test(
  'a Claude turn of two steps: the call goes out, its result comes back, the final text parses',
  STEP_TIMEOUT,
  async () => {
    // Catches: a step loop that never sees her call, a result that never reaches the CLI, or a final answer the parser cannot read.
    const { client, bridge, runs, workDir } = rig();
    const first = client.complete(FIRST, REPLY);
    await until(() => runs.length === 1, 'the run started');
    assert.deepEqual(await bridge.list('tok-1'), TOOLS);
    pushAll(
      runs[0],
      claudeCall({
        text: STEP_ONE_TEXT,
        tools: [{ id: 'toolu_1', name: 'mcp__nep__intention_update', input: CALL_ARGS }],
        stop: 'tool_use',
      })
    );
    const one = await first;
    assert.equal(one.text, STEP_ONE_TEXT);
    assert.equal(one.finishReason, 'tool_calls');
    // The client hands normalised calls, as the API client does, since the step loop reads them unwrapped.
    const calls = one.toolCalls as Array<{ id?: string; name?: string; parsed?: unknown }>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.id, 'toolu_1');
    assert.equal(calls[0]?.name, 'intention_update');
    assert.deepEqual(calls[0]?.parsed, CALL_ARGS);

    // The CLI calls the tool on the MCP server, which forwards it here; it waits for the step loop.
    const forwarded = bridge.call('tok-1', {
      name: 'intention_update',
      arguments: CALL_ARGS,
      meta: { 'claudecode/toolUseId': 'toolu_1' },
    });
    const second = client.complete(secondStep(STEP_ONE_TEXT, 'toolu_1', 'intention 7 is done', NOTE), REPLY);
    const answer = await forwarded;
    assert.equal(answer.isError, false);
    assert.ok(answer.text.startsWith('intention 7 is done'), answer.text);
    assert.ok(answer.text.endsWith(NOTE), `the step's note travels with the last result: ${answer.text}`);

    pushAll(runs[0], [...claudeCall({ text: FINAL_TEXT, stop: 'end_turn' }), claudeResult(FINAL_TEXT)]);
    runs[0].end(0);
    const two = await second;
    assert.equal(two.text, FINAL_TEXT);
    assert.equal(two.finishReason, 'stop');
    const parsed = parseOutput(two.text);
    assert.deepEqual(
      parsed.messages.map((one) => one.text),
      ['Still on, I checked it off.']
    );
    assert.equal(runs.length, 1, 'both steps ran in one process');
    await assert.rejects(bridge.list('tok-1'), { code: 'turn-unknown' });
    await until(() => fs.readdirSync(workDir).length === 0, 'the run directory was removed');
  }
);

test('the calls of a Claude answer reach the step loop as it reads them, not as refusals', STEP_TIMEOUT, async () => {
  // Catches: raw provider-shaped calls (`function.name`), so every call of hers read as `unknown-skill` with no name.
  const { client, runs } = rig();
  const first = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(
    runs[0],
    claudeCall({ tools: [{ id: 'toolu_4', name: 'mcp__nep__intention_update', input: CALL_ARGS }], stop: 'tool_use' })
  );
  const { toolCalls } = await first;
  const handed = toolCalls?.[0] as { name?: string; parsed?: unknown } | undefined;
  assert.equal(handed?.name, 'intention_update');
  assert.deepEqual(handed?.parsed, CALL_ARGS);
  const registry = buildSkills({ table: SKILL_DEFINITIONS });
  const planned = normalizeCalls({ calls: toolCalls, registry, step: 1 });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.problem, null);
  assert.deepEqual(planned[0]?.args, CALL_ARGS);
});

test('a tool call that reaches the bridge after its result is known is answered at once', STEP_TIMEOUT, async () => {
  // Catches: a result handed over before the CLI's call arrived and lost, so the CLI waits forever and her turn hangs.
  const { client, bridge, runs } = rig();
  const first = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(
    runs[0],
    claudeCall({ tools: [{ id: 'toolu_9', name: 'mcp__nep__intention_update', input: CALL_ARGS }], stop: 'tool_use' })
  );
  await first;
  const second = client.complete(secondStep('', 'toolu_9', 'intention 7 is done'), REPLY);
  await new Promise((resolve) => setImmediate(resolve));
  const answer = await bridge.call('tok-1', { name: 'intention_update', arguments: CALL_ARGS, meta: null });
  assert.equal(answer.text, 'intention 7 is done');
  finishClaude(runs[0]);
  assert.equal((await second).text, FINAL_TEXT);
});

test('each Claude step reports its own usage and records one entry at no cost', STEP_TIMEOUT, async () => {
  // Catches: usage summed over the turn or dropped, so the archive and /usage lose her core's tokens on the subscription.
  const { client, runs, records } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(runs[0], [...claudeCall({ text: FINAL_TEXT, stop: 'end_turn' }), claudeResult(FINAL_TEXT)]);
  runs[0].end(0);
  const done = await asked;
  assert.deepEqual(done.usage, {
    prompt_tokens: USAGE.input + USAGE.written + USAGE.read,
    completion_tokens: USAGE.output,
    prompt_tokens_details: { cached_tokens: USAGE.read },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.role, 'core');
  assert.equal(records[0]?.cost, 0);
  assert.equal(records[0]?.cachedTokens, USAGE.read);
});

test('a Claude answer cut at the output cap finishes with length', STEP_TIMEOUT, async () => {
  // Catches: a cut answer read as complete, so a half-written last <msg> is posted instead of dropped.
  const { client, runs } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(runs[0], [...claudeCall({ text: '<think>long</think><msg>Still', stop: 'max_tokens' }), claudeResult('')]);
  runs[0].end(0);
  assert.equal((await asked).finishReason, 'length');
});

test('a Codex turn of two steps: the step ends when the started call waits at the bridge', STEP_TIMEOUT, async () => {
  // Catches: a Codex step resolved before its call is known, or never, since Codex marks no end of a model call.
  const { client, bridge, runs } = rig({ core: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const first = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  runs[0].push({ type: 'thread.started', thread_id: 'th-1' });
  runs[0].push({ type: 'turn.started' });
  runs[0].push(codexAgent('item_0', STEP_ONE_TEXT));
  runs[0].push(codexToolStarted('item_1', 'intention_update', CALL_ARGS));
  const forwarded = bridge.call('tok-1', { name: 'intention_update', arguments: CALL_ARGS, meta: null });
  const one = await first;
  assert.equal(one.text, STEP_ONE_TEXT);
  // The client hands normalised calls, as the API client does, since the step loop reads them unwrapped.
  const calls = one.toolCalls as Array<{ id?: string; name?: string; parsed?: unknown }>;
  assert.equal(calls[0]?.id, 'item_1');
  assert.equal(calls[0]?.name, 'intention_update');
  assert.deepEqual(calls[0]?.parsed, CALL_ARGS);

  const second = client.complete(secondStep(STEP_ONE_TEXT, 'item_1', 'intention 7 is done'), REPLY);
  assert.equal((await forwarded).text, 'intention 7 is done');
  runs[0].push(codexToolDone('item_1', 'intention_update', CALL_ARGS, 'intention 7 is done'));
  runs[0].push(codexAgent('item_2', FINAL_TEXT));
  runs[0].push(codexDone({ input: 31_000, cached: 27_400, output: 140 }));
  runs[0].end(0);
  const two = await second;
  assert.equal(two.text, FINAL_TEXT);
  assert.deepEqual(two.usage, {
    prompt_tokens: 31_000,
    completion_tokens: 140,
    prompt_tokens_details: { cached_tokens: 27_400 },
  });
});

test('a turn that ends on calls kills its process once the hold has passed', STEP_TIMEOUT, async () => {
  // Catches: a step loop that stopped after a call, leaving the CLI and its MCP server waiting for good.
  const { client, bridge, runs, timers } = rig();
  const first = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(
    runs[0],
    claudeCall({ tools: [{ id: 'toolu_1', name: 'mcp__nep__intention_update', input: CALL_ARGS }], stop: 'tool_use' })
  );
  await first;
  const hold = timers.find((timer) => timer.ms === HOLD_MS && !timer.cleared);
  assert.ok(hold, `a hold of ${HOLD_MS} ms: ${JSON.stringify(timers.map((timer) => timer.ms))}`);
  hold.fn();
  assert.equal(runs[0].killed, true);
  await assert.rejects(bridge.list('tok-1'), { code: 'turn-unknown' });
});

// ---- which requests take the route ---------------------------------------------------------------------------------

test('a request of another role goes to the direct client', STEP_TIMEOUT, async () => {
  // Catches: the analyzer's small requests sent through a CLI process each, on her subscription window.
  const { client, runs, directCalls } = rig();
  const answer = await client.complete(FIRST, { role: 'analyzer', purpose: 'address' });
  assert.equal(answer.text, '<msg>from the api</msg>');
  assert.equal(directCalls.length, 1);
  assert.equal(runs.length, 0);
});

test('the core goes to the direct client while its route is the API', STEP_TIMEOUT, async () => {
  // Catches: an installed CLI used for her turns although the owner never chose the route.
  const { client, runs, directCalls } = rig({ core: null });
  await client.complete(FIRST, REPLY);
  assert.equal(directCalls.length, 1);
  assert.equal(runs.length, 0);
});

test('the chain route of a request wins over the stored route', STEP_TIMEOUT, async () => {
  // Catches: the chain client choosing the harness while config.json still says API, and the turn going to the API.
  const { client, runs, directCalls } = rig({ core: null });
  const asked = client.complete(FIRST, {
    ...REPLY,
    chainRoute: { via: 'harness', backend: 'claude', model: 'claude-opus-4-8', effort: null },
  });
  await until(() => runs.length === 1, 'the run started');
  finishClaude(runs[0]);
  await asked;
  assert.equal(directCalls.length, 0);
  const [run] = runs;
  assert.equal(valueAfter(run?.child.args ?? [], '--model'), 'claude-opus-4-8');
});

test(
  'an API chain route sends the core request to the direct client though a harness is stored',
  STEP_TIMEOUT,
  async () => {
    // Catches: a fallback route of the chain started as a second CLI run on the spent window.
    const { client, runs, directCalls } = rig();
    await client.complete(FIRST, { ...REPLY, chainRoute: { via: 'api', key: 'helpers', model: 'x/y', effort: null } });
    assert.equal(directCalls.length, 1);
    assert.equal(runs.length, 0);
  }
);

test('a failed step on a chain route is thrown for the chain', STEP_TIMEOUT, async () => {
  // Catches: the subscription client and the chain both repeating the step, so one failure spends two API requests.
  const { client, runs, directCalls } = rig();
  const asked = client.complete(FIRST, {
    ...REPLY,
    chainRoute: { via: 'harness', backend: 'claude', model: 'claude-opus-4-8', effort: null },
  });
  await until(() => runs.length === 1, 'the run started');
  pushAll(runs[0], [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: '' }]);
  runs[0].end(1);
  await assert.rejects(asked, { code: 'subscription-exhausted' });
  assert.equal(directCalls.length, 0);
});

// ---- the rails -----------------------------------------------------------------------------------------------------

test('a step above the request token cap is refused before any process starts', STEP_TIMEOUT, async () => {
  // Catches: the per-request token cap skipped on the subscription, a rail the engine keeps on every route.
  const { client, runs } = rig({ llm: { maxRequestTokens: 10 } });
  await assert.rejects(client.complete(FIRST, REPLY), (err) => err instanceof TokenLimitError);
  assert.equal(runs.length, 0);
});

test('a step past the daily request cap is refused before any process starts', STEP_TIMEOUT, async () => {
  // Catches: subscription steps that never count against llm.maxRequestsPerDay, so a spammed mention runs without end.
  const { client, runs, state } = rig({ llm: { maxRequestsPerDay: 1 } });
  countLlmRequest(state, 1, Date.UTC(2026, 10, 6, 12));
  await assert.rejects(client.complete(FIRST, REPLY), (err) => err instanceof DailyCapError);
  assert.equal(runs.length, 0);
});

// ---- failures ------------------------------------------------------------------------------------------------------

test('an exhausted window fails the step with subscription-exhausted, the code she is told', STEP_TIMEOUT, async () => {
  // Catches: a spent window read as a generic error, so she and the owner see "error" and nobody knows the week ran out.
  const { client, runs, directCalls } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  pushAll(runs[0], [
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_762_560_000 },
    },
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'limit reached' },
  ]);
  runs[0].end(1);
  const err = await asked.then(
    () => assert.fail('the step answered'),
    (error: unknown) => error
  );
  assert.equal((err as { code?: unknown }).code, 'subscription-exhausted');
  assert.equal(errorCodeOf(err), 'subscription-exhausted');
  assert.equal(directCalls.length, 0);
});

test('another failed Claude run fails the step with subscription-failed', STEP_TIMEOUT, async () => {
  // Catches: an is_error result returned as her answer, so the CLI's error text is parsed as her speech.
  const { client, runs } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  runs[0].push({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  runs[0].end(1);
  await assert.rejects(asked, { code: 'subscription-failed' });
});

test('a process that exits without a result fails the step with subscription-failed', STEP_TIMEOUT, async () => {
  // Catches: a crashed CLI that resolves the step with empty text, which reads as her choosing silence.
  const { client, runs } = rig();
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  runs[0].end(2);
  await assert.rejects(asked, { code: 'subscription-failed' });
});

test('a Codex usage limit fails the step with subscription-exhausted', STEP_TIMEOUT, async () => {
  // Catches: Codex's spent window reported as a generic failure, so the owner cannot tell it from a broken install.
  const { client, runs } = rig({ core: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const asked = client.complete(FIRST, REPLY);
  await until(() => runs.length === 1, 'the run started');
  runs[0].push({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 3 days." } });
  runs[0].end(1);
  await assert.rejects(asked, { code: 'subscription-exhausted' });
});

test('a route whose backend is not installed fails with not-installed and starts nothing', STEP_TIMEOUT, async () => {
  // Catches: a spawn of a missing binary, whose ENOENT reaches her as a bare "error".
  const { client, runs } = rig({ installed: ['codex'] });
  await assert.rejects(client.complete(FIRST, REPLY), { code: 'not-installed' });
  assert.equal(runs.length, 0);
});

// ---- the login state the header reads ----------------------------------------------------------------------------

test(
  'a Claude run that is not logged in reports a lost login, and the next answered turn reports ok',
  STEP_TIMEOUT,
  async () => {
    // Catches: the header's Core line left active while every turn fails on a dropped login (owner, 2026-11-08).
    const { client, runs, outcomes } = rig();
    const asked = client.complete(FIRST, REPLY);
    await until(() => runs.length === 1, 'the run started');
    runs[0].push({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    runs[0].end(1);
    await assert.rejects(asked, { code: 'subscription-login' });
    const again = client.complete(FIRST, { ...REPLY, tools: [] });
    await until(() => runs.length === 2, 'the second run started');
    finishClaude(runs[1]);
    await again;
    assert.deepEqual(outcomes, ['claude:login', 'claude:ok']);
  }
);

test('a request of another role or on the API route reports nothing', STEP_TIMEOUT, async () => {
  // Catches: an answer of the analyzer or of the API counted as proof that the harness is logged in again.
  const { client, outcomes } = rig({ core: null });
  await client.complete(FIRST, REPLY);
  await client.complete(FIRST, { role: 'analyzer' });
  assert.deepEqual(outcomes, []);
});
