// Her core requests through a subscription CLI: the client in front of the direct client (src/llm/openrouter.ts) while
// the core's route names a backend: the route the chain client chose, else the first route of the core's chain
// (src/subharness/memory-path.ts#harnessPathOf). The step loop stays as it is and calls
// `complete` per step. The first step of a turn starts one `claude -p` or `codex exec` with her system text in place of
// the CLI's own and her user text on stdin, and resolves when the model's first call stops. Her tools reach the CLI
// through the `nep` MCP server (bin/neptunia-mcp.ts), which forwards each call over the core socket to the tool bridge
// (src/subharness/tool-bridge.ts), where it waits. The next step finds the session by its tool call ids, answers the
// waiting calls with the step's results, and reads the stream again until the next model call stops. Only requests of
// the role `core` take the route; every other role goes to the direct client unchanged. Each step passes the same two
// rails as an API request before anything starts, records its usage at no cost and returns the backend, so the archive
// keeps one row per step. A failure rejects with an Error whose `code` is one of `SUBSCRIPTION_CODES`. A request that
// brings the route the chain client chose (`chainRoute`, src/llm/chain-client.ts) takes that route, and its failure goes
// back to the chain, which moves on; any other request takes the stored route, and its failure fails the request. Logs
// carry the backend, counts and codes, never text.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { childEnvOf, outputLimitEnv } from '../agent-runner/backend.ts';
import { killTree } from '../agent-runner/opencode.ts';
import { SUBSCRIPTION_CODES, TokenLimitError, countLlmRequest, toolCallsOf } from '../llm/openrouter.ts';
import type { CompleteResult } from '../llm/openrouter.ts';
import { isListedEffort } from '../llm/roles.ts';
import { estimateMessages, estimateTools } from '../llm/tokens.ts';
import { coreSocketPath } from '../interface/socket.ts';
import { log } from '../log.ts';
import type { Transport } from '../protocol/wire.ts';
import { bareToolName } from '../tools/gateway.ts';
import type { UsageEntry } from '../tools/operations/usage.ts';
import { markedRun } from './activity.ts';
import { LOGIN_FAILURE, runOutcomeOf } from './login-state.ts';
import type { LoginState, RunOutcome } from './login-state.ts';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from './mcp-server.ts';
import type { BridgeAnswer, BridgeCall } from './mcp-server.ts';
import { isInstalled, subharnessPlace } from './place.ts';
import { isNativeThinking, nativeThinkingCodexArgs, nativeThinkingEnv } from './thinking.ts';
import { harnessPathOf } from './memory-path.ts';
import type { SubharnessMemoryPath } from './memory-path.ts';

/** The route of her core: the API, or one backend with its model and effort. */
export type SubscriptionPath = { kind: 'api' } | SubharnessMemoryPath;
import { createToolBridge, routeTurnLink } from './tool-bridge.ts';
import type { ToolBridge } from './tool-bridge.ts';

/** One CLI process as the client asks for it. */
export type SubscriptionChild = {
  binary: string;
  args: Array<string>;
  env: Record<string, string>;
  stdin: string;
  cwd: string;
};
/** The started process: its stdout line by line, its exit, and the kill of its process group. */
export type SubscriptionProcess = { lines: AsyncIterable<string>; exited: Promise<number | null>; kill(): void };

export type SubscriptionClientDeps = {
  privateDir: string;
  /** The route in place of the core's chain, for a paid script whose `--core` flag replaces it; absent, the chain is
   * read again at every first step. */
  fixedPath?: SubscriptionPath;
  direct: { complete(messages: unknown, options?: unknown): Promise<CompleteResult> };
  bridge: ToolBridge;
  spawn(child: SubscriptionChild): SubscriptionProcess;
  /** How the CLI starts the MCP server, and the socket it reaches the bridge on. */
  mcp: { command: string; args: ReadonlyArray<string>; socketPath: string };
  /** Each run gets a folder `turn-*` inside it, mode 700, removed when the run ends. */
  workDir: string;
  getConfig(): { llm: Record<string, unknown> };
  /** Persistent state, for the daily request count of `llm.maxRequestsPerDay`. */
  state: { data: object; markDirty(): void };
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The environment the child's plain variables come from; the process's own by default. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  record?(entry: UsageEntry): void;
  /** Told what each step through the harness came to, for the header's login state (src/subharness/login-state.ts). */
  ran?(backend: Route['backend'], outcome: RunOutcome): void;
};

type Rec = Record<string, unknown>;
type Route = Extract<SubscriptionPath, { kind: 'subharness' }>;
type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number } };
type Finish = 'stop' | 'tool_calls' | 'length';
type ToolUse = { id: string; name: string; json: string };
/** What one model call came to. */
type StepAnswer = { text: string; calls: Array<ToolUse>; finish: Finish; usage: Usage };
/** A call the model made, its result once the step loop gave it, and the waiting MCP call once it arrived. */
type Entry = {
  id: string;
  name: string;
  args: string;
  answer: BridgeAnswer | null;
  reply: Reply | null;
  paired: boolean;
};
type Reply = (answer: BridgeAnswer) => void;
/** An MCP call at the bridge that no model call has been paired with yet. */
type Parked = { call: BridgeCall; reply: Reply; id: string | null };
/** Claude's model call as its stream events build it. */
type ClaudeCall = {
  text: string;
  tools: Map<number, ToolUse>;
  prompt: number;
  cached: number;
  output: number;
  stop: unknown;
};

type Session = {
  deps: SubscriptionClientDeps;
  /** The client's open sessions, which this one leaves when it ends. */
  sessions: Set<Session>;
  route: Route;
  process: SubscriptionProcess;
  closeBridge(): void;
  dir: string;
  step: { resolve(answer: StepAnswer): void; reject(error: Error): void } | null;
  entries: Array<Entry>;
  parked: Array<Parked>;
  /** Claude: the model call being read, the final answer once the turn ended, and a rejected window. */
  call: ClaudeCall | null;
  final: StepAnswer | null;
  isExhausted: boolean;
  /** Codex: the agent messages and the started calls since the last step. */
  texts: Array<string>;
  stepIds: Array<string>;
  hold: unknown;
  idle: unknown;
  timeoutMs: number;
  isOver: boolean;
  ended(): void;
};

/** How long a session that ended on calls waits for its next step (ms), when `llm.subscription.holdMs` is unset. */
const HOLD_MS_DEFAULT = 60_000;
/** The meta key Claude names the tool call of an MCP call by. */
const TOOL_USE_META = 'claudecode/toolUseId';
/** Claude's stop reasons as the chat-completions finish reasons the step loop reads. */
const FINISH: Readonly<Record<string, Finish>> = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length' };

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const rec = (value: unknown): Rec => (isRec(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const usageOf = (prompt: number, cached: number, completion: number): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  prompt_tokens_details: { cached_tokens: cached },
});

/** A JSON text with its object keys sorted, so two writings of the same arguments compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRec(value)) return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const canonicalJson = (json: string): string => {
  try {
    return canonical(JSON.parse(json === '' ? '{}' : json));
  } catch {
    return json;
  }
};

/** The text of a message's content: a string, or its text parts joined in order. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => str(rec(part).text)).join('');
}

/** The system text and the first user text of a turn's first request. */
function splitFirst(messages: ReadonlyArray<Rec>): { system: string; user: string } {
  const system = messages.filter((message) => message.role === 'system').map((message) => textOf(message.content));
  const user = messages.find((message) => message.role === 'user');
  return { system: system.join('\n\n'), user: textOf(user?.content) };
}

/** The tool results of a later step, the step's trailing note after the last one; null for a turn's first request. */
function laterStep(messages: ReadonlyArray<Rec>): Array<{ id: string; text: string }> | null {
  const last = messages.findLastIndex((message) => message.role === 'assistant');
  if (last === -1) return null;
  const after = messages.slice(last + 1);
  const results = after
    .filter((message) => message.role === 'tool')
    .map((message) => ({ id: str(message.tool_call_id), text: textOf(message.content) }));
  const note = after
    .filter((message) => message.role === 'user')
    .map((message) => textOf(message.content))
    .join('\n\n');
  const tail = results.at(-1);
  if (tail !== undefined && note !== '') tail.text = `${tail.text}\n\n${note}`;
  return results;
}

/** Claude's arguments: her system text replaces the CLI's whole prompt, no built-in tool, no settings, no session file. */
function claudeArgs(route: Route, system: string, server: object | null): Array<string> {
  const tools =
    server === null ? [] : ['--mcp-config', JSON.stringify(server), '--allowedTools', `${MCP_TOOL_PREFIX}*`];
  return [
    '-p',
    '--system-prompt',
    system,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    ...tools,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    route.model,
    ...(route.effort === null ? [] : ['--effort', route.effort]),
  ];
}

/**
 * Codex's arguments: her system text as the instructions file in place of Codex's own, no project docs, no environment
 * or permission text, no shell, patch, image or web tool, and the `nep` server's calls approved. The `-c` keys were read
 * from the strings of the installed 0.164.0 and only a live turn proves them.
 */
function codexArgs(
  route: Route,
  instructions: string,
  server: { command: string; args: Array<string> } | null,
  thinking: boolean
): Array<string> {
  const set = (pair: string): Array<string> => ['-c', pair];
  const nep =
    server === null
      ? []
      : [
          ...set(`mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(server.command)}`),
          ...set(`mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(server.args)}`),
          ...set(`mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`),
        ];
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-m',
    route.model,
    ...(route.effort === null ? [] : set(`model_reasoning_effort=${route.effort}`)),
    ...set(`model_instructions_file=${JSON.stringify(instructions)}`),
    ...set('project_doc_max_bytes=0'),
    ...set('include_environment_context=false'),
    ...set('include_permissions_instructions=false'),
    ...set('features.shell_tool=false'),
    ...set('features.unified_exec=false'),
    ...set('features.view_image=false'),
    ...set('features.apply_patch_freeform=false'),
    ...set('web_search="disabled"'),
    ...nep,
    ...nativeThinkingCodexArgs(thinking),
  ];
}

/** The real spawn: its own process group, stdin written and closed, stdout read line by line. */
export function spawnSubscriptionChild(child: SubscriptionChild): SubscriptionProcess {
  const proc = spawn(child.binary, child.args, {
    cwd: child.cwd,
    env: child.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  proc.stdin.on('error', () => {
    // a child that exits before reading its stdin ends the run through its exit, not this pipe
  });
  proc.stdin.end(child.stdin);
  const exited = new Promise<number | null>((resolve) => {
    proc.once('close', (code) => resolve(code));
    proc.once('error', () => resolve(null));
  });
  return {
    lines: readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }),
    exited,
    kill: () => killTree(proc, 'SIGKILL'),
  };
}

/** The settings of the route, read at the moment of use. */
function settingsOf(llm: Rec): { thinking: boolean; holdMs: number } {
  const own = rec(llm.subscription);
  const hold = num(own.holdMs);
  return {
    thinking: isNativeThinking({ llm }),
    holdMs: hold > 0 ? hold : HOLD_MS_DEFAULT,
  };
}

const llmOf = (deps: SubscriptionClientDeps): Rec => rec(deps.getConfig().llm);

const isSubscriptionFailure = (error: unknown): boolean =>
  isRec(error) && SUBSCRIPTION_CODES.some((code) => code === error.code);

/** Stops the session's hold or idle timer. */
function stopTimer(session: Session, which: 'hold' | 'idle'): void {
  const handle = session[which];
  if (handle !== null) session.deps.clearTimer(handle);
  session[which] = null;
}

/** Ends the session once: its timers, its token, its folder; `kill` stops a process that is still running. */
function end(session: Session, kill: boolean): void {
  if (session.isOver) return;
  session.isOver = true;
  stopTimer(session, 'hold');
  stopTimer(session, 'idle');
  session.closeBridge();
  session.sessions.delete(session);
  fs.rmSync(session.dir, { recursive: true, force: true });
  for (const waiter of session.parked) waiter.reply({ text: 'the turn is over', isError: true });
  if (kill) session.process.kill();
  session.ended();
}

function fail(session: Session, code: string, message: string): void {
  const step = session.step;
  session.step = null;
  log.warn('subscription: run failed', { backend: session.route.backend, code });
  end(session, true);
  step?.reject(coded(code, message));
}

/** The timeout of a step that waits: no event within it fails the step. */
function armIdle(session: Session): void {
  stopTimer(session, 'idle');
  if (session.step === null || session.isOver) return;
  session.idle = session.deps.setTimer(
    () => fail(session, 'subscription-timeout', 'no event within the step timeout'),
    session.timeoutMs
  );
}

/** A session that ended on calls waits `holdMs` for its next step, then its process is killed. */
function armHold(session: Session): void {
  stopTimer(session, 'hold');
  session.hold = session.deps.setTimer(
    () => {
      log.info('subscription: hold passed', { backend: session.route.backend });
      end(session, true);
    },
    settingsOf(llmOf(session.deps)).holdMs
  );
}

function resolveStep(session: Session, answer: StepAnswer): void {
  stopTimer(session, 'idle');
  const step = session.step;
  session.step = null;
  step?.resolve(answer);
}

/** Pairs each waiting MCP call with its model call: by Claude's tool use id, else by name and arguments in order. */
function pair(session: Session): void {
  for (const waiter of [...session.parked]) {
    const entry = session.entries.find(
      (one) =>
        !one.paired &&
        (waiter.id === null
          ? one.name === waiter.call.name && one.args === canonical(waiter.call.arguments)
          : one.id === waiter.id)
    );
    if (entry === undefined) continue;
    entry.paired = true;
    session.parked.splice(session.parked.indexOf(waiter), 1);
    if (entry.answer === null) entry.reply = waiter.reply;
    else {
      waiter.reply(entry.answer);
      session.entries.splice(session.entries.indexOf(entry), 1);
    }
  }
  if (session.route.backend === 'codex') codexStepReady(session);
}

function announce(session: Session, calls: ReadonlyArray<ToolUse>): void {
  for (const call of calls)
    session.entries.push({
      id: call.id,
      name: call.name,
      args: canonicalJson(call.json),
      answer: null,
      reply: null,
      paired: false,
    });
}

/** The result of one call: to its waiting MCP call, or kept until it arrives. */
function answerCall(session: Session, id: string, text: string): void {
  const entry = session.entries.find((one) => one.id === id);
  if (entry === undefined) return;
  const answer = { text, isError: false };
  if (entry.reply === null) {
    entry.answer = answer;
    return;
  }
  entry.reply(answer);
  session.entries.splice(session.entries.indexOf(entry), 1);
}

function bridgeCall(session: Session, call: BridgeCall): Promise<BridgeAnswer> {
  if (session.isOver) return Promise.resolve({ text: 'the turn is over', isError: true });
  const meta = call.meta?.[TOOL_USE_META];
  return new Promise((reply) => {
    session.parked.push({ call, reply, id: typeof meta === 'string' ? meta : null });
    pair(session);
  });
}

// ---- Claude's stream -------------------------------------------------------------------------------------------

function claudeCallEnded(session: Session): void {
  const call = session.call;
  session.call = null;
  if (call === null) return;
  const answer: StepAnswer = {
    text: call.text,
    calls: [...call.tools.values()],
    finish: FINISH[str(call.stop)] ?? 'stop',
    usage: usageOf(call.prompt, call.cached, call.output),
  };
  if (answer.finish !== 'tool_calls') {
    session.final = answer;
    return;
  }
  announce(session, answer.calls);
  resolveStep(session, answer);
  armHold(session);
  pair(session);
}

function claudeStream(session: Session, event: Rec): void {
  const call = session.call;
  const index = num(event.index);
  switch (event.type) {
    case 'message_start': {
      const usage = rec(rec(event.message).usage);
      const read = num(usage.cache_read_input_tokens);
      const prompt = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + read;
      session.call = { text: '', tools: new Map(), prompt, cached: read, output: 0, stop: null };
      return;
    }
    case 'content_block_start': {
      const block = rec(event.content_block);
      if (call !== null && block.type === 'tool_use')
        call.tools.set(index, { id: str(block.id), name: bareToolName(str(block.name)), json: '' });
      return;
    }
    case 'content_block_delta': {
      const delta = rec(event.delta);
      const tool = call?.tools.get(index);
      if (call !== null && delta.type === 'text_delta') call.text += str(delta.text);
      if (tool !== undefined && delta.type === 'input_json_delta') tool.json += str(delta.partial_json);
      return;
    }
    case 'message_delta':
      if (call === null) return;
      call.stop = rec(event.delta).stop_reason;
      call.output = num(rec(event.usage).output_tokens);
      return;
    case 'message_stop':
      claudeCallEnded(session);
      return;
  }
}

/** The code of a failed Claude run: a spent window, a lost login, or anything else. */
function claudeFailure(session: Session, event: Rec): string {
  if (session.isExhausted || event.api_error_status === 429) return 'subscription-exhausted';
  if (LOGIN_FAILURE.test(str(event.result))) return 'subscription-login';
  return 'subscription-failed';
}

function claudeEvent(session: Session, line: Rec): void {
  if (line.type === 'stream_event') claudeStream(session, rec(line.event));
  else if (line.type === 'rate_limit_event' && rec(line.rate_limit_info).status === 'rejected')
    session.isExhausted = true;
  else if (line.type === 'result') {
    const final = session.final;
    if (line.is_error === true || final === null) {
      fail(session, claudeFailure(session, line), 'the claude run failed');
      return;
    }
    const step = session.step;
    session.step = null;
    end(session, false);
    step?.resolve(final);
  }
}

// ---- Codex's stream --------------------------------------------------------------------------------------------

/** A Codex step ends when every call it started waits at the bridge, since Codex marks no end of a model call. */
function codexStepReady(session: Session): void {
  if (session.step === null || session.stepIds.length === 0) return;
  const calls = session.stepIds.map((id) => session.entries.find((one) => one.id === id));
  if (calls.some((one) => one === undefined || !one.paired)) return;
  const answer: StepAnswer = {
    text: session.texts.join('\n\n'),
    calls: calls.flatMap((one) => (one === undefined ? [] : [{ id: one.id, name: one.name, json: one.args }])),
    finish: 'tool_calls',
    usage: usageOf(0, 0, 0),
  };
  session.texts = [];
  session.stepIds = [];
  resolveStep(session, answer);
  armHold(session);
}

function codexEvent(session: Session, event: Rec): void {
  const item = rec(event.item);
  if (event.type === 'item.completed' && item.type === 'agent_message') session.texts.push(str(item.text));
  else if (event.type === 'item.started' && item.type === 'mcp_tool_call') {
    const id = str(item.id);
    announce(session, [{ id, name: bareToolName(str(item.tool)), json: JSON.stringify(item.arguments ?? {}) }]);
    session.stepIds.push(id);
    pair(session);
  } else if (event.type === 'turn.completed') {
    const usage = rec(event.usage);
    const answer: StepAnswer = {
      text: session.texts.join('\n\n'),
      calls: [],
      finish: 'stop',
      usage: usageOf(num(usage.input_tokens), num(usage.cached_input_tokens), num(usage.output_tokens)),
    };
    const step = session.step;
    session.step = null;
    end(session, false);
    step?.resolve(answer);
  } else if (event.type === 'turn.failed' || event.type === 'error') {
    const message = str(event.message) || str(rec(event.error).message);
    if (/usage limit/i.test(message)) fail(session, 'subscription-exhausted', 'the codex usage limit is reached');
    else if (event.type === 'turn.failed') fail(session, 'subscription-failed', 'the codex turn failed');
  }
}

/** Reads the run's stdout to its end; a run that ends while it still owes a step fails it. */
async function read(session: Session): Promise<void> {
  try {
    for await (const line of session.process.lines) {
      if (session.isOver) continue;
      armIdle(session);
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (session.route.backend === 'claude') claudeEvent(session, rec(event));
      else codexEvent(session, rec(event));
    }
  } catch {
    // a stream that breaks ends the run like one that closes
  }
  if (!session.isOver) fail(session, 'subscription-failed', 'the CLI ended before its answer');
}

/** The promise of the session's next step, which an abort of the request fails. */
function nextStep(session: Session, options: Rec): Promise<StepAnswer> {
  const pending = new Promise<StepAnswer>((resolve, reject) => {
    session.step = { resolve, reject };
  });
  const signal = options.signal;
  if (signal instanceof AbortSignal) {
    if (signal.aborted) fail(session, 'subscription-timeout', 'the request was aborted');
    else
      signal.addEventListener('abort', () => fail(session, 'subscription-timeout', 'the request was aborted'), {
        once: true,
      });
  }
  armIdle(session);
  return pending;
}

/** Answers a later step's waiting calls with its results and returns the session's next step. */
function resume(
  session: Session,
  results: ReadonlyArray<{ id: string; text: string }>,
  options: Rec
): Promise<StepAnswer> {
  stopTimer(session, 'hold');
  const next = nextStep(session, options);
  for (const result of results) answerCall(session, result.id, result.text);
  return next;
}

/** The core's route as its chain stores it: its first route when that is a harness, else the API. */
function storedPath(privateDir: string): SubscriptionPath {
  const path = harnessPathOf(privateDir, 'core');
  return path.kind === 'subharness' ? path : { kind: 'api' };
}

/** The route of the chain client's `chainRoute` (src/llm/route-text.ts) as a path, null for a request without one. */
function chainPathOf(value: unknown): SubscriptionPath | null {
  if (!isRec(value)) return null;
  if (value.via === 'api') return { kind: 'api' };
  const backend = value.backend === 'claude' || value.backend === 'codex' ? value.backend : null;
  if (value.via !== 'harness' || backend === null || typeof value.model !== 'string') return null;
  const effort = isListedEffort(value.effort) ? value.effort : null;
  return { kind: 'subharness', backend, model: value.model, effort };
}

/** The client in front of `deps.direct`. */
export function createSubscriptionClient(deps: SubscriptionClientDeps): {
  complete(messages: unknown, options?: unknown): Promise<CompleteResult>;
} {
  const sessions = new Set<Session>();

  /** The rails of an API request: the token estimate against the cap, then the day's count. Returns the estimate. */
  function rails(messages: Array<Rec>, options: Rec): number {
    const llm = llmOf(deps);
    const tools = Array.isArray(options.tools) ? options.tools.filter(isRec) : [];
    const estimated = estimateMessages(messages) + (tools.length > 0 ? estimateTools(tools) : 0);
    const cap = typeof options.maxRequestTokens === 'number' ? options.maxRequestTokens : num(llm.maxRequestTokens);
    if (estimated > cap) {
      const err = new TokenLimitError(`request estimated at ${estimated} tokens, cap is ${cap}`);
      throw Object.assign(err, { key: 'llm.maxRequestTokens', used: estimated, cap });
    }
    if (options.countAgainstDailyCap !== false) countLlmRequest(deps.state, llm.maxRequestsPerDay, deps.now());
    return estimated;
  }

  /** The step's answer as the step loop reads an API answer, after its usage is recorded. */
  function resultOf(route: Route, answer: StepAnswer, estimated: number, options: Rec): CompleteResult {
    const { usage } = answer;
    deps.record?.({
      role: 'core',
      ...(typeof options.iface === 'string' ? { iface: options.iface } : {}),
      promptTokens: usage.prompt_tokens,
      cachedTokens: usage.prompt_tokens_details.cached_tokens,
      completionTokens: usage.completion_tokens,
      cost: 0,
    });
    log.info('subscription: step', {
      backend: route.backend,
      finish: answer.finish,
      calls: answer.calls.length,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    });
    // The shape the API client returns, since the step loop reads the calls unwrapped.
    const toolCalls = toolCallsOf(
      answer.calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.json },
      }))
    );
    const result = {
      text: answer.text,
      usage,
      estimated,
      finishReason: answer.finish,
      promptTokens: usage.prompt_tokens,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      // The archive corrects its row by these: the model and backend that answered, not the API's.
      model: route.model,
      backend: route.backend,
      source: 'subprocess',
    };
    return result;
  }

  /** Starts the run of a turn's first request and returns its first step. */
  function start(route: Route, messages: ReadonlyArray<Rec>, options: Rec): Promise<StepAnswer> {
    if (!isInstalled(deps.privateDir, route.backend))
      throw coded('not-installed', `${route.backend} is not installed in the private layer`);
    const settings = settingsOf(llmOf(deps));
    const place = subharnessPlace(deps.privateDir, route.backend);
    const { system, user } = splitFirst(messages);
    const tools = Array.isArray(options.tools) ? options.tools.filter(isRec) : [];
    fs.mkdirSync(deps.workDir, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(deps.workDir, 'turn-'));
    fs.chmodSync(dir, 0o700);
    let session: Session | null = null;
    const opened =
      tools.length === 0
        ? null
        : deps.bridge.open({
            tools,
            call: (call) =>
              session === null ? Promise.reject(coded('turn-unknown', 'no run yet')) : bridgeCall(session, call),
          });
    let server: { command: string; args: Array<string> } | null = null;
    if (opened !== null) {
      const tokenFile = path.join(dir, 'token');
      fs.writeFileSync(tokenFile, opened.token, { mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
      const { command, args, socketPath } = deps.mcp;
      server = { command, args: [...args, '--socket', socketPath, '--token-file', tokenFile] };
    }
    let args: Array<string>;
    if (route.backend === 'claude') {
      args = claudeArgs(route, system, server === null ? null : { mcpServers: { [MCP_SERVER_NAME]: server } });
    } else {
      const instructions = path.join(dir, 'instructions.md');
      fs.writeFileSync(instructions, system, { mode: 0o600 });
      args = codexArgs(route, instructions, server, settings.thinking);
    }
    const maxOutput =
      typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : num(llmOf(deps).maxOutputTokens);
    const env = childEnvOf(
      {
        ...place.env,
        ...nativeThinkingEnv(route.backend, settings.thinking),
        ...outputLimitEnv(route.backend, maxOutput > 0 ? maxOutput : undefined),
      },
      deps.hostEnv
    );
    const timeout = typeof options.timeoutMs === 'number' ? options.timeoutMs : num(llmOf(deps).timeoutMs);
    let ended: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const started: Session = {
      deps,
      sessions,
      route,
      process: deps.spawn({ binary: place.binary, args, env, stdin: user, cwd: dir }),
      closeBridge: () => opened?.close(),
      dir,
      step: null,
      entries: [],
      parked: [],
      call: null,
      final: null,
      isExhausted: false,
      texts: [],
      stepIds: [],
      hold: null,
      idle: null,
      timeoutMs: timeout > 0 ? timeout : HOLD_MS_DEFAULT,
      isOver: false,
      ended,
    };
    session = started;
    sessions.add(started);
    void markedRun(deps.privateDir, route.backend, () => done);
    log.info('subscription: run started', { backend: route.backend, tools: tools.length });
    const first = nextStep(started, options);
    void read(started);
    return first;
  }

  const sessionOf = (results: ReadonlyArray<{ id: string }>): Session | null =>
    [...sessions].find((session) => session.entries.some((entry) => results.some((one) => one.id === entry.id))) ??
    null;

  async function onRoute(messages: Array<Rec>, options: Rec): Promise<CompleteResult> {
    const results = laterStep(messages);
    const session = results === null ? null : sessionOf(results);
    const chosen = chainPathOf(options.chainRoute);
    const route = session?.route ?? chosen ?? deps.fixedPath ?? storedPath(deps.privateDir);
    if (route.kind === 'api') return deps.direct.complete(messages, options);
    const estimated = rails(messages, options);
    try {
      let answer: StepAnswer;
      if (session !== null && results !== null) answer = await resume(session, results, options);
      else if (results !== null) throw coded('subscription-lost', 'no open run holds the calls of this step');
      else answer = await start(route, messages, options);
      deps.ran?.(route.backend, 'ok');
      return resultOf(route, answer, estimated, options);
    } catch (error) {
      if (isSubscriptionFailure(error)) deps.ran?.(route.backend, runOutcomeOf(error));
      throw error;
    }
  }

  return {
    complete(messages, options = {}) {
      const asked = rec(options);
      if (asked.role !== 'core') return deps.direct.complete(messages, options);
      const list = Array.isArray(messages) ? messages.filter(isRec) : [];
      return onRoute(list, asked);
    },
  };
}

/**
 * Her core's client as the core builds it (src/core.ts): over the direct client, with the real spawn, clock and timers,
 * the MCP server `bin/neptunia-mcp.ts` under the root, the core socket under the data folder, and a bridge whose tokens
 * are 32 random bytes. `serve` routes one connection of the core socket (src/subharness/tool-bridge.ts, `routeTurnLink`).
 */
export function coreSubscription<TDirect extends SubscriptionClientDeps['direct']>(deps: {
  direct: TDirect;
  paths: { privateDir: string; rootDir: string; dataDir: string };
  hot: { config: unknown };
  state: SubscriptionClientDeps['state'];
  usage: { record(entry: UsageEntry): void };
  /** Where each step's outcome is kept for the header, under the role `core`. */
  logins?: Pick<LoginState, 'ran'>;
}): { llm: TDirect; serve(transport: Transport, other: (transport: Transport) => void): void } {
  const bridge = createToolBridge({ token: () => randomBytes(32).toString('hex') });
  const { paths, hot, usage } = deps;
  const client = createSubscriptionClient({
    privateDir: paths.privateDir,
    direct: deps.direct,
    bridge,
    spawn: spawnSubscriptionChild,
    mcp: {
      command: process.execPath,
      args: [path.join(paths.rootDir, 'bin', 'neptunia-mcp.ts')],
      socketPath: coreSocketPath(paths.dataDir),
    },
    workDir: path.join(os.tmpdir(), 'neptunia-turns'),
    getConfig: () => ({ llm: rec(rec(hot.config).llm) }),
    state: deps.state,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
    // The handles are the ones setTimer above made.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    record: (entry) => usage.record(entry),
    ran: (backend, outcome) => deps.logins?.ran('core', backend, outcome),
  });
  return {
    llm: { ...deps.direct, complete: (messages, options) => client.complete(messages, options) },
    serve: (transport, other) => routeTurnLink(transport, bridge, other),
  };
}
