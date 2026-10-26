// The offline model of tools/replay.mjs (`--answers-dir <dir>`): for every request to an
// Anthropic model the tool writes the request to a file and waits for the answer in another,
// instead of calling OpenRouter. An outside agent reads `req-<n>.md` and writes `ans-<n>.txt`.
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
// Numbers count the run's Anthropic requests from 1, zero-padded to 3. Requests to other models
// are not touched. A directory that holds files of an earlier run is refused.

import fs from 'node:fs';
import path from 'node:path';
import { toolCallsOf } from '../../src/llm/openrouter.js';

export const ANSWERS_POLL_MS = 2000;
export const ANSWERS_TIMEOUT_MIN = 20;
export const ANSWERS_SOURCE = 'answers-dir';

/** Whether `model` is served by the answerer (`anthropic/claude-*`). */
export function isAnthropicModel(model) {
  return typeof model === 'string' && model.startsWith('anthropic/claude-');
}

/** The text of one message content: a string, or content parts joined with a newline. */
export function contentText(content) {
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
export function renderRequest({ model, purpose = null, messages, tools = null, toolChoice = null }) {
  const parts = [`model: ${model}`, `purpose: ${purpose ?? 'none'}`, ''];
  for (const message of messages ?? []) {
    parts.push(`## ${message?.role ?? 'user'}`, '', contentText(message?.content), '');
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      parts.push(
        '### tool calls',
        '',
        ...message.tool_calls.map((call) =>
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
export function requestJson({ model, purpose = null, messages, tools = null, toolChoice = null }) {
  const list = messages ?? [];
  const system = list.filter((m) => m?.role === 'system').map((m) => contentText(m.content));
  return (
    JSON.stringify(
      {
        model,
        purpose: purpose ?? null,
        system: system.length > 0 ? system.join('\n\n') : null,
        messages: list
          .filter((m) => m?.role !== 'system')
          .map((m) => ({
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

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const pad = (n) => String(n).padStart(3, '0');

/**
 * @param {{ dir: string, timeoutMin?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number, estimate?: (messages: object[]) => number }} options
 */
export function createAnswersDir({
  dir,
  timeoutMin = ANSWERS_TIMEOUT_MIN,
  pollMs = ANSWERS_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  estimate = () => 0,
}) {
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
  async function answer(model, messages, options = {}) {
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
    let toolCalls = null;
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
  function finish(code) {
    writeAtomic(path.join(dir, 'done'), `exit ${code}\n`);
  }

  return { answer, finish, dir, count: () => count };
}

/**
 * `createLlm` that routes Anthropic models to `answers` and everything else to the real client.
 * @param {Function} createLlm
 * @param {{ answer: Function }} answers
 * @param {(config: object, purpose?: string) => string} modelOf  The model a request without `model` uses.
 * @param {{ firstOnly?: boolean }} [opts]  firstOnly: only a turn's first answer goes to the files; a tool-loop
 *   step continuing it (its task text says so, labels task.continue*) goes to the real model.
 */
/** A tool-loop step's task text (labels task.continue*): the engine re-renders the turn as one user message. */
const CONTINUED_RE = /This is the same (inner )?turn, continued after/;

export function withAnswersDir(createLlm, answers, modelOf, { firstOnly = false } = {}) {
  return (deps) => {
    const real = createLlm(deps);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'complete') {
          return (messages, options = {}) => {
            const model = options.model ?? modelOf(deps.getConfig(), options.purpose);
            const continued =
              firstOnly &&
              Array.isArray(messages) &&
              messages.some((m) => m?.role === 'assistant' || CONTINUED_RE.test(contentText(m?.content)));
            return isAnthropicModel(model) && !continued
              ? answers.answer(model, messages, options)
              : target.complete(messages, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}
