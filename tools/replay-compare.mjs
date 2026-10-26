#!/usr/bin/env node
// Operations tool. One purpose: compare two replay runs of the same triggers -- the old path (text tags
// `<call>` / `<draw>`, one request per trigger, tools/replay.mjs in message mode with --answers-dir) and
// the new one (native or text tool calls on the step engine, tools/replay.mjs --loop-triggers) -- on a blind
// voice sheet and a table of numbers. Writes nothing but its own output files and reads no network, no key,
// no data/.
//
//   node tools/replay-compare.mjs <oldOut> <newOut> --out <dir>
//
// `<oldOut>`: one folder per scenario (S01..S30 of .agents/docs/sims/2026-10-20-native-tools-baseline/old/), each
// with `ans-001.txt` (her raw answer), `replay.out` (the single-mode JSON: trigger, answers, usage) and,
// when kept, `req-001.json` (the request: its `<chat>` block is the sheet's context) and `ans-001.meta.json`
// (the provider's usage, cost and latency). `<newOut>`: the output folder of `--loop-triggers` -- a
// `runs.jsonl` in it, or in each of its subfolders (one per scenario, when each was run with its own
// `--answers-dir`). A new line is paired with the old scenario whose trigger message it answers.
// `--out <dir>` (not existing, or empty) gets:
//   sheet.html   every paired scenario, the old and the new answer blind and in a random order, built
//                through tools/lib/pair.mjs#renderSheet (the posted messages, reactions, GIF, pictures drawn and
//                posts of message calls of each side; the calls are not shown);
//   key.json     which side (`a` the old, `b` the new) is shown first, per scenario: the key of the sheet
//                (tools/replay-score.mjs tallies the owner's scores against it);
//   metrics.md   per scenario and in total: calls (names and statuses), held-text leaks (speech posted in a
//                step whose calls did not all work and need no reading: must be 0), duplicate effects, requests per
//                turn, tokens in / out / cache read / cache written, cost, latency, thinkMissing, coercions,
//                unreadable and cut-off calls, cap hits; then the pass bar of the stage 4 plan (zero leaks; S08 and
//                S09 draw with a channel and a boolean `self`; S26-S28 exactly one picture each; S21-S25 no calls;
//                S29 a GIF and S30 a reaction; mean requests per turn at most the old plus 0.3; mean cost at most
//                the old times 1.15; thinkMissing under 10% of the steps) with a verdict per line, and the
//                scenarios whose wording needs a human read (S01, S17: the errand spoken of as handed off).
// THE FILES HOLD MESSAGE CONTENTS: the server's eyes only, like the replay outputs they read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { CliError } from './lib/cli.mjs';
import { pairOrder, renderSheet } from './lib/pair.mjs';
import { pairAnswerOf } from './replay.mjs';

const USAGE = 'usage: node tools/replay-compare.mjs <oldOut> <newOut> --out <dir>';
/** The mean requests per turn the new path may spend above the old one. */
export const MAX_EXTRA_REQUESTS = 0.3;
/** The factor of the old mean cost per turn the new path may reach. */
export const MAX_COST_FACTOR = 1.15;
/** The share of steps without her thinking at the head the new path may have (exclusive). */
export const MAX_THINK_MISSING = 0.1;
/** Scenarios whose wording only a reader can judge, with what to look for. */
export const MANUAL_CHECKS = Object.freeze({
  S01: 'speaks of the errand as handed off, claims no found meme',
  S17: 'speaks of the errand as handed off, claims nothing before the result',
});
/** Skills whose result is something to read (their speech waits), from the skill definitions. */
const RESULT_OF = new Map(SKILL_DEFINITIONS.map((definition) => [definition.name, definition.result]));

const attrsOf = (text) =>
  Object.fromEntries(Array.from(String(text ?? '').matchAll(/(\w+)="([^"]*)"/g), (m) => [m[1], m[2]]));

/**
 * The calls and pictures of an old answer's text, from the retired tags: every `<call skill="x" ...>body</call>` is
 * a call named by its skill; a `<draw self="yes">scene</draw>`, alone or inside a call, is a `draw.create` (inside a
 * call it takes the call's `channel`). Pure.
 * @param {string} text
 * @returns {{ name: string, args: object }[]}
 */
export function oldCallsOf(text) {
  const source = String(text ?? '');
  const out = [];
  const taken = [];
  for (const match of source.matchAll(/<call\b([^>]*?)(?:\/>|>([\s\S]*?)<\/call>)/g)) {
    const attrs = attrsOf(match[1]);
    const body = match[2] ?? '';
    const nested = /<draw\b([^>]*)>([\s\S]*?)<\/draw>/.exec(body);
    if (nested) {
      const inner = attrsOf(nested[1]);
      out.push({
        at: match.index,
        name: 'draw.create',
        args: {
          text: nested[2].trim(),
          self: inner.self === 'yes' || inner.self === 'true',
          ...(attrs.channel ? { channel: attrs.channel } : {}),
        },
      });
    } else {
      const { skill, ...rest } = attrs;
      out.push({
        at: match.index,
        name: skill ?? '',
        args: { ...rest, ...(body.trim() ? { text: body.trim() } : {}) },
      });
    }
    taken.push([match.index, match.index + match[0].length]);
  }
  for (const match of source.matchAll(/<draw\b([^>]*)>([\s\S]*?)<\/draw>/g)) {
    if (taken.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const attrs = attrsOf(match[1]);
    out.push({
      at: match.index,
      name: 'draw.create',
      args: { text: match[2].trim(), self: attrs.self === 'yes' || attrs.self === 'true' },
    });
  }
  return out.sort((a, b) => a.at - b.at).map(({ name, args }) => ({ name, args }));
}

/** The lines of a request's `<chat>` block as sheet context, `Author: text`; [] without a request. */
function chatOf(requestFile) {
  try {
    const json = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const user = (json.messages ?? []).find((message) => message.role === 'user');
    const text =
      typeof user?.content === 'string'
        ? user.content
        : Array.isArray(user?.content)
          ? user.content.map((part) => part.text ?? '').join('')
          : '';
    const block = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
    return block
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const cut = line.indexOf(': ');
        return cut > 0 && cut < 60
          ? { author: line.slice(0, cut), text: line.slice(cut + 2) }
          : { author: '', text: line };
      });
  } catch {
    return [];
  }
}

/**
 * The old side: every subfolder of `dir` that holds `ans-001.txt` and `replay.out`, as
 * `{ label, triggerId, answer, calls, requests, tokens, cost, ms, thinkMissing, context }` in folder order.
 * @param {string} dir
 */
export function readOldSide(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const folder = path.join(dir, name);
    if (
      !fs.statSync(folder).isDirectory() ||
      !fs.existsSync(path.join(folder, 'ans-001.txt')) ||
      !fs.existsSync(path.join(folder, 'replay.out'))
    )
      continue;
    const text = fs.readFileSync(path.join(folder, 'ans-001.txt'), 'utf8');
    const replay = JSON.parse(fs.readFileSync(path.join(folder, 'replay.out'), 'utf8'));
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folder, 'ans-001.meta.json'), 'utf8'));
    } catch {
      meta = null;
    }
    const calls = oldCallsOf(text);
    const shown = replay.answers?.[0] ?? {};
    const usage = meta?.usage ?? null;
    const cacheRead = Number(usage?.cache_read_input_tokens) || 0;
    const cacheWrite = Number(usage?.cache_creation_input_tokens) || 0;
    out.push({
      label: name,
      triggerId: String(replay.trigger?.id ?? ''),
      answer: {
        think: shown.think ?? '',
        messages: shown.messages ?? [],
        // The single mode drops a reaction or a GIF it cannot place (no library, no target): the tags in her text are read too.
        reactions: (shown.reactions?.length > 0
          ? shown.reactions
          : Array.from(text.matchAll(/<react\b[^>]*>([^<]+)<\/react>/g), (m) => ({ emoji: m[1].trim() }))
        ).map((reaction) => ({ emoji: reaction.emoji ?? reaction })),
        gif: shown.gif
          ? { id: shown.gif.id ?? shown.gif }
          : /<gif\b[^>]*>([^<]+)<\/gif>/.exec(text)
            ? { id: /<gif\b[^>]*>([^<]+)<\/gif>/.exec(text)[1].trim() }
            : null,
        drawings: calls.filter((call) => call.name === 'draw.create').map((call) => ({ text: call.args.text ?? '' })),
        posts: calls
          .filter((call) => call.name === 'message.create' && call.args.text)
          .map((call) => ({ text: call.args.text })),
        skip: shown.skip === true,
      },
      calls,
      requests: fs.readdirSync(folder).filter((file) => /^ans-\d+\.txt$/.test(file)).length,
      tokens: usage
        ? {
            prompt: (Number(usage.input_tokens) || 0) + cacheRead + cacheWrite,
            completion: Number(usage.output_tokens) || 0,
            cacheRead,
            cacheWrite,
          }
        : {
            prompt: Number(replay.usage?.promptTokens) || 0,
            completion: Number(replay.usage?.completionTokens) || 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
      cost: Number.isFinite(meta?.total_cost_usd) ? meta.total_cost_usd : null,
      ms: Number.isFinite(meta?.duration_ms) ? meta.duration_ms : null,
      thinkMissing: !text.trim().startsWith('<think>'),
      context: chatOf(path.join(folder, 'req-001.json')),
    });
  }
  return out;
}

/**
 * The new side: the lines of every `runs.jsonl` in `dir` or in its subfolders (folder order, then line order).
 * @param {string} dir
 * @returns {object[]}
 */
export function readNewSide(dir) {
  const files = [
    path.join(dir, 'runs.jsonl'),
    ...fs
      .readdirSync(dir)
      .sort()
      .map((name) => path.join(dir, name, 'runs.jsonl')),
  ].filter((file) => fs.existsSync(file));
  return files.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

/** The kind of a skill's result: `data`, `effect`, `job`; `data` for one the definitions do not know (she must read it). */
const resultKind = (skill) => RESULT_OF.get(skill) ?? 'data';

/** The number of identical calls (the same skill and arguments) of an effect or a job in `calls` beyond the first. */
function duplicateEffects(calls) {
  const seen = new Set();
  let duplicates = 0;
  for (const call of calls) {
    if (resultKind(call.name) === 'data') continue;
    const key = `${call.name}\u0000${JSON.stringify(call.args)}`;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  return duplicates;
}

/** What one new line is, in the shape the metrics read: its calls with statuses, leaks, duplicates, counts, numbers. */
export function newTurnOf(line) {
  const loop = line.loop;
  const calls = loop.steps.flatMap((step) =>
    step.calls.map((c) => ({
      name: c.skill,
      args: c.args ?? {},
      status: c.result?.status ?? null,
      code: c.result?.code ?? null,
      step: step.step,
    }))
  );
  // A leak: speech posted in a step with a call that did not work or that she has to read first.
  const leaks = loop.steps.filter((step) => {
    if (step.held || !step.answer || step.calls.length === 0) return false;
    const spoke = step.answer.messages.length > 0 || step.answer.reactions.length > 0 || Boolean(step.answer.gif);
    return spoke && step.calls.some((c) => c.result?.status !== 'ok' || resultKind(c.skill) === 'data');
  }).length;
  const ok = calls.filter((call) => call.status === 'ok');
  return {
    label: line.scenario ?? line.id,
    triggerId: String(line.triggerId ?? ''),
    answer: pairAnswerOf(line),
    calls,
    leaks,
    duplicates: duplicateEffects(ok),
    requests: loop.turnRequests,
    steps: loop.steps.length,
    tokens: {
      prompt: loop.tokens.prompt,
      completion: loop.tokens.completion,
      cacheRead: loop.tokens.cacheRead ?? 0,
      cacheWrite: loop.tokens.cacheWrite ?? 0,
    },
    cost: loop.cost,
    ms: loop.ms,
    thinkMissing: loop.thinkMissing,
    coerced: loop.coerced,
    malformed: loop.malformed,
    capped: loop.capped,
    held: loop.held,
    context: line.context ?? [],
  };
}

const mean = (values) => {
  const list = values.filter(Number.isFinite);
  return list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length;
};
const fmt = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);
const callText = (calls, withStatus) =>
  calls.length === 0
    ? '-'
    : calls
        .map((call) => `${call.name}${withStatus ? `:${call.status ?? '-'}${call.code ? `(${call.code})` : ''}` : ''}`)
        .join(', ');

/**
 * The scenarios of both sides paired by the message that triggered them: `{ label, old, new }` for each old
 * scenario that has a new line (the first one when several), the old ones without a new line (`missing`) and the
 * new lines without an old scenario (`extra`). Pure.
 */
export function pairSides(oldSide, newSide) {
  const byTrigger = new Map();
  for (const line of newSide) if (!byTrigger.has(String(line.triggerId))) byTrigger.set(String(line.triggerId), line);
  const pairs = [];
  const missing = [];
  for (const item of oldSide) {
    const line = byTrigger.get(item.triggerId);
    if (line) {
      byTrigger.delete(item.triggerId);
      pairs.push({ label: item.label, old: item, new: newTurnOf(line) });
    } else missing.push(item.label);
  }
  return { pairs, missing, extra: [...byTrigger.values()].map((line) => line.scenario ?? line.id) };
}

/**
 * The pass bar of the stage 4 plan over the paired scenarios: `[{ name, pass, detail }]`, `pass` null for what only a
 * reader can judge. A scenario the pairs do not hold is skipped by its check (noted in the detail). Pure.
 */
export function passBar(pairs) {
  const byLabel = new Map(pairs.map((pair) => [pair.label, pair.new]));
  const checks = [];
  const each = (labels, test) =>
    labels.filter((label) => byLabel.has(label)).map((label) => [label, test(byLabel.get(label))]);
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `S${String(from + i).padStart(2, '0')}`);
  const verdict = (name, results, detail) =>
    checks.push({
      name,
      pass: results.length === 0 ? null : results.every(([, ok]) => ok),
      detail:
        results.length === 0
          ? 'no such scenario in this run'
          : (detail ??
            results
              .filter(([, ok]) => !ok)
              .map(([label]) => label)
              .join(', ')),
    });
  const leaks = pairs.reduce((total, pair) => total + pair.new.leaks, 0);
  checks.push({ name: 'zero held-text leaks', pass: leaks === 0, detail: `${leaks} leak(s)` });
  const draws = (turn) => turn.calls.filter((call) => call.name === 'draw.create' && call.status === 'ok');
  verdict(
    'S08, S09 draw.create with a channel and a boolean self',
    each(['S08', 'S09'], (turn) =>
      draws(turn).some(
        (call) => typeof call.args.channel === 'string' && call.args.channel && typeof call.args.self === 'boolean'
      )
    )
  );
  verdict(
    'S26-S28 make exactly one draw.create each',
    each(range(26, 28), (turn) => turn.calls.filter((call) => call.name === 'draw.create').length === 1)
  );
  verdict(
    'S21-S25 (chat) make no calls',
    each(range(21, 25), (turn) => turn.calls.length === 0)
  );
  verdict(
    'S29 keeps its GIF',
    each(['S29'], (turn) => Boolean(turn.answer?.gif))
  );
  verdict(
    'S30 keeps its reaction',
    each(['S30'], (turn) => (turn.answer?.reactions ?? []).length > 0)
  );
  const oldRequests = mean(pairs.map((pair) => pair.old.requests));
  const newRequests = mean(pairs.map((pair) => pair.new.requests));
  checks.push({
    name: `mean requests per turn at most the old plus ${MAX_EXTRA_REQUESTS}`,
    pass: oldRequests === null ? null : newRequests <= oldRequests + MAX_EXTRA_REQUESTS,
    detail: `old ${fmt(oldRequests)}, new ${fmt(newRequests)}`,
  });
  const oldCost = mean(pairs.map((pair) => pair.old.cost));
  const newCost = mean(pairs.map((pair) => pair.new.cost));
  checks.push({
    name: `mean cost per turn at most the old times ${MAX_COST_FACTOR}`,
    pass: oldCost === null || newCost === null ? null : newCost <= oldCost * MAX_COST_FACTOR,
    detail: `old ${fmt(oldCost, 4)}, new ${fmt(newCost, 4)} USD`,
  });
  const steps = pairs.reduce((total, pair) => total + pair.new.steps, 0);
  const missing = pairs.reduce((total, pair) => total + pair.new.thinkMissing, 0);
  checks.push({
    name: `thinkMissing under ${MAX_THINK_MISSING * 100}% of the steps`,
    pass: steps === 0 ? null : missing / steps < MAX_THINK_MISSING,
    detail: `${missing} of ${steps}`,
  });
  for (const [label, look] of Object.entries(MANUAL_CHECKS))
    if (byLabel.has(label)) checks.push({ name: `${label} by a reader: ${look}`, pass: null, detail: 'manual' });
  return checks;
}

/** metrics.md: the totals, the pass bar, the per-scenario table, then what was not paired. Pure. */
export function renderMetrics({ pairs, missing, extra }) {
  const sum = (list, pick) => list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
  const side = (name, turns) => {
    const costs = turns.map((turn) => turn.cost).filter(Number.isFinite);
    return `| ${name} | ${turns.length} | ${fmt(mean(turns.map((turn) => turn.requests)))} | ${sum(turns, (t) => t.tokens.prompt)} | ${sum(turns, (t) => t.tokens.completion)} | ${sum(turns, (t) => t.tokens.cacheRead)} | ${sum(turns, (t) => t.tokens.cacheWrite)} | ${
      costs.length > 0
        ? fmt(
            costs.reduce((a, b) => a + b, 0),
            4
          )
        : '-'
    } | ${fmt(mean(turns.map((turn) => turn.cost)), 4)} | ${fmt(mean(turns.map((turn) => turn.ms)), 0)} |`;
  };
  const olds = pairs.map((pair) => pair.old);
  const news = pairs.map((pair) => pair.new);
  const lines = [
    '# Replay comparison: old against new',
    '',
    `${pairs.length} paired scenario(s)${missing.length > 0 ? `; no new run for: ${missing.join(', ')}` : ''}${extra.length > 0 ? `; no old scenario for: ${extra.join(', ')}` : ''}`,
    '',
  ];
  lines.push(
    '## Totals',
    '',
    '| side | turns | mean requests | in | out | cache read | cache written | cost | mean cost | mean ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    side('old', olds),
    side('new', news),
    ''
  );
  lines.push(
    `new side: held-text leaks ${sum(news, (t) => t.leaks)}; held steps ${sum(news, (t) => t.held)}; duplicate effects ${sum(news, (t) => t.duplicates)} (old ${sum(olds, (t) => duplicateEffects(t.calls))}); thinkMissing ${sum(news, (t) => t.thinkMissing)} of ${sum(news, (t) => t.steps)} steps (old ${olds.filter((t) => t.thinkMissing).length} of ${olds.length}); coerced ${sum(news, (t) => t.coerced)}; unreadable or cut-off calls ${sum(news, (t) => t.malformed)}; cap hits ${sum(news, (t) => t.capped)}`,
    ''
  );
  lines.push('## Pass bar', '');
  for (const check of passBar(pairs))
    lines.push(`- ${check.pass === null ? 'MANUAL' : check.pass ? 'PASS' : 'FAIL'}: ${check.name} (${check.detail})`);
  lines.push(
    '',
    '## Per scenario',
    '',
    '| scenario | old calls | new calls (statuses) | leaks | duplicates | requests old/new | in old/new | out old/new | cache read new | cost old/new | ms old/new | think missing | coerced | unreadable | capped |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const { label, old, new: now } of pairs) {
    lines.push(
      `| ${label} | ${callText(old.calls, false)} | ${callText(now.calls, true)} | ${now.leaks} | ${now.duplicates} (${duplicateEffects(old.calls)}) | ${old.requests}/${now.requests} | ${old.tokens.prompt}/${now.tokens.prompt} | ${old.tokens.completion}/${now.tokens.completion} | ${now.tokens.cacheRead} | ${fmt(old.cost, 4)}/${fmt(now.cost, 4)} | ${old.ms ?? '-'}/${now.ms ?? '-'} | ${now.thinkMissing} | ${now.coerced} | ${now.malformed} | ${now.capped} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The tool. Returns `{ code, result }`; nothing is printed here.
 * @param {string[]} argv
 * @param {{ rng?: () => number }} [options]
 */
export function main(argv, { rng = Math.random } = {}) {
  const positional = [];
  let outDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      outDir = argv[(i += 1)];
      if (typeof outDir !== 'string' || outDir === '' || outDir.startsWith('--')) throw new CliError(USAGE);
    } else if (argv[i].startsWith('--')) throw new CliError(USAGE);
    else positional.push(argv[i]);
  }
  if (positional.length !== 2 || outDir === null) throw new CliError(USAGE);
  const [oldDir, newDir] = positional.map((dir) => path.resolve(dir));
  for (const dir of [oldDir, newDir])
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new CliError(`replay-compare: ${dir} is not a folder`);
  const out = path.resolve(outDir);
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new CliError(`replay-compare: ${out} is not empty`);
  const oldSide = readOldSide(oldDir);
  const newSide = readNewSide(newDir);
  if (oldSide.length === 0)
    throw new CliError(`replay-compare: no scenario (ans-001.txt and replay.out) under ${oldDir}`);
  if (newSide.length === 0) throw new CliError(`replay-compare: no runs.jsonl under ${newDir}`);
  const paired = pairSides(oldSide, newSide);
  const order = pairOrder(paired.pairs.length, rng);
  const key = { a: 'old (text tags)', b: 'new (tool calls)', pairs: {} };
  const sheet = paired.pairs.map((pair, index) => {
    const first = order[index];
    key.pairs[pair.label] = { first, triggerId: pair.old.triggerId };
    const context = pair.new.context.length > 0 ? pair.new.context : pair.old.context;
    const answers = { A: pair.old.answer, B: pair.new.answer };
    return { id: pair.label, context, first: answers[first], second: answers[first === 'A' ? 'B' : 'A'] };
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sheet.html'), renderSheet(sheet));
  fs.writeFileSync(path.join(out, 'key.json'), `${JSON.stringify(key, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'metrics.md'), renderMetrics(paired));
  const checks = passBar(paired.pairs);
  return {
    code: checks.some((check) => check.pass === false) ? 1 : 0,
    result: {
      sheet: path.join(out, 'sheet.html'),
      key: path.join(out, 'key.json'),
      metrics: path.join(out, 'metrics.md'),
      pairs: paired.pairs.length,
      missing: paired.missing,
      extra: paired.extra,
      failed: checks.filter((check) => check.pass === false).map((check) => check.name),
    },
  };
}

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { code, result } = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(code);
  } catch (err) {
    process.stderr.write(
      `${err instanceof CliError ? err.message : `replay-compare: ${err?.name ?? 'Error'}: ${err?.message ?? err}`}\n`
    );
    process.exit(err instanceof CliError ? err.exitCode : 1);
  }
}
