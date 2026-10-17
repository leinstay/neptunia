#!/usr/bin/env node
// Operations tool: the paired search comparison. The same real queries go through the web
// lookup's own search step once per engine (Brave, Exa, OpenRouter's web plugin), so the default
// engine (`web.search.engine`) is chosen by numbers -- answered / empty / failed, latency, cost --
// and by the owner's blind scores, instead of by a few live turns.
//
//   cd /opt/neptunia-bot && node tools/search-compare.mjs <queries.jsonl> --out <dir>
//        [--engines brave,exa,openrouter] [--key <ENV_NAME>] [--repeat N] [--max-usd 2]
//        [--seed <text>] [--dry-run]
//
// The queries (tools/lib/search-compare.mjs#parseQueries): one JSON row per line, `{ id, query,
// asked?, note? }`.
//
// Each row and engine runs src/web/lookup.js#createLookup(...).search() under the live config and
// prompts with `web.search.engine` forced to that engine and `web.search.fallback` to [] (through
// a config view of this process only; `features.webLookup` and `web.search.enabled` forced on,
// `web.maxPerDay` forced to 1 over a fresh counter), with the real clients: src/web/brave.js
// (BRAVE_SEARCH_API_KEY), src/web/exa.js (keyless; EXA_API_KEY when set), and the summary on the
// `reasoner` as production sends it. The cache is bypassed: every search gets a fresh lookup over a
// fresh in-memory state and a store stub whose media cache is a new empty object, so the cache key
// (`search:<sha1 of the normalized query>`) never hits and nothing is kept. An engine the lookup
// cannot run (Brave without its key) is `skipped` for every row. The tool never retries beyond
// what the clients do.
//
// Timings: the engine's own call (the Brave or Exa client's `search`, or, for `openrouter`, the one
// request that searches and summarizes) and the summary request are measured by wrapping the
// clients the lookup is handed; the whole step around `search()`. The failure reason is the
// lookup's own (`lookup: search` log line); a NotByokError from the client is reported `not-byok`.
//
// `--dry-run`: runs the first row through the lookup with recording stand-ins and prints each
// engine's request shapes (the search call, the summary request's model, options and message
// sizes); nothing is sent, no OpenRouter key is read.
//
// Rails: requests marked `origin: 'search-compare'`, never counted against llm.maxRequestsPerDay,
// no calibration, the daily counters a throwaway copy; one search at a time; no row is started
// once the summed cost has passed `--max-usd` (default 2). The key: the variable `--key` names
// (read from the private .env), else OPENROUTER_SIM_KEY (tools/lib/cli.mjs#simKey). Nothing under
// data/ is read or written; `--out` may not point there.
//
// Output in `--out`: `results.jsonl` (per row, engine and run `{ id, engine, ok, reason,
// ms_search, ms_summary, ms_total, results, cost, text, sources }`, plus `run` with `--repeat`
// above 1), `summary.md` (also printed), `blind.md` (the owner's blind sheet, letters shuffled
// per query by `--seed`, default today's UTC date) and `blind-key.json` (`id -> { A: engine, ... }`).
// `results.jsonl`, `blind.md` and `blind-key.json` quote chat: keep them on the server. Logs carry
// ids, engines and outcomes only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defaultDataDir, parseFlags, privateDirOf, runCli, simKey } from './lib/cli.mjs';
import { costOf } from './lib/recall-eval.mjs';
import { outcomeOf, parseQueries, renderBlind, renderSummary, summarize } from './lib/search-compare.mjs';

const USAGE =
  'usage: node tools/search-compare.mjs <queries.jsonl> --out <dir> [--engines brave,exa,openrouter] [--key <ENV_NAME>] [--repeat N] [--max-usd 2] [--seed <text>] [--dry-run]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'search-compare';
const DEFAULT_ENGINES = ['brave', 'exa', 'openrouter'];
const DEFAULT_MAX_USD = 2;
const MAX_REPEAT = 20;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const GUILD = 'search-compare';
// The stand-in answers of a dry run: never sent anywhere, only there so the lookup reaches its summary request.
const DRY_RESULT = { title: 'dry run', url: 'https://example.com/', snippet: 'dry run' };
const DRY_TEXT = 'dry run answer';

/** A number from a flag in [min, max], `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
  return n;
}

/** Whether `file` is `dir` or inside it. */
function inside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The key the run spends: the variable `name` names, else the simulator key (simKey). Never printed. */
function keyOf(name, env) {
  if (name === undefined) return simKey(ORIGIN, env);
  if (!ENV_NAME_RE.test(name)) throw new CliError(`search-compare: --key takes the name of a variable, not a key\n${USAGE}`);
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`search-compare: ${name} is not set (.env)`);
  return value.trim();
}

/** An env value trimmed, or null when unset or blank. */
function envValue(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The `--engines` list: known engines, each once, in the given order. */
function enginesOf(value, known) {
  if (value === undefined) return [...DEFAULT_ENGINES];
  const list = String(value)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (list.length === 0 || list.some((e) => !known.includes(e)) || new Set(list).size !== list.length) {
    throw new CliError(`search-compare: --engines takes a comma list of ${known.join(', ')}, each once\n${USAGE}`);
  }
  return list;
}

/** The live config with the engine forced and nothing else that could stop one search: a view, never written back. */
function forcedConfig(live, engine) {
  const web = live?.web ?? {};
  return {
    ...live,
    features: { ...(live?.features ?? {}), webLookup: true },
    web: { ...web, maxPerDay: 1, search: { ...(web.search ?? {}), enabled: true, engine, fallback: [] } },
  };
}

/** The shape of one model request: model, options (plugins included) and the messages' roles and sizes. */
function requestShape(messages, options) {
  return {
    model: options?.model ?? null,
    options: Object.fromEntries(Object.entries(options ?? {}).filter(([k]) => k !== 'model')),
    messages: messages.map((m) => ({ role: m.role, chars: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length })),
  };
}

/**
 * The whole tool: the markdown summary on stdout (or, with `--dry-run`, the first row's request shapes).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, hot?: object|null, llmClient?: object|null,
 *   searches?: { brave?: object, exa?: object }|null, env?: Record<string, string|undefined>,
 *   rootDir?: string }} [options]  `hot`, `llmClient` and `searches` stand in for the live config
 *   and prompts, the OpenRouter client and the search clients (tests).
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now, hot: givenHot = null, llmClient = null, searches: givenSearches = null, env = process.env, rootDir = ROOT } = {}) {
  const flags = parseFlags(argv, {
    values: ['--out', '--engines', '--key', '--repeat', '--max-usd', '--seed'],
    switches: ['--dry-run'],
    usage: USAGE,
  });
  if (flags._.length !== 1) throw new CliError(USAGE);
  const dry = flags['--dry-run'] === true;
  const queriesFile = path.resolve(cwd, flags._[0]);
  let text;
  try {
    text = fs.readFileSync(queriesFile, 'utf8');
  } catch (err) {
    throw new CliError(`search-compare: cannot read the queries ${queriesFile} (${err?.code ?? err?.name ?? 'Error'})`);
  }
  const { rows, errors } = parseQueries(text);
  if (errors.length > 0) throw new CliError(`search-compare: the queries file has ${errors.length} problem(s):\n${errors.slice(0, 20).join('\n')}`);
  if (rows.length === 0) throw new CliError('search-compare: the queries file has no row');

  const { createLookup, SEARCH_ENGINES } = await import('../src/web/lookup.js');
  const { NotByokError } = await import('../src/llm/openrouter.js');
  const { onLog } = await import('../src/log.js');
  const { utcDay } = await import('../src/time.js');

  const engines = enginesOf(flags['--engines'], SEARCH_ENGINES);
  const repeat = numberFlag(flags['--repeat'], 1, { min: 1, max: MAX_REPEAT, integer: true });
  const maxUsd = numberFlag(flags['--max-usd'], DEFAULT_MAX_USD);
  const seed = flags['--seed'] ?? utcDay(now());
  let outDir = null;
  if (!dry) {
    if (!flags['--out']) throw new CliError(`search-compare: give --out <dir> (a measurements folder)\n${USAGE}`);
    outDir = path.resolve(cwd, flags['--out']);
    for (const dataDir of new Set([defaultDataDir(cwd, env), defaultDataDir(rootDir, env)])) {
      if (inside(outDir, path.resolve(dataDir))) throw new CliError('search-compare: --out may not be under data/');
    }
  }

  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir, env) });
  }

  try {
    if (!hot.prompts?.['search-summary']) throw new CliError('search-compare: prompts.search-summary is missing');
    if (!llmClient) {
      const { loadDotEnv } = await import('../src/config.js');
      loadDotEnv(privateDirOf(rootDir, env));
    }
    const keys = { brave: envValue(env, 'BRAVE_SEARCH_API_KEY'), exa: envValue(env, 'EXA_API_KEY') };

    /**
     * One search on `engine` through a fresh lookup: its own state and an empty media cache (no
     * hit, nothing kept), the clients wrapped to time them. Resolves the run's record (without `id`).
     */
    async function runOnce(engine, query, { llm, searches }) {
      const timing = { search: null, summary: null, cost: 0, results: null, llmError: null };
      const wrappedLlm = {
        async complete(messages, options) {
          const started = now();
          try {
            const completion = await llm.complete(messages, { ...options, origin: ORIGIN, countAgainstDailyCap: false, skipCalibration: true });
            timing.cost += costOf(completion?.usage);
            return completion;
          } catch (err) {
            timing.llmError = err;
            throw err;
          } finally {
            const ms = now() - started;
            if (engine === 'openrouter') timing.search = ms;
            else timing.summary = ms;
          }
        },
      };
      const wrap = (client) =>
        client && typeof client.search === 'function'
          ? {
              async search(q, options) {
                const started = now();
                try {
                  const found = await client.search(q, options);
                  timing.results = found?.ok && Array.isArray(found.results) ? found.results.length : 0;
                  return found;
                } finally {
                  timing.search = now() - started;
                }
              },
            }
          : undefined;
      const view = {
        get config() {
          return forcedConfig(hot.config ?? {}, engine);
        },
        get prompts() {
          return hot.prompts;
        },
      };
      const lookup = createLookup({
        hot: view,
        store: { getMediaCache: () => ({}), markMediaCacheDirty() {} },
        llm: wrappedLlm,
        state: { data: {}, markDirty() {} },
        pageFetcher: { fetchText: async () => ({ ok: false, reason: 'network' }) },
        searches: { brave: wrap(searches.brave), exa: wrap(searches.exa) },
        keys,
        now,
      });
      const base = { engine, ok: false, reason: null, ms_search: null, ms_summary: null, ms_total: null, results: 0, cost: 0, text: '', sources: [] };
      if (!lookup.hasSearch()) return { ...base, reason: 'skipped' };

      let logged = null;
      const stop = onLog((entry) => {
        if (entry?.msg === 'lookup: search') logged = entry;
      });
      const started = now();
      let found;
      try {
        found = await lookup.search(GUILD, query);
      } finally {
        stop();
      }
      const record = { ...base, ms_search: timing.search, ms_summary: timing.summary, ms_total: now() - started, cost: timing.cost };
      if (found) {
        const sources = found.sources ?? [];
        return { ...record, ok: true, reason: found.text ? null : 'empty', results: timing.results ?? sources.length, text: found.text, sources };
      }
      let reason = logged?.reason ?? 'not-run';
      if (timing.llmError instanceof NotByokError) reason = 'not-byok';
      return { ...record, reason, results: timing.results ?? 0 };
    }

    if (dry) {
      const row = rows[0];
      const out = [`# dry run: row ${row.id}, nothing sent`, ''];
      for (const engine of engines) {
        const calls = [];
        const recorder = {
          async search(q, options) {
            calls.push({ kind: 'search', engine, count: options?.count ?? null, timeoutMs: options?.timeoutMs ?? null, apiKey: options?.apiKey ? 'set' : 'none', queryChars: String(q).length });
            return { ok: true, results: [DRY_RESULT] };
          },
        };
        const llm = {
          async complete(messages, options) {
            calls.push({ kind: 'completion', ...requestShape(messages, options) });
            return { text: DRY_TEXT, usage: {} };
          },
        };
        const r = await runOnce(engine, row.query, { llm, searches: { brave: recorder, exa: recorder } });
        out.push(`## ${engine}`, '');
        if (r.reason === 'skipped') out.push('skipped: the lookup cannot run this engine (a missing key)', '');
        else out.push('```json', JSON.stringify(calls, null, 2), '```', '');
      }
      process.stderr.write(`search-compare: dry run, ${rows.length} row(s) x ${engines.length} engine(s) x ${repeat}, nothing sent\n`);
      return `${out.join('\n')}`;
    }

    let llm = llmClient;
    if (!llm) {
      const { createLlm } = await import('../src/llm/openrouter.js');
      const { createCalibrator } = await import('../src/llm/tokens.js');
      const apiKey = keyOf(flags['--key'], env);
      // Per-role keys are not looked up (env {}): the given key pays; the daily counters are a throwaway copy.
      llm = createLlm({ apiKey, env: {}, getConfig: () => hot.config, calibrator: createCalibrator(), state: { data: {}, markDirty() {} } });
    }
    let searches = givenSearches;
    if (!searches) {
      const { createBraveSearch } = await import('../src/web/brave.js');
      const { createExaSearch } = await import('../src/web/exa.js');
      searches = { brave: createBraveSearch(), exa: createExaSearch() };
    }

    process.stderr.write(
      `search-compare: ${rows.length} row(s) x ${engines.length} engine(s) x ${repeat}, up to ${rows.length * engines.length * repeat} search step(s), no row started once the cost passes ${maxUsd} USD\n`,
    );
    const results = [];
    let spent = 0;
    let stopped = null;
    let done = 0;
    for (const row of rows) {
      if (spent > maxUsd) {
        stopped = 'max-usd';
        break;
      }
      for (let run = 1; run <= repeat; run += 1) {
        for (const engine of engines) {
          const r = await runOnce(engine, row.query, { llm, searches });
          spent += r.cost;
          results.push({ id: row.id, ...r, ...(repeat > 1 ? { run } : {}) });
          process.stderr.write(`search-compare: ${row.id} ${engine}${repeat > 1 ? ` run ${run}` : ''} ${outcomeOf(r)}${r.reason && r.reason !== 'empty' ? ` (${r.reason})` : ''}${r.ms_total !== null ? ` ${r.ms_total} ms` : ''}\n`);
        }
      }
      done += 1;
    }

    const ran = rows.slice(0, done);
    const summary = summarize(results, engines);
    const markdown = renderSummary(summary, {
      at: new Date(now()).toISOString(),
      queries: path.basename(queriesFile),
      repeat,
      seed,
      rows: done,
      notRun: rows.length - done,
      stopped,
    });
    const blind = renderBlind(ran, results, engines, seed);
    fs.mkdirSync(outDir, { recursive: true });
    const fields = ({ id, engine, ok, reason, ms_search, ms_summary, ms_total, results: count, cost, text: answer, sources, run }) => ({
      id,
      engine,
      ok,
      reason,
      ms_search,
      ms_summary,
      ms_total,
      results: count,
      cost,
      text: answer,
      sources,
      ...(run !== undefined ? { run } : {}),
    });
    const lines = results.map((r) => JSON.stringify(fields(r)));
    const files = {
      'results.jsonl': lines.length > 0 ? `${lines.join('\n')}\n` : '',
      'summary.md': markdown,
      'blind.md': blind.markdown,
      'blind-key.json': `${JSON.stringify(blind.key, null, 2)}\n`,
    };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), body);
    return `${markdown}\n${Object.keys(files)
      .map((name) => path.join(outDir, name))
      .join('\n')}\n`;
  } finally {
    if (!givenHot) hot.close?.();
  }
}

runCli(import.meta.url, main);
