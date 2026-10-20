// The offline model of tools/replay.mjs (`--answers-dir <dir>`): for every request to an
// Anthropic model the tool writes the request to a file and waits for the answer in another,
// instead of calling OpenRouter. An outside agent reads `req-<n>.md` and writes `ans-<n>.txt`.
//
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
export function renderRequest({ model, purpose = null, messages }) {
  const parts = [`model: ${model}`, `purpose: ${purpose ?? 'none'}`, ''];
  for (const message of messages ?? []) {
    parts.push(`## ${message?.role ?? 'user'}`, '', contentText(message?.content), '');
  }
  return parts.join('\n');
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
export function createAnswersDir({ dir, timeoutMin = ANSWERS_TIMEOUT_MIN, pollMs = ANSWERS_POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, estimate = () => 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const stale = fs.readdirSync(dir).filter((name) => /^(req-\d+\.md|ans-\d+\.txt|done)$/.test(name));
  if (stale.length > 0) throw new Error(`answers-dir: ${dir} holds files of an earlier run (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', ...' : ''}); use an empty directory`);
  let count = 0;

  /** Write the request, wait for the answer; resolves in the shape of the llm client's `complete`. */
  async function answer(model, messages, options = {}) {
    count += 1;
    const id = pad(count);
    const reqFile = path.join(dir, `req-${id}.md`);
    const ansFile = path.join(dir, `ans-${id}.txt`);
    writeAtomic(reqFile, renderRequest({ model, purpose: options?.purpose ?? null, messages }));
    const deadline = now() + timeoutMin * 60_000;
    for (;;) {
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error('request aborted');
      if (fs.existsSync(ansFile)) break;
      if (now() >= deadline) throw new Error(`answers-dir: no ans-${id}.txt within ${timeoutMin} min`);
      await sleep(pollMs);
    }
    const text = fs.readFileSync(ansFile, 'utf8');
    const promptTokens = estimate(messages);
    return {
      text,
      usage: { prompt_tokens: promptTokens, completion_tokens: 0, cost: 0, source: ANSWERS_SOURCE },
      estimated: promptTokens,
      finishReason: 'stop',
      provider: ANSWERS_SOURCE,
      promptTokens,
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
 */
export function withAnswersDir(createLlm, answers, modelOf) {
  return (deps) => {
    const real = createLlm(deps);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'complete') {
          return (messages, options = {}) => {
            const model = options.model ?? modelOf(deps.getConfig(), options.purpose);
            return isAnthropicModel(model) ? answers.answer(model, messages, options) : target.complete(messages, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}
