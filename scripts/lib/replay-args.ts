// The command line of scripts/replay.ts: the usage text, the limits a flag is checked against and `parseArgs`, which
// turns `argv` into the one options object every mode of the script reads. scripts/replay.ts re-exports what the
// tests and the other scripts import from it.

import { ANSWERS_TIMEOUT_MIN } from './answers-dir.ts';
import { CliError } from './cli.ts';
import { DRAW_MODES, DEFAULT_LIVE_PICTURES, MAX_PICTURES, isDateKey } from './selfreflection-day.ts';
import type { Untyped } from '../../src/tools/types.ts';

export const USAGE =
  'usage: node scripts/replay.ts <placeId> <triggerMessageId> [--before 40] [--samples 1] [--show-request] [--as-of-moment] [--hide-self <substring>]... [--hide-self-all] [--snapshot <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts <placeId> <triggerMessageId> --split [--text "<candidate text>"] [--before <split.contextMessages>] [--samples 3] [--spend <usd>]\n' +
  '       node scripts/replay.ts <placeId> <triggerMessageId> --recall [--text "<candidate text>"] [--before <context.channelMessages - 1>] [--budget <ms>] [--show-request] [--spend <usd>]\n' +
  '       node scripts/replay.ts --pair <promptsDirA> <promptsDirB> (--triggers <file> | <placeId> <triggerMessageId>) [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --show-request <turnId> [--steps] [--snapshot <dir>] [--before 40] [--as-of-moment]\n' +
  '       node scripts/replay.ts --selfreflection <selfPicture|picture> [--count 1] [--topic "<text>"] [--selfreflection-own-history] [--prompts <dir>] [--out <file>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --skills <scenarios.json> [--prompts <dir> | --pair-prompts <dirA> <dirB>] [--out <dir>] [--before 40] [--as-of-moment] [--snapshot <dir>] [--dry] [--core-tools] [--transport native|text] [--spend <usd>]\n' +
  '       node scripts/replay.ts --pair-transport (--triggers <file> | <placeId> <triggerMessageId>) [--no-cache] [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --loop-triggers (--triggers <file> | <placeId> <triggerMessageId>) [--transport native|text] [--no-cache] [--before 40] [--as-of-moment] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --selfreflection-day [--seed <text>] [--date YYYY-MM-DD] [--draw fake|live] [--max-pictures <n>] [--out <dir>] [--spend <usd>]   (cwd: the bot directory)\n' +
  '       node scripts/replay.ts --inner <intention_due|errand_deadline|review|heartbeat> [--intention <id> | --review] [--snapshot <dir>] [--show-request] [--samples n] [--prompts <dir>] [--out <file>] [--spend <usd>] [--hide-channel <id>]... [--hide-message <id>]...\n' +
  '       (any mode that sends requests also takes: [--answers-dir <dir> [--answers-first-only] [--answers-all] [--answers-timeout-min 20]])';

/** The wake kinds `--inner` runs (src/behavior/inner.ts#WAKE_KINDS). */
export const INNER_KINDS = Object.freeze(['intention_due', 'errand_deadline', 'review', 'heartbeat']);

/** An intention id (src/intentions/model.ts#newIntentionId). */
export const INTENTION_ID = /^[A-Za-z0-9_-]{1,20}$/;

/** The selfreflection kinds a brief is asked of: the ones that draw. */
export const SELFREFLECTION_KINDS = Object.freeze(['selfPicture', 'picture']);

export const MAX_SELFREFLECTION_COUNT = 50;

/** The longest `--seed` of a `--selfreflection-day` run. */
export const MAX_SEED_CHARS = 200;

/** A journal turn id (src/memory/journal.ts#start). */
export const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;

export const SNOWFLAKE = /^\d{17,20}$/;

export const MAX_BEFORE = 500;

export const DEFAULT_SAMPLES = 1;

export const DEFAULT_SPLIT_SAMPLES = 3;

export const MAX_SAMPLES = 10;

export const MAX_BUDGET_MS = 600000;

/** A whole number in [min, max] from a flag's value, or a CliError with the usage. */
export function intFlag(value: Untyped, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(USAGE);
  return n;
}

/** The options of one run of scripts/replay.ts, as `parseArgs` reads them off the command line. */
export type ReplayArgs = {
  before: number | null;
  samples: number | null;
  showRequest: boolean;
  asOfMoment: boolean;
  hideSelf: Array<string>;
  hideSelfAll: boolean;
  split: boolean;
  recall: boolean;
  budget: number | null;
  text: string | null;
  pair: [string, string] | null;
  triggers: string | null;
  snapshot: string | null;
  outDir: string | null;
  spend: string | undefined;
  showRequestTurn: string | null;
  selfreflection: string | null;
  count: number | null;
  topic: string | null;
  prompts: string | null;
  skills: string | null;
  dry: boolean;
  pairPrompts: [string, string] | null;
  selfreflectionDay: boolean;
  seed: string | null;
  date: string | null;
  draw: string | null;
  maxPictures: number | null;
  coreTools: boolean;
  pairTransport: boolean;
  loopTriggers: boolean;
  transport: 'native' | 'text' | null;
  steps: boolean;
  noCache: boolean;
  inner: string | null;
  intention: string | null;
  review: boolean;
  hideChannels: Array<string>;
  hideMessages: Array<string>;
  answersDir: string | null;
  answersFirstOnly: boolean;
  answersTimeoutMin: number;
  placeId?: string | null;
  triggerId?: string | null;
  answersAll?: boolean;
  selfreflectionOwnHistory?: boolean;
};

/**
 * `argv` (after the script) as `{ placeId, triggerId, before, samples,
 * showRequest, asOfMoment, hideSelf, hideSelfAll, split, recall, budget, text }`
 * (`hideSelf`: the substrings, lower-cased; `before` null when not given:
 * the caller picks the mode's default; `text` null without `--text`;
 * `budget` null without `--budget`); throws a CliError with the usage.
 * `--split` takes no reply-mode flag; `--recall` takes only `--text`,
 * `--before`, `--budget` and `--show-request`; `--text` needs `--split`
 * or `--recall`, `--budget` needs `--recall`. Also `pair` ([dirA, dirB] or
 * null), `triggers` (a file, with `--pair` only), `snapshot`, `outDir` (with
 * `--pair` only), `spend` (the raw `--spend` value, undefined when absent) and
 * `showRequestTurn` (`--show-request <turnId>`: no positionals, no mode flag; `--steps`
 * sets `steps` and goes only with it).
 * `--selfreflection <kind>` sets `selfreflection` (one of SELFREFLECTION_KINDS) and takes only `--count`
 * (`count`, 1 by default), `--topic` (`topic`, raw), `--prompts` (`prompts`),
 * `--out` (`outDir`: the briefs file) and `--spend`; those three take nothing
 * else. `--skills <file>` sets `skills` (the scenario file) and takes only
 * `--out`, `--before`, `--as-of-moment`, `--snapshot`, `--spend`, `--dry`
 * (`dry`, only with it), and one of `--prompts <dir>` (`prompts`) and
 * `--pair-prompts <dirA> <dirB>` (`pairPrompts`, [dirA, dirB], only with it;
 * null when absent); no positionals. `--selfreflection-day` sets `selfreflectionDay` and takes only `--seed`
 * (`seed`, raw, null when absent), `--date` (`date`, a calendar `YYYY-MM-DD`), `--draw` (`draw`,
 * `fake` by default), `--max-pictures` (`maxPictures`, only with `--draw live`, DEFAULT_LIVE_PICTURES
 * by default there, null with `fake`), `--out` and `--spend`; those four take nothing else.
 */
export function parseArgs(argv: Array<string>): ReplayArgs {
  const out: ReplayArgs = {
    before: null,
    samples: null,
    showRequest: false,
    asOfMoment: false,
    hideSelf: [],
    hideSelfAll: false,
    split: false,
    recall: false,
    budget: null,
    text: null,
    pair: null,
    triggers: null,
    snapshot: null,
    outDir: null,
    spend: undefined,
    showRequestTurn: null,
    selfreflection: null,
    count: null,
    topic: null,
    prompts: null,
    skills: null,
    dry: false,
    pairPrompts: null,
    selfreflectionDay: false,
    seed: null,
    date: null,
    draw: null,
    maxPictures: null,
    coreTools: false,
    pairTransport: false,
    loopTriggers: false,
    transport: null,
    steps: false,
    noCache: false,
    inner: null,
    intention: null,
    review: false,
    hideChannels: [],
    hideMessages: [],
    answersDir: null,
    answersFirstOnly: false,
    answersTimeoutMin: ANSWERS_TIMEOUT_MIN,
  };
  const positional = [];
  const pathValue = (value: Untyped) => {
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
    else if (arg === '--answers-dir') out.answersDir = pathValue(argv[(i += 1)]);
    else if (arg === '--answers-first-only') out.answersFirstOnly = true;
    else if (arg === '--answers-timeout-min') out.answersTimeoutMin = intFlag(argv[(i += 1)], 1, 1440);
    else if (arg === '--skills') out.skills = pathValue(argv[(i += 1)]);
    else if (arg === '--dry') out.dry = true;
    else if (arg === '--steps') out.steps = true;
    else if (arg === '--core-tools') out.coreTools = true;
    else if (arg === '--pair-transport') out.pairTransport = true;
    else if (arg === '--loop-triggers') out.loopTriggers = true;
    else if (arg === '--no-cache') out.noCache = true;
    else if (arg === '--transport') {
      const transport = argv[(i += 1)];
      if (transport !== 'native' && transport !== 'text') throw new CliError(USAGE);
      out.transport = transport;
    } else if (arg === '--as-of-moment') out.asOfMoment = true;
    else if (arg === '--hide-self-all') out.hideSelfAll = true;
    else if (arg === '--split') out.split = true;
    else if (arg === '--recall') out.recall = true;
    else if (arg === '--budget') out.budget = intFlag(argv[(i += 1)], 1, MAX_BUDGET_MS);
    else if (arg === '--selfreflection-day') out.selfreflectionDay = true;
    else if (arg === '--inner') {
      const kind = argv[(i += 1)];
      if (!INNER_KINDS.includes(kind)) throw new CliError(USAGE);
      out.inner = kind;
    } else if (arg === '--hide-channel' || arg === '--hide-message') {
      const id = argv[(i += 1)];
      if (!/^\d{1,25}$/.test(id ?? '')) throw new CliError(USAGE);
      (arg === '--hide-channel' ? out.hideChannels : out.hideMessages).push(id);
    } else if (arg === '--intention') {
      const id = argv[(i += 1)];
      if (!INTENTION_ID.test(id ?? '')) throw new CliError(USAGE);
      out.intention = id;
    } else if (arg === '--review') out.review = true;
    else if (arg === '--seed') {
      const seed = pathValue(argv[(i += 1)]);
      if (seed.length > MAX_SEED_CHARS) throw new CliError(USAGE);
      out.seed = seed;
    } else if (arg === '--date') {
      const date = argv[(i += 1)];
      if (!isDateKey(date)) throw new CliError(USAGE);
      out.date = date;
    } else if (arg === '--draw') {
      const draw = argv[(i += 1)];
      if (!DRAW_MODES.includes(draw)) throw new CliError(USAGE);
      out.draw = draw;
    } else if (arg === '--max-pictures') out.maxPictures = intFlag(argv[(i += 1)], 1, MAX_PICTURES);
    else if (arg === '--selfreflection') {
      const kind = argv[(i += 1)];
      if (!SELFREFLECTION_KINDS.includes(kind)) throw new CliError(USAGE);
      out.selfreflection = kind;
    } else if (arg === '--count') out.count = intFlag(argv[(i += 1)], 1, MAX_SELFREFLECTION_COUNT);
    else if (arg === '--prompts') out.prompts = pathValue(argv[(i += 1)]);
    else if (arg === '--pair-prompts') out.pairPrompts = [pathValue(argv[(i += 1)]), pathValue(argv[(i += 1)])];
    else if (arg === '--topic') {
      const topic = argv[(i += 1)];
      if (typeof topic !== 'string') throw new CliError(USAGE);
      out.topic = topic;
    } else if (arg === '--text') {
      const text = argv[(i += 1)];
      if (typeof text !== 'string' || text.trim() === '') throw new CliError(USAGE);
      out.text = text;
    } else if (arg === '--hide-self') {
      const needle = argv[(i += 1)];
      if (typeof needle !== 'string' || needle.trim() === '' || needle.startsWith('--')) throw new CliError(USAGE);
      out.hideSelf.push(needle.toLowerCase());
    } else if (arg === '--before') out.before = intFlag(argv[(i += 1)], 0, MAX_BEFORE);
    else if (arg === '--samples') out.samples = intFlag(argv[(i += 1)], 1, MAX_SAMPLES);
    else if (arg.startsWith('--')) throw new CliError(USAGE);
    else positional.push(arg);
  }
  if (out.steps && out.showRequestTurn === null) throw new CliError(USAGE);
  const [placeId, triggerId, extra] = positional;
  // --no-cache: the trigger runs send her requests with the prompt-cache marker a live turn has; this one sends none.
  if (out.noCache && !(out.pairTransport || out.loopTriggers)) throw new CliError(USAGE);
  if (out.inner !== null) {
    // --intention for an intention's wake, --review only with the review (the heartbeat takes neither); --snapshot, --show-request,
    // --samples, --prompts, --out and --spend; no positionals.
    const review = out.inner === 'review';
    const bare = review || out.inner === 'heartbeat';
    if (
      positional.length > 0 ||
      (bare ? out.intention !== null : out.intention === null || out.review) ||
      (out.review && !review) ||
      out.selfreflectionDay ||
      out.selfreflection !== null ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.count !== null ||
      out.topic !== null ||
      out.dry ||
      out.pairPrompts !== null ||
      out.coreTools ||
      out.pairTransport ||
      out.loopTriggers ||
      out.transport !== null ||
      out.seed !== null ||
      out.date !== null ||
      out.draw !== null ||
      out.maxPictures !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, review, samples: out.samples ?? 1, placeId: null, triggerId: null };
  }
  if (out.intention !== null || out.review || out.hideChannels.length > 0 || out.hideMessages.length > 0)
    throw new CliError(USAGE);
  if (out.selfreflectionDay) {
    // The day flags, --out and --spend only; no positionals; --max-pictures with --draw live only.
    if (
      positional.length > 0 ||
      out.selfreflection !== null ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.snapshot !== null ||
      out.count !== null ||
      out.topic !== null ||
      out.prompts !== null ||
      out.dry ||
      out.pairPrompts !== null ||
      out.coreTools ||
      out.pairTransport ||
      out.loopTriggers ||
      out.transport !== null ||
      (out.maxPictures !== null && out.draw !== 'live')
    ) {
      throw new CliError(USAGE);
    }
    const draw = out.draw ?? 'fake';
    return {
      ...out,
      draw,
      maxPictures: draw === 'live' ? (out.maxPictures ?? DEFAULT_LIVE_PICTURES) : null,
      samples: 1,
      placeId: null,
      triggerId: null,
    };
  }
  if (out.seed !== null || out.date !== null || out.draw !== null || out.maxPictures !== null)
    throw new CliError(USAGE);
  if (out.skills !== null) {
    // The scenario file with the memory, output and prompt-layer flags, --spend and --dry only; no positionals.
    if (
      positional.length > 0 ||
      out.selfreflection !== null ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.count !== null ||
      out.topic !== null ||
      (out.prompts !== null && out.pairPrompts !== null) ||
      out.pairTransport ||
      out.loopTriggers
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: 1, placeId: null, triggerId: null };
  }
  if (out.dry || out.pairPrompts !== null || out.coreTools) throw new CliError(USAGE);
  if (
    (out.pairTransport || out.loopTriggers) &&
    (out.pair || out.selfreflection !== null || out.showRequestTurn !== null || (out.pairTransport && out.loopTriggers))
  )
    throw new CliError(USAGE);
  if (out.transport !== null && !out.loopTriggers) throw new CliError(USAGE);
  if (out.selfreflection !== null) {
    // The selfreflection flags, --out and --spend only; no positionals.
    if (
      positional.length > 0 ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.pair ||
      out.triggers !== null ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.asOfMoment ||
      out.before !== null ||
      out.snapshot !== null
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, count: out.count ?? 1, samples: 1, placeId: null, triggerId: null };
  }
  if (out.count !== null || out.topic !== null || out.prompts !== null) throw new CliError(USAGE);
  if (out.showRequestTurn !== null) {
    // Only the memory and history flags go with it; no model request is made.
    if (
      positional.length > 0 ||
      out.showRequest ||
      out.pair ||
      out.triggers ||
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0 ||
      out.outDir
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: DEFAULT_SAMPLES, placeId: null, triggerId: null };
  }
  if (out.pair || out.pairTransport || out.loopTriggers) {
    // Reply mode only, one sample per side; the triggers from the file or the two positionals.
    // --pair-transport: the two sides are the native transport (A) and the text one (B), not two prompt layers.
    // --loop-triggers: one side (`--transport`, default the config's), the turn's steps recorded.
    if (
      out.split ||
      out.recall ||
      out.samples !== null ||
      out.showRequest ||
      out.text !== null ||
      out.budget !== null ||
      out.hideSelfAll ||
      out.hideSelf.length > 0
    )
      throw new CliError(USAGE);
    if (
      out.triggers !== null
        ? positional.length > 0
        : extra !== undefined || !SNOWFLAKE.test(placeId ?? '') || !SNOWFLAKE.test(triggerId ?? '')
    )
      throw new CliError(USAGE);
    return { ...out, samples: 1, placeId: placeId ?? null, triggerId: triggerId ?? null };
  }
  if (out.triggers !== null || out.outDir !== null) throw new CliError(USAGE);
  if (extra !== undefined || !SNOWFLAKE.test(placeId ?? '') || !SNOWFLAKE.test(triggerId ?? ''))
    throw new CliError(USAGE);
  if (out.split && (out.showRequest || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0))
    throw new CliError(USAGE);
  if (out.split && out.recall) throw new CliError(USAGE);
  if (out.recall && (out.samples !== null || out.asOfMoment || out.hideSelfAll || out.hideSelf.length > 0))
    throw new CliError(USAGE);
  if (out.text !== null && !out.split && !out.recall) throw new CliError(USAGE);
  if (out.budget !== null && !out.recall) throw new CliError(USAGE);
  return {
    ...out,
    samples: out.samples ?? (out.split ? DEFAULT_SPLIT_SAMPLES : DEFAULT_SAMPLES),
    placeId,
    triggerId,
  };
}
