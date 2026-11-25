// The offline model of scripts/replay.ts (`--answers-dir <dir>`): for every request, of any role and model, the tool
// writes the request to a file and waits for the answer in another, instead of calling a provider or a harness
// (`offlineCore`, which scripts/lib/script-routes.ts puts in place of every client). An outside agent reads
// `req-<n>.md` and writes `ans-<n>.txt`.
//
//   <dir>/req-001.json the same request for machines, written first: { model, purpose, system, messages:
//                      [{ role, content }] } with the exact strings (system = the system messages joined
//                      with a blank line, null when there is none; messages = the others in order)
//   (a request with native tools also has `tools` and `toolChoice` in req-001.json and a `## tools` section in the .md;
//    an assistant message with tool calls keeps `tool_calls`, a tool message its `tool_call_id`)
//   <dir>/ans-001.tool-calls.json  optional: [{ id?, name, arguments }] (arguments an object or a string), the answer's tool calls
//   <dir>/req-001.md   model: <id>, purpose: <purpose|none>, then every message in order under
//                      `## system` / `## user` / `## assistant` headings, verbatim (content parts
//                      joined with a newline; an image part is the line `[image]`)
//   <dir>/ans-001.txt  the model's text, written by the answerer (write a temp file, then rename)
//   <dir>/done         written when the run ends: `exit <code>`
//
// Numbers count the run's answered requests from 1, zero-padded to 3. A directory that holds files of an earlier run
// is refused.

import fs from 'node:fs';
import path from 'node:path';
import { toolCallsOf } from '../../src/llm/openrouter.ts';
import type { CompleteResult } from '../../src/llm/openrouter.ts';
import type { Untyped } from '../../src/tools/types.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

export const ANSWERS_POLL_MS = 2000;
export const ANSWERS_TIMEOUT_MIN = 20;
export const ANSWERS_SOURCE = 'answers-dir';

/** The text of one message content: a string, or content parts joined with a newline. */
export function contentText(content: Untyped): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return String(part.text ?? '');
      if (part && typeof part.type === 'string') return '[image]';
      return '';
    })
    .join('\n');
}

/** The body of `req-<n>.md`. */
export function renderRequest({ model, purpose = null, messages, tools = null, toolChoice = null }: Rec): string {
  const parts = [`model: ${model}`, `purpose: ${purpose ?? 'none'}`, ''];
  for (const message of messages ?? []) {
    parts.push(`## ${message?.role ?? 'user'}`, '', contentText(message?.content), '');
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      parts.push(
        '### tool calls',
        '',
        ...message.tool_calls.map((call: Rec) =>
          `${call?.id ?? ''} ${call?.function?.name ?? ''} ${call?.function?.arguments ?? ''}`.trim()
        ),
        ''
      );
    }
  }
  if (Array.isArray(tools) && tools.length > 0)
    parts.push('## tools', '', `tool_choice: ${toolChoice ?? 'auto'}`, '', JSON.stringify(tools, null, 2), '');
  return parts.join('\n');
}

/** The body of `req-<n>.json`: exact strings, so a reader never parses the Markdown. */
export function requestJson({ model, purpose = null, messages, tools = null, toolChoice = null }: Rec): string {
  const list = messages ?? [];
  const system = list.filter((m: Rec) => m?.role === 'system').map((m: Rec) => contentText(m.content));
  return (
    JSON.stringify(
      {
        model,
        purpose: purpose ?? null,
        system: system.length > 0 ? system.join('\n\n') : null,
        messages: list
          .filter((m: Rec) => m?.role !== 'system')
          .map((m: Rec) => ({
            role: m?.role ?? 'user',
            content: contentText(m?.content),
            ...(Array.isArray(m?.tool_calls) ? { tool_calls: m.tool_calls } : {}),
            ...(typeof m?.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
          })),
        ...(Array.isArray(tools) && tools.length > 0 ? { tools, toolChoice: toolChoice ?? 'auto' } : {}),
      },
      null,
      2
    ) + '\n'
  );
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const pad = (n: number) => String(n).padStart(3, '0');

export function createAnswersDir({
  dir,
  timeoutMin = ANSWERS_TIMEOUT_MIN,
  pollMs = ANSWERS_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  estimate = () => 0,
}: {
  dir: string;
  timeoutMin?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  estimate?: (messages: Array<Rec>) => number;
}): {
  answer: (
    model: string,
    messages: Untyped,
    options?: Untyped
  ) => Promise<{
    toolCalls?: Untyped;
    text: string;
    usage: { prompt_tokens: number; completion_tokens: number; cost: number; source: string };
    estimated: number;
    finishReason: string;
    provider: string;
    promptTokens: number;
  }>;
  finish: (code: Untyped) => void;
  dir: string;
  count: () => number;
} {
  fs.mkdirSync(dir, { recursive: true });
  const stale = fs
    .readdirSync(dir)
    .filter((name) => /^(req-\d+\.(?:md|json)|ans-\d+\.(?:txt|tool-calls\.json)|done)$/.test(name));
  if (stale.length > 0)
    throw new Error(
      `answers-dir: ${dir} holds files of an earlier run (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', ...' : ''}); use an empty directory`
    );
  let count = 0;

  /** Write the request, wait for the answer; resolves in the shape of the llm client's `complete`. */
  async function answer(model: string, messages: Untyped, options: Untyped = {}) {
    count += 1;
    const id = pad(count);
    const reqFile = path.join(dir, `req-${id}.md`);
    const ansFile = path.join(dir, `ans-${id}.txt`);
    writeAtomic(
      path.join(dir, `req-${id}.json`),
      requestJson({
        model,
        purpose: options?.purpose ?? null,
        messages,
        tools: options?.tools,
        toolChoice: options?.toolChoice,
      })
    );
    writeAtomic(
      reqFile,
      renderRequest({
        model,
        purpose: options?.purpose ?? null,
        messages,
        tools: options?.tools,
        toolChoice: options?.toolChoice,
      })
    );
    const deadline = now() + timeoutMin * 60_000;
    for (;;) {
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error('request aborted');
      if (fs.existsSync(ansFile)) break;
      if (now() >= deadline) throw new Error(`answers-dir: no ans-${id}.txt within ${timeoutMin} min`);
      await sleep(pollMs);
    }
    const text = fs.readFileSync(ansFile, 'utf8');
    const promptTokens = estimate(messages);
    // Optional native tool calls of the answer, read only for a request that had tools.
    const callsFile = path.join(dir, `ans-${id}.tool-calls.json`);
    let toolCalls: Untyped = null;
    if (Array.isArray(options?.tools) && options.tools.length > 0) {
      toolCalls = [];
      if (fs.existsSync(callsFile)) {
        const given = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
        toolCalls = toolCallsOf(
          (Array.isArray(given) ? given : []).map((call, i) => ({
            id: call?.id ?? `call_${i + 1}`,
            function: { name: call?.name, arguments: call?.arguments },
          }))
        );
      }
    }
    return {
      text,
      usage: { prompt_tokens: promptTokens, completion_tokens: 0, cost: 0, source: ANSWERS_SOURCE },
      estimated: promptTokens,
      finishReason: 'stop',
      provider: ANSWERS_SOURCE,
      promptTokens,
      ...(toolCalls ? { toolCalls } : {}),
    };
  }

  /** `<dir>/done`: the run ended with `exit <code>`. */
  function finish(code: Untyped) {
    writeAtomic(path.join(dir, 'done'), `exit ${code}\n`);
  }

  return { answer, finish, dir, count: () => count };
}

/**
 * The client that answers every request it gets from `answers`, whatever the role and the model: a paid script's
 * routing puts it in place of every provider and harness (scripts/lib/script-routes.ts, `offline`).
 * @param modelOf The model a request without `model` names in its request file, from the request's `purpose`.
 */
export function offlineCore(
  answers: Pick<ReturnType<typeof createAnswersDir>, 'answer'>,
  modelOf: (purpose: Untyped) => string | undefined
): { complete(messages: unknown, options?: unknown): Promise<CompleteResult> } {
  return {
    complete: (messages, options) => {
      const asked: Rec = typeof options === 'object' && options !== null ? options : {};
      const model = typeof asked.model === 'string' ? asked.model : (modelOf(asked.purpose) ?? '');
      return answers.answer(model, messages, asked);
    },
  };
}
