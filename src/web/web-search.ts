// The web agent's search command (agents/scout/web-search.ts, run from the agent's
// shell as `web-search <query> [--count N]` through agents/scout/bin/web-search):
// OpenCode v1.19.3 offers its own `websearch` tool only with Exa or Parallel
// switched on directly, and Exa is used only through OpenRouter here. So the
// agent searches with one OpenRouter chat completion carrying the web plugin
// on Exa, built the way the lookup's `openrouter` engine builds its request
// (src/web/lookup.ts#webSearchPlugins), and reads the results from the
// answer's `url_citation` annotations (src/web/lookup.ts#urlCitations),
// printed as plain numbered lines: title, URL, one-line snippet
// (src/web/lookup.ts#renderResults). The answer's own text is never printed.
//
// The key is the task's OpenRouter key the runner already gives the OpenCode
// child (OPENROUTER_API_KEY, the agents' key, never the persona's); the model
// is the one the runner reads from the live config at each task
// (webSearchModel: the setting `web.search.model`, the model of the
// persona's own web.search on the same engine) and passes as NEPTUNIA_WEB_SEARCH_MODEL. A failure prints one
// `web-search: <code>` line on stderr and a non-zero exit; neither the key nor
// a response body is ever printed. Pure but for `fetchImpl`.

import { errorFields } from '../error-fields.ts';
import { objOf } from '../tools/types.ts';
import { searchModel } from '../llm/roles.ts';
import { apiUrl, openRouterHeaders } from '../llm/openrouter.ts';
import { clampText } from '../memory/clamp.ts';
import { cleanQuery, renderResults, urlCitations, webSearchPlugins } from './lookup.ts';

/** The environment variable the runner passes the search model in (src/agent-runner/opencode.ts). */
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
 * The model the scout agent searches with in `config` (the live engine config): the persona's own
 * web.search's, the setting `web.search.model` (src/llm/roles.ts#searchModel).
 */
export function webSearchModel(config: unknown): string | undefined {
  return searchModel(config);
}

/**
 * The command line: the words that are not options make the query (cleaned as the lookup cleans
 * one: src/web/lookup.ts#cleanQuery); `--count N`, `--count=N` or `-n N` the number of results
 * (1..10 when sent). `{ error: 'no-query' }` without a query, `{ error: 'bad-count' }` for a count
 * that is not a whole positive number, `{ error: 'bad-option' }` for any other option.
 */
export function parseSearchArgs(argv: Array<string>): { query: string; count: number } | { error: string } {
  const words: Array<string> = [];
  let count = DEFAULT_COUNT;
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    let value: string;
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
 */
export function buildSearchRequest({
  query,
  count,
  model,
}: {
  query: string;
  count: number;
  model: string | undefined;
}): object {
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
 */
export function searchResults(json: unknown): Array<{ title: string; url: string; snippet: string }> {
  const choices = objOf(json).choices;
  const annotations = objOf(objOf(Array.isArray(choices) ? choices[0] : undefined).message).annotations;
  return urlCitations(annotations).map((result) => ({
    ...result,
    snippet: clampText(result.snippet, SNIPPET_CHARS, { tolerance: 1 }),
  }));
}

/**
 * The results as the command prints them: numbered blocks of title, URL and snippet
 * (src/web/lookup.ts#renderResults), a final newline; '' for none.
 */
export function formatResults(results: Array<{ title: string; url: string; snippet: string }>): string {
  return results.length ? `${renderResults(results)}\n` : '';
}

/**
 * One run of the command: `{ code, stdout, stderr }`, never throws. stderr is one
 * `web-search: <code>` line on a failure: `no-query`, `bad-count`, `bad-option` (exit 2),
 * `no-key` (no OPENROUTER_API_KEY, exit 2), `http-<status>`, `timeout`, `network`, `bad-answer`
 * (not JSON, or an error inside it) or `no-results` (exit 1).
 */
export async function runWebSearch({
  argv,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
}: {
  argv: Array<string>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const fail = (code: number, reason: string): { code: number; stdout: string; stderr: string } => ({
    code,
    stdout: '',
    stderr: `web-search: ${reason}\n`,
  });
  const parsed = parseSearchArgs(argv);
  if ('error' in parsed) return fail(EXIT.usage, parsed.error);
  const apiKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  if (!apiKey) return fail(EXIT.usage, 'no-key');
  const givenModel = env[WEB_SEARCH_MODEL_ENV];
  const given = typeof givenModel === 'string' ? givenModel.trim() : '';
  const model = given || webSearchModel({});
  const body = buildSearchRequest({ ...parsed, model });

  let response: Response;
  try {
    response = await fetchImpl(apiUrl(BASE_URL, 'chat/completions'), {
      method: 'POST',
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const { name } = errorFields(err);
    return fail(EXIT.failed, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  if (!response?.ok) return fail(EXIT.failed, `http-${response?.status ?? 'unknown'}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return fail(EXIT.failed, 'bad-answer');
  }
  if (!json || typeof json !== 'object' || objOf(json).error) return fail(EXIT.failed, 'bad-answer');
  const results = searchResults(json);
  if (!results.length) return fail(EXIT.failed, 'no-results');
  return { code: EXIT.ok, stdout: formatResults(results), stderr: '' };
}
