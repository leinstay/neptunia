// Her memory writer through a subharness: the memory session's one request (src/memory/db/session.ts) as one run of
// `claude -p` or `codex exec` installed in the private layer (src/subharness/place.ts), with no tools, the session's
// system text in place of the backend's own and the answer read by the same `parseSessionAnswer`. Nothing else of the
// writer changes. `memoryWriterClient` is the session's model client: at every call it reads the path in keys.json
// (src/subharness/memory-path.ts) and sends the request either to the direct client or through the backend. A run that
// fails rejects with an Error whose `code` says why, which the sweep records as it records a failed request. The child
// gets the backend's home and the plain variables of `childEnvOf`, never a key of the core. Log lines carry the
// backend, the exit code and the tokens, never the text.

import fs from 'node:fs';
import nodePath from 'node:path';
import { childEnvOf, outputLimitEnv, tokensOf } from '../agent-runner/backend.ts';
import { log } from '../log.ts';
import { SESSION_PURPOSE } from '../memory/db/session.ts';
import type { Completion, SessionContext } from '../memory/db/session.ts';
import type { UsageEntry } from '../tools/impl/usage.ts';
import { markedRun } from './activity.ts';
import { memoryPath } from './memory-path.ts';
import type { SubharnessMemoryPath } from './memory-path.ts';
import { isInstalled, subharnessPlace } from './place.ts';

/** The shape of codex's final message (`--output-schema`): the whole answer the memory-session prompt asks for, thinking and `<memory>` block included, as one string. */
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
};

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
    'json',
    '--model',
    path.model,
    ...(path.effort === null ? [] : ['--effort', path.effort]),
  ];
}

/** codex: read-only whatever the agents' modes are, the answer schema and the final-message file. */
function codexArgs(path: SubharnessMemoryPath, schemaFile: string, outFile: string): Array<string> {
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
  ];
}

/** The completion of claude's JSON envelope: its `result` and its tokens. */
function claudeCompletion(stdout: string): Completion {
  const envelope = objectOf(stdout.trim());
  if (envelope === null || envelope.is_error === true) throw refusal('backend-error');
  const text = typeof envelope.result === 'string' ? envelope.result : '';
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

/** The completion of codex's final message: its `answer`, else the message as it is; the tokens it printed. */
function codexCompletion(final: string, outcome: ChildOutcome): Completion {
  const message = objectOf(final.trim());
  const text = message !== null && typeof message.answer === 'string' ? message.answer : final.trim();
  if (text.trim() === '') throw refusal('empty-answer');
  return {
    text,
    usage: { prompt_tokens: 0, completion_tokens: tokensOf(`${outcome.stderr}\n${outcome.stdout}`) ?? 0 },
  };
}

/** One run of the writer through `path`. Resolves the completion the sweep reads; rejects with an Error whose `code` says why. */
export async function runMemoryWriter(
  path: SubharnessMemoryPath,
  input: { system: string; user: string; timeoutMs: number; maxOutputTokens?: number },
  deps: MemoryWriterDeps
): Promise<Completion> {
  if (!isInstalled(deps.privateDir, path.backend)) throw refusal('not-installed');
  const place = subharnessPlace(deps.privateDir, path.backend);
  fs.mkdirSync(deps.workDir, { recursive: true });
  const dir = fs.mkdtempSync(nodePath.join(deps.workDir, 'memory-'));
  try {
    const schemaFile = nodePath.join(dir, 'schema.json');
    const outFile = nodePath.join(dir, 'final.txt');
    const codex = path.backend === 'codex';
    if (codex) fs.writeFileSync(schemaFile, JSON.stringify(MEMORY_ANSWER_SCHEMA));
    const outcome = await markedRun(deps.privateDir, path.backend, () =>
      deps.runChild({
        binary: place.binary,
        args: codex ? codexArgs(path, schemaFile, outFile) : claudeArgs(path, input.system),
        env: childEnvOf({ ...place.env, ...outputLimitEnv(path.backend, input.maxOutputTokens) }),
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
    if (outcome.exitCode !== 0) throw refusal(`exit-${outcome.exitCode ?? 'signal'}`);
    const ran = { model: path.model, backend: path.backend, source: 'subprocess' };
    if (!codex) return { ...claudeCompletion(outcome.stdout), ...ran };
    let final = '';
    try {
      final = fs.readFileSync(outFile, 'utf8');
    } catch {
      // no final message: the answer is empty
    }
    return { ...codexCompletion(final, outcome), ...ran };
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

/**
 * The session's model client: the direct client or the subharness, by the path in keys.json at each call. Only the
 * sweep's request (purpose `memory-session`) can take the subharness path; the description review stays direct.
 */
export function memoryWriterClient(deps: {
  writer: MemoryWriterDeps;
  direct: SessionContext['llm'];
  /** The usage store's `record`: called for a subharness run, never for a direct one (the `llm: usage` line counts that). */
  record?: (entry: UsageEntry) => void;
  /** Called once per refused run on either path, before the rejection reaches the sweep: the memory probe runs at once. */
  onRefused?: () => void;
}): SessionContext['llm'] {
  const { writer, direct, record, onRefused } = deps;
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
      if (options.purpose !== SESSION_PURPOSE) return direct.complete(messages, options);
      return told(async () => {
        const path = memoryPath(writer.privateDir);
        if (path.kind === 'direct') return direct.complete(messages, options);
        const timeout = Number(options.timeoutMs);
        const completion = await runMemoryWriter(
          path,
          {
            ...splitMessages(messages),
            timeoutMs: timeout > 0 ? timeout : FALLBACK_TIMEOUT_MS,
            ...(typeof options.maxOutputTokens === 'number' ? { maxOutputTokens: options.maxOutputTokens } : {}),
          },
          writer
        );
        record?.({
          role: 'memory',
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          cost: 0,
        });
        return completion;
      });
    },
  };
}
