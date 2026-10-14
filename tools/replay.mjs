#!/usr/bin/env node
// Operations tool. One purpose: replay a real or a scheduled turn of the
// engine without side effects, with the working tree's code, prompts and
// memory, and print what the persona would do now and what her request looked
// like. Four modes:
// - a message: one real message answered again (or its splitter, its server
//   search, or the request a journal turn sent);
// - a pair of prompt layers (`--pair`): the same triggers answered with two
//   prompt directories, on a blind sheet;
// - a diary brief (`--diary`): the diary's scheduled turn run in the diary
//   channel, its plan and drawing brief reported;
// - skill scenarios (`--skills`): an invented request put to the persona
//   after a real chat, with her skills shown, to see whether she uses one or
//   declines; her calls pass the real gateway and never run.
// Exists so a prompt or profile change can be checked against real moments
// before it is deployed.
//
// Not for: measuring what the analyzer does to memory (tools/memory-sim.mjs);
// reading the journal's day numbers (tools/journal-report.mjs).
//
//   cd /opt/neptunia-bot && node tools/replay.mjs <channelId> <triggerMessageId>
//        [--before 40] [--samples 1] [--show-request] [--as-of-moment]
//        [--hide-self <substring>]... [--hide-self-all] [--snapshot <dir>] [--spend <usd>]
//   cd /opt/neptunia-bot && node tools/replay.mjs <channelId> <triggerMessageId> --split
//        [--text "<candidate text>"] [--before <split.contextMessages>] [--samples 3] [--spend <usd>]
//   cd /opt/neptunia-bot && node tools/replay.mjs <channelId> <triggerMessageId> --recall
//        [--text "<candidate text>"] [--before <context.channelMessages - 1>] [--budget <ms>] [--show-request] [--spend <usd>]
//   cd /opt/neptunia-bot && node tools/replay.mjs --pair <promptsDirA> <promptsDirB>
//        (--triggers <file> | <channelId> <triggerMessageId>) [--before 40] [--as-of-moment]
//        [--snapshot <dir>] [--out <dir>] [--spend <usd>]
//   cd /opt/neptunia-bot && node tools/replay.mjs --show-request <turnId> [--snapshot <dir>] [--before 40] [--as-of-moment]
//   cd /opt/neptunia-bot && node tools/replay.mjs --diary <selfPicture|picture> [--count 1] [--topic "<text>"]
//        [--prompts <dir>] [--out <file>] [--spend <usd>]
//   cd /opt/neptunia-bot && node tools/replay.mjs --skills <scenarios.json> [--out <dir>] [--before 40]
//        [--as-of-moment] [--snapshot <dir>] [--dry] [--spend <usd>]
//
// The spend gate (tools/lib/cli.mjs#spendGate): every mode that sends model
// requests prints its estimate first (~USD_PER_ANSWER per request: a persona
// answer, a splitter sample, the recall classifier and its summary, a diary
// brief's plan and compose requests, a skill run's answer and its possible
// follow-up) and refuses, exit code 2, without `--spend <usd>` covering it.
// `--skills` also stops once what the provider reports spent (`usage.cost`,
// else the estimate per request) reaches `--spend`.
//
// `--skills <file>`: a JSON array of scenarios (tools/prompts/skill-scenarios.example.json
// shows the shape; parseScenarios checks it), each `{ id, channelId, before?,
// author, text, grants, runs?, result?, discovery? }`. For each one: the last
// `--before` messages of the channel up to and including the message `before`
// names (omitted: the newest ones), fetched and normalized as in the message
// mode; then `text` as a new message by the member `author` (their real
// profile and attitude), one minute after that message (now, without
// `before`), calling the persona by a tag (a `mention`, no reply). The
// persona's grants are exactly `grants` in a copy of the config (never
// written; src/behavior/sandbox.js#personaGrantsConfig): skill names, groups
// and `*` expanded as `/nep access grant` expands them for her
// (src/ops/access.js#expandPersonaGrant: a group or `*` is its read skills); a
// name no grant opens for her is kept, so the gateway refuses it as live.
// Her `<skills>` block is the catalogue of that requester as the live turn
// lists it (src/behavior/sandbox.js#scenarioInventory): whole, as after
// `skills: inventory` (`discovery` "inventory", the default), the named ones
// (`discovery` a list of up to four names, as after `skills: <names>`), or
// none ("none"). Answered `runs` times (1..10, default 1) in the sandbox
// (src/behavior/sandbox.js#answerSkillScenario). A `<call>` is resolved and
// checked as live (#simulateCall: src/skills/executors.js#resolveCall over
// the guild's channels, roles and stored members, src/skills/gateway.js#checkSkill
// with the requester's real role ids, the image quota read from a copy of
// the state); the operation never runs: a call that passed is recorded and
// answered `ok` with `result` (the text an operation would have answered,
// '' when omitted); a refusal is answered as live. When a live turn would
// ask her again (any refusal; an `ok` of an operation other than a message,
// a reaction or a picture) the follow-up request is sent too, framed as the
// live turn frames it under the config read: with features.followUpContinuation
// on (a missing key counts as on) the turn continued over her lines with the
// call's mark, off the reply request again with a `<result>` block -- set it
// in config.local.json to compare the two; each run line says which
// (`followUp.continuation`).
// Written to `--out` (default ./replay-skills-<time>/, refused under data/
// and when it exists and is not empty): `runs.jsonl` (one line per run:
// decision `call` / `no-call` / `malformed-call`, the skill with the
// arguments she wrote and the resolved ones, the gateway's verdict, her
// visible messages of both passes, tokens and cost) and `report.md` (a table
// per scenario: calls, runs without a call, refusals, then every run).
// stdout: the summary. `--dry`: no model request and no key needed; the
// first request of every scenario is built and its sizes printed.
// THE FILES HOLD MESSAGE CONTENTS: the server's eyes only, like stdout.
//
// Prompt layers (tools/lib/prompt-layers.mjs#promptLayersHot, the one helper
// for both modes that take a prompt directory): a scratch copy of the config
// files and the tracked prompts/, with directories copied into prompts.local/
// in order and read by src/hot.js as the bot reads its own. `--pair` gives
// each side its directory alone as prompts.local/; `--diary --prompts <dir>`
// lays the directory over the live prompts.local/ (a file of the same name
// replaces it whole, labels.json included). Nothing in the checkout changes.
//
// `--diary <kind>`: `--count` briefs (1..50) of one diary kind, each one
// `runTurn({ channel, mode: 'diary', diary: { kind, [topic], forced: false } })`
// of the real turn runner (src/behavior/turn.js, wired as src/index.js wires
// it) in the diary channel (`diary.channelId`): the plan request on the
// classifier model with the given kind the only one offered (as `/nep diary
// post <kind>` does; `forced: false` keeps the compose request a scheduled
// post's), then the compose request on the voice model. Not the sandbox: the
// sandbox never builds a diary post (src/behavior/sandbox.js#SANDBOX_OMITS).
// `--topic`: the owner's topic as `/nep diary post <kind> <topic>` threads it
// (trimmed, blank is none, then src/behavior/diary.js#diaryTopic). What keeps
// the bot and its memory untouched here: hot is seen with
// `features.dryRun = true` and `bot.dryRunChannelId = ''` (the turn ends in
// its dry-run branch: nothing acted, drawn, recorded or mirrored); every
// Discord REST call but GET is refused and the channel's send / sendTyping
// throw; the store is the real one with an in-memory copy of its state that
// is never flushed (flush, forget, wipe and reload methods throw); the image
// client keeps its quota and refuses to generate; in that in-memory state
// only, today's diary picture and image counts read 0 so the picture gate
// opens. Requests carry `origin: 'replay'` and never count against
// `llm.maxRequestsPerDay`. Output: the briefs `[{ kind, plan, self, request,
// messages, outcome }]` (request = the first `<draw>` scene text, self its
// self flag, messages the post's `<msg>` texts after the diary's filters) to
// `--out <file>` (rewritten after each brief; refused under data/) with a
// summary on stdout, else on stdout. Exit code 1 when no brief drew.
//
// `--snapshot <dir>`: the memory is read from a snapshot of data/ (written by
// `/nep memory snapshot`, or an unpacked stop-backup) instead of the live
// data/, read only as ever.
//
// `--pair <promptsDirA> <promptsDirB>`: the same triggers answered twice, once
// with each prompt layer: each directory is laid over the tracked prompts/
// exactly as prompts.local/ is at runtime (so `--pair prompts prompts` gives
// two identical sides: the harness check, which must score even). The
// triggers: a file of lines `<channelId> <triggerMessageId> [<turnId>]`
// (`--triggers`, tools/lib/pair.mjs#parseTriggers), or one trigger as
// positionals. Both sides share everything else: the fetched chat, the memory
// (`--snapshot`), the clock (the trigger's moment), `--as-of-moment`, the
// config, the model, one sample each. Tool results: the sandbox runs no tool
// (see "Left out" below), so neither side gets any; when a line names its
// `turnId`, the journal's action records of that turn (data/guilds/<g>/journal,
// read only) are copied into key.json so the owner sees which tools the live
// turn ran. Per pair the side shown first is drawn at random. Written to
// `--out` (default ./replay-pair-<time>/, refused when it exists and is not
// empty): `sheet.html` (the blind sheet: each pair's chat, then the two
// answers as "1" and "2", nothing saying which side is which, a choice per
// pair and a button that writes the scores as JSON) and `key.json` (`{ a, b,
// pairs: { <pairId>: { first, channelId, triggerId, turnId, journalActions } } }`).
// tools/replay-score.mjs tallies the scores. stdout: one JSON object with the
// paths, the pair count, the failed pairs and the usage.
//
// `--show-request <turnId>`: no model request. Prints the request dumps of
// that turn when the journal kept them (data/guilds/<g>/journal/requests/<day>/
// <turnId>-<attempt>.json, every attempt; `source: 'dump'`); else rebuilds it
// (`source: 'rebuilt'`, with a note saying so): the turn's `turn.start` record
// gives the channel, the trigger message, the mode and the trigger kind; the
// chat is fetched as below and the sandbox request (see "Left out") is built
// with the memory of `--snapshot` (else the live data/), never sent. Without
// a turnId after it, `--show-request` is the switch it always was.
//
// The engine's modules are imported from the current working directory
// (`<cwd>/src/...`), so the same file works wherever it is placed.
//
// What it does:
// - Fetches over REST the trigger and the `--before` messages preceding it,
//   oldest first, normalized exactly as a live history is
//   (src/discord/collect.js#fetchHistoryWindow -> normalizeMessage): ids,
//   authors (display names as the live client resolves them: every author and
//   mentioned member is fetched over REST one by one before the messages are
//   normalized), the persona's own messages marked `self`, reply references,
//   mentions, attachment / embed / sticker labels, reactions. Pictures are
//   never downloaded or described; the describer's cached captions and watched
//   summaries are rendered as the live transcript renders them
//   (src/behavior/sandbox.js#replayMedia, every entry the cache holds now).
// - Answers it in the replay sandbox (src/behavior/sandbox.js#answerReply
//   with `{ history, triggerId, kind, mode }`) at the trigger's time. The
//   trigger kind and mode come from the journal's newest `turn.start` record
//   whose trigger is this message (data/guilds/<g>/journal, read only);
//   otherwise the sandbox guesses: `reply` when the trigger replies to the
//   persona, else `mention`.
// - Memory: the live view (src/behavior/sandbox.js#liveView: data/, the live
//   config.local.json and prompts.local/), except that `<recent>` never shows
//   lines the analyzer added at or after the trigger (they describe what came
//   after it). `--as-of-moment` hides every dated item written at or after
//   the trigger instead (src/behavior/sandbox.js#momentView) and reports what
//   was hidden.
// - `--hide-self <substring>` (repeatable) leaves out of the request every
//   self fact of the guild memory (`getGuild().self`) that contains any given
//   substring (case-insensitive); `--hide-self-all` leaves out every self
//   fact. Either way it works on a copy of the guild memory (the store's own
//   arrays are never touched) and the output reports `hiddenSelf: <count>`.
//   It applies on top of both memory modes above.
//
// `--split`: no reply at all. Sends instead, `--samples` times (default 3:
// the classifier is not deterministic), the very request a live turn's
// splitter sends (src/behavior/turn.js#maybeSplit): system = prompts.split
// (the live layers, prompts.local/ first) with `{{name}}` and `{{maxTasks}}`
// filled; user = the `<transcript>` of the last `split.contextMessages`
// fetched messages before the trigger (src/behavior/prompt.js#classifierTranscript,
// the describer's cached captions when features.mediaDescriptions is on)
// and the `<candidate>` line; on the analyzer model (roleModel) with
// helperRequestOptions (role `analyzer`, `split.maxOutputTokens`,
// purpose `split`); each answer parsed by src/behavior/split.js#parseSplitAnswer.
// `--text "<candidate text>"` replaces the trigger's content (same author,
// same time, same lines before it), so an invented message is tested in the
// real channel's context. `--before` defaults to `split.contextMessages`
// here. The output says whether a live turn would ask at all
// (splitCandidate, labels.task.part); the request is sent either way, so the
// prompt can be tested. Only --text / --before / --samples go with it. No
// cache marker on any of these requests.
//
// `--recall`: no reply either. Reproduces the server search of a live turn
// (src/behavior/turn.js#maybeLookup) for the trigger, or for `--text` in its
// place (same author, time and lines before it, as with --split):
// 1. the search classifier's request, once: system = prompts.lookup with
//    `{{name}}` and `{{today}}` (the trigger's day in `bot.timezone`); user =
//    the `<transcript>` of the last `web.search.contextMessages` fetched
//    messages before the trigger (cached captions with
//    features.mediaDescriptions on, cached video states with video vision on,
//    cached link reads with features.webLookup and web.links on) and the
//    `<candidate>` line; on the reasoner model (roleModel) with helperRequestOptions
//    (role `reasoner`, `web.search.classifierMaxOutputTokens`, purpose
//    `lookup`); the answer parsed by src/behavior/recall.js#parseLookupAnswer
//    at the trigger's time;
// 2. when the answer has a server part, the `run()` of
//    src/behavior/recall-run.js#createRecall with the turn's arguments (the
//    served guild, this channel, the persona's id and name, `history` = the
//    fetched lines, `candidate` = the trigger, `server` = the parsed part),
//    over REST: the member and message searches (src/discord/search.js), the
//    pull rail toward this channel, the windows, the summary request
//    (prompts/recall-summary.md, purpose `recall-summary`). Its clock starts
//    at the trigger's moment (the summary's `{{today}}`, the recent-lines
//    window and the pull rail's age read as the live turn read them);
//    `recall.timeoutMs` is its budget, `--budget <ms>` overrides it. Memory:
//    the live store read only (profiles, lore, learned items; `<recent>`
//    without the lines added at or after the trigger); the daily recall
//    counter is a private copy (the store's is never bumped), and nothing
//    runs when `recall.maxPerDay` is already spent today on the real counter.
// The windows (`clusters`), the stored notes (`memory`) and the number of the
// stretch the summary named are read back from the summary request as sent
// (its `<memory>` and `<found>` blocks), so they are exactly what the summary
// saw; a line of a message with line breaks is shown with the message line
// before it (a gap or date marker too: the text cannot tell them apart). With no summary request (skipped for
// lack of time, or nothing found) there are no clusters to show. Also
// printed: every Discord search with its query and hit count, the hits per
// channel with the pull rail's verdict, whether the run's deadline fired,
// and whether the classifier plus the search would have come in after the
// turn's `pace.prepareSearchMs` (`late`; a live turn's history fetch and file
// previews are not counted). `--before` defaults to `context.channelMessages`
// - 1 (the live history, the trigger included): the search never looks past
// the oldest line of that chat. `--show-request` adds both requests. Left
// out, unlike a live turn: file previews in the transcript, the web search
// (the classifier's `web` line is printed, not run), a routed call, a private
// chat; no prompt-cache marker. Exit code 1 when the classifier fails or the
// run is stopped.
//
// Left out, unlike a live turn (the sandbox does none of it): no web search
// or link reading, no server recall, no pictures sent to the model, no
// neighbouring channels or pulled channels, no variety pass (`<worn>`), no
// owner-forced text, no private chat, no line on where a read-only channel's
// call is answered. `<senses>` still says whether a search key is configured
// (BRAVE_SEARCH_API_KEY present), as a live turn's does; no search is run.
//
// What keeps the running bot undisturbed: no gateway session (a discord.js
// Client that never logs in, its token on REST only); the memory store is the
// real one behind a wrapper that passes only the sandbox's read methods and
// refuses every write; the llm client counts on an in-memory copy of the
// daily counters and every request goes out with `countAgainstDailyCap:
// false`, `skipCalibration: true`, `origin: 'replay'`; with one sample no
// prompt-cache marker is sent at all (a cache write would cost more and serve
// nothing). `--recall` sends Discord's own searches (GET only) and reads the
// media cache through a private copy. Nothing is written anywhere and nothing
// is posted.
//
// Output: every log line (the engine's JSON lines included) goes to stderr;
// stdout carries exactly one JSON object. THIS TOOL PRINTS MESSAGE CONTENTS
// AND MEMORY ABOUT REAL PEOPLE (the answers, the `<people>` block, the lines
// the server search found and, with `--show-request`, the whole request): it
// is a diagnostic for the owner's
// and the lead's eyes on the server; never paste its output into a commit, an
// issue or a chat. It never prints a token. Exit code 0 on success, 1 on any
// error (the message on stderr). Ctrl-C once stops the sampling; twice exits.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
// CliError: an operator-facing failure, printed as is, exit code `exitCode` (1 unless the spend gate refused: 2).
import { CliError, REFUSED_EXIT, resolveGuildId, spendGate } from './lib/cli.mjs';
import { pairOrder, parseTriggers, renderSheet } from './lib/pair.mjs';
import { promptLayersHot } from './lib/prompt-layers.mjs';

const USAGE =
  'usage: node tools/replay.mjs <channelId> <triggerMessageId> [--before 40] [--samples 1] [--show-request] [--as-of-moment] [--hide-self <substring>]... [--hide-self-all] [--snapshot <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs <channelId> <triggerMessageId> --split [--text "<candidate text>"] [--before <split.contextMessages>] [--samples 3] [--spend <usd>]\n' +
  '       node tools/replay.mjs <channelId> <triggerMessageId> --recall [--text "<candidate text>"] [--before <context.channelMessages - 1>] [--budget <ms>] [--show-request] [--spend <usd>]\n' +
  '       node tools/replay.mjs --pair <promptsDirA> <promptsDirB> (--triggers <file> | <channelId> <triggerMessageId>) [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --show-request <turnId> [--snapshot <dir>] [--before 40] [--as-of-moment]\n' +
  '       node tools/replay.mjs --diary <selfPicture|picture> [--count 1] [--topic "<text>"] [--prompts <dir>] [--out <file>] [--spend <usd>]\n' +
  '       node tools/replay.mjs --skills <scenarios.json> [--out <dir>] [--before 40] [--as-of-moment] [--snapshot <dir>] [--dry] [--spend <usd>]   (cwd: the bot directory)';
/** The diary kinds a brief is asked of: the ones that draw. */
const DIARY_KINDS = Object.freeze(['selfPicture', 'picture']);
/** A diary brief's requests: the plan (classifier model) and the compose (voice model). */
const DIARY_REQUESTS_PER_BRIEF = 2;
const MAX_DIARY_COUNT = 50;
/** The estimate per model request this tool sends: about what a persona answer costs on the live key. */
const USD_PER_ANSWER = 0.15;
/** A journal turn id (src/memory/journal.js#start). */
const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;
/** A recall run's requests at most: the classifier and the summary. */
const RECALL_REQUESTS = 2;
const SNOWFLAKE = /^\d{17,20}$/;
const DEFAULT_BEFORE = 40;
const MAX_BEFORE = 500;
const DEFAULT_SAMPLES = 1;
const DEFAULT_SPLIT_SAMPLES = 3;
const MAX_SAMPLES = 10;
const MAX_BUDGET_MS = 600000;


/** A deep-frozen copy of a JSON value. */
function frozenCopy(value) {
  const copy = value === undefined ? {} : structuredClone(value);
  const freeze = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const item of Object.values(v)) freeze(item);
    }
    return v;
  };
  return freeze(copy);
}

/**
 * The real store with every write refused: the methods in `reads` pass
 * through; any other method throws; `state` is a frozen copy whose
 * `markDirty` throws. Nothing is ever flushed from here.
 * @param {object} store  From src/memory/store.js#createStore.
 * @param {readonly string[]} reads
 */
function readOnlyStore(store, reads) {
  const refused = (name) => () => {
    throw new Error(`replay-cli: the memory store is read-only here (${name} refused)`);
  };
  const out = {};
  for (const key of Object.keys(store)) {
    if (key === 'state') continue;
    if (typeof store[key] !== 'function') continue;
    out[key] = reads.includes(key) ? (...args) => store[key](...args) : refused(key);
  }
  const data = frozenCopy(store.state?.data);
  out.state = {
    get data() {
      return data;
    },
    markDirty: refused('state.markDirty'),
  };
  return out;
}

/** A whole number in [min, max] from a flag's value, or a CliError with the usage. */
function intFlag(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(USAGE);
  return n;
}

/**
 * A view of the same shape as `view` whose guild memory lacks the self facts
 * that match: every one when `all`, else those containing any of `needles`
 * (lower-cased; compared case-insensitively). `getGuild` returns a shallow
 * copy with a new `self` array; the store's own guild object and array are
 * never mutated. Returns `{ view, hidden }` with the number of facts left out
 * (counted on the guild memory as it stands now).
 */
function withoutSelfFacts(view, { all, needles }) {
  const keeps = (fact) => {
    if (all) return false;
    if (typeof fact !== 'string') return true;
    const text = fact.toLowerCase();
    return !needles.some((needle) => text.includes(needle));
  };
  const filtered = (guild) => {
    const self = Array.isArray(guild?.self) ? guild.self : null;
    return self ? { ...guild, self: self.filter(keeps) } : guild;
  };
  const before = view.memory.getGuild();
  const hidden = Array.isArray(before?.self) ? before.self.filter((fact) => !keeps(fact)).length : 0;
  return {
    hidden,
    view: {
      get prompts() {
        return view.prompts;
      },
      get config() {
        return view.config;
      },
      get calibrator() {
        return view.calibrator;
      },
      memory: { ...view.memory, getGuild: () => filtered(view.memory.getGuild()) },
    },
  };
}

/**
 * `argv` (after the script) as `{ channelId, triggerId, before, samples,
 * showRequest, asOfMoment, hideSelf, hideSelfAll, split, recall, budget, text }`
 * (`hideSelf`: the substrings, lower-cased; `before` null when not given:
 * the caller picks the mode's default; `text` null without `--text`;
 * `budget` null without `--budget`); throws a CliError with the usage.
 * `--split` takes no reply-mode flag; `--recall` takes only `--text`,
 * `--before`, `--budget` and `--show-request`; `--text` needs `--split`
 * or `--recall`, `--budget` needs `--recall`. Also `pair` ([dirA, dirB] or
 * null), `triggers` (a file, with `--pair` only), `snapshot`, `outDir` (with
 * `--pair` only), `spend` (the raw `--spend` value, undefined when absent) and
 * `showRequestTurn` (`--show-request <turnId>`: no positionals, no mode flag).
 * `--diary <kind>` sets `diary` (one of DIARY_KINDS) and takes only `--count`
 * (`count`, 1 by default), `--topic` (`topic`, raw), `--prompts` (`prompts`),
 * `--out` (`outDir`: the briefs file) and `--spend`; those three take nothing
 * else. `--skills <file>` sets `skills` (the scenario file) and takes only
 * `--out`, `--before`, `--as-of-moment`, `--snapshot`, `--spend` and `--dry`
 * (`dry`, only with it); no positionals.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    before: null, samples: null, showRequest: false, asOfMoment: false, hideSelf: [], hideSelfAll: false, split: false, recall: false, budget: null, text: null,
    pair: null, triggers: null, snapshot: null, outDir: null, spend: undefined, showRequestTurn: null,
    diary: null, count: null, topic: null, prompts: null, skills: null, dry: false,
  };
  const positional = [];
  const pathValue = (value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new CliError(USAGE);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--show-request') {
      // `--show-request <turnId>`: the stored or rebuilt request of a journal turn; bare, the old switch.
      if (TURN_ID.test(argv[i + 1] ?? '')) out.showRequestTurn = argv[(i += 1)];
      else out.showRequest = true;
    } else if (arg === '--pair') out.pair = [pathValue(argv[(i += 1)]), pathValue(argv[(i += 1)])];
    else if (arg === '--triggers') out.triggers = pathValue(argv[(i += 1)]);
    else if (arg === '--snapshot') out.snapshot = pathValue(argv[(i += 1)]);
    else if (arg === '--out') out.outDir = pathValue(argv[(i += 1)]);
    else if (arg === '--spend') out.spend = pathValue(argv[(i += 1)]);
    else if (arg === '--skills') out.skills = pathValue(argv[(i += 1)]);
    else if (arg === '--dry') out.dry = true;
    else if (arg === '--as-of-moment') out.asOfMoment = true;
    else if (arg === '--hide-self-all') out.hideSelfAll = true;
    else if (arg === '--split') out.split = true;
    else if (arg === '--recall') out.recall = true;
    else if (arg === '--budget') out.budget = intFlag(argv[(i += 1)], 1, MAX_BUDGET_MS);
    else if (arg === '--diary') {
      const kind = argv[(i += 1)];
      if (!DIARY_KINDS.includes(kind)) throw new CliError(USAGE);
      out.diary = kind;
    } else if (arg === '--count') out.count = intFlag(argv[(i += 1)], 1, MAX_DIARY_COUNT);
    else if (arg === '--prompts') out.prompts = pathValue(argv[(i += 1)]);
    else if (arg === '--topic') {
      const topic = argv[(i += 1)];
      if (typeof topic !== 'string') throw new CliError(USAGE);
      out.topic = topic;
    }
    else if (arg === '--text') {
      const text = argv[(i += 1)];
      if (typeof text !== 'string' || text.trim() === '') throw new CliError(USAGE);
      out.text = text;
    }
    else if (arg === '--hide-self') {
      const needle = argv[(i += 1)];
      if (typeof needle !== 'string' || needle.trim() === '' || needle.startsWith('--')) throw new CliError(USAGE);
      out.hideSelf.push(needle.toLowerCase());
    } else if (arg === '--before') out.before = intFlag(argv[(i += 1)], 0, MAX_BEFORE);
    else if (arg === '--samples') out.samples = intFlag(argv[(i += 1)], 1, MAX_SAMPLES);
    else if (arg.startsWith('--')) throw new CliError(USAGE);
    else positional.push(arg);
  }
  const [channelId, triggerId, extra] = positional;
  if (out.skills !== null) {
    // The scenario file with the memory and output flags, --spend and --dry only; no positionals.
    if (
      positional.length > 0 || out.diary !== null || out.showRequestTurn !== null || out.showRequest || out.pair || out.triggers !== null || out.split || out.recall ||
      out.samples !== null || out.text !== null || out.budget !== null || out.hideSelfAll || out.hideSelf.length > 0 || out.count !== null || out.topic !== null || out.prompts !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: 1, channelId: null, triggerId: null };
  }
  if (out.dry) throw new CliError(USAGE);
  if (out.diary !== null) {
    // The diary flags, --out and --spend only; no positionals.
    if (
      positional.length > 0 || out.showRequestTurn !== null || out.showRequest || out.pair || out.triggers !== null || out.split || out.recall || out.samples !== null ||
      out.text !== null || out.budget !== null || out.hideSelfAll || out.hideSelf.length > 0 || out.asOfMoment || out.before !== null || out.snapshot !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, count: out.count ?? 1, samples: 1, channelId: null, triggerId: null };
  }
  if (out.count !== null || out.topic !== null || out.prompts !== null) throw new CliError(USAGE);
  if (out.showRequestTurn !== null) {
    // Only the memory and history flags go with it; no model request is made.
    if (positional.length > 0 || out.showRequest || out.pair || out.triggers || out.split || out.recall || out.samples !== null || out.text !== null || out.budget !== null || out.hideSelfAll || out.hideSelf.length > 0 || out.outDir) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: DEFAULT_SAMPLES, channelId: null, triggerId: null };
  }
  if (out.pair) {
    // Reply mode only, one sample per side; the triggers from the file or the two positionals.
    if (out.split || out.recall || out.samples !== null || out.showRequest || out.text !== null || out.budget !== null || out.hideSelfAll || out.hideSelf.length > 0) throw new CliError(USAGE);
    if (out.triggers !== null ? positional.length > 0 : extra !== undefined || !SNOWFLAKE.test(channelId ?? '') || !SNOWFLAKE.test(triggerId ?? '')) throw new CliError(USAGE);
    return { ...out, samples: 1, channelId: channelId ?? null, triggerId: triggerId ?? null };
  }
  if (out.triggers !== null || out.outDir !== null) throw new CliError(USAGE);
  if (extra !== undefined || !SNOWFLAKE.test(channelId ?? '') || !SNOWFLAKE.test(triggerId ?? '')) throw new CliError(USAGE);
  if (out.split && (out.showRequest || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0)) throw new CliError(USAGE);
  if (out.split && out.recall) throw new CliError(USAGE);
  if (out.recall && (out.samples !== null || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0)) throw new CliError(USAGE);
  if (out.text !== null && !out.split && !out.recall) throw new CliError(USAGE);
  if (out.budget !== null && !out.recall) throw new CliError(USAGE);
  return { ...out, samples: out.samples ?? (out.split ? DEFAULT_SPLIT_SAMPLES : DEFAULT_SAMPLES), channelId, triggerId };
}

/** The `<tag>` block of a request's user text, whole (tags included); null when it has none. */
function blockOf(text, tag) {
  const match = new RegExp(`(?:^|\\n\\n)(<${tag}>\\n[\\s\\S]*?\\n</${tag}>)(?=\\n\\n|$)`).exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * The journal's newest `turn.start` record whose trigger is `triggerId` (a
 * turn that answered this message), or null.
 * @param {object[]} records  The journal's records, oldest first (journalRecords).
 * @param {string} triggerId
 */
function turnStartForTrigger(records, triggerId) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.kind === 'turn.start' && record.trigger?.messageId === triggerId) return record;
  }
  return null;
}

/**
 * A REST-only Discord connection: no login, no gateway, no event handler.
 * Fetches the served guild (`bot.guildId`, else the only guild the bot is
 * in), its channels (so `#channel` mentions and categories resolve as in the
 * live cache), its custom emoji, the bot's own user and member.
 */
async function connectDiscord({ discord, token, configuredGuildId, resolveGuild, log }) {
  const { Client, Routes } = discord;
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  try {
    const guilds = await client.rest.get(Routes.userGuilds());
    const resolved = resolveGuild(configuredGuildId, (Array.isArray(guilds) ? guilds : []).map((g) => ({ id: g.id, name: g.name })));
    if (resolved.error) throw new CliError(`replay-cli: ${resolved.error}`);
    const guildId = resolved.guildId;
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    try {
      await guild.emojis.fetch();
    } catch (err) {
      log.warn('replay-cli: the custom emoji cannot be fetched', { errorName: err?.name, statusCode: err?.status });
    }
    const me = await client.rest.get(Routes.user());
    try {
      client.user = new discord.ClientUser(client, me);
    } catch {
      // Only `guild.members.me` needs it; nothing here reads it.
    }
    // A reaction's emoji getter reads `client.application.emojis`; without a gateway login the application is null.
    try {
      if (!client.application) client.application = new discord.ClientApplication(client, { id: me.id });
    } catch (err) {
      log.warn('replay-cli: the application object cannot be built', { errorName: err?.name });
    }
    let member = null;
    try {
      member = await guild.members.fetch(me.id);
    } catch (err) {
      log.warn('replay-cli: the bot member cannot be fetched, using the user name', { errorName: err?.name, statusCode: err?.status });
    }
    const self = { id: String(me.id), name: member?.displayName ?? me.username ?? 'bot' };
    log.info('replay-cli: discord over REST', { guildId, channels: channels.size, emoji: guild.emojis.cache.size, self: self.id });
    return { client, guild, guildId, self };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/**
 * Puts every member in `ids` into the guild's member cache, one REST call
 * each (`GET /guilds/{id}/members/{user}`; the list form would need the
 * gateway), so normalizeMessage reads their display names. A member who left
 * stays unresolved (the user's own name is used). Returns the counts.
 */
async function cacheMembers(guild, ids) {
  let fetched = 0;
  let missing = 0;
  for (const id of ids) {
    if (guild.members.cache.has(id)) continue;
    try {
      await guild.members.fetch(id);
      fetched += 1;
    } catch {
      missing += 1;
    }
  }
  return { fetched, missing };
}

/**
 * The `--split` mode: the request src/behavior/turn.js#maybeSplit sends for
 * `trigger` (its classifierContext rebuilt here: the trigger's text cut to
 * `context.maxMessageChars`, the last `split.contextMessages` messages of
 * `history` other than the trigger in a `<transcript>` block), sent
 * `samples` times one after another, each answer parsed. A failed request
 * is a verdict with `reason: 'failed'` and its rail code; any failure or a
 * stop makes the code 1. Returns `{ code, result }`.
 */
async function runSplit({ hot, mods, llm, history, trigger, triggerKind, kindFrom, selfName, descriptions, samples, signal }) {
  const { splitSettings, splitCandidate, mayHaveParts, parseSplitAnswer, fillPromptTemplate, classifierTranscript, roleModel, helperRequestOptions, railReason } = mods;
  const config = hot.config;
  const prompt = hot.prompts?.split;
  if (!prompt) throw new CliError('replay-cli: prompts.split is missing (prompts/split.md or prompts.local/split.md)');
  const labels = hot.prompts?.labels;
  const settings = splitSettings(config);

  // src/behavior/turn.js#classifierContext with the splitter's arguments (no videos, no reads).
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
  const context = settings.contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-settings.contextMessages) : [];
  const transcriptBlock =
    context.length === 0 ? '' : `<transcript>\n${classifierTranscript(context, { config, selfName, labels, descriptions })}\n</transcript>\n`;
  const system = fillPromptTemplate(prompt, { name: selfName ?? '', maxTasks: settings.maxTasks });
  const user = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;
  const model = roleModel(config, 'analyzer', 'split');

  // Whether a live turn would ask at all (the gate in runTurnOnce), with the reasons when not.
  const candidate = splitCandidate(trigger, triggerKind, config);
  const textPasses = mayHaveParts(trigger.content, settings.minChars);
  const labelsPart = Boolean(labels?.task?.part);
  const notAsked = [];
  if (config?.features?.splitTasks === false) notAsked.push('feature-off');
  if (!['mention', 'reply', 'name', 'followUp', 'private'].includes(triggerKind)) notAsked.push('trigger-kind');
  if (settings.maxTasks < 2) notAsked.push('max-tasks');
  if (!textPasses) notAsked.push('text-too-short-or-one-sentence');
  if (!labelsPart) notAsked.push('no-labels-task-part');

  const verdicts = [];
  let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  let failed = false;
  let stopped = false;
  for (let i = 0; i < samples; i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const startedAt = Date.now();
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model,
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: settings.maxOutputTokens, purpose: 'split', signal }),
        },
      );
      const u = completion?.usage;
      usage = {
        requests: usage.requests + 1,
        promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
        completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
      };
      const { parts, reason } = parseSplitAnswer(completion?.text, settings.maxTasks);
      verdicts.push({ raw: completion?.text ?? null, parts, reason, ms: Date.now() - startedAt });
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      failed = true;
      verdicts.push({ raw: null, parts: null, reason: 'failed', error: railReason(err), status: err?.statusCode ?? null, ms: Date.now() - startedAt });
    }
  }

  return {
    code: failed || stopped ? 1 : 0,
    result: {
      trigger: {
        id: trigger.id,
        author: trigger.authorName ?? null,
        at: Number.isFinite(trigger.ts) ? new Date(trigger.ts).toISOString() : null,
        kind: triggerKind ?? null,
        kindFrom,
      },
      text: String(trigger.content ?? ''),
      mayHaveParts: {
        wouldAsk: candidate && labelsPart,
        splitCandidate: candidate,
        textPasses,
        notAsked,
        settings,
      },
      model: model ?? null,
      contextLines: context.length,
      verdicts,
      stopped,
      usage,
      request: { system, user },
    },
  };
}

/** The state.json fields of the daily recall counter (src/behavior/recall-run.js RECALL_DAILY). */
const RECALL_DAILY = Object.freeze({ dayKey: 'recallDay', countKey: 'recallCount' });
/** The heading of a `<found>` section (src/behavior/recall.js#buildRecallRequest): `## n | YYYY-MM-DD | #channel`. */
const FOUND_HEADER_RE = /^## (\d+) \| (\d{4}-\d{2}-\d{2}) \| #(.*)$/;
/**
 * The mark src/behavior/recall.js#renderRecallWindows puts before the LAST
 * line of a message the search matched (recall.js HIT_MARK): the `#n [` line
 * of a one-line message, the last line of a message with line breaks.
 */
const FOUND_HIT = '>> ';
/** A message line of a `<found>` section: `#n [`, after the hit mark on a matched one-line message. */
const FOUND_LINE_RE = /^(>> )?#\d+ \[/;

/**
 * The engine functions --recall uses, named one by one (no module spread: two
 * modules may export the same name). A missing one is a CliError.
 */
async function loadRecallMods(load) {
  const recall = await load('behavior/recall.js');
  const runner = await load('behavior/recall-run.js');
  const prompt = await load('behavior/prompt.js');
  const roles = await load('llm/roles.js');
  const openrouter = await load('llm/openrouter.js');
  const time = await load('time.js');
  const turn = await load('behavior/turn.js');
  const describe = await load('memory/describe.js');
  const lookup = await load('web/lookup.js');
  const media = await load('discord/media.js');
  const pull = await load('discord/pull-fetch.js');
  const youtube = await load('memory/youtube-check.js');
  const mods = {
    parseLookupAnswer: recall.parseLookupAnswer,
    recallSettings: recall.recallSettings,
    parseRecallAnswer: recall.parseRecallAnswer,
    createRecall: runner.createRecall,
    classifierTranscript: prompt.classifierTranscript,
    fillPromptTemplate: prompt.fillPromptTemplate,
    roleModel: roles.roleModel,
    helperRequestOptions: openrouter.helperRequestOptions,
    railReason: openrouter.railReason,
    zonedDay: time.zonedDay,
    countToday: time.countToday,
    paceSettings: turn.paceSettings,
    createDescriber: describe.createDescriber,
    createLookup: lookup.createLookup,
    collectReadableLinks: media.collectReadableLinks,
    checkPull: pull.checkPull,
    isVideoVisionOn: youtube.isVideoVisionOn,
  };
  for (const [name, fn] of Object.entries(mods)) {
    if (typeof fn !== 'function') throw new CliError(`replay-cli: the engine has no ${name} (--recall needs it)`);
  }
  return mods;
}

/** The inside of the `<tag>` block of a request's text (src/behavior/prompt.js#block), or null. */
function innerBlock(text, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * The windows of a summary request's `<found>` block, in its order: `{ n,
 * date, channel, lines (messages), matched (the messages the search matched,
 * the hit mark dropped), text (the section as sent) }`. A heading counts
 * only first or after a blank line (sections are separated by one); a line
 * that is no message line goes with the message line before it, and one
 * that opens with the hit mark marks that message as matched.
 */
function foundSections(user) {
  const inner = innerBlock(user, 'found');
  if (inner === null) return [];
  const sections = [];
  let current = null;
  let last = null;
  let previous = null;
  for (const line of inner.split('\n')) {
    const header = previous === null || previous === '' ? FOUND_HEADER_RE.exec(line) : null;
    previous = line;
    if (header) {
      current = { n: Number(header[1]), date: header[2], channel: header[3], messages: [], text: [] };
      sections.push(current);
      last = null;
      continue;
    }
    if (!current) continue;
    current.text.push(line);
    const message = FOUND_LINE_RE.exec(line);
    if (message) {
      last = { text: line.slice(message[1]?.length ?? 0), hit: Boolean(message[1]) };
      current.messages.push(last);
    } else if (last && line.startsWith(FOUND_HIT)) {
      last.text += `\n${line.slice(FOUND_HIT.length)}`;
      last.hit = true;
    } else if (last) last.text += `\n${line}`;
  }
  return sections.map((s) => ({
    n: s.n,
    date: s.date,
    channel: s.channel,
    lines: s.messages.length,
    matched: s.messages.filter((m) => m.hit).map((m) => m.text.trimEnd()),
    text: s.text.join('\n').trimEnd(),
  }));
}

/** An ISO time from epoch ms, or null. */
function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The `--recall` mode: the search classifier's request of a live turn for
 * `trigger` (src/behavior/turn.js#maybeLookup: its classifierContext rebuilt
 * here), then, when the answer has a server part, recall-run's `run()` with
 * the turn's arguments; read only (see the header). Every model request goes
 * through `llm` (the tool's rails) and is recorded; the Discord searches are
 * recorded on the way through the guild's REST client (restored after).
 * Returns `{ code, result }`: code 1 when the classifier failed or the run
 * was stopped.
 */
async function runRecall({ hot, mods, llm, store, guild, guildId, channel, self, history, trigger, triggerKind, kindFrom, mediaCache, recentAsOf, replayMedia, budget, showRequest, at, signal }) {
  const {
    parseLookupAnswer,
    recallSettings,
    parseRecallAnswer,
    createRecall,
    classifierTranscript,
    fillPromptTemplate,
    roleModel,
    helperRequestOptions,
    railReason,
    zonedDay,
    countToday,
    paceSettings,
    createDescriber,
    createLookup,
    collectReadableLinks,
    checkPull,
    isVideoVisionOn,
  } = mods;
  const config = hot.config;
  const prompt = hot.prompts?.lookup;
  if (!prompt) throw new CliError('replay-cli: prompts.lookup is missing (prompts/lookup.md or prompts.local/lookup.md)');
  const labels = hot.prompts?.labels;
  const timezone = config.bot?.timezone;
  const selfName = self.name;
  const startedAt = Date.now();

  // Every model request of this mode, with its answer (the summary's request is where the windows are read back from).
  const calls = [];
  let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  const recording = {
    async complete(messages, options) {
      const call = { purpose: options?.purpose ?? null, messages, raw: null, error: null, status: null, ms: null };
      calls.push(call);
      const t = Date.now();
      try {
        const completion = await llm.complete(messages, options);
        const u = completion?.usage;
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
        call.raw = completion?.text ?? null;
        return completion;
      } catch (err) {
        call.error = err?.name === 'TimeoutError' ? 'timeout' : railReason(err);
        call.status = err?.statusCode ?? null;
        throw err;
      } finally {
        call.ms = Date.now() - t;
      }
    },
  };
  // The describer's caption cache and the link cache read through a private copy of the media cache
  // (their reads LRU-touch it); no request can leave from them.
  let cacheCopy = null;
  const cacheStore = {
    getMediaCache: () => (cacheCopy ??= structuredClone(mediaCache ?? {})),
    markMediaCacheDirty() {},
  };
  const refusing = {
    complete: async () => {
      throw new Error('replay-cli: no request from the caches');
    },
  };

  // 1. The search classifier, as maybeLookup builds it: the media states a live turn has by then, from the caches.
  const media = replayMedia(history, { cache: mediaCache, sites: config.media?.video?.sites, before: null });
  const descriptions = config.features?.mediaDescriptions === true ? media.descriptions : undefined;
  const videos = isVideoVisionOn(config) ? media.videos : undefined;
  let reads;
  if (config.features?.webLookup === true && config.web?.links?.enabled !== false) {
    // src/behavior/turn.js#readableLinkCandidates: newest message first.
    const sites = config.media?.video?.sites ?? [];
    const links = [];
    for (let i = history.length - 1; i >= 0; i -= 1) links.push(...collectReadableLinks(history[i], { videoSites: sites }));
    reads = createLookup({ hot, store: cacheStore, llm: refusing }).cachedReads(guildId, links);
  }
  const searchCfg = config.web?.search ?? {};
  const contextMessages = Math.max(0, Math.floor(searchCfg.contextMessages ?? 50));
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
  const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
  const transcriptBlock =
    context.length === 0 ? '' : `<transcript>\n${classifierTranscript(context, { config, selfName, labels, descriptions, videos, reads })}\n</transcript>\n`;
  // The skills list of skills discovery is left empty: a replay reads only the search lines.
  const lookupSystem = fillPromptTemplate(prompt, { today: zonedDay(at, timezone), name: selfName ?? '', skills: '' });
  const lookupUser = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;
  const model = roleModel(config, 'reasoner', 'lookup');
  let classifierRaw = null;
  let classifierError = null;
  try {
    const completion = await recording.complete(
      [
        { role: 'system', content: lookupSystem },
        { role: 'user', content: lookupUser },
      ],
      { model, ...helperRequestOptions(config, { role: 'reasoner', maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 200, purpose: 'lookup', signal }) },
    );
    classifierRaw = completion?.text ?? null;
  } catch (err) {
    classifierError = signal?.aborted ? 'stopped' : railReason(err);
  }
  const classifierMs = Date.now() - startedAt;
  let parsed = null;
  if (classifierError === null) {
    // An empty answer is a failed call in the live turn too (`lookup: classifier failed`, `empty`).
    if (String(classifierRaw ?? '').trim()) parsed = parseLookupAnswer(classifierRaw, { timezone, now: at, maxForms: recallSettings(config)?.maxForms });
    else classifierError = 'empty';
  }
  const server = parsed?.server ?? null;

  // 2. The server search, when the answer asks for it and the rails allow it.
  const recallHot = {
    get config() {
      const live = hot.config;
      return budget === null ? live : { ...live, recall: { ...(live.recall ?? {}), timeoutMs: budget } };
    },
    get prompts() {
      return hot.prompts;
    },
  };
  const settings = recallSettings(recallHot.config);
  let notRun = null;
  if (classifierError !== null) notRun = 'no-classifier-answer';
  else if (!server) notRun = 'no-server-part';
  else if (!settings) notRun = 'feature-off';
  else if (countToday(store.state.data, RECALL_DAILY, Date.now()) >= settings.maxPerDay) notRun = 'daily';
  else if (signal?.aborted) notRun = 'stopped';
  if (notRun === 'daily') process.stderr.write('replay-cli: recall.maxPerDay is spent today; the server search is not run\n');

  const searches = [];
  const rawHits = new Map();
  let deadlineFired = false;
  let found = null;
  let recallMs = 0;
  if (notRun === null) {
    // The daily recall counter: a private copy, bumped by the run and dropped after it.
    const data = { recallDay: store.state.data.recallDay, recallCount: store.state.data.recallCount };
    const recallStore = {
      state: { data, markDirty() {} },
      listUserProfiles: (id) => store.listUserProfiles(id),
      getLore: (id) => store.getLore(id),
      getGuild: (id) => store.getGuild(id),
      getRecent: () => recentAsOf(),
    };
    const describer = createDescriber({ hot, store: cacheStore, llm: refusing });
    // The run's first timer is its deadline (recall.timeoutMs); the second only cuts a search still out.
    let timersSet = 0;
    const timers = {
      set: (fn, ms) => {
        const deadline = timersSet === 0;
        timersSet += 1;
        return setTimeout(() => {
          if (deadline) deadlineFired = true;
          fn();
        }, ms);
      },
      clear: (timer) => clearTimeout(timer),
    };
    // Discord's searches recorded on the way (queries, totals, raw hits); every other route passes untouched.
    const rest = guild.client.rest;
    const ownGet = Object.hasOwn(rest, 'get') ? rest.get : null;
    const restGet = rest.get.bind(rest);
    rest.get = async (route, options) => {
      const kind = /\/messages\/search$/.test(String(route)) ? 'messages' : /\/members\/search$/.test(String(route)) ? 'members' : null;
      if (!kind) return restGet(route, options);
      const entry = { route: kind, query: options?.query ? Object.fromEntries(options.query) : {}, total: null, hits: null, error: null, status: null };
      searches.push(entry);
      try {
        const body = await restGet(route, options);
        if (kind === 'members') entry.hits = Array.isArray(body) ? body.length : null;
        else if (Array.isArray(body?.messages)) {
          // The same flattening as src/discord/search.js#searchMessages.
          let count = 0;
          for (const group of body.messages) {
            const list = Array.isArray(group) ? group : [group];
            const flagged = list.filter((m) => m?.hit === true);
            for (const m of flagged.length > 0 ? flagged : list) {
              if (!m?.id) continue;
              count += 1;
              if (!rawHits.has(m.id)) rawHits.set(m.id, { channelId: m.channel_id ?? null, bot: m.author?.bot === true, authorId: m.author?.id ?? null });
            }
          }
          entry.total = Number.isFinite(body.total_results) ? body.total_results : null;
          entry.hits = count;
        } else entry.error = 'not-indexed';
        return body;
      } catch (err) {
        entry.error = err?.name ?? 'Error';
        entry.status = err?.status ?? err?.statusCode ?? null;
        throw err;
      }
    };
    // The run's clock starts at the trigger's moment, as the live turn's did.
    const offset = at - Date.now();
    const clock = () => Date.now() + offset;
    const t = Date.now();
    try {
      const recall = createRecall({ hot: recallHot, store: recallStore, llm: recording, describer, now: clock, timers });
      found = await recall.run({ guild, guildId, channel, selfId: self.id, selfName, history, candidate: trigger, server });
    } finally {
      recallMs = Date.now() - t;
      if (ownGet) rest.get = ownGet;
      else delete rest.get;
    }
  }

  // 3. What the summary saw and said, read back from its request as sent.
  const summaryCall = calls.find((call) => call.purpose === 'recall-summary') ?? null;
  const summaryUser = summaryCall?.messages?.find?.((m) => m?.role === 'user')?.content ?? null;
  const summarySystem = summaryCall?.messages?.find?.((m) => m?.role === 'system')?.content ?? null;
  const sections = foundSections(summaryUser);
  const stats = found?.stats ?? null;
  const answered = stats?.summary === 'answered';
  const named = answered && summaryCall?.raw != null ? parseRecallAnswer(summaryCall.raw, { answerChars: settings?.answerChars, count: sections.length }).stretch : null;
  const stretch = found?.stretch
    ? {
        n: named,
        from: answered ? 'summary' : 'fallback',
        channelId: found.stretch.channelId ?? null,
        channel: found.stretch.channelName ?? null,
        date: Number.isFinite(found.stretch.startTs) ? zonedDay(found.stretch.startTs, timezone) : null,
        at: isoOf(found.stretch.startTs),
        lines: found.stretch.lines,
      }
    : null;
  // The hits per channel and what the turn's filters made of them (other bots, the turn's own chat, the pull rail).
  const ownIds = new Set(history.map((m) => m.id));
  const perChannel = new Map();
  for (const [id, hit] of rawHits) {
    const key = hit.channelId ?? '';
    if (!perChannel.has(key)) perChannel.set(key, { hits: 0, bots: 0, ownChat: 0 });
    const row = perChannel.get(key);
    row.hits += 1;
    if (hit.bot && hit.authorId !== self.id) row.bots += 1;
    if (ownIds.has(id)) row.ownChat += 1;
  }
  const hitChannels = [...perChannel].map(([channelId, row]) => {
    let pull = null;
    try {
      pull = checkPull({ guild, channelId, destination: channel, partner: null, config: recallHot.config, now: at }).skip ?? 'ok';
    } catch (err) {
      pull = `error:${err?.name ?? 'Error'}`;
    }
    return { channelId, channel: guild.channels.cache.get(channelId)?.name ?? null, ...row, pull };
  });
  const pace = paceSettings(config);
  const elapsedMs = classifierMs + recallMs;
  const stopped = Boolean(signal?.aborted);

  const result = {
    trigger: {
      id: trigger.id,
      author: trigger.authorName ?? null,
      at: isoOf(trigger.ts),
      kind: triggerKind ?? null,
      kindFrom,
    },
    text: String(trigger.content ?? ''),
    classifier: {
      raw: classifierRaw,
      parsed: parsed
        ? {
            web: parsed.web ?? null,
            server: server
              ? { forms: server.forms, who: server.who, from: server.from, to: server.to, fromAt: isoOf(server.from), toAt: isoOf(server.to) }
              : null,
            reason: parsed.reason ?? null,
          }
        : null,
      error: classifierError,
      model: model ?? null,
      contextLines: context.length,
      ms: classifierMs,
    },
    recall: { ran: notRun === null, notRun, budgetMs: settings?.timeoutMs ?? null, budgetFrom: budget === null ? 'config' : 'flag', stats },
    people: (found?.people ?? []).map((p) => ({ ...p, newestAt: isoOf(p.newestTs) })),
    clusters: sections,
    memory: (innerBlock(summaryUser, 'memory') ?? '').split('\n').filter(Boolean),
    stretch,
    summary: found?.text ?? null,
    summaryRaw: summaryCall?.raw ?? null,
    outcome: {
      summary: stats?.summary ?? null,
      summaryError: summaryCall?.error ?? null,
      timedOut: deadlineFired,
      searchCut: searches.some((s) => s.error === 'AbortError'),
      late: { limitMs: pace.prepareSearchMs, elapsedMs, late: pace.prepareSearchMs !== null && elapsedMs > pace.prepareSearchMs },
    },
    searches,
    hitChannels,
    stopped,
    ms: Date.now() - startedAt,
    usage,
  };
  if (showRequest) {
    result.request = {
      lookup: { system: lookupSystem, user: lookupUser },
      summary: summaryCall ? { system: summarySystem, user: summaryUser } : null,
    };
  }
  return { code: classifierError !== null || stopped ? 1 : 0, result };
}

/**
 * The channel, the chat up to the trigger (normalized as a live history is)
 * and the trigger's line and moment, over REST (see the header): a CliError
 * when the channel or the trigger cannot be read. Returns `{ channel,
 * history, triggerLine, at }`.
 */
async function readMoment({ client, guild, guildId, self, channelId, triggerId, before, config, fetchHistoryWindow, fetchMessage, log }) {
  const channel = await readableChannel({ client, guild, guildId, channelId });

  const trigger = await fetchMessage(channel, triggerId);
  if (!trigger) throw new CliError('replay-cli: the trigger message was not found');
  if (trigger.author?.id === self.id) throw new CliError("replay-cli: the trigger is the persona's own message; give the message she answered");

  const history = await fetchWindow({ guild, channel, self, anchorId: triggerId, limit: before + 1, config, fetchHistoryWindow, log });
  if (history.length === 0 || history[history.length - 1].id !== triggerId) {
    throw new CliError('replay-cli: the chat up to the trigger cannot be read');
  }
  const triggerLine = history[history.length - 1];
  return { channel, history, triggerLine, at: triggerLine.ts };
}

/** A channel of the served guild that can be read: from the guild's fetched channels, else one REST fetch (a thread is not in that list); else a CliError. */
async function readableChannel({ client, guild, guildId, channelId }) {
  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') throw new CliError('replay-cli: that channel cannot be read');
  if (String(channel.guildId ?? channel.guild?.id ?? '') !== String(guildId)) throw new CliError('replay-cli: that channel is not in the served guild');
  return channel;
}

/**
 * The last `limit` messages of `channel` up to and including `anchorId` (the newest ones when
 * it is null), oldest first, normalized as a live history is: the authors and mentioned members
 * (and the ids of `memberIds`) put into the member cache first, so their display names resolve.
 */
async function fetchWindow({ guild, channel, self, anchorId, limit, config, fetchHistoryWindow, log, memberIds = [] }) {
  const windowOptions = {
    anchorId: anchorId ?? undefined,
    limit,
    selfId: self.id,
    embedTextChars: config.media?.embedTextChars,
    videoSites: config.media?.video?.sites,
    maxUrlChars: config.context?.maxUrlChars,
  };
  // Pass 1 learns who wrote and who is mentioned; their members are cached; pass 2 normalizes with their display names.
  const first = limit > 0 ? await fetchHistoryWindow(channel, windowOptions) : [];
  const ids = new Set(memberIds.filter((id) => id !== self.id));
  for (const message of first) {
    if (message.authorId !== self.id) ids.add(message.authorId);
    for (const id of message.mentionedUserIds ?? []) if (id !== self.id) ids.add(id);
  }
  const members = await cacheMembers(guild, ids);
  // The audience rail's view of bots: the members named in per-member channel overwrites,
  // fetched like src/index.js warms them at startup (src/discord/audience-warm.js).
  try {
    const warm = await import(pathToFileURL(path.join(process.cwd(), 'src', 'discord', 'audience-warm.js')).href);
    const overwriteIds = warm.overwriteMemberIds(guild.channels.cache.values(), (id) => guild.members.cache.has(id));
    const warmed = await warm.fetchMembers(overwriteIds, (id) => guild.members.fetch(id));
    log.info('replay-cli: audience members warmed', warmed);
  } catch (err) {
    log.warn('replay-cli: audience warm skipped', { error: String(err?.message ?? err).slice(0, 120) });
  }
  const history = limit > 0 ? await fetchHistoryWindow(channel, windowOptions) : [];
  log.info('replay-cli: chat fetched', { channelId: channel.id, lines: history.length, members: members.fetched, membersMissing: members.missing });
  return history;
}

/**
 * The memory view of a reply-mode answer (see the header): live memory with
 * `<recent>` cut at the trigger, or every dated item cut with
 * `--as-of-moment`; self facts left out on `--hide-self`. `hotLike` gives
 * the prompts and the config (a pair's side has its own prompts). Returns
 * `{ view, hiddenSelf, hidden }`.
 */
function memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args, mods }) {
  const { liveView, momentView, momentCutoff, hiddenLater } = mods;
  const base = liveView({ hot: hotLike, store, guildId, calibrator });
  const cutoff = momentCutoff(situation) ?? at;
  const asOf = momentView(base, cutoff);
  const memoryView = args.asOfMoment
    ? asOf
    : {
        get prompts() {
          return base.prompts;
        },
        get config() {
          return base.config;
        },
        calibrator: base.calibrator,
        // Live memory, but `<recent>` never shows a line the analyzer added at or after the trigger.
        memory: { ...base.memory, getRecent: asOf.memory.getRecent },
      };
  // Self facts left out of the request on the operator's word: a copy of the guild memory, the store untouched.
  const selfFilter = args.hideSelfAll || args.hideSelf.length > 0;
  const { view, hidden: hiddenSelf } = selfFilter
    ? withoutSelfFacts(memoryView, { all: args.hideSelfAll, needles: args.hideSelf })
    : { view: memoryView, hidden: 0 };
  return { view, hiddenSelf, hidden: args.asOfMoment ? hiddenLater(base, cutoff) : null };
}

/** The text of a message's content: a string, or its text parts joined. */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : '';
}

/** The JSON records of every journal day file under `dir`, oldest day first; unreadable lines skipped. */
function journalRecords(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, -1)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn or hand-broken line
      }
    }
  }
  return out;
}

/** The request dumps of `turnId` under a journal directory, every attempt, oldest day first. */
function storedDumps(journalDir, turnId) {
  const root = path.join(journalDir, 'requests');
  let days = [];
  try {
    days = fs.readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const day of days) {
    for (const name of fs.readdirSync(path.join(root, day)).sort()) {
      if (!name.startsWith(`${turnId}-`) || !name.endsWith('.json')) continue;
      try {
        out.push({ file: path.join(root, day, name), dump: JSON.parse(fs.readFileSync(path.join(root, day, name), 'utf8')) });
      } catch {
        // a dump cut short: skipped
      }
    }
  }
  return out;
}

/**
 * The turn a `--diary` brief runs: `{ mode: 'diary', diary: { kind, [topic],
 * forced: false } }`. The topic as `/nep diary post` threads it: trimmed,
 * blank is none, then `diaryTopic` (src/behavior/diary.js), on the params
 * only when present.
 * @param {{ diary: string, topic: string|null }} args  From parseArgs.
 * @param {{ diaryTopic: (text: string|null) => string|null }} mods
 */
export function diaryTurnParams(args, { diaryTopic }) {
  const topic = diaryTopic(String(args.topic ?? '').trim() || null);
  return { mode: 'diary', diary: { kind: args.diary, ...(topic ? { topic } : {}), forced: false } };
}

/**
 * The prompt layers of a `--diary --prompts <dir>` run, for promptLayersHot:
 * the live prompts.local/ (when the checkout has one), then `promptsDir`.
 * @param {string} root
 * @param {string} promptsDir
 * @returns {string[]}
 */
export function diaryPromptLayers(root, promptsDir) {
  return fs.existsSync(path.join(root, 'prompts.local')) ? ['prompts.local', promptsDir] : [promptsDir];
}

/**
 * `hot` as a `--diary` turn sees it: `features.dryRun` on and
 * `bot.dryRunChannelId` empty (the turn acts on nothing and mirrors nothing);
 * everything else, the config's other keys included, read from `hot` at use.
 * @param {object} hot  From src/hot.js#createHot.
 */
export function dryRunHot(hot) {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config ?? {};
        return { ...config, features: { ...(config.features ?? {}), dryRun: true }, bot: { ...(config.bot ?? {}), dryRunChannelId: '' } };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The real store for a `--diary` run: reads pass through; `state` is an
 * in-memory deep copy whose markDirty does nothing; flush, forget, wipe and
 * reload methods throw; the recall trace is a no-op. Other mutations touch
 * only this process's cache, which is never flushed.
 * @param {object} store  From src/memory/store.js#createStore.
 */
function unflushedStore(store) {
  const state = { data: structuredClone(store.state?.data ?? {}), markDirty() {} };
  const refused = new Set(['flush', 'flushEntry', 'forgetUser', 'forgetPrivate', 'wipeGuild', 'setPingsOff', 'dropCaches', 'reloadState']);
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === 'state') return state;
      if (refused.has(prop)) {
        return () => {
          throw new Error(`replay-cli: the memory store is not written here (${String(prop)} refused)`);
        };
      }
      if (prop === 'appendRecallTrace') return () => undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, state };
}

/**
 * The `--diary` mode (see the header): `args.count` briefs of one kind from
 * the real turn runner in the diary channel, nothing acted on. Returns
 * `{ code, result }`.
 */
async function runDiary({ args, root, load, hot: liveHot, createHot, loadDotEnv, log, signal, rng }) {
  const { DIARY_PICTURES_DAILY, diaryTopic, isPictureKind, isSetKind, stripUrls, validatePlan } = await load('behavior/diary.js');
  const { createStore } = await load('memory/store.js');
  const { createCalibrator } = await load('llm/tokens.js');
  const { createLlm } = await load('llm/openrouter.js');
  const { createImageGen } = await load('llm/images.js');
  const { createTurnRunner } = await load('behavior/turn.js');
  const { createChannelRouter } = await load('behavior/route-channel.js');
  const { createRecall } = await load('behavior/recall-run.js');
  const { createEmojiIndex } = await load('discord/emoji.js');
  const { canAttach, canSend } = await load('discord/collect.js');
  const { resolveGuild } = await load('discord/guild.js');
  const { createDescriber } = await load('memory/describe.js');
  const { createImageFetcher } = await load('discord/fetch-image.js');
  const { createVideoFetcher } = await load('discord/fetch-video.js');
  const { createPageFetcher } = await load('web/fetch-page.js');
  const { createBraveSearch } = await load('web/brave.js');
  const { createLookup } = await load('web/lookup.js');
  const { parseJsonObject, parseOutput } = await load('llm/parse.js');
  const { stripDashes } = await load('memory/clamp.js');
  const { countToday } = await load('time.js');

  const params = diaryTurnParams(args, { diaryTopic });
  const { kind } = params.diary;
  const topic = params.diary.topic ?? null;
  const liveData = path.join(root, 'data');
  if (!fs.existsSync(liveData)) throw new CliError(`replay-cli: no data directory at ${liveData}`);
  const outFile = args.outDir !== null ? path.resolve(root, args.outDir) : null;
  if (outFile !== null && (outFile === liveData || outFile.startsWith(`${liveData}${path.sep}`))) throw new CliError('replay-cli: --out may not be under data/');

  loadDotEnv(root);
  const discordToken = process.env.DISCORD_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  if (!openrouterKey) throw new CliError('replay-cli: OPENROUTER_API_KEY is not set (.env)');

  let layered = null;
  let client = null;
  try {
    if (args.prompts !== null) {
      const layers = diaryPromptLayers(root, args.prompts);
      layered = promptLayersHot(createHot, root, layers);
      log.info('replay-cli: diary prompt layers', { layers: layers.length });
    }
    const hot = dryRunHot(layered?.hot ?? liveHot);
    const config = hot.config;
    const diaryChannelId = config.diary?.channelId;
    if (!diaryChannelId) throw new CliError('replay-cli: diary.channelId is not set');
    if (config.features?.diary === false) log.warn('replay-cli: features.diary is off; the live diary would not post', {});
    const weight = config.diary?.kinds?.[kind];
    if (!(Number.isFinite(weight) && weight > 0)) log.warn('replay-cli: the kind has no positive weight in diary.kinds', { kind, weight: weight ?? null });
    if (!isPictureKind(kind, config.diary?.pictureKinds)) log.warn('replay-cli: the kind is not in diary.pictureKinds; it draws only when the plan says picture', { kind });
    if (isSetKind(kind, config.diary?.setKinds)) log.warn('replay-cli: the kind is a set kind; only the first <draw> is reported', { kind });

    // The store and the counters: an in-memory copy; the picture gate opened there only.
    const { store, state } = unflushedStore(createStore({ dataDir: liveData }));
    const nowMs = Date.now();
    const were = {
      diaryPictures: countToday(state.data, DIARY_PICTURES_DAILY, nowMs),
      images: countToday(state.data, { dayKey: 'imageDay', countKey: 'imageCount' }, nowMs),
    };
    state.data[DIARY_PICTURES_DAILY.countKey] = 0;
    state.data.imageCount = 0;
    log.info('replay-cli: diary gates opened', { diaryPicturesWere: were.diaryPictures, imagesWere: were.images, paused: Boolean(state.data.paused) });

    // The model clients: every request the tool's own, recorded with its purpose.
    const calibrator = createCalibrator(state.data.calibration);
    const realLlm = createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state });
    const noCache = args.count === 1;
    const calls = [];
    const llm = new Proxy(realLlm, {
      get(target, prop) {
        if (prop === 'complete') {
          return async (messages, options = {}) => {
            const call = { purpose: options?.purpose ?? null, text: null, usage: null, error: null };
            calls.push(call);
            try {
              const completion = await target.complete(messages, {
                ...options, origin: 'replay', countAgainstDailyCap: false, skipCalibration: true, ...(noCache ? { cache: false } : {}),
              });
              call.text = completion?.text ?? null;
              call.usage = completion?.usage ?? null;
              return completion;
            } catch (err) {
              call.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
              throw err;
            }
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const realImages = createImageGen({ apiKey: openrouterKey, getConfig: () => hot.config, state });
    const images = {
      quota: (...a) => realImages.quota(...a),
      familyOf: (...a) => realImages.familyOf(...a),
      generate: async () => {
        throw new Error('replay-cli: picture generation is disabled in this tool');
      },
    };

    // Discord over REST, every write refused.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({ discord, token: discordToken, configuredGuildId: config.bot?.guildId || '', resolveGuild, log });
    client = connection.client;
    const { guildId, self } = connection;
    const queueRequest = client.rest.queueRequest.bind(client.rest);
    client.rest.queueRequest = (request) => {
      const method = String(request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return Promise.reject(new Error(`replay-cli: Discord ${method} refused (read-only tool)`));
      return queueRequest(request);
    };
    let channel = null;
    try {
      channel = await client.channels.fetch(diaryChannelId);
    } catch {
      channel = null;
    }
    if (!channel || String(channel.guildId ?? channel.guild?.id ?? '') !== String(guildId)) throw new CliError('replay-cli: the diary channel is not in the served guild');
    const refuse = (name) => async () => {
      throw new Error(`replay-cli: channel.${name} refused (read-only tool)`);
    };
    channel.send = refuse('send');
    channel.sendTyping = refuse('sendTyping');
    let writable = false;
    try {
      writable = canSend(channel) && canAttach(channel);
    } catch {
      writable = false;
    }
    if (!writable) log.warn('replay-cli: the bot cannot send or attach in the diary channel; the live diary would skip it (not-writable)', {});

    // The engine, wired as src/index.js wires it.
    const imageFetcher = createImageFetcher();
    const describer = createDescriber({ hot, store, llm, imageFetcher, videoFetcher: createVideoFetcher(), state, youtubeApiKey: process.env.YOUTUBE_API_KEY || null });
    const lookup = createLookup({
      hot, store, llm, state, pageFetcher: createPageFetcher(), braveSearch: createBraveSearch(), braveApiKey: process.env.BRAVE_SEARCH_API_KEY || null,
    });
    const turns = createTurnRunner({
      hot, store, llm, calibrator, client, describer, imageFetcher, lookup, images,
      recall: createRecall({ hot, store, llm, describer }),
      emoji: createEmojiIndex(client, () => guildId),
      getSelfName: () => self.name,
      routeChannels: createChannelRouter({ hot, store, llm }),
      isWarmingUp: () => false,
      activity: null,
    });
    log.info('replay-cli: diary ready', { guildId, channelId: channel.id, kind, count: args.count, topicChars: topic ? topic.length : 0 });

    const briefs = [];
    let usage = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    for (let n = 1; n <= args.count; n += 1) {
      if (signal?.aborted) break;
      const from = calls.length;
      let result;
      try {
        result = await turns.runTurn({ channel, ...params });
      } catch (err) {
        result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
      }
      const mine = calls.slice(from);
      for (const call of mine) {
        const cost = Number(call.usage?.cost_details?.upstream_inference_cost ?? call.usage?.cost ?? 0);
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(call.usage?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(call.usage?.completion_tokens) || 0),
          cost: Math.round((usage.cost + (Number.isFinite(cost) ? cost : 0)) * 10000) / 10000,
        };
      }
      const planCall = mine.filter((c) => c.purpose === 'diary-plan').pop() ?? null;
      const composeCall = mine.filter((c) => c.purpose === 'reply' && c.text !== null).pop() ?? null;

      // The plan as the turn built it: the planner's JSON with the kind forced, validated against the one kind offered.
      let answer = null;
      if (planCall?.text) {
        try {
          answer = parseJsonObject(planCall.text);
        } catch {
          answer = null;
        }
      }
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) answer = { ...answer, kind };
      const pictureAllowed = result?.outcome !== 'refused' || result?.reason !== 'pictures';
      const validated = validatePlan(answer, { [kind]: 1 }, { pictureAllowed, searchKinds: config.diary?.searchKinds, pictureKinds: config.diary?.pictureKinds }, rng);
      const plan = topic ? { ...validated, topic } : validated;

      // The compose answer as runTurn reads it for a diary post.
      let draw = null;
      let messages = [];
      if (composeCall?.text) {
        const parsed = parseOutput(composeCall.text);
        const live = hot.config;
        messages = parsed.messages.map((m) => m.text);
        if (live.features?.multiMessage === false) messages = messages.slice(0, 1);
        if (live.format?.stripDashes !== false) messages = messages.map(stripDashes).filter((t) => t !== '');
        messages = messages.map(stripUrls).filter((t) => t !== '').slice(0, Math.max(0, live.diary?.maxMessages ?? 3));
        draw = parsed.draw ?? null;
      }
      const brief = {
        kind,
        plan,
        self: draw ? draw.self === true : null,
        request: draw ? draw.text : null,
        messages,
        outcome: result?.outcome ?? null,
        ...(result?.reason ? { reason: result.reason } : {}),
        ...(planCall?.error ? { planError: planCall.error } : {}),
      };
      briefs.push(brief);
      if (outFile !== null) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, `${JSON.stringify(briefs, null, 1)}\n`);
      }
      log.info('replay-cli: diary brief', { n, outcome: brief.outcome, planFallback: plan.fallback ?? null, self: brief.self, requestChars: brief.request ? brief.request.length : 0, requests: mine.length });
    }
    const withDraw = briefs.filter((b) => b.request).length;
    const stopped = Boolean(signal?.aborted);
    const code = withDraw === 0 || stopped ? 1 : 0;
    if (outFile === null) return { code, result: briefs };
    return { code, result: { out: outFile, kind, topic: Boolean(topic), prompts: args.prompts !== null, briefs: briefs.length, withDraw, stopped, usage } };
  } finally {
    if (layered) {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- skill scenarios (--skills) ----------------------------------------------------

/** The fields a scenario may have. */
const SCENARIO_KEYS = Object.freeze(['id', 'channelId', 'before', 'author', 'text', 'grants', 'runs', 'result', 'discovery']);
const SCENARIO_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_RUNS = 10;
/** Discord's longest message: the most a scenario's text or canned result may hold. */
const MAX_SCENARIO_TEXT = 4000;
/** The most skills a classifier's `skills:` line names (src/skills/discovery.js#MAX_PROPOSED). */
const MAX_DISCOVERY_NAMES = 4;
/** How long after the anchor message the invented one is written. */
const SCENARIO_AFTER_MS = 60_000;
/** Discord's epoch, for the invented message's id (a snowflake of its moment). */
const DISCORD_EPOCH = 1420070400000n;
/** A run's requests at most: her answer and the follow-up after a call. */
const SKILL_REQUESTS_PER_RUN = 2;

/**
 * The scenarios of a `--skills` file (`text`, its content): a non-empty JSON array of
 * `{ id, channelId, before?, author, text, grants, runs?, result?, discovery? }` -- `id` 1..64
 * of `A-Z a-z 0-9 . _ -`, unique; `channelId`, `author` and `before` (optional) message, channel
 * and member ids; `text` the invented message (1..4000 characters); `grants` a list of skill
 * names, groups or `*` (may be empty); `runs` 1..10 (default 1); `result` the text the
 * operation answers when a call passes (default ''); `discovery` `"inventory"` (default),
 * `"none"` or a list of 1..4 skill names. Any other field, type or value is a CliError naming
 * the scenario. Names are checked against the registry later (scenarioGrants, scenarioDiscovery).
 * @param {string} text
 * @returns {{ id: string, channelId: string, before: string|null, author: string, text: string, grants: string[],
 *   runs: number, result: string, discovery: 'inventory'|'none'|string[] }[]}
 */
export function parseScenarios(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CliError(`replay-cli: the scenario file is not JSON (${err.message})`);
  }
  if (!Array.isArray(data) || data.length === 0) throw new CliError('replay-cli: the scenario file must be a non-empty JSON array');
  const ids = new Set();
  return data.map((raw, index) => {
    const bad = (what) => new CliError(`replay-cli: scenario ${index + 1}${typeof raw?.id === 'string' ? ` (${raw.id})` : ''}: ${what}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
    for (const key of Object.keys(raw)) if (!SCENARIO_KEYS.includes(key)) throw bad(`unknown field ${key}`);
    if (typeof raw.id !== 'string' || !SCENARIO_ID.test(raw.id)) throw bad('id must be 1..64 characters of A-Z a-z 0-9 . _ -');
    if (ids.has(raw.id)) throw bad('the id is used twice');
    ids.add(raw.id);
    if (typeof raw.channelId !== 'string' || !SNOWFLAKE.test(raw.channelId)) throw bad('channelId must be a channel id');
    if (raw.before !== undefined && raw.before !== null && (typeof raw.before !== 'string' || !SNOWFLAKE.test(raw.before))) throw bad('before must be a message id or omitted');
    if (typeof raw.author !== 'string' || !SNOWFLAKE.test(raw.author)) throw bad('author must be a member id');
    if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_SCENARIO_TEXT) throw bad(`text must be 1..${MAX_SCENARIO_TEXT} characters`);
    if (!Array.isArray(raw.grants) || raw.grants.some((g) => typeof g !== 'string' || !g.trim())) throw bad('grants must be a list of skill names, groups or "*"');
    const runs = raw.runs ?? 1;
    if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw bad(`runs must be a whole number 1..${MAX_RUNS}`);
    const result = raw.result ?? '';
    if (typeof result !== 'string' || result.length > MAX_SCENARIO_TEXT) throw bad(`result must be text of at most ${MAX_SCENARIO_TEXT} characters`);
    const discovery = raw.discovery ?? 'inventory';
    const named = Array.isArray(discovery) && discovery.length >= 1 && discovery.length <= MAX_DISCOVERY_NAMES && discovery.every((n) => typeof n === 'string' && n.trim());
    if (discovery !== 'inventory' && discovery !== 'none' && !named) throw bad(`discovery must be "inventory", "none" or a list of 1..${MAX_DISCOVERY_NAMES} skill names`);
    return {
      id: raw.id,
      channelId: raw.channelId,
      before: raw.before ?? null,
      author: raw.author,
      text: raw.text,
      grants: raw.grants.map((g) => g.trim()),
      runs,
      result,
      discovery: named ? discovery.map((n) => n.trim()) : discovery,
    };
  });
}

/**
 * The skill names a scenario's `grants` store for the persona, in order, de-duplicated: each
 * key expanded by `expand` (src/ops/access.js#expandPersonaGrant: a skill by name, a group or
 * `*` as its read skills), a name no grant opens for her kept (`refused`) so the gateway
 * refuses it as live. A key that names no skill is a CliError naming the scenario.
 * @param {{ id: string, grants: string[] }} scenario
 * @param {(key: string) => ({ names: string[], refused: string[] } | null)} expand
 * @returns {string[]}
 */
export function scenarioGrants(scenario, expand) {
  const names = [];
  for (const key of scenario.grants) {
    const expanded = expand(key);
    if (!expanded) throw new CliError(`replay-cli: scenario ${scenario.id}: grants names no skill: ${key}`);
    for (const name of [...expanded.names, ...expanded.refused]) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** A scenario's `discovery` against the registry's skill `names`: a CliError for a name it does not have. */
export function scenarioDiscovery(scenario, names) {
  if (!Array.isArray(scenario.discovery)) return scenario.discovery;
  const unknown = scenario.discovery.filter((name) => !names.includes(name));
  if (unknown.length > 0) throw new CliError(`replay-cli: scenario ${scenario.id}: discovery names no skill: ${unknown.join(', ')}`);
  return scenario.discovery;
}

/**
 * The invented message of a scenario as a normalized history line (src/discord/collect.js#normalizeMessage's
 * shape): by `authorId` / `authorName` in `channel` at `at`, the text as given, tagging the
 * persona (`mentionedUserIds`: `selfId`), replying to nothing, without media. Its id is the
 * snowflake of its moment, so it sorts after every line before it. Pure.
 * @param {{ text: string, authorId: string, authorName: string, channel: { id: string, name?: string|null,
 *   category?: string|null, topic?: string|null }, selfId: string, at: number }} input
 * @returns {object}
 */
export function scenarioTrigger({ text, authorId, authorName, channel, selfId, at }) {
  return {
    id: String((BigInt(Math.floor(at)) - DISCORD_EPOCH) << 22n),
    channelId: String(channel.id),
    channelName: channel.name ?? null,
    channelCategory: channel.category ?? null,
    channelTopic: channel.topic ?? null,
    authorId: String(authorId),
    authorName,
    self: false,
    bot: false,
    content: text,
    ts: at,
    mentionedUserIds: [String(selfId)],
    mentionedChannelIds: [],
    replyToId: null,
    replyPingUserId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

/** What she showed in one pass (a shaped answer): her messages, reactions, GIF, drawing, skip, and her think. */
function visibleOf(answer) {
  if (!answer) return null;
  return {
    messages: answer.messages.map((m) => m.text),
    reactions: answer.reactions.map((r) => r.emoji),
    gif: answer.gif?.id ?? null,
    draw: answer.draw?.text ?? null,
    skip: answer.skip,
    think: answer.think ?? '',
  };
}

/**
 * One run of a scenario (answerSkillScenario's) as its JSONL line: the decision (`call`,
 * `malformed-call`, `no-call`), the skill and the arguments she wrote (the body as `body`),
 * the gateway's verdict, the call recorded when it passed (`executed`), the result she got, her
 * visible messages of both passes (the follow-up's with `continuation`: whether it continued the
 * turn), the tokens of both and their cost (`usage.cost` as the
 * provider reported it; null when it reported none). Pure.
 * @param {string} scenarioId
 * @param {number} index  0-based.
 * @param {object} run
 * @returns {object}
 */
export function runRecord(scenarioId, index, run) {
  const usages = [run.usage, run.followUp?.usage].filter(Boolean);
  const sum = (key) => usages.reduce((total, u) => total + (Number(u?.[key]) || 0), 0);
  const costs = usages.map((u) => Number(u?.cost)).filter(Number.isFinite);
  const outcome = run.outcome ?? null;
  const follow = run.followUp;
  return {
    scenario: scenarioId,
    run: index + 1,
    decision: run.call ? 'call' : run.callError ? 'malformed-call' : 'no-call',
    skill: run.call?.skill ?? null,
    args: run.call ? { ...run.call.args, ...(run.call.body ? { body: run.call.body } : {}) } : null,
    extraCalls: run.extraCalls ?? 0,
    verdict: outcome?.verdict ?? null,
    executed: outcome?.executed ?? null,
    result: outcome ? { status: outcome.result.status, code: outcome.result.code ?? null } : null,
    first: visibleOf(run.answer),
    followUp: follow ? (follow.error ? { error: follow.error } : { ...visibleOf(follow.answer), extraCall: follow.extraCall === true, continuation: follow.continuation === true }) : null,
    tokens: { prompt: sum('prompt_tokens'), completion: sum('completion_tokens') },
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * A scenario's counts over its run records: runs, calls (of which `passed` and `denied` by the
 * resolution, the gateway or the command), `noCall` (she declined or deflected: no call),
 * `malformed`, follow-ups answered, tokens and cost (null when no run reported one). Pure.
 * @param {object[]} records  runRecord's.
 */
export function scenarioSummary(records) {
  const calls = records.filter((r) => r.decision === 'call');
  const costs = records.map((r) => r.cost).filter(Number.isFinite);
  return {
    runs: records.length,
    calls: calls.length,
    passed: calls.filter((r) => r.verdict?.ok === true).length,
    denied: calls.filter((r) => r.verdict && r.verdict.ok !== true).length,
    noCall: records.filter((r) => r.decision === 'no-call').length,
    malformed: records.filter((r) => r.decision === 'malformed-call').length,
    followUps: records.filter((r) => r.followUp && !r.followUp.error).length,
    promptTokens: records.reduce((t, r) => t + r.tokens.prompt, 0),
    completionTokens: records.reduce((t, r) => t + r.tokens.completion, 0),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/** One line of text for a markdown table cell. */
function cell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** `text` as a markdown quote, line by line. */
function quoted(text) {
  return String(text ?? '').split('\n').map((line) => `> ${line}`).join('\n');
}

/** One pass of a run (visibleOf's) as markdown lines. */
function passLines(pass) {
  if (!pass) return [];
  const out = [];
  for (const message of pass.messages) out.push(quoted(message), '');
  if (pass.reactions.length > 0) out.push(`reactions: ${pass.reactions.join(' ')}`, '');
  if (pass.gif) out.push(`gif: ${pass.gif}`, '');
  if (pass.draw) out.push(`draw: ${cell(pass.draw)}`, '');
  if (pass.messages.length === 0 && pass.reactions.length === 0 && !pass.gif && !pass.draw) out.push(pass.skip ? '(skip)' : '(nothing)', '');
  return out;
}

/**
 * The markdown report of a `--skills` run: a table of every scenario's counts (scenarioSummary),
 * then per scenario its message, grants and every run: the decision, the call with its
 * arguments and the gateway's verdict, her messages of the first pass and of the follow-up.
 * Tool output for the owner, not model-facing. Pure.
 * @param {{ scenario: object, grantNames: string[], summary: object, records: object[], error?: string }[]} entries
 * @returns {string}
 */
export function renderSkillsReport(entries) {
  const lines = ['# Skill scenarios', '', '| scenario | runs | calls | passed | denied | no call | malformed | follow-ups | cost (USD) |', '|---|---|---|---|---|---|---|---|---|'];
  for (const { scenario, summary, error } of entries) {
    if (error) lines.push(`| ${cell(scenario.id)} | failed: ${cell(error)} | | | | | | | |`);
    else lines.push(`| ${cell(scenario.id)} | ${summary.runs} | ${summary.calls} | ${summary.passed} | ${summary.denied} | ${summary.noCall} | ${summary.malformed} | ${summary.followUps} | ${summary.cost === null ? '-' : summary.cost.toFixed(4)} |`);
  }
  for (const { scenario, grantNames, records = [], error } of entries) {
    lines.push('', `## ${scenario.id}`, '', quoted(scenario.text), '', `grants: ${grantNames?.length ? grantNames.join(', ') : '(none)'}; discovery: ${Array.isArray(scenario.discovery) ? scenario.discovery.join(', ') : scenario.discovery}`, '');
    if (error) {
      lines.push(`failed: ${cell(error)}`);
      continue;
    }
    for (const record of records) {
      lines.push(`### run ${record.run}: ${record.decision}`, '');
      if (record.decision === 'call') {
        const verdict = record.verdict?.ok ? 'passed' : `refused at ${record.verdict?.stage}: ${record.verdict?.code}${record.verdict?.reason ? ` (${record.verdict.reason})` : ''}`;
        lines.push(`call: \`${cell(record.skill)}\` ${cell(JSON.stringify(record.args))}`, '', `gateway: ${verdict}`, '');
      }
      if (record.extraCalls > 0) lines.push(`extra calls ignored: ${record.extraCalls}`, '');
      lines.push(...passLines(record.first));
      if (record.followUp?.error) lines.push(`follow-up failed: ${cell(record.followUp.error)}`, '');
      else if (record.followUp) lines.push(`after the result (${record.result?.status}${record.result?.code ? `, ${record.result.code}` : ''}):`, '', ...passLines(record.followUp));
      lines.push(`tokens: ${record.tokens.prompt} in, ${record.tokens.completion} out; cost: ${record.cost === null ? '-' : record.cost.toFixed(4)}`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The `--skills` mode (see the header): every scenario of `scenarios` put to the persona after
 * its channel's real chat, nothing posted, run or written but the output files. Returns
 * `{ code, result }`: code 1 when a scenario failed or the runs were stopped.
 */
async function runSkills({ args, scenarios, root, liveData, mods, hot, store, guild, guildId, client, self, llm, calibrator, mediaCache, gifs, customEmoji, searchAvailable, before, log, signal, budget, viewMods, channelOf }) {
  const {
    answerSkillScenario, skillScenarioRequest, scenarioInventory, simulateCall, personaGrantsConfig, replayMedia,
    fetchHistoryWindow, requesterOf, callViewOf, skillRegistry, expandPersonaGrant, createImageGen, grantedSkillNames,
  } = mods;
  const registry = skillRegistry();
  const names = [...registry.keys()];
  // Every name is checked before anything is fetched or sent.
  const plans = scenarios.map((scenario) => ({ scenario, grantNames: scenarioGrants(scenario, expandPersonaGrant), discovery: scenarioDiscovery(scenario, names) }));

  let outDir = null;
  if (!args.dry) {
    outDir = path.resolve(root, args.outDir ?? `replay-skills-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`)) throw new CliError('replay-cli: --out may not be under data/');
    if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) throw new CliError(`replay-cli: ${outDir} is not empty`);
    fs.mkdirSync(outDir, { recursive: true });
  }
  const jsonl = outDir ? path.join(outDir, 'runs.jsonl') : null;

  // The spend cap: what the provider reports spent (else the estimate per request) stops the runs at --spend.
  let spent = 0;
  const spendStop = new AbortController();
  // Ctrl-C stops the runs too: one signal for both.
  if (signal?.aborted) spendStop.abort();
  else signal?.addEventListener?.('abort', () => spendStop.abort(), { once: true });
  const runSignal = spendStop.signal;
  if (jsonl) fs.writeFileSync(jsonl, '');
  const capped = {
    async complete(messages, options) {
      if (budget !== null && spent >= budget) {
        spendStop.abort();
        throw new Error('replay-cli: --spend reached');
      }
      const completion = await llm.complete(messages, { ...options, signal: runSignal });
      const cost = Number(completion?.usage?.cost);
      spent += Number.isFinite(cost) ? cost : USD_PER_ANSWER;
      if (budget !== null && spent >= budget) spendStop.abort();
      return completion;
    },
  };
  // The image quota a drawing's budget is read from: today's counters of the state copy, read only.
  const refusing = async () => {
    throw new Error('replay-cli: no request from the image client');
  };
  const frozenState = {
    data: store.state.data,
    markDirty() {
      throw new Error('replay-cli: the state is read-only here');
    },
  };

  const entries = [];
  const dry = [];
  let cut = false;
  for (const { scenario, grantNames, discovery } of plans) {
    if (runSignal.aborted) {
      cut = true;
      break;
    }
    try {
      const channel = await readableChannel({ client, guild, guildId, channelId: scenario.channelId });
      if (scenario.author === self.id) throw new CliError('replay-cli: the author is the persona');
      const history = await fetchWindow({ guild, channel, self, anchorId: scenario.before, limit: Math.max(1, before), config: hot.config, fetchHistoryWindow, log, memberIds: [scenario.author] });
      if (scenario.before && history[history.length - 1]?.id !== scenario.before) throw new CliError('replay-cli: the anchor message was not found in that channel');
      const last = history[history.length - 1] ?? null;
      const at = scenario.before && last ? last.ts + SCENARIO_AFTER_MS : Date.now();
      const authorName = guild.members.cache.get(scenario.author)?.displayName ?? store.getUser(guildId, scenario.author)?.names?.[0] ?? scenario.author;
      const trigger = scenarioTrigger({ text: scenario.text, authorId: scenario.author, authorName, channel: channelOf(channel), selfId: self.id, at });
      const situation = { history: [...history, trigger], triggerId: trigger.id, kind: 'mention', mode: 'reply' };

      // The config with her grants, read now and kept for the scenario; never written.
      const scenarioConfig = personaGrantsConfig(hot.config, self.id, grantNames);
      const hotLike = {
        get prompts() {
          return hot.prompts;
        },
        get config() {
          return scenarioConfig;
        },
      };
      const { view } = memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args: { asOfMoment: args.asOfMoment, hideSelf: [], hideSelfAll: false }, mods: viewMods });
      const requester = requesterOf(trigger, channel);
      const inventory = scenarioInventory({ config: scenarioConfig, selfId: self.id, texts: hot.prompts?.skills, requester, conversationId: channel.id, registry, discovery });
      // `<skills_granted>`: the names of the skills the scenario grants her, as a live turn lists them.
      const skillsGranted = grantedSkillNames({ config: scenarioConfig, selfId: self.id, registry });
      const media = replayMedia(situation.history, { cache: mediaCache, sites: scenarioConfig.media?.video?.sites, before: null });
      const input = {
        view, situation, selfId: self.id, selfName: self.name, channel: channelOf(channel), at,
        descriptions: media.descriptions, videos: media.videos, customEmoji, gifs, mediaCache, searchAvailable, skillsInventory: inventory, skillsGranted,
      };
      const shown = { rows: inventory?.length ?? 0, allowed: (inventory ?? []).filter((row) => row.allowed).length };
      if (args.dry) {
        const request = skillScenarioRequest(input);
        dry.push({
          id: scenario.id, channelId: channel.id, lines: history.length, systemChars: request.system.length, userChars: request.user.length,
          tokens: request.tokens, limit: request.limit, skillsBlock: blockOf(request.user, 'skills') !== null, skills: shown, runs: scenario.runs,
        });
        continue;
      }
      const images = { quota: createImageGen({ apiKey: '', getConfig: () => scenarioConfig, state: frozenState, fetchImpl: refusing }).quota };
      const memoryOn = scenarioConfig.features?.memory !== false;
      const answered = await answerSkillScenario({
        ...input,
        llm: capped,
        runs: scenario.runs,
        signal: runSignal,
        onCall: (call, { idByIndex, history: lines }) =>
          simulateCall({
            call,
            view: callViewOf({ channel, guildId, idByIndex, lines, pulledIds: new Map(), memoryOn, store, selfId: self.id, skills: registry }),
            config: scenarioConfig,
            selfId: self.id,
            requester,
            conversationId: channel.id,
            now: at,
            images,
            resultText: scenario.result,
          }),
      });
      if (answered.stopped) cut = true;
      const records = answered.runs.map((run, index) => runRecord(scenario.id, index, run));
      if (records.length > 0) fs.appendFileSync(jsonl, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      entries.push({ scenario, grantNames, records, summary: { ...scenarioSummary(records), skills: shown, tokensEstimate: answered.request.tokens } });
      log.info('replay-cli: skill scenario', { runs: records.length, calls: records.filter((r) => r.decision === 'call').length });
    } catch (err) {
      const error = err instanceof CliError ? err.message : `${err?.name ?? 'Error'}`;
      if (args.dry) dry.push({ id: scenario.id, error });
      else entries.push({ scenario, grantNames, records: [], summary: null, error });
    }
  }
  // Stopped only when something was left unanswered: by Ctrl-C, else by the spend cap.
  const stoppedBy = !cut ? null : signal?.aborted ? 'signal' : 'spend';
  if (args.dry) return { code: dry.some((d) => d.error) ? 1 : 0, result: { dry: true, scenarios: dry } };
  const report = path.join(outDir, 'report.md');
  fs.writeFileSync(report, renderSkillsReport(entries));
  const failed = entries.filter((e) => e.error).map((e) => ({ id: e.scenario.id, error: e.error }));
  return {
    code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
    result: {
      out: outDir,
      runs: jsonl,
      report,
      scenarios: entries.filter((e) => !e.error).map((e) => ({ id: e.scenario.id, ...e.summary })),
      failed,
      stoppedBy,
      spentUsd: Math.round(spent * 10000) / 10000,
    },
  };
}

/** One answer as the output and the sheet show it. */
function answerOut(answer) {
  return answer
    ? { think: answer.think, messages: answer.messages.map((m) => m.text), skip: answer.skip, reactions: answer.reactions, gif: answer.gif, draw: answer.draw ?? null }
    : null;
}

/**
 * The whole tool. Returns `{ code, result }`; never prints to stdout itself.
 * @param {string[]} argv
 * @param {{ root?: string, signal?: AbortSignal, rng?: () => number }} [options]
 */
export async function main(argv, { root = process.cwd(), signal, rng = Math.random } = {}) {
  const args = parseArgs(argv);
  const src = path.join(root, 'src');
  if (!fs.existsSync(path.join(src, 'behavior', 'sandbox.js'))) throw new CliError(`replay-cli: no engine under ${src}; run it from the bot's directory`);
  const load = (rel) => import(pathToFileURL(path.join(src, rel)).href);

  // The triggers of a pair, read before anything else: their number is the estimate.
  let pairTriggers = null;
  if (args.pair) {
    if (args.triggers !== null) {
      try {
        pairTriggers = parseTriggers(fs.readFileSync(path.resolve(root, args.triggers), 'utf8'));
      } catch (err) {
        throw new CliError(`replay-cli: ${args.triggers}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
      }
      if (pairTriggers.length === 0) throw new CliError(`replay-cli: ${args.triggers} names no trigger`);
    } else pairTriggers = [{ channelId: args.channelId, triggerId: args.triggerId, turnId: null }];
  }
  // The scenarios of --skills, read before anything else too: their runs are the estimate.
  let scenarios = null;
  if (args.skills !== null) {
    let text;
    try {
      text = fs.readFileSync(path.resolve(root, args.skills), 'utf8');
    } catch (err) {
      throw new CliError(`replay-cli: ${args.skills}: ${err?.code === 'ENOENT' ? 'not found' : err.message}`);
    }
    scenarios = parseScenarios(text);
  }
  // The spend gate: the estimate first; nothing is sent without --spend covering it.
  let spendBudget = null;
  if (args.showRequestTurn === null) {
    const skillRuns = scenarios ? scenarios.reduce((total, s) => total + s.runs, 0) : 0;
    const requests = args.dry
      ? 0
      : args.diary ? DIARY_REQUESTS_PER_BRIEF * args.count : args.pair ? 2 * pairTriggers.length : args.recall ? RECALL_REQUESTS : scenarios ? SKILL_REQUESTS_PER_RUN * skillRuns : args.samples;
    const detail = `~${USD_PER_ANSWER} USD per request${args.diary ? `, ${DIARY_REQUESTS_PER_BRIEF} per brief: the plan and the compose` : ''}${scenarios ? `, up to ${SKILL_REQUESTS_PER_RUN} per run: her answer and the follow-up after a call` : ''}`;
    const gate = spendGate({ estimateUsd: requests * USD_PER_ANSWER, requests, spend: args.spend, detail });
    if (!gate.ok) throw new CliError(`replay-cli: ${gate.text}`, { exitCode: REFUSED_EXIT });
    spendBudget = gate.budget;
    process.stderr.write(`replay-cli: ${gate.text}\n`);
  }

  const { loadDotEnv } = await load('config.js');
  const { createHot } = await load('hot.js');
  const { log } = await load('log.js');

  // Reads config.json, config.local.json and both prompt layers; writes nothing. Not watched: one request.
  const hot = createHot({ rootDir: root });
  if (args.diary) {
    try {
      return await runDiary({ args, root, load, hot, createHot, loadDotEnv, log, signal, rng });
    } finally {
      hot.close();
    }
  }
  const liveData = path.join(root, 'data');
  const dataDir = args.snapshot !== null ? path.resolve(root, args.snapshot) : liveData;
  if (!fs.existsSync(dataDir)) throw new CliError(`replay-cli: no data directory at ${dataDir}`);

  // --show-request <turnId>: a stored dump needs neither Discord nor a key.
  let turnStart = null;
  if (args.showRequestTurn !== null) {
    const journalGuild = resolveGuildId(liveData, hot.config.bot?.guildId || undefined);
    const journalDirs = [...new Set([path.join(liveData, 'guilds', journalGuild, 'journal'), path.join(dataDir, 'guilds', journalGuild, 'journal')])];
    for (const dir of journalDirs) {
      const dumps = storedDumps(dir, args.showRequestTurn);
      if (dumps.length > 0) {
        hot.close();
        return { code: 0, result: { source: 'dump', turnId: args.showRequestTurn, dumps: dumps.map(({ file, dump }) => ({ file, ...dump })) } };
      }
    }
    for (const dir of journalDirs) {
      turnStart = journalRecords(dir).find((record) => record?.kind === 'turn.start' && record.turnId === args.showRequestTurn) ?? null;
      if (turnStart) break;
    }
    if (!turnStart) throw new CliError(`replay-cli: no request dump and no turn.start record of ${args.showRequestTurn} in the journal`);
    if (!SNOWFLAKE.test(turnStart.scope?.channel ?? '') || !SNOWFLAKE.test(turnStart.trigger?.messageId ?? '')) {
      throw new CliError('replay-cli: that turn has no channel or trigger message to rebuild it from (a spontaneous or private turn)');
    }
    args.channelId = turnStart.scope.channel;
    args.triggerId = turnStart.trigger.messageId;
  }

  loadDotEnv(root);
  const discordToken = process.env.DISCORD_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!discordToken) throw new CliError('replay-cli: DISCORD_TOKEN is not set (.env)');
  if (!openrouterKey && args.showRequestTurn === null && !args.dry) throw new CliError('replay-cli: OPENROUTER_API_KEY is not set (.env)');
  const searchAvailable = typeof process.env.BRAVE_SEARCH_API_KEY === 'string' && process.env.BRAVE_SEARCH_API_KEY.trim().length > 0;

  const { createStore } = await load('memory/store.js');
  const { createCalibrator } = await load('llm/tokens.js');
  const { createLlm } = await load('llm/openrouter.js');
  const {
    SANDBOX_STORE_READS,
    liveView,
    answerReply,
    situationHistory,
    sandboxRequestInput,
    momentView,
    momentCutoff,
    hiddenLater,
    momentKind,
    momentMode,
    isSpontaneous,
    replayMedia,
    answerSkillScenario,
    skillScenarioRequest,
    scenarioInventory,
    simulateCall,
    personaGrantsConfig,
  } = await load('behavior/sandbox.js');
  const { fetchHistoryWindow, fetchMessage } = await load('discord/collect.js');
  const { createEmojiIndex } = await load('discord/emoji.js');
  const { resolveGuild } = await load('discord/guild.js');
  const viewMods = { liveView, momentView, momentCutoff, hiddenLater };
  const splitMods = args.split
    ? {
        ...(await load('behavior/split.js')),
        ...(await load('behavior/prompt.js')),
        ...(await load('llm/roles.js')),
        ...(await load('llm/openrouter.js')),
      }
    : null;
  const recallMods = args.recall ? await loadRecallMods(load) : null;
  // --skills: the operations register themselves and the command tree the skills derive from (src/ops/index.js).
  let skillMods = null;
  if (scenarios) {
    await load('ops/index.js');
    const { skillRegistry } = await load('skills/registry.js');
    const { expandPersonaGrant } = await load('ops/access.js');
    const { requesterOf, callViewOf } = await load('behavior/turn.js');
    const { createImageGen } = await load('llm/images.js');
    const { grantedSkillNames } = await load('skills/discovery.js');
    skillMods = {
      answerSkillScenario, skillScenarioRequest, scenarioInventory, simulateCall, personaGrantsConfig, replayMedia,
      fetchHistoryWindow, requesterOf, callViewOf, skillRegistry, expandPersonaGrant, createImageGen, grantedSkillNames,
    };
    for (const [name, fn] of Object.entries(skillMods)) {
      if (typeof fn !== 'function') throw new CliError(`replay-cli: the engine has no ${name} (--skills needs it)`);
    }
  }
  // --split reads the same context the splitter reads; --recall the live turn's whole history
  // (the trigger included: context.channelMessages lines); the reply mode its own window.
  const before =
    args.before ??
    (args.split
      ? splitMods.splitSettings(hot.config).contextMessages
      : args.recall
        ? Math.min(MAX_BEFORE, Math.max(0, Math.floor(Number(hot.config.context?.channelMessages) || 1) - 1))
        : DEFAULT_BEFORE);
  if (args.split && !hot.prompts?.split) throw new CliError('replay-cli: prompts.split is missing (prompts/split.md or prompts.local/split.md)');
  if (args.recall && !hot.prompts?.lookup) throw new CliError('replay-cli: prompts.lookup is missing (prompts/lookup.md or prompts.local/lookup.md)');

  let client = null;
  const sides = [];
  try {
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    const connection = await connectDiscord({ discord, token: discordToken, configuredGuildId: hot.config.bot?.guildId || '', resolveGuild, log });
    client = connection.client;
    const { guild, guildId, self } = connection;
    const config = hot.config;

    const realStore = createStore({ dataDir });
    const store = readOnlyStore(realStore, SANDBOX_STORE_READS);
    const stateData = store.state.data;
    const calibrator = createCalibrator(stateData.calibration);
    const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
    const realLlm = openrouterKey ? createLlm({ apiKey: openrouterKey, getConfig: () => hot.config, calibrator, state: llmState }) : null;
    // Every request is marked as this tool's own. One sample or the splitter: no cache marker
    // (a skill scenario's runs share their request: the sandbox marks it when it has several).
    const noCache = args.split || args.recall || (args.samples === 1 && !scenarios);
    const llm = {
      complete: (messages, options) =>
        realLlm.complete(messages, { ...options, origin: 'replay', countAgainstDailyCap: false, skipCalibration: true, ...(noCache ? { cache: false } : {}) }),
    };
    const mediaCache = typeof store.getMediaCache === 'function' ? (store.getMediaCache(guildId) ?? null) : null;
    const gifs = hot.config.features?.gifs !== false && typeof store.getGifs === 'function' ? (store.getGifs(guildId) ?? null) : null;
    const customEmoji = createEmojiIndex(client, guildId).list();
    // The live journal's records, read once on first need: the mode and trigger kind each turn recorded at its start.
    let journalCache = null;
    const journalOf = () => (journalCache ??= journalRecords(path.join(liveData, 'guilds', String(guildId), 'journal')));
    const momentOf = (channelId, triggerId) =>
      readMoment({ client, guild, guildId, self, channelId, triggerId, before, config, fetchHistoryWindow, fetchMessage, log });
    const channelOf = (channel) => ({ id: channel.id, name: channel.name ?? null, category: channel.parent?.name ?? null, topic: channel.topic ?? null });

    if (args.pair) {
      // Each side: the bot's config and tracked prompts with its own directory as prompts.local/.
      for (const dir of args.pair) sides.push(promptLayersHot(createHot, root, [dir]));
      const journalDir = path.join(liveData, 'guilds', String(guildId), 'journal');
      const turnIds = new Set(pairTriggers.map((t) => t.turnId).filter(Boolean));
      const actions = turnIds.size > 0 ? journalRecords(journalDir).filter((r) => r?.kind === 'action' && turnIds.has(r.turnId)) : [];
      const order = pairOrder(pairTriggers.length, rng);
      const outDir = path.resolve(root, args.outDir ?? `replay-pair-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`)) throw new CliError('replay-cli: --out may not be under data/');
      if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) throw new CliError(`replay-cli: ${outDir} is not empty`);
      let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
      const onUsage = (u) => {
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
      };
      const sheet = [];
      const key = { a: path.resolve(root, args.pair[0]), b: path.resolve(root, args.pair[1]), asOfMoment: args.asOfMoment, snapshot: args.snapshot !== null ? dataDir : null, pairs: {} };
      const failed = [];
      for (const [index, trigger] of pairTriggers.entries()) {
        if (signal?.aborted) break;
        const id = `p${index + 1}`;
        let moment;
        try {
          moment = await momentOf(trigger.channelId, trigger.triggerId);
        } catch (err) {
          failed.push({ id, triggerId: trigger.triggerId, error: err instanceof CliError ? err.message : `${err?.name ?? 'Error'}` });
          continue;
        }
        const { channel, history, triggerLine, at } = moment;
        const recorded = turnStartForTrigger(journalOf(), trigger.triggerId);
        const recordedMode = recorded ? momentMode(recorded.mode) : null;
        const mode = recordedMode && !isSpontaneous(recordedMode) ? recordedMode : 'reply';
        const kind = recorded ? momentKind(recorded.trigger?.kind) : null;
        const situation = { history, triggerId: trigger.triggerId, kind, mode };
        const media = replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null });
        const answers = {};
        for (const [side, { hot: sideHotView }] of [['A', sides[0]], ['B', sides[1]]]) {
          const hotLike = {
            get prompts() {
              return sideHotView.prompts;
            },
            get config() {
              return hot.config;
            },
          };
          const { view } = memoryViewFor({ hotLike, store, guildId, calibrator, situation, at, args, mods: viewMods });
          try {
            const result = await answerReply({
              view, situation, selfId: self.id, selfName: self.name, channel: channelOf(channel), llm, samples: 1, at, signal, onUsage,
              descriptions: media.descriptions, videos: media.videos, customEmoji, gifs, mediaCache, searchAvailable,
            });
            answers[side] = answerOut(result.answers[0] ?? null);
          } catch (err) {
            answers[side] = null;
            failed.push({ id, side, error: err?.name ?? 'Error' });
          }
        }
        const first = order[index];
        const second = first === 'A' ? 'B' : 'A';
        sheet.push({
          id,
          context: history.map((line) => ({ author: line.self ? self.name : (line.authorName ?? line.authorId), text: line.content ?? '' })),
          first: answers[first],
          second: answers[second],
        });
        key.pairs[id] = {
          first,
          channelId: trigger.channelId,
          triggerId: triggerLine.id,
          turnId: trigger.turnId,
          journalActions: trigger.turnId
            ? actions.filter((r) => r.turnId === trigger.turnId).map((r) => ({ opId: r.opId ?? null, name: r.name ?? null, phase: r.phase ?? null, by: r.by ?? null, result: r.result ?? null }))
            : null,
          answers: { A: answers.A, B: answers.B },
        };
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'sheet.html'), renderSheet(sheet));
      fs.writeFileSync(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 1)}\n`);
      return {
        code: failed.length > 0 || signal?.aborted ? 1 : 0,
        result: { sheet: path.join(outDir, 'sheet.html'), key: path.join(outDir, 'key.json'), pairs: sheet.length, failed, stopped: Boolean(signal?.aborted), usage },
      };
    }

    if (scenarios) {
      return await runSkills({
        args, scenarios, root, liveData, mods: skillMods, hot, store, guild, guildId, client, self, llm, calibrator, mediaCache, gifs, customEmoji,
        searchAvailable, before, log, signal, budget: spendBudget, viewMods, channelOf,
      });
    }

    const { channel, history, triggerLine, at } = await momentOf(args.channelId, args.triggerId);

    // The turn this trigger started: the journal's turn.start record (the one --show-request
    // names, else the newest whose trigger is this message), else the sandbox's guess.
    const recorded = turnStart ?? turnStartForTrigger(journalOf(), args.triggerId);
    const recordedMode = recorded ? momentMode(recorded.mode) : null;
    const mode = recordedMode && !isSpontaneous(recordedMode) ? recordedMode : 'reply';
    const kind = recorded ? momentKind(recorded.trigger?.kind) : null;
    const kindFrom = recorded ? 'journal' : 'guess';
    const situation = { history, triggerId: args.triggerId, kind, mode };

    if (args.split) {
      // The trigger kind as the sandbox reads it: the journal's, else 'reply' to the persona, else 'mention'.
      const { triggerKind } = situationHistory(situation);
      // The live splitter gets captions only when the describer runs (features.mediaDescriptions === true).
      const descriptions =
        hot.config.features?.mediaDescriptions === true
          ? replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null }).descriptions
          : undefined;
      // --text: the same message (author, time, id) with the operator's text in place of its own.
      const trigger = args.text !== null ? { ...triggerLine, content: args.text } : triggerLine;
      return await runSplit({
        hot,
        mods: splitMods,
        llm,
        history,
        trigger,
        triggerKind,
        kindFrom: kind ? 'journal' : 'guess',
        selfName: self.name,
        descriptions,
        samples: args.samples,
        signal,
      });
    }

    if (args.recall) {
      // The trigger kind as the sandbox reads it (reported only: the live turn asks the search classifier on a direct call).
      const { triggerKind } = situationHistory(situation);
      // --text: the same message (author, time, id) with the operator's text in place of its own.
      const trigger = args.text !== null ? { ...triggerLine, content: args.text } : triggerLine;
      // `<recent>` as the reply mode shows it: no line the analyzer added at or after the trigger.
      const asOf = momentView(liveView({ hot, store, guildId, calibrator }), momentCutoff(situation) ?? at);
      return await runRecall({
        hot,
        mods: recallMods,
        llm,
        store,
        guild,
        guildId,
        channel,
        self,
        history,
        trigger,
        triggerKind,
        kindFrom: kind ? 'journal' : 'guess',
        mediaCache,
        recentAsOf: () => asOf.memory.getRecent(),
        replayMedia,
        budget: args.budget,
        showRequest: args.showRequest,
        at,
        signal,
      });
    }

    const { view, hiddenSelf, hidden } = memoryViewFor({ hotLike: hot, store, guildId, calibrator, situation, at, args, mods: viewMods });
    const media = replayMedia(history, { cache: mediaCache, sites: hot.config.media?.video?.sites, before: null });

    if (turnStart) {
      // The request rebuilt, never sent: what the sandbox would send for this turn now.
      const { buildRequest, userText } = await load('behavior/prompt.js');
      const request = buildRequest(
        sandboxRequestInput({
          view, situation, selfId: self.id, selfName: self.name, channel: channelOf(channel), at,
          descriptions: media.descriptions, videos: media.videos, customEmoji, gifs, mediaCache, searchAvailable,
        }),
      );
      const [systemMessage, userMessage] = request.messages;
      return {
        code: 0,
        result: {
          source: 'rebuilt',
          note:
            'no request dump of this turn is kept: this is the sandbox request rebuilt from its turn.start record, the chat fetched now and the memory of ' +
            `${dataDir}; it is not the request the live turn sent (no tool results, no pictures, no neighbouring channels)`,
          turnId: args.showRequestTurn,
          trigger: { id: triggerLine.id, at: new Date(at).toISOString(), kind: kind ?? null, kindFrom, mode },
          channel: { id: channel.id, name: channel.name ?? null },
          memory: args.asOfMoment ? 'as-of-moment' : 'live',
          ...(hidden ? { hidden } : {}),
          request: { system: textOfContent(systemMessage.content), user: userText(request.textFallback ?? userMessage.content) },
        },
      };
    }

    let usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    const result = await answerReply({
      view,
      situation,
      selfId: self.id,
      selfName: self.name,
      channel: channelOf(channel),
      llm,
      samples: args.samples,
      at,
      signal,
      onUsage: (u) => {
        usage = {
          requests: usage.requests + 1,
          promptTokens: usage.promptTokens + (Number(u?.prompt_tokens) || 0),
          completionTokens: usage.completionTokens + (Number(u?.completion_tokens) || 0),
        };
      },
      descriptions: media.descriptions,
      videos: media.videos,
      customEmoji,
      gifs,
      mediaCache,
      searchAvailable,
    });

    const out = {
      trigger: {
        id: triggerLine.id,
        author: triggerLine.authorName ?? null,
        at: new Date(at).toISOString(),
        kind: kind ?? null,
        kindFrom,
        mode,
      },
      channel: { id: channel.id, name: channel.name ?? null },
      lines: history.length,
      memory: args.asOfMoment ? 'as-of-moment' : 'live',
      ...(args.snapshot !== null ? { snapshot: dataDir } : {}),
      ...(hidden ? { hidden } : {}),
      hiddenSelf,
      peopleBlock: blockOf(result.request.user, 'people'),
      answers: result.answers.map((answer) => ({
        think: answer.think,
        messages: answer.messages.map((m) => m.text),
        skip: answer.skip,
        reactions: answer.reactions,
        gif: answer.gif,
      })),
      stopped: result.stopped,
      usage,
    };
    if (args.showRequest) out.request = { system: result.request.system, user: result.request.user };
    return { code: result.stopped ? 1 : 0, result: out };
  } finally {
    hot.close();
    for (const side of sides) {
      side.hot.close();
      fs.rmSync(side.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}

// ---- entry point -------------------------------------------------------------

/** Whether this file is the script node was started with (symlinks and drive-letter case allowed for). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    return norm(fs.realpathSync(process.argv[1])) === norm(fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Every log line, the engine's included, goes to stderr; stdout keeps only the final JSON object.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  const finish = (code, result) => stdoutWrite(`${JSON.stringify(result)}\n`, () => process.exit(code));

  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (!controller.signal.aborted) {
      process.stderr.write('replay-cli: stopping (Ctrl-C again to exit at once)\n');
      controller.abort();
      return;
    }
    process.exit(130);
  });
  process.on('unhandledRejection', (err) => process.stderr.write(`replay-cli: unhandled rejection: ${err?.name ?? 'Error'}: ${err?.message ?? err}\n`));

  main(process.argv.slice(2), { signal: controller.signal }).then(
    ({ code, result }) => finish(code, result),
    (err) => {
      const message = err instanceof CliError ? err.message : `replay-cli: ${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      process.stderr.write(`${message}\n`);
      process.exit(err instanceof CliError ? err.exitCode : 1);
    },
  );
}
