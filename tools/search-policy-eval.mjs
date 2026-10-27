#!/usr/bin/env node
// Operations tool: measure the search classifier (prompts.lookup, purpose `lookup`) against a
// labelled sheet of questions, so a change to the search policy is judged by numbers -- the
// confusion matrix of the owner's tier against the classifier's decision, the agreement, the
// disagreements, latency and cost -- instead of by a few live turns.
//
//   cd /opt/neptunia/app && node tools/search-policy-eval.mjs <sheet.jsonl> --out <dir>
//        [--key <ENV_NAME>] [--model <id>] [--limit N] [--max-usd 1] [--concurrency 4]
//        [--self-name <name>] [--dry-run]
//
// The sheet (tools/lib/search-policy-eval.mjs#parseSheet): one JSON row per line, `{ id, source,
// question, context: [{ author, text }], tier: none|fast|memory|agent, note, author? }`.
//
// Each row is asked as a live turn asks it (src/behavior/turn.js#maybeLookup): the user message
// is src/behavior/turn.js#lookupClassifierInput over the row's `context` lines (one minute apart
// before now; a line by the persona's name is hers) and the question as the trigger (by the row's
// `author`, else `-`), under the live config and labels; the system prompt is prompts.lookup
// (tracked, or the deployment's prompts.local/lookup.md through the usual loader, src/hot.js)
// with `{{today}}` = today in `bot.timezone`, `{{name}}` = the persona's name (`--self-name`,
// else the config's first `bot.nameTriggers`) and `{{skills}}` = the skills index when discovery
// is on (src/tools/discovery.ts), as the turn fills them. One completion on the `analyzer` role
// (roleModel for purpose `lookup`; `--model` pins another for this run only), with the turn's
// helper options (sideRequestOptions: its temperature, timeout and hedge), the answer capped at
// `web.search.classifierMaxOutputTokens`. The answer is read by
// src/behavior/recall.js#parseLookupAnswer and mapped to a decision
// (tools/lib/search-policy-eval.mjs#decisionOf): `web:` -> fast, a server part without `web:` ->
// memory, nothing -> none (never agent: the classifier asks for no errand); a call that threw or
// answered nothing -> failed.
// Not reproduced: the turn planner, pictures, videos and read links in the transcript, the failed
// classifier's fallback.
//
// `--dry-run`: prints the first row's request (the filled system prompt and the user message)
// and sends nothing; no key is read.
//
// Rails: requests marked `origin: 'search-policy-eval'`, never counted against
// llm.maxRequestsPerDay, no calibration, no prompt-cache marker, the daily counters a throwaway
// copy; at most `--concurrency` (default 4) at once; no row is started once the summed cost has
// passed `--max-usd` (default 1). The key: the variable `--key` names (read from the private
// .env), else OPENROUTER_SIM_KEY (tools/lib/cli.mjs#simKey). Nothing under data/ is read or
// written; `--out` may not point there.
//
// Output in `--out`: `results.jsonl` (per row `{ id, source, tier, decision, query, forms, who,
// ms, ok }`: the query and forms come from chat, the file is as private as the sheet) and
// `summary.md` (tools/lib/search-policy-eval.mjs#renderSummary), which is also printed on stdout.
// Logs carry ids and decisions only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defaultDataDir, parseFlags, privateDirOf, runCli, simKey } from './lib/cli.mjs';
import { costOf } from './lib/recall-eval.mjs';
import { decisionOf, parseSheet, renderSummary, rowChat, summarize } from './lib/search-policy-eval.mjs';

const USAGE =
  'usage: node tools/search-policy-eval.mjs <sheet.jsonl> --out <dir> [--key <ENV_NAME>] [--model <id>] [--limit N] [--max-usd 1] [--concurrency 4] [--self-name <name>] [--dry-run]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'search-policy-eval';
const DEFAULT_MAX_USD = 1;
const DEFAULT_CONCURRENCY = 4;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

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
  if (!ENV_NAME_RE.test(name))
    throw new CliError(`search-policy-eval: --key takes the name of a variable, not a key\n${USAGE}`);
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`search-policy-eval: ${name} is not set (.env)`);
  return value.trim();
}

/**
 * The whole tool: the markdown summary on stdout (or, with `--dry-run`, the first row's request).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, hot?: object|null, llmClient?: object|null,
 *   env?: Record<string, string|undefined>, rootDir?: string }} [options]  `hot` and `llmClient`
 *   stand in for the live config and prompts and the OpenRouter client (tests).
 * @returns {Promise<string>}
 */
export async function main(
  argv,
  {
    cwd = process.cwd(),
    now = Date.now,
    hot: givenHot = null,
    llmClient = null,
    env = process.env,
    rootDir = ROOT,
  } = {}
) {
  const flags = parseFlags(argv, {
    values: ['--out', '--key', '--model', '--limit', '--max-usd', '--concurrency', '--self-name'],
    switches: ['--dry-run'],
    usage: USAGE,
  });
  if (flags._.length !== 1) throw new CliError(USAGE);
  const dry = flags['--dry-run'] === true;
  const sheetFile = path.resolve(cwd, flags._[0]);
  let text;
  try {
    text = fs.readFileSync(sheetFile, 'utf8');
  } catch (err) {
    throw new CliError(`search-policy-eval: cannot read the sheet ${sheetFile} (${err?.code ?? err?.name ?? 'Error'})`);
  }
  const { rows, errors } = parseSheet(text);
  if (errors.length > 0)
    throw new CliError(
      `search-policy-eval: the sheet has ${errors.length} problem(s):\n${errors.slice(0, 20).join('\n')}`
    );
  if (rows.length === 0) throw new CliError('search-policy-eval: the sheet has no row');
  const limit = numberFlag(flags['--limit'], rows.length, { min: 1, integer: true });
  const maxUsd = numberFlag(flags['--max-usd'], DEFAULT_MAX_USD);
  const concurrency = numberFlag(flags['--concurrency'], DEFAULT_CONCURRENCY, { min: 1, max: 16, integer: true });
  const asked = rows.slice(0, limit);
  let outDir = null;
  if (!dry) {
    if (!flags['--out']) throw new CliError(`search-policy-eval: give --out <dir> (a measurements folder)\n${USAGE}`);
    outDir = path.resolve(cwd, flags['--out']);
    for (const dataDir of new Set([defaultDataDir(cwd, env), defaultDataDir(rootDir, env)])) {
      if (inside(outDir, path.resolve(dataDir))) throw new CliError('search-policy-eval: --out may not be under data/');
    }
  }

  const { lookupClassifierInput } = await import('../src/behavior/turn.js');
  const { fillPromptTemplate } = await import('../src/behavior/prompt.js');
  const { parseLookupAnswer, recallSettings } = await import('../src/behavior/recall.js');
  const { sideRequestOptions } = await import('../src/llm/openrouter.js');
  const { roleModel } = await import('../src/llm/roles.js');
  const { discoveryOn, skillsIndex } = await import('../src/tools/discovery.ts');
  const { skillRegistry } = await import('../src/tools/registry.ts');
  const { zonedDay } = await import('../src/time.js');

  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir, env) });
  }
  const model = flags['--model'] ?? null;
  /** The live config, with `--model` pinned for purpose `lookup` in this process only. */
  const configNow = () => {
    const live = hot.config ?? {};
    if (!model) return live;
    const models = live.models ?? {};
    return { ...live, models: { ...models, byPurpose: { ...(models.byPurpose ?? {}), lookup: model } } };
  };

  try {
    if (!hot.prompts?.lookup) throw new CliError('search-policy-eval: prompts.lookup is missing');
    if (!hot.prompts?.labels) throw new CliError('search-policy-eval: prompts.labels is missing');
    const selfName = flags['--self-name'] ?? hot.config?.bot?.nameTriggers?.[0] ?? 'bot';

    /** One row's request, as maybeLookup builds it, read now. */
    const requestOf = (row) => {
      const config = configNow();
      const { history, trigger } = rowChat(row, { now: now(), selfName });
      const { user } = lookupClassifierInput({ config, labels: hot.prompts.labels, selfName, history, trigger });
      const discovery = discoveryOn(config)
        ? { index: skillsIndex(skillRegistry(), hot.prompts?.tools), names: [...skillRegistry().keys()] }
        : { index: '', names: [] };
      const system = fillPromptTemplate(hot.prompts.lookup, {
        today: zonedDay(now(), config.bot?.timezone),
        name: selfName,
        skills: discovery.index,
      });
      return { config, system, user, skillNames: discovery.names };
    };

    if (dry) {
      const { config, system, user } = requestOf(asked[0]);
      process.stderr.write(`search-policy-eval: dry run, ${asked.length} row(s), nothing sent\n`);
      return `# row ${asked[0].id} (model ${roleModel(config, 'analyzer', 'lookup') ?? '-'})\n\n## system\n\n${system}\n\n## user\n\n${user}\n`;
    }

    process.stderr.write(
      `search-policy-eval: ${asked.length} row(s), up to ${asked.length} model request(s), none started once the cost passes ${maxUsd} USD\n`
    );
    let llm = llmClient;
    if (!llm) {
      const { loadDotEnv } = await import('../src/config.js');
      const { createLlm } = await import('../src/llm/openrouter.js');
      const { createCalibrator } = await import('../src/llm/tokens.js');
      loadDotEnv(privateDirOf(rootDir, env));
      const apiKey = keyOf(flags['--key'], env);
      // Per-role keys are not looked up (env {}): the given key pays; the daily counters are a throwaway copy.
      llm = createLlm({
        apiKey,
        env: {},
        getConfig: configNow,
        calibrator: createCalibrator(),
        state: { data: {}, markDirty() {} },
      });
    }

    let spent = 0;
    let stopped = null;
    const results = new Array(asked.length).fill(null);

    /** One row asked and decided. */
    async function ask(row) {
      const { config, system, user, skillNames } = requestOf(row);
      const started = now();
      const base = { id: row.id, source: row.source, tier: row.tier };
      let completion;
      try {
        completion = await llm.complete(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          {
            model: roleModel(config, 'analyzer', 'lookup'),
            ...sideRequestOptions(config, {
              role: 'analyzer',
              maxOutputTokens: config.web?.search?.classifierMaxOutputTokens ?? 2000,
              purpose: 'lookup',
            }),
            origin: ORIGIN,
            countAgainstDailyCap: false,
            skipCalibration: true,
            cache: false,
          }
        );
      } catch (err) {
        return {
          ...base,
          decision: 'failed',
          query: null,
          forms: [],
          who: [],
          ms: now() - started,
          ok: false,
          error: err?.name ?? 'Error',
          costUsd: 0,
        };
      }
      const ms = now() - started;
      const costUsd = costOf(completion?.usage);
      spent += costUsd;
      if (!String(completion?.text ?? '').trim())
        return { ...base, decision: 'failed', query: null, forms: [], who: [], ms, ok: false, error: 'empty', costUsd };
      const parsed = parseLookupAnswer(completion.text, {
        timezone: config.bot?.timezone,
        now: now(),
        maxForms: recallSettings(config)?.maxForms,
        skillNames,
      });
      return {
        ...base,
        decision: decisionOf(parsed),
        query: parsed.web ?? null,
        forms: parsed.server?.forms ?? [],
        who: parsed.server?.who ?? [],
        ms,
        ok: true,
        costUsd,
      };
    }

    let next = 0;
    const worker = async () => {
      while (next < asked.length && !stopped) {
        if (spent > maxUsd) {
          stopped = 'max-usd';
          break;
        }
        const index = next++;
        const r = await ask(asked[index]);
        results[index] = r;
        process.stderr.write(
          `search-policy-eval: ${r.id} tier ${r.tier} decision ${r.decision}${r.error ? ` (${r.error})` : ''} ${r.ms} ms\n`
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, asked.length) }, worker));

    const done = results.filter(Boolean);
    const summary = summarize(done);
    const markdown = renderSummary(summary, {
      at: new Date(now()).toISOString(),
      sheet: path.basename(sheetFile),
      model: roleModel(configNow(), 'analyzer', 'lookup') ?? null,
      skipped: asked.length - done.length,
      stopped,
    });
    fs.mkdirSync(outDir, { recursive: true });
    const lines = done.map(({ id, source, tier, decision, query, forms, who, ms, ok }) =>
      JSON.stringify({ id, source, tier, decision, query, forms, who, ms, ok })
    );
    fs.writeFileSync(path.join(outDir, 'results.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
    fs.writeFileSync(path.join(outDir, 'summary.md'), markdown);
    return `${markdown}\n${path.join(outDir, 'results.jsonl')}\n${path.join(outDir, 'summary.md')}\n`;
  } finally {
    if (!givenHot) hot.close?.();
  }
}

runCli(import.meta.url, main);
