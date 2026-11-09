// scripts/lib/script-routes.ts: the routing of a paid script. By default a script spends what production spends, the
// keys of keys.json under the chains of config.json; a flag `--<role> <route>` replaces one role for the run alone, and
// `--variant` runs the same inputs on several such setups. The clients are fakes: no CLI starts, no provider is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../scripts/lib/cli.ts';
import {
  parseRoute,
  routedConfig,
  scriptRouting,
  sideBySide,
  sideBySideText,
  takeRouteFlags,
  takeRoutes,
} from '../scripts/lib/script-routes.ts';
import type { RouteRole, Variant } from '../scripts/lib/script-routes.ts';
import type { KeyRing } from '../src/keys/ring.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import type { ChildOutcome, ChildRun } from '../src/subharness/memory-writer.ts';
import type { SubscriptionChild, SubscriptionProcess } from '../src/subharness/subscription-client.ts';
import { connectSocket, MAX_FRAME_BYTES } from '../src/protocol/wire.ts';
import { bridgePeer } from '../src/subharness/tool-bridge.ts';
import { routingPath, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const CORE_KEY = 'sk-or-v1-core-secret-0123456789';
const HELPERS_KEY = 'sk-or-v1-helpers-secret-0123456789';
const ANALYZER_KEY = 'sk-or-v1-analyzer-secret-0123456789';
const MESSAGES = [
  { role: 'system', content: 'You are the persona.' },
  { role: 'user', content: 'Is the trip still on?' },
];
const FINAL = '<think>Yes.</think><msg>Still on.</msg>';
// Changed: the roles run on the chains of `models.routes` alone (spec 2026-11-09-model-routes, slice 4), which the rig
// writes into config.json, so the live settings hold no model of a role.
const LIVE = {
  models: {},
  llm: { maxRequestTokens: 50_000, maxRequestsPerDay: 5000, subscription: { thinking: false, holdMs: 45_000 } },
  web: { quickSearch: { engine: 'openrouter' } },
};

/** A chain route on a key, as `models.routes` holds it. */
const onKey = (key: string, model: string, effort: string | null = null) => ({ via: 'api', key, model, effort });

type PathRecord = { backend: string; model: string; effort: string | null };

/** A spawn that answers every run with one finished Claude message and keeps the child it was given. */
function fakeSpawn() {
  const children: Array<SubscriptionChild> = [];
  const se = (event: object) => ({ type: 'stream_event', event });
  const spawn = (child: SubscriptionChild): SubscriptionProcess => {
    children.push(child);
    const queue = [
      se({ type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FINAL } }),
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
      se({ type: 'message_stop' }),
      { type: 'result', subtype: 'success', is_error: false, result: FINAL, num_turns: 1 },
    ].map((event) => JSON.stringify(event));
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

/**
 * The script's live config: the shipped values with the private config.json laid over them, read at each call, as a
 * script's `hot.config` holds it. The chains are read from it (src/llm/route-chain.ts), not from the file directly.
 */
function liveWith(dir: string): unknown {
  const stored = JSON.parse(fs.readFileSync(routingPath(dir), 'utf8')) as { models?: object; llm?: object };
  return { ...LIVE, models: { ...LIVE.models, ...stored.models }, llm: { ...LIVE.llm, ...stored.llm } };
}

/** The chains of the rig: the core and quick search on `main` then `spare`, the analyzer on `tools`, vision off. */
const CHAINS = {
  core: [onKey('main', 'anthropic/claude-opus-4.6'), onKey('spare', 'anthropic/claude-opus-4.6')],
  memory: [onKey('main', 'anthropic/claude-opus-4.6'), onKey('spare', 'anthropic/claude-opus-4.6')],
  analyzer: [onKey('tools', 'openai/gpt-6.1-sol', 'low')],
  vision: [],
  search: [onKey('main', 'perplexity/sonar'), onKey('spare', 'perplexity/sonar')],
};

/** Writes `chains` as `models.routes` of the private config.json, over what the folder's config holds. */
function writeChains(dir: string, chains: Record<string, unknown>): void {
  const stored = JSON.parse(fs.readFileSync(routingPath(dir), 'utf8')) as { models?: Record<string, unknown> };
  const routes = { ...(stored.models?.routes as object | undefined), ...chains };
  fs.writeFileSync(routingPath(dir), JSON.stringify({ ...stored, models: { ...stored.models, routes } }));
}

/** A private dir with four named keys, the chains of CHAINS, and the given harness routes in front of them. */
function rig(options: { core?: PathRecord | null; memory?: PathRecord | null; loggedIn?: boolean } = {}) {
  const dir = tempDir('nep-script-routes-');
  writeKeysFile(dir, {
    core: [
      { name: 'main', value: CORE_KEY },
      { name: 'spare', value: 'sk-or-v1-spare-secret-0123456789' },
    ],
    extra: { helpers: HELPERS_KEY, tools: ANALYZER_KEY },
    subharness: { key: null, modes: {} },
  });
  const harness = (record: PathRecord | null | undefined) =>
    record === undefined || record === null ? null : [{ via: 'harness', ...record }];
  writeChains(dir, {
    ...CHAINS,
    ...(harness(options.core) === null ? {} : { core: harness(options.core) }),
    ...(harness(options.memory) === null ? {} : { memory: harness(options.memory) }),
  });
  for (const backend of ['claude', 'codex'] as const) fakeVendor(dir, backend, { loggedIn: options.loggedIn ?? true });
  const { spawn, children } = fakeSpawn();
  const sent: Array<{ key: string | null; options: Record<string, unknown> }> = [];
  const childRuns: Array<ChildRun> = [];
  let built = 0;
  const createDirect = (ring: KeyRing) => {
    built += 1;
    return {
      complete: (_messages: unknown, opts?: unknown): Promise<CompleteResult> => {
        const asked = (opts ?? {}) as Record<string, unknown>;
        const role = typeof asked.role === 'string' ? asked.role : 'core';
        sent.push({ key: ring.route(role)?.value ?? null, options: asked });
        return Promise.resolve({ text: '<msg>from the api</msg>', usage: {}, estimated: 0 });
      },
    };
  };
  const runChild = (run: ChildRun): Promise<ChildOutcome> => {
    childRuns.push(run);
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ type: 'result', result: FINAL }), stderr: '' });
  };
  const deps = (variant: Variant, roles: ReadonlyArray<RouteRole> = ['core', 'memory', 'analyzer']) => ({
    privateDir: dir,
    roles,
    variant,
    getConfig: (): unknown => liveWith(dir),
    createDirect,
    state: { data: {}, markDirty: () => {} },
    spawn,
    runChild,
    workDir: tempDir('nep-script-routes-work-'),
    hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/persona' },
  });
  return { dir, deps, children, sent, childRuns, builtCount: () => built };
}

/** Asserts that `run` throws a one-line CliError that starts with `tool:` and names `code`, with no key value in it. */
async function assertRefused(run: () => unknown, tool: string, code: string): Promise<void> {
  await assert.rejects(
    () => Promise.resolve().then(run),
    (err: unknown) => {
      assert.ok(err instanceof CliError, String(err));
      assert.ok(err.message.startsWith(`${tool}:`), err.message);
      assert.ok(err.message.includes(code), err.message);
      assert.equal(err.message.includes('\n'), false, err.message);
      for (const value of [CORE_KEY, HELPERS_KEY, ANALYZER_KEY]) assert.equal(err.message.includes(value), false);
      return true;
    }
  );
}

test('a key route reads the key name, the model id and the effort', () => {
  // Catches: the model id cut at its first slash, or the effort left on the model id.
  // On the analyzer: an API effort is refused for the core since the routes spec of 2026-11-09 (owner rule, no
  // provider reasoning for the core), covered in tests/route-text.test.ts.
  assert.deepEqual(parseRoute('replay-cli', 'analyzer', 'helpers/anthropic/claude-opus-5.5:medium'), {
    kind: 'key',
    key: 'helpers',
    model: 'anthropic/claude-opus-5.5',
    effort: 'medium',
  });
});

test('a colon suffix of a model id that is no effort level stays on the model id', () => {
  // Catches: a provider variant such as `:free` dropped from the model or refused as a bad effort.
  assert.deepEqual(parseRoute('replay-cli', 'analyzer', 'helpers/meta-llama/llama-5:free'), {
    kind: 'key',
    key: 'helpers',
    model: 'meta-llama/llama-5:free',
    effort: null,
  });
});

test('a harness route reads the backend, the model and the effort', () => {
  // Catches: `harness:` read as a key name, so the core goes out on the API under a key called harness.
  assert.deepEqual(parseRoute('replay-cli', 'core', 'harness:claude/claude-opus-4-8:low'), {
    kind: 'harness',
    backend: 'claude',
    model: 'claude-opus-4-8',
    effort: 'low',
  });
});

test('a route with no model is refused as malformed', async () => {
  // Catches: `--core helpers` taken as a key with an empty model, which the provider refuses after the run started.
  await assertRefused(() => parseRoute('replay-cli', 'core', 'helpers'), 'replay-cli', 'route-malformed');
  await assertRefused(() => parseRoute('replay-cli', 'core', 'harness:claude'), 'replay-cli', 'route-malformed');
});

test('a harness route for a role no harness carries is refused', async () => {
  // Catches: an analyzer on claude accepted, then sent to the API with a harness model id.
  await assertRefused(
    () => parseRoute('recall-eval', 'analyzer', 'harness:claude/claude-opus-4-8'),
    'recall-eval',
    'route-unsupported'
  );
});

test('opencode is refused as a harness of a route', async () => {
  // Catches: an opencode core accepted although `opencode run` takes no system prompt of its own.
  await assertRefused(
    () => parseRoute('replay-cli', 'core', 'harness:opencode/anthropic/claude-opus-4.6'),
    'replay-cli',
    'route-unsupported'
  );
});

test('the role flags leave the argv and the other flags stay in order', () => {
  // Catches: a role flag passed on to the script's own parser, which refuses it as unknown.
  const taken = takeRouteFlags(
    'replay-cli',
    ['--trigger', '1', '--core', 'helpers/anthropic/claude-opus-5.5', '--samples', '2'],
    { variants: false }
  );
  assert.deepEqual(taken.argv, ['--trigger', '1', '--samples', '2']);
  assert.equal(taken.variants.length, 1);
  const [only] = taken.variants;
  assert.deepEqual(only.routes.core, {
    kind: 'key',
    key: 'helpers',
    model: 'anthropic/claude-opus-5.5',
    effort: null,
  });
});

test('no role flag gives one variant that changes no role', () => {
  // Catches: an empty argv giving no variant, so a script runs nothing.
  const taken = takeRouteFlags('memory-session', ['--db', 'x.db'], { variants: true });
  assert.equal(taken.variants.length, 1);
  const [only] = taken.variants;
  assert.deepEqual(only.routes, {});
});

test('each --variant runs on the role flags given outside it, with its own flags on top', () => {
  // Catches: a variant that drops the shared flags, or one variant's flags leaking into the next.
  // The first variant's core carries no effort: an API effort on the core is refused since the routes spec of 2026-11-09.
  const taken = takeRouteFlags(
    'replay-cli',
    [
      '--analyzer',
      'helpers/openai/gpt-6.1-sol',
      '--variant',
      '--core helpers/anthropic/claude-opus-5.5',
      '--variant',
      '--core harness:codex/gpt-6.1-sol',
    ],
    { variants: true }
  );
  assert.equal(taken.variants.length, 2);
  const [first, second] = taken.variants;
  const [one, two] = [first.routes, second.routes];
  assert.equal(one.analyzer?.model, 'openai/gpt-6.1-sol');
  assert.equal(two.analyzer?.model, 'openai/gpt-6.1-sol');
  assert.equal(one.core?.kind, 'key');
  assert.equal(two.core?.kind, 'harness');
  assert.notEqual(first.label, second.label);
});

test('--variant is refused by a script that runs one setup', async () => {
  // Catches: a variant silently ignored by recall-eval, which then reports one setup as two.
  await assertRefused(() => takeRoutes('recall-eval', ['--variant', '--core helpers/x/y']), 'recall-eval', 'variant');
});

test("with no flag the core request goes out on the first key of production's core chain and the analyzer on its own", async () => {
  // Catches: a script that still spends one key for every role instead of the routing production has.
  const { deps, sent, children } = rig();
  const routing = await scriptRouting('replay-cli', deps({}));
  await routing.llm.complete(MESSAGES, { role: 'core', purpose: 'reply' });
  await routing.llm.complete(MESSAGES, { role: 'analyzer', purpose: 'address' });
  assert.deepEqual(
    sent.map((one) => one.key),
    [CORE_KEY, ANALYZER_KEY]
  );
  assert.equal(children.length, 0);
});

test('a key route sends the role on that key with its model and effort, and writes nothing to config.json', async () => {
  // Catches: an override that edits the deployment's settings, or one that loses its model or effort on the way.
  const { dir, deps, sent } = rig();
  const before = fs.readFileSync(routingPath(dir), 'utf8');
  // On the analyzer: an API effort on the core is refused since the routes spec of 2026-11-09.
  const routing = await scriptRouting(
    'replay-cli',
    deps({ analyzer: parseRoute('t', 'analyzer', 'helpers/x-ai/grok-6:high') })
  );
  await routing.llm.complete(MESSAGES, { role: 'analyzer', purpose: 'address' });
  assert.equal(sent[0].key, HELPERS_KEY);
  const [{ options }] = sent;
  assert.equal(options.model, 'x-ai/grok-6');
  assert.deepEqual(options.reasoning, { effort: 'high' });
  assert.equal(fs.readFileSync(routingPath(dir), 'utf8'), before);
  assert.equal(routing.keyOf('analyzer'), HELPERS_KEY);
});

test("each request names its route's key to the direct client, never the key ring's first key", async () => {
  // Catches: the chain bypassed in a script, so a spent core key is never left for the next one.
  const { deps, sent } = rig();
  const routing = await scriptRouting('replay-cli', deps({}));
  await routing.llm.complete(MESSAGES, { role: 'analyzer', purpose: 'address' });
  const [first] = sent;
  assert.deepEqual(first?.options.routeKey, { name: 'tools', value: ANALYZER_KEY });
});

test('a key route on the core replaces its whole chain, so a harness failure never reaches a stored key', async () => {
  // Catches: the flag replacing only the first route, so the stored core keys still answer behind the measured route.
  const { deps } = rig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } });
  const routing = await scriptRouting(
    'replay-cli',
    deps({ core: parseRoute('t', 'core', 'helpers/anthropic/claude-opus-5.5') })
  );
  assert.equal(routing.keyOf('core'), HELPERS_KEY);
  assert.deepEqual(routing.routes('core'), [
    { via: 'api', key: 'helpers', model: 'anthropic/claude-opus-5.5', effort: null },
  ]);
});

test('an unknown key name is refused before any client is built', async () => {
  // Catches: a typo in the key name found only when the first request fails, after the run has spent on other roles.
  const { deps, builtCount } = rig();
  await assertRefused(
    () => scriptRouting('replay-cli', deps({ analyzer: parseRoute('t', 'analyzer', 'nosuch/openai/gpt-6.1-sol') })),
    'replay-cli',
    'key-unknown'
  );
  assert.equal(builtCount(), 0);
});

test('a harness that is not logged in is refused before any request', async () => {
  // Catches: a core on a logged-out claude that fails turn after turn instead of stopping at the start.
  const { deps, children } = rig({ loggedIn: false });
  await assertRefused(
    () => scriptRouting('replay-cli', deps({ core: parseRoute('t', 'core', 'harness:claude/claude-opus-4-8') })),
    'replay-cli',
    'harness-not-connected'
  );
  assert.equal(children.length, 0);
});

test('a harness route on the core runs the core request through that CLI with its model', async () => {
  // Catches: the override read from config.json instead of the flag, so the core stays on the API.
  const { deps, children, sent } = rig();
  const routing = await scriptRouting(
    'replay-cli',
    deps({ core: parseRoute('t', 'core', 'harness:claude/claude-opus-4-8:low') })
  );
  const answer = await routing.llm.complete(MESSAGES, { role: 'core', purpose: 'reply', maxOutputTokens: 900 });
  await routing.close();
  assert.equal(answer.text, FINAL);
  assert.equal(children.length, 1);
  const [{ args }] = children;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8');
  assert.equal(sent.length, 0);
});

test("production's harness core carries the core request, and a key route on the core takes it back to the API", async () => {
  // Catches: the stored harness winning over the flag, so `--core <key>/<model>` measures the subscription instead.
  const stored = { backend: 'claude', model: 'claude-opus-4-6', effort: null };
  const onHarness = rig({ core: stored });
  const production = await scriptRouting('replay-cli', onHarness.deps({}));
  await production.llm.complete(MESSAGES, { role: 'core', purpose: 'reply', maxOutputTokens: 900 });
  await production.close();
  assert.equal(onHarness.children.length, 1);

  const overridden = rig({ core: stored });
  const routing = await scriptRouting(
    'replay-cli',
    overridden.deps({ core: parseRoute('t', 'core', 'helpers/anthropic/claude-opus-5.5') })
  );
  await routing.llm.complete(MESSAGES, { role: 'core', purpose: 'reply' });
  await routing.close();
  assert.equal(overridden.children.length, 0);
  const [sentOne] = overridden.sent;
  assert.equal(sentOne.key, HELPERS_KEY);
});

test('a harness route on memory sends a memory request through the writer run and names the path', async () => {
  // Catches: a memory override that the writer client never reads, so the session still spends the memory key.
  const { deps, childRuns, sent } = rig();
  const routing = await scriptRouting(
    'memory-session',
    deps({ memory: parseRoute('t', 'memory', 'harness:claude/claude-opus-4-8') }, ['memory'])
  );
  await routing.llm.complete(MESSAGES, { role: 'memory', purpose: 'memory-session', timeoutMs: 1000 });
  assert.equal(childRuns.length, 1);
  assert.equal(sent.length, 0);
  assert.deepEqual(routing.memoryPath(), {
    kind: 'subharness',
    backend: 'claude',
    model: 'claude-opus-4-8',
    effort: null,
  });
});

test('the start lines name one role each with its key name or harness and model, never a key value', async () => {
  // Catches: a line that prints the key value, or a role the script spends left out of the lines.
  const { deps } = rig({ memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
  const routing = await scriptRouting(
    'replay-cli',
    deps({ core: parseRoute('t', 'core', 'helpers/anthropic/claude-opus-5.5') }, [
      'core',
      'memory',
      'analyzer',
      'vision',
    ])
  );
  assert.equal(routing.said.length, 4);
  const [core, memory, analyzer, vision] = routing.said;
  assert.match(core, /^core: .*helpers.*anthropic\/claude-opus-5\.5/);
  assert.match(memory, /^memory: .*codex.*gpt-6\.1-sol/);
  assert.match(analyzer, /^analyzer: .*tools.*openai\/gpt-6\.1-sol/);
  assert.match(vision, /^vision: off/);
  for (const line of routing.said)
    for (const value of [CORE_KEY, HELPERS_KEY, ANALYZER_KEY]) assert.equal(line.includes(value), false);
});

test('an offline client answers every role and no key or CLI is used', async () => {
  // Catches: a replay from answer files that still sends a helper request to the provider or starts the stored CLI.
  const { deps, sent, children } = rig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } });
  const answered: Array<unknown> = [];
  const offline = {
    complete: (_messages: unknown, opts?: unknown): Promise<CompleteResult> => {
      answered.push(opts);
      return Promise.resolve({ text: 'from the files', usage: {}, estimated: 0 });
    },
  };
  const routing = await scriptRouting('replay-cli', { ...deps({}), offline });
  for (const role of ['core', 'memory', 'analyzer', 'search'])
    assert.equal((await routing.llm.complete(MESSAGES, { role })).text, 'from the files');
  assert.equal(answered.length, 4);
  assert.equal(sent.length, 0);
  assert.equal(children.length, 0);
  assert.equal(routing.keyOf('embedding'), null);
});

test('the routed config replaces the chains of the replaced roles and leaves the live object alone', () => {
  // Catches: an overlay that mutates the hot config, so a later variant inherits the previous one's model.
  // Changed: a role's model is its chain's (slice 4), so the overlay replaces the chain of each role on a key.
  const live = structuredClone(LIVE);
  const config = routedConfig(live, {
    analyzer: parseRoute('t', 'analyzer', 'helpers/google/gemini-3.8-flash'),
    search: parseRoute('t', 'search', 'helpers/perplexity/sonar-pro'),
    vision: parseRoute('t', 'vision', 'helpers/google/gemini-3.8-flash'),
  }) as typeof LIVE & { models: { routes: Record<string, unknown> } };
  const { routes } = config.models;
  assert.deepEqual(routes.analyzer, [onKey('helpers', 'google/gemini-3.8-flash')]);
  assert.deepEqual(routes.vision, [onKey('helpers', 'google/gemini-3.8-flash')]);
  assert.deepEqual(routes.search, [onKey('helpers', 'perplexity/sonar-pro')]);
  assert.deepEqual(live, LIVE);
});

test('side by side keeps what the variants share once and puts what differs under each variant', () => {
  // Catches: an output that repeats the input per variant, or one that drops a variant's answer.
  const merged = sideBySide(
    ['production', '--core helpers/x/y'],
    [
      { trigger: { id: '1' }, answers: [{ text: 'a' }, { text: 'b' }] },
      { trigger: { id: '1' }, answers: [{ text: 'c' }, { text: 'b' }] },
    ]
  );
  assert.deepEqual(merged, {
    trigger: { id: '1' },
    answers: [
      {
        variants: [
          { variant: 'production', text: 'a' },
          { variant: '--core helpers/x/y', text: 'c' },
        ],
      },
      { text: 'b' },
    ],
  });
});

test('side by side text lists every input once with each variant beneath it', () => {
  // Catches: a scope that only one variant ran missing from the output, or the variants printed one after the other.
  const text = sideBySideText(
    ['a', 'b'],
    [
      [
        { input: 'scope group:discord', lines: ['ok, 4 lines'] },
        { input: 'scope dm:discord:7', lines: ['ok, 2 lines'] },
      ],
      [{ input: 'scope group:discord', lines: ['failed, 4 lines'] }],
    ]
  );
  assert.deepEqual(text, [
    'scope group:discord',
    '  [a] ok, 4 lines',
    '  [b] failed, 4 lines',
    'scope dm:discord:7',
    '  [a] ok, 2 lines',
    '  [b] (not run)',
  ]);
});

test('the routing reads a changed config.json at the next request', async () => {
  // Catches: the chains read once at the start, so a route set during a long run is not used.
  const { dir, deps, sent } = rig();
  const routing = await scriptRouting('replay-cli', deps({}));
  writeChains(dir, { analyzer: [onKey('helpers', 'openai/gpt-6.1-sol')] });
  await routing.llm.complete(MESSAGES, { role: 'analyzer' });
  assert.equal(sent[0].key, HELPERS_KEY);
  assert.ok(fs.existsSync(path.join(dir, 'keys.json')));
});

/** The value after `flag` in an argv. */
const argOf = (args: ReadonlyArray<string>, flag: string): string => args[args.indexOf(flag) + 1] ?? '';

/**
 * A spawn whose run first does what `bin/neptunia-mcp.ts` does (reads the token file, connects to the socket of the
 * `--mcp-config`, lists the tools), then answers with the finished message of `fakeSpawn`.
 */
function bridgeSpawn() {
  const answer = fakeSpawn();
  const listed: Array<string> = [];
  const sockets: Array<string> = [];
  const spawn = (child: SubscriptionChild): SubscriptionProcess => {
    const config = JSON.parse(argOf(child.args, '--mcp-config')) as { mcpServers: { nep: { args: Array<string> } } };
    const { args } = config.mcpServers.nep;
    const socketPath = argOf(args, '--socket');
    sockets.push(socketPath);
    const token = fs.readFileSync(argOf(args, '--token-file'), 'utf8').trim();
    const peerDone = connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES }).then(async (transport) => {
      const tools = await bridgePeer(transport, token).list();
      for (const tool of tools) listed.push((tool as { function: { name: string } }).function.name);
      transport.close();
    });
    const run = answer.spawn(child);
    const { lines } = run;
    const held: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => {
        const inner = lines[Symbol.asyncIterator]();
        return { next: () => peerDone.then(() => inner.next()) };
      },
    };
    return { ...run, lines: held, exited: peerDone.then(() => 0) };
  };
  return { spawn, listed, sockets };
}

test("a core step with tools on a harness reaches the script's own bridge, which lists the step's tools", async () => {
  // Catches: the script handing the CLI a socket nobody listens on, so her tools never reach a replay on a harness.
  const { deps } = rig();
  const fake = bridgeSpawn();
  const tools = [
    { type: 'function', function: { name: 'memory.search', description: 'search', parameters: { type: 'object' } } },
  ];
  const routing = await scriptRouting('replay-cli', {
    ...deps({ core: parseRoute('t', 'core', 'harness:claude/claude-sonnet-5-5') }),
    spawn: fake.spawn,
  });
  const answer = await routing.llm.complete(MESSAGES, { role: 'core', purpose: 'reply', tools });
  assert.equal(answer.text, FINAL);
  assert.deepEqual(fake.listed, ['memory.search']);
  await routing.close();
  const [socket = ''] = fake.sockets;
  assert.equal(fs.existsSync(socket), false);
});
