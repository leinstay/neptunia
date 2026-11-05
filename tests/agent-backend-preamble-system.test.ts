// Where a task's preamble and the agent's own prompt reach the child of each backend: src/agent-runner/backend.ts
// (createAgentEngine, the recipes) through src/subharness/run.ts. The system instructions are the preamble first, then
// the agent's prompt; the prompt text is the task alone. The forms per backend, read off the installed binaries:
//   claude    `--system-prompt <text>` or `--system-prompt-file <path>`, which replace the built-in system prompt;
//   codex     `-c model_instructions_file=<path>`, which replaces codex's base instructions;
//   opencode  the run agent's `prompt` (the `build` agent unless `--agent` names another) in OPENCODE_CONFIG_CONTENT or
//             in the file OPENCODE_CONFIG names, inline or as `{file:<path>}`; OpenCode puts it before everything else.
// The children are a fake spawn that refuses, like Linux, any one argument or environment entry over 131071 bytes
// (measured on this server: 131072 bytes fail with E2BIG), so a long preamble must take a file form and arrive whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createAgentEngine, createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { taskPrompt } from '../src/agent-runner/opencode.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { present, wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The longest single argument or `NAME=value` environment entry execve takes here, in bytes. */
const MAX_ARG_BYTES = 131_071;
const AGENT_PROMPT = 'AGENT-PROMPT: you are an errand agent; leave your findings in the working folder.';
const PREAMBLE = 'PREAMBLE-LAYER: the deployment speaks first.\nKeep answers short.';
const GOAL = 'look at the disk';
const CONTEXT = { recent: [{ author: 'someone', text: 'how full is it?' }] };
const BACKENDS: ReadonlyArray<BackendName> = ['claude', 'codex', 'opencode'];

/** What the fake child was given, read while it ran (a file form is read before the run removes it). */
type Seen = {
  system: string | null;
  prompt: string;
  /** stdin and every argument except the value of claude's `--system-prompt`: what the model may read as the user's */
  userSide: string;
  files: Array<string>;
  steps: unknown;
};

/** The value after `flag` in `args`, or undefined. */
const after = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** A TOML string value as codex reads it from `-c key=value`: basic or literal quotes, else the raw text. */
function tomlString(raw: string): string {
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

/** An OpenCode config value that may point at a file: `{file:<path>}` reads the file. */
function opencodeText(value: unknown, files: Array<string>): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\{file:(.+)\}$/.exec(value);
  if (!match) return value;
  files.push(match[1]);
  return fs.readFileSync(match[1], 'utf8');
}

/** The system instructions and the prompt text the child of `name` received. */
function seenBy(name: BackendName, args: ReadonlyArray<string>, env: Record<string, string>, stdin: string): Seen {
  const seen = seenSystem(name, args, env, stdin);
  const userSide = [stdin, ...args.filter((_, at) => args[at - 1] !== '--system-prompt')].join('\n');
  return { ...seen, userSide };
}

/** The system instructions and the prompt text, as `seenBy` without the user side. */
function seenSystem(
  name: BackendName,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  stdin: string
): Omit<Seen, 'userSide'> {
  const files: Array<string> = [];
  if (name === 'claude') {
    const inline = after(args, '--system-prompt');
    const file = after(args, '--system-prompt-file');
    if (file !== undefined) files.push(file);
    const system = inline ?? (file === undefined ? null : fs.readFileSync(file, 'utf8'));
    return { system, prompt: stdin, files, steps: undefined };
  }
  if (name === 'codex') {
    const setting = args
      .filter((_, at) => at > 0 && (args[at - 1] === '-c' || args[at - 1] === '--config'))
      .find((value) => value.startsWith('model_instructions_file='));
    let system: string | null = null;
    if (setting !== undefined) {
      const file = tomlString(setting.slice('model_instructions_file='.length));
      files.push(file);
      system = fs.readFileSync(file, 'utf8');
    }
    return { system, prompt: stdin, files, steps: undefined };
  }
  const agentName = after(args, '--agent') ?? 'build';
  const configs: Array<Record<string, unknown>> = [];
  if (env.OPENCODE_CONFIG !== undefined) {
    files.push(env.OPENCODE_CONFIG);
    configs.push(JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8')) as Record<string, unknown>);
  }
  if (env.OPENCODE_CONFIG_CONTENT !== undefined)
    configs.push(JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>);
  let system: string | null = null;
  let steps: unknown;
  for (const config of configs) {
    const agent = (config.agent as Record<string, Record<string, unknown>> | undefined)?.[agentName];
    if (agent === undefined) continue;
    system = opencodeText(agent.prompt, files) ?? system;
    steps = agent.steps ?? steps;
  }
  return { system, prompt: args.at(-1) ?? '', files, steps };
}

/** A spawn that records what each child got and answers as the backend would; it refuses an over-long argument. */
function fakeSpawn(name: BackendName, seen: Array<Seen>) {
  const impl = (_binary: string, args: Array<string>, options: { env: Record<string, string> }) => {
    const tooLong = [...args, ...Object.entries(options.env).map(([key, value]) => `${key}=${value}`)].some(
      (entry) => Buffer.byteLength(entry, 'utf8') > MAX_ARG_BYTES
    );
    if (tooLong) throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    let stdin = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => {
      stdin += chunk;
    });
    child.stdin.on('end', () => {
      seen.push(seenBy(name, args, options.env, stdin));
      if (name === 'claude') child.stdout.write(JSON.stringify({ type: 'result', result: 'done', is_error: false }));
      else if (name === 'codex') fs.writeFileSync(after(args, '-o') ?? '', 'done');
      else child.stdout.write('done');
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

/** An engine of the agent scout whose every run goes to the fake child of `name`, on a route that names it. */
function rig(name: BackendName) {
  const base = tempDir('nep-preamble-system-');
  const promptFile = path.join(base, 'agent.md');
  fs.writeFileSync(promptFile, AGENT_PROMPT);
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen: Array<Seen> = [];
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [promptFile],
    modelRole: 'scout',
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      denyDir: path.join(base, 'nosudo'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (backend) => createBackend(backend, { binary, spawnImpl: fakeSpawn(backend, seen) }),
    },
  });
  const route: TaskRoute = { backend: name, model: null, effort: null, mode: 'read' };
  const task = (id: string, preamble?: string) =>
    ({
      id,
      goal: GOAL,
      context: CONTEXT,
      route,
      secrets: { openrouterKey: 'sk-or-v1-test-0123456789' },
      ...(preamble === undefined ? {} : { preamble }),
    }) as unknown as Parameters<typeof engine.run>[0];
  return { engine, seen, task };
}

/** The one child a run started; fails when the run started none (a refused spawn, an unread system form). */
function onlyChild(seen: Array<Seen>): Seen {
  assert.equal(seen.length, 1, 'the run started exactly one child');
  return seen[0];
}

/** Asserts `system` is `preamble`, then the agent's prompt, with only blank space between them. */
function assertLayers(given: string | null, preamble: string): void {
  const system = present(given, 'system instructions in the form of its backend');
  assert.ok(system.startsWith(preamble), 'the preamble opens the system instructions, whole');
  assert.ok(system.endsWith(AGENT_PROMPT), "the agent's own prompt follows the preamble");
  assert.equal(system.slice(preamble.length, system.length - AGENT_PROMPT.length).trim(), '', 'nothing between them');
}

for (const name of BACKENDS) {
  test(`${name}: the preamble opens the system instructions, the agent's prompt follows, the prompt is the task alone`, async () => {
    // Catches: the preamble and the agent's prompt still ride in the prompt text, where the model reads them as the
    // user's words, or the agent's prompt comes before the preamble.
    const { engine, seen, task } = rig(name);
    const outcome = await engine.run(task('p1', PREAMBLE));
    assert.equal(outcome.status, 'done');
    const child = onlyChild(seen);
    assertLayers(child.system, PREAMBLE);
    assert.equal(child.prompt.trim(), taskPrompt(GOAL, CONTEXT));
    assert.ok(!child.userSide.includes('PREAMBLE-LAYER'), 'the preamble never appears on the user side');
    assert.ok(!child.userSide.includes('AGENT-PROMPT'), "the agent's prompt is not repeated on the user side");
  });

  test(`${name}: without a preamble the system instructions are the agent's prompt alone`, async () => {
    // Catches: a run with no preamble gets an empty first layer, a stray separator, or no system instructions at all.
    const { engine, seen, task } = rig(name);
    const outcome = await engine.run(task('p2'));
    assert.equal(outcome.status, 'done');
    const child = onlyChild(seen);
    assert.equal(child.system, AGENT_PROMPT);
    assert.equal(child.prompt.trim(), taskPrompt(GOAL, CONTEXT));
  });

  test(`${name}: a preamble too long for one argument arrives whole, and its files are gone after the run`, async () => {
    // Catches: a long preamble passed inline fails the spawn with E2BIG, or is cut to fit, or a file holding the
    // deployment's private text stays in the temporary folder. 70000 two-byte characters are 140000 bytes, past the
    // 131071-byte limit of one argument though far under 100000 characters.
    const long = `LONG-START ${'é'.repeat(70_000)} ${'x'.repeat(60_000)} LONG-END`;
    const { engine, seen, task } = rig(name);
    const outcome = await engine.run(task('p3', long));
    assert.equal(outcome.status, 'done', 'the child started');
    const child = onlyChild(seen);
    assertLayers(child.system, long);
    assert.ok(!child.userSide.includes('LONG-START'), 'the preamble never appears on the user side');
    for (const file of child.files) assert.equal(fs.existsSync(file), false, 'no file of the run is left behind');
  });
}

test('opencode: the config carries the prompt and no step cap', async () => {
  // The expectation changed on the owner's word of 2026-11-05: OpenCode gets no step cap, because at the cap it appends
  // an assistant turn that Gemini and Anthropic refuse. Catches: the scout's profile steps reach OpenCode's config.
  const { engine, seen, task } = rig('opencode');
  await engine.run(task('p4', PREAMBLE));
  assert.equal(onlyChild(seen).steps, undefined);
});
