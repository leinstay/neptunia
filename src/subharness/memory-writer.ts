// Her memory writer through a subharness: the memory session's one request (src/memory/db/session.ts) as one run of
// `claude -p` or `codex exec` installed in the private layer (src/subharness/place.ts), with no tools, the session's
// system text in place of the backend's own and the answer read by the same `parseSessionAnswer`. Nothing else of the
// writer changes. `memoryWriterClient` is the model client of every memory-role request, the session's, the description
// review's and the bind merge's: at every call it reads the path in config.json (src/subharness/memory-path.ts) and
// sends the request either to the direct client or through the backend, or takes the route the chain client chose
// (`chainRoute`). A run that
// fails rejects with an Error whose `code` says why, `not-logged-in` when claude asks for a login, which the sweep records
// as it records a failed request. The child gets the backend's home and the plain variables of `childEnvOf`, never a key
// of the core. Native thinking follows `llm.subscription.thinking` as in her turns (src/subharness/thinking.ts). Log lines carry the backend, the exit code and the tokens, never the text. `memoryCapabilities` says where a path differs from the direct
// one. Claude 2.1.317 enforces `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (measured 2026-11-05: with 20 a run ended `is_error` at 80
// output tokens, with none 436 at `end_turn`), so the cap goes there. Codex 0.164.0 has no such control, so its gap is
// reported, and nothing trims the answer instead.

import fs from 'node:fs';
import nodePath from 'node:path';
import { childEnvOf, outputLimitEnv, tokensOf } from '../agent-runner/backend.ts';
import { isListedEffort } from '../llm/roles.ts';
import { log } from '../log.ts';
import type { Completion, SessionContext } from '../memory/db/session.ts';
import type { MemoryBackend } from './routing.ts';
import type { UsageEntry } from '../tools/operations/usage.ts';
import { markedRun } from './activity.ts';
import { LOGIN_FAILURE, runOutcomeOf } from './login-state.ts';
import type { RunOutcome } from './login-state.ts';
import { memoryPath } from './memory-path.ts';
import type { MemoryPath, SubharnessMemoryPath } from './memory-path.ts';
import { isInstalled, subharnessPlace } from './place.ts';
import { nativeThinkingCodexArgs, nativeThinkingEnv } from './thinking.ts';

/** The shape of codex's final message (`--output-schema`): the whole answer the request's prompt asks for, thinking and tags included, as one string. */
export const MEMORY_ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

/** One child process the writer starts. */
export type ChildRun = {
  binary: string;
  args: Array<string>;
  env: Record<string, string>;
  stdin: string;
  cwd: string;
  timeoutMs: number;
};
/** What it came to; `error` when it did not run to its own end (`timeout`, `spawn`, `backend-missing`). */
export type ChildOutcome = { exitCode: number | null; stdout: string; stderr: string; error?: string };
export type ChildRunner = (run: ChildRun) => Promise<ChildOutcome>;

export type MemoryWriterDeps = {
  privateDir: string;
  /** The core passes the child runner of src/agent-runner/backend.ts (process group, timeout kill); a test a recorder. */
  runChild: ChildRunner;
  /** The run's working directory; the codex schema file and final-message file go into a fresh folder inside it, removed after the run. */
  workDir: string;
  /**
   * Whether the run keeps the model's native thinking, read at each run: `llm.subscription.thinking`
   * (src/subharness/thinking.ts). Absent, the run has it off, as the setting's default does.
   */
  thinking?: () => boolean;
};

/** How the writer's run on a backend compares with the direct request, whose limit and system text the request enforces. */
export type MemoryCapabilities = {
  systemPrompt: 'replaced' | 'prefixed';
  tools: 'none' | 'read-only-sandbox';
  usage: 'split' | 'total-only';
  maxOutputTokens: 'enforced' | 'gap';
};

const CAPABILITIES: Readonly<Record<MemoryBackend, MemoryCapabilities>> = {
  claude: { systemPrompt: 'replaced', tools: 'none', usage: 'split', maxOutputTokens: 'enforced' },
  // codex keeps its own instructions and a shell in its sandbox; the system text arrives first on its stdin.
  codex: { systemPrompt: 'prefixed', tools: 'read-only-sandbox', usage: 'total-only', maxOutputTokens: 'gap' },
};

export function memoryCapabilities(backend: MemoryBackend): MemoryCapabilities {
  return CAPABILITIES[backend];
}

/** The controls of the direct path that `backend` lacks, by name. */
export function memoryGaps(backend: MemoryBackend): Array<string> {
  return Object.entries(CAPABILITIES[backend])
    .filter(([, value]) => value === 'gap')
    .map(([name]) => name);
}

/** The wait of a run whose caller gave none: the default of `memoryDb.session.timeoutMs`. */
const FALLBACK_TIMEOUT_MS = 300_000;

/** An Error the sweep reads the code of. */
const refusal = (code: string): Error => Object.assign(new Error(`memory writer: ${code}`), { code });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A count of the envelope's usage, 0 when absent or no number. */
const count = (usage: Record<string, unknown>, key: string): number => {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/** The JSON object of a text, or null. */
function objectOf(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * claude: the system text as one `--system-prompt` argument. Linux caps one argument at 128 KiB (MAX_ARG_STRLEN); her
 * session's system text is far below it.
 */
function claudeArgs(path: SubharnessMemoryPath, system: string): Array<string> {
  return [
    '-p',
    '--system-prompt',
    system,
    '--tools',
    '',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    path.model,
    ...(path.effort === null ? [] : ['--effort', path.effort]),
  ];
}

/** codex: read-only whatever the agents' modes are, the answer schema and the final-message file. */
function codexArgs(path: SubharnessMemoryPath, schemaFile: string, outFile: string, thinking: boolean): Array<string> {
  return [
    'exec',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--output-schema',
    schemaFile,
    '-o',
    outFile,
    '-m',
    path.model,
    ...(path.effort === null ? [] : ['-c', `model_reasoning_effort=${path.effort}`]),
    ...nativeThinkingCodexArgs(thinking),
  ];
}

/** The JSON objects of claude's stream, one per line; a line that is no object is skipped. */
function streamOf(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').flatMap((line) => {
    const object = line.trim() === '' ? null : objectOf(line.trim());
    return object === null ? [] : [object];
  });
}

/** The `result` line that ends claude's stream, a stdout of one object taken as that line; else null. */
const envelopeOf = (stream: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null =>
  stream.findLast((line) => line.type === 'result') ?? (stream.length === 1 ? stream[0] : null);

/**
 * The text of every assistant message in the stream, in order. A run cut at `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is resumed
 * by claude itself in a new message that picks up mid-thought, and `result` holds only that last message, so the
 * answer is the texts joined. Null when the stream carries no assistant message.
 */
function assistantText(stream: ReadonlyArray<Record<string, unknown>>): string | null {
  const messages = stream.filter((line) => line.type === 'assistant' && isRecord(line.message));
  if (messages.length === 0) return null;
  return messages
    .flatMap((line): Array<unknown> => {
      const content: unknown = isRecord(line.message) ? line.message.content : null;
      return Array.isArray(content) ? (content as Array<unknown>) : [];
    })
    .map((part: unknown) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** Whether claude's run failed for want of a login: an error envelope or a failed exit whose text asks for one. */
function loginLost(outcome: ChildOutcome): boolean {
  const envelope = envelopeOf(streamOf(outcome.stdout));
  const failed = outcome.exitCode !== 0 || envelope?.is_error === true;
  return failed && LOGIN_FAILURE.test(`${outcome.stdout}\n${outcome.stderr}`);
}

/** The completion of claude's stream: the text of its assistant messages, else its `result`, and its tokens. */
function claudeCompletion(stdout: string): Completion {
  const stream = streamOf(stdout);
  const envelope = envelopeOf(stream);
  if (envelope === null || envelope.is_error === true) throw refusal('backend-error');
  // The answer of a refused or cut run is no memory block: the sweep keeps its cursor and applies nothing.
  if (envelope.stop_reason === 'refusal') throw refusal('model-refused');
  if (envelope.stop_reason === 'max_tokens') throw refusal('output-truncated');
  const text = assistantText(stream) ?? (typeof envelope.result === 'string' ? envelope.result : '');
  if (text.trim() === '') throw refusal('empty-answer');
  const usage = isRecord(envelope.usage) ? envelope.usage : {};
  const cached = count(usage, 'cache_read_input_tokens');
  return {
    text,
    usage: {
      prompt_tokens: count(usage, 'input_tokens') + count(usage, 'cache_creation_input_tokens') + cached,
      completion_tokens: count(usage, 'output_tokens'),
      prompt_tokens_details: { cached_tokens: cached },
    },
  };
}

/** The completion of codex's final message: its `answer`, else the message as it is; the one total it printed. */
function codexCompletion(final: string, outcome: ChildOutcome): Completion {
  const message = objectOf(final.trim());
  const text = message !== null && typeof message.answer === 'string' ? message.answer : final.trim();
  if (text.trim() === '') throw refusal('empty-answer');
  const total = tokensOf(`${outcome.stderr}\n${outcome.stdout}`);
  return {
    text,
    usage: { prompt_tokens: 0, completion_tokens: 0, ...(total === undefined ? {} : { total_tokens: total }) },
  };
}

/** One run of the writer through `path`. Resolves the completion the sweep reads; rejects with an Error whose `code` says why. */
export async function runMemoryWriter(
  path: SubharnessMemoryPath,
  input: { system: string; user: string; timeoutMs: number; maxOutputTokens?: number },
  deps: MemoryWriterDeps
): Promise<Completion> {
  const ran = { backend: path.backend, model: path.model };
  if (!isInstalled(deps.privateDir, path.backend)) throw Object.assign(refusal('not-installed'), ran);
  const place = subharnessPlace(deps.privateDir, path.backend);
  fs.mkdirSync(deps.workDir, { recursive: true });
  const dir = fs.mkdtempSync(nodePath.join(deps.workDir, 'memory-'));
  try {
    const schemaFile = nodePath.join(dir, 'schema.json');
    const outFile = nodePath.join(dir, 'final.txt');
    const codex = path.backend === 'codex';
    const thinking = deps.thinking?.() ?? false;
    if (codex) fs.writeFileSync(schemaFile, JSON.stringify(MEMORY_ANSWER_SCHEMA));
    const outcome = await markedRun(deps.privateDir, path.backend, () =>
      deps.runChild({
        binary: place.binary,
        args: codex ? codexArgs(path, schemaFile, outFile, thinking) : claudeArgs(path, input.system),
        env: childEnvOf({
          ...place.env,
          ...nativeThinkingEnv(path.backend, thinking),
          ...outputLimitEnv(path.backend, input.maxOutputTokens),
        }),
        stdin: codex ? `${input.system}\n\n${input.user}` : input.user,
        cwd: dir,
        timeoutMs: input.timeoutMs,
      })
    );
    log.info('memory writer: subharness run', {
      backend: path.backend,
      exitCode: outcome.exitCode,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (outcome.error !== undefined) throw refusal(outcome.error);
    if (!codex && loginLost(outcome)) throw refusal('not-logged-in');
    if (outcome.exitCode !== 0) throw refusal(`exit-${outcome.exitCode ?? 'signal'}`);
    if (!codex) return { ...claudeCompletion(outcome.stdout), ...ran, source: 'subprocess' };
    let final = '';
    try {
      final = fs.readFileSync(outFile, 'utf8');
    } catch {
      // no final message: the answer is empty
    }
    return { ...codexCompletion(final, outcome), ...ran, source: 'subprocess' };
  } catch (error) {
    // The sweep records the path that failed, whichever step refused it.
    throw Object.assign(error as Error, ran);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The text of a message's content: a string, or its text parts joined in order (a `cacheSegment` mark is dropped). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
}

/** The system text and the user content of a request's messages. */
function splitMessages(messages: ReadonlyArray<Record<string, unknown>>): { system: string; user: string } {
  const of = (role: string): string =>
    messages
      .filter((message) => message.role === role)
      .map((message) => textOf(message.content))
      .join('\n\n');
  return { system: of('system'), user: of('user') };
}

/** The route of the chain client's `chainRoute` (src/llm/chain-client.ts) as a path, null for a request without one. */
function chainPathOf(value: unknown): MemoryPath | null {
  if (!isRecord(value)) return null;
  if (value.via === 'api') return { kind: 'direct' };
  const backend = value.backend === 'claude' || value.backend === 'codex' ? value.backend : null;
  if (value.via !== 'harness' || backend === null || typeof value.model !== 'string') return null;
  return {
    kind: 'subharness',
    backend,
    model: value.model,
    effort: isListedEffort(value.effort) ? value.effort : null,
  };
}

/**
 * The memory role's model client: the direct client or the subharness, by the path in config.json at each call. Every
 * request of the role takes the path: the sweep's (purpose `memory-session`), the description review's draft and check
 * (src/memory/db/describe.ts) and the bind merge's description join (src/memory/db/person-bind.ts).
 */
export function memoryWriterClient(deps: {
  writer: MemoryWriterDeps;
  direct: SessionContext['llm'];
  /** The usage store's `record`: called for a subharness run, never for a direct one (the `llm: usage` line counts that). */
  record?: (entry: UsageEntry) => void;
  /** Called once per refused run on either path, before the rejection reaches the sweep: the memory probe runs at once. */
  onRefused?: () => void;
  /** Told what each run of the subharness path came to, for the header's login state (src/subharness/login-state.ts). */
  ran?: (backend: SubharnessMemoryPath['backend'], outcome: RunOutcome) => void;
  /** The path of each call in place of config.json's, for a paid script whose `--memory` flag replaces the role (scripts/lib/script-routes.ts). */
  path?: () => MemoryPath;
}): SessionContext['llm'] {
  const { writer, direct, record, onRefused, ran } = deps;
  async function told<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      onRefused?.();
      throw error;
    }
  }
  return {
    complete(messages, options) {
      return told(async () => {
        const path = chainPathOf(options.chainRoute) ?? deps.path?.() ?? memoryPath(writer.privateDir);
        if (path.kind === 'direct') return direct.complete(messages, options);
        const timeout = Number(options.timeoutMs);
        let completion: Completion;
        try {
          completion = await runMemoryWriter(
            path,
            {
              ...splitMessages(messages),
              timeoutMs: timeout > 0 ? timeout : FALLBACK_TIMEOUT_MS,
              ...(typeof options.maxOutputTokens === 'number' ? { maxOutputTokens: options.maxOutputTokens } : {}),
            },
            writer
          );
        } catch (error) {
          ran?.(path.backend, runOutcomeOf(error));
          throw error;
        }
        ran?.(path.backend, 'ok');
        const { usage } = completion;
        record?.({
          role: 'memory',
          // A backend that prints one total counts it as input, where it inflates nothing the writer wrote.
          promptTokens: usage?.prompt_tokens || usage?.total_tokens || 0,
          cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          cost: 0,
        });
        return completion;
      });
    },
  };
}
