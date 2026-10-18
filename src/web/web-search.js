// The web agent's search command (bin/web-search.mjs, run from the agent's
// shell as `web-search <query> [--count N]` through agents/web/bin/web-search):
// OpenCode v1.19.3 offers its own `websearch` tool only with Exa or Parallel
// switched on directly, and Exa is used only through OpenRouter here. So the
// agent searches with one OpenRouter chat completion carrying the web plugin
// on Exa, built the way the lookup's `openrouter` engine builds its request
// (src/web/lookup.js#webSearchPlugins), and reads the results from the
// answer's `url_citation` annotations (src/web/lookup.js#urlCitations),
// printed as plain numbered lines: title, URL, one-line snippet
// (src/web/lookup.js#renderResults). The answer's own text is never printed.
//
// The key is the task's OpenRouter key the runner already gives the OpenCode
// child (OPENROUTER_API_KEY, the agents' key, never the persona's); the model
// is the one the runner reads from the live config at each task
// (webSearchModel: the `reasoner` role for `search-summary`, the lookup's
// model) and passes as NEPTUNIA_WEB_SEARCH_MODEL. A failure prints one
// `web-search: <code>` line on stderr and a non-zero exit; neither the key nor
// a response body is ever printed. Pure but for `fetchImpl`.

import { roleModel } from '../llm/roles.js';
import { apiUrl, openRouterHeaders } from '../llm/openrouter.js';
import { clampText } from '../memory/clamp.js';
import { cleanQuery, renderResults, urlCitations, webSearchPlugins } from './lookup.js';

/** The environment variable the runner passes the search model in (src/agent-runner/opencode.js). */
export const WEB_SEARCH_MODEL_ENV = 'NEPTUNIA_WEB_SEARCH_MODEL';
/** The results asked for when `--count` is not given. */
export const DEFAULT_COUNT = 8;
/** OpenRouter's API, where the agent's key is valid (the runner sends it past the proxy: NO_PROXY). */
const BASE_URL = 'https://openrouter.ai/api/v1';
/** The answer's own length: its text is never read, only its annotations. */
const REPLY_TOKENS = 256;
/** The longest wait for the one request (ms). */
const TIMEOUT_MS = 45_000;
/** A snippet's length in characters. */
const SNIPPET_CHARS = 240;
/** Exit codes: found, a failure of the search, a wrong command line or setup. */
const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

/**
 * The model the web agent searches with in `config` (the live engine config): the lookup's,
 * `roles.reasoner` for the `search-summary` purpose (src/llm/roles.js#roleModel).
 * @param {object} config
 * @returns {string}
 */
export function webSearchModel(config) {
  return roleModel(config, 'reasoner', 'search-summary');
}

/**
 * The command line: the words that are not options make the query (cleaned as the lookup cleans
 * one: src/web/lookup.js#cleanQuery); `--count N`, `--count=N` or `-n N` the number of results
 * (1..10 when sent). `{ error: 'no-query' }` without a query, `{ error: 'bad-count' }` for a count
 * that is not a whole positive number, `{ error: 'bad-option' }` for any other option.
 * @param {string[]} argv
 * @returns {{ query: string, count: number } | { error: string }}
 */
export function parseSearchArgs(argv) {
  const words = [];
  let count = DEFAULT_COUNT;
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    let value = null;
    if (arg === '--count' || arg === '-n') {
      value = list[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--count=')) {
      value = arg.slice('--count='.length);
    } else if (arg === '--') {
      words.push(...list.slice(i + 1));
      break;
    } else if (arg.startsWith('-') && arg.length > 1) {
      return { error: 'bad-option' };
    } else {
      words.push(arg);
      continue;
    }
    if (!/^\d+$/.test(value) || Number(value) < 1) return { error: 'bad-count' };
    count = Number(value);
  }
  const query = cleanQuery(words.join(' '));
  if (!query) return { error: 'no-query' };
  return { query, count };
}

/**
 * The chat-completions body of one search: the query as the only message, the web plugin on Exa
 * with `max_results` = `count` clamped to 1..10, a short answer.
 * @param {{ query: string, count: number, model: string }} request
 * @returns {object}
 */
export function buildSearchRequest({ query, count, model }) {
  return {
    model,
    messages: [{ role: 'user', content: query }],
    max_tokens: REPLY_TOKENS,
    plugins: webSearchPlugins(count, DEFAULT_COUNT),
  };
}

/**
 * The results of an answer (the parsed chat-completions JSON): its first choice's `url_citation`
 * annotations as `{ title, url, snippet }`, each url once, the snippet one line of at most
 * SNIPPET_CHARS cut on a clean boundary. An answer without annotations gives [].
 * @param {unknown} json
 * @returns {{ title: string, url: string, snippet: string }[]}
 */
export function searchResults(json) {
  const annotations = json?.choices?.[0]?.message?.annotations;
  return urlCitations(annotations).map((result) => ({ ...result, snippet: clampText(result.snippet, SNIPPET_CHARS, { tolerance: 1 }) }));
}

/**
 * The results as the command prints them: numbered blocks of title, URL and snippet
 * (src/web/lookup.js#renderResults), a final newline; '' for none.
 * @param {{ title: string, url: string, snippet: string }[]} results
 * @returns {string}
 */
export function formatResults(results) {
  return results.length ? `${renderResults(results)}\n` : '';
}

/**
 * One run of the command: `{ code, stdout, stderr }`, never throws. stderr is one
 * `web-search: <code>` line on a failure: `no-query`, `bad-count`, `bad-option` (exit 2),
 * `no-key` (no OPENROUTER_API_KEY, exit 2), `http-<status>`, `timeout`, `network`, `bad-answer`
 * (not JSON, or an error inside it) or `no-results` (exit 1).
 * @param {{ argv: string[], env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runWebSearch({ argv, env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const fail = (code, reason) => ({ code, stdout: '', stderr: `web-search: ${reason}\n` });
  const parsed = parseSearchArgs(argv);
  if (parsed.error) return fail(EXIT.usage, parsed.error);
  const apiKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  if (!apiKey) return fail(EXIT.usage, 'no-key');
  const given = typeof env[WEB_SEARCH_MODEL_ENV] === 'string' ? env[WEB_SEARCH_MODEL_ENV].trim() : '';
  const model = given || webSearchModel({});
  const body = buildSearchRequest({ ...parsed, model });

  let response;
  try {
    response = await fetchImpl(apiUrl(BASE_URL, 'chat/completions'), {
      method: 'POST',
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(EXIT.failed, err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');
  }
  if (!response?.ok) return fail(EXIT.failed, `http-${response?.status ?? 'unknown'}`);
  let json;
  try {
    json = await response.json();
  } catch {
    return fail(EXIT.failed, 'bad-answer');
  }
  if (!json || typeof json !== 'object' || json.error) return fail(EXIT.failed, 'bad-answer');
  const results = searchResults(json);
  if (!results.length) return fail(EXIT.failed, 'no-results');
  return { code: EXIT.ok, stdout: formatResults(results), stderr: '' };
}
