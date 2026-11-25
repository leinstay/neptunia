// The command line of scripts/replay.ts: the usage text, the limits a flag is checked against and `parseArgs`, which
// turns `argv` into the one options object every mode of the script reads but the stored turn
// (scripts/lib/replay-stored.ts parses its own).

import { ANSWERS_TIMEOUT_MIN } from './answers-dir.ts';
import { CliError } from './cli.ts';
import { DRAW_MODES, DEFAULT_LIVE_PICTURES, MAX_PICTURES, isDateKey } from './diary-day.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { DIARY_KINDS } from '../../src/behavior/diary.ts';

export const USAGE =
  'usage: node scripts/replay.ts <placeId> <triggerMessageId> [--samples 1] [--show-request] [--snapshot <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --show-request <turnId> [--steps] [--snapshot <dir>]\n' +
  '       node scripts/replay.ts --data <copy dir> (--turn <turnId> ... | --cut <turnId> --into <new copy dir>)   (a stored turn, its own usage)\n' +
  '       node scripts/replay.ts --skills <scenarios.json> [--prompts <dir>] [--out <dir>] [--snapshot <dir>] [--dry] [--core-tools] [--spend <usd>]\n' +
  '       node scripts/replay.ts --loop-triggers (--triggers <file> | <placeId> <triggerMessageId>) [--no-cache] [--snapshot <dir>] [--out <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --diary-day [--seed <text>] [--date YYYY-MM-DD] [--draw fake|live] [--max-pictures <n>] [--out <dir>] [--spend <usd>]   (cwd: the bot directory)\n' +
  '       node scripts/replay.ts --diary-day --diary-kind <kind> [--samples n] [--seed <text>] [--prompts <dir>] [--draw fake|live|none] [--max-pictures <n>] [--show-request] [--diary-voice] [--out <dir>] [--spend <usd>]\n' +
  '       node scripts/replay.ts --inner <intention_due|errand_deadline|heartbeat> [--intention <id>] [--snapshot <dir>] [--show-request] [--samples n] [--seed <text>] [--prompts <dir>] [--out <file>] [--spend <usd>] [--hide-channel <id>]... [--hide-message <id>]... [--errand-answers <file>]\n' +
  '       (any mode that sends requests also takes: [--answers-dir <dir> [--answers-timeout-min 20]])';

/** The wake kinds `--inner` runs (src/behavior/inner.ts#WAKE_KINDS). */
export const INNER_KINDS = Object.freeze(['intention_due', 'errand_deadline', 'heartbeat']);

/** An intention id (src/intentions/model.ts#newIntentionId). */
export const INTENTION_ID = /^[A-Za-z0-9_-]{1,20}$/;

/** The longest `--seed` of a `--diary-day` or `--inner` run. */
export const MAX_SEED_CHARS = 200;

/** A journal turn id (src/memory/journal.ts#start). */
export const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;

export const SNOWFLAKE = /^\d{17,20}$/;

export const DEFAULT_SAMPLES = 1;

export const MAX_SAMPLES = 10;

/** A whole number in [min, max] from a flag's value, or a CliError with the usage. */
export function intFlag(value: Untyped, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(USAGE);
  return n;
}

/** The options of one run of scripts/replay.ts, as `parseArgs` reads them off the command line. */
export type ReplayArgs = {
  samples: number | null;
  showRequest: boolean;
  triggers: string | null;
  snapshot: string | null;
  outDir: string | null;
  spend: string | undefined;
  showRequestTurn: string | null;
  prompts: string | null;
  skills: string | null;
  dry: boolean;
  diaryDay: boolean;
  diaryKind: string | null;
  diaryVoice: boolean;
  seed: string | null;
  date: string | null;
  draw: string | null;
  maxPictures: number | null;
  coreTools: boolean;
  loopTriggers: boolean;
  steps: boolean;
  noCache: boolean;
  inner: string | null;
  intention: string | null;
  hideChannels: Array<string>;
  hideMessages: Array<string>;
  answersDir: string | null;
  answersTimeoutMin: number;
  errandAnswers?: string | null;
  placeId?: string | null;
  triggerId?: string | null;
};

/**
 * `argv` (after the script) as `{ placeId, triggerId, samples, showRequest }`;
 * throws a CliError with the usage.
 * Also `triggers` (a file, with `--loop-triggers` only), `snapshot`, `outDir` (with
 * `--loop-triggers` only), `spend` (the raw `--spend` value, undefined when absent) and
 * `showRequestTurn` (`--show-request <turnId>`: no positionals, no mode flag; `--steps`
 * sets `steps` and goes only with it).
 * `--skills <file>` sets `skills` (the scenario file) and takes only
 * `--out`, `--snapshot`, `--spend`, `--dry`
 * (`dry`, only with it), and `--prompts <dir>` (`prompts`, null when absent); no positionals.
 * `--diary-day` sets `diaryDay` and takes only `--seed`
 * (`seed`, raw, null when absent), `--date` (`date`, a calendar `YYYY-MM-DD`), `--draw` (`draw`,
 * `fake` by default), `--max-pictures` (`maxPictures`, only with `--draw live`, DEFAULT_LIVE_PICTURES
 * by default there, null with `fake`), `--out` and `--spend`; those four take nothing else. `--diary-kind <kind>`
 * (`diaryKind`, a key of DIARY_KINDS) goes with `--diary-day` alone and runs one entry of that kind `--samples` times
 * (`samples`, 1 by default); it takes `--prompts <dir>` and `--draw none`, which the day does not, and no `--date`.
 */
/** Whether `out` holds a flag only `--inner` takes: `--intention`, `--hide-channel`, `--hide-message`, `--errand-answers`. */
function innerOnly(out: ReplayArgs): boolean {
  return (
    out.intention !== null ||
    out.hideChannels.length > 0 ||
    out.hideMessages.length > 0 ||
    (out.errandAnswers ?? null) !== null
  );
}

/** Whether `out` holds a flag only `--diary-day` takes: `--date`, `--draw`, `--max-pictures`, `--diary-kind`, `--diary-voice`. */
function dayFlags(out: ReplayArgs): boolean {
  return out.date !== null || out.draw !== null || out.maxPictures !== null || out.diaryKind !== null || out.diaryVoice;
}

/**
 * Whether `out` holds a flag of `--diary-kind` without it (`--samples`, `--prompts`, `--draw none`, `--show-request`,
 * `--diary-voice`), or `--date` with it.
 */
function diaryKindMisused(out: ReplayArgs): boolean {
  if (out.diaryKind !== null) return out.date !== null;
  return out.samples !== null || out.prompts !== null || out.draw === 'none' || out.showRequest || out.diaryVoice;
}

/** The switches of the diary modes, each the field it sets. */
const DIARY_SWITCHES: Readonly<Record<string, 'diaryDay' | 'diaryVoice'>> = {
  '--diary-day': 'diaryDay',
  '--diary-voice': 'diaryVoice',
};

export function parseArgs(argv: Array<string>): ReplayArgs {
  const out: ReplayArgs = {
    samples: null,
    showRequest: false,
    triggers: null,
    snapshot: null,
    outDir: null,
    spend: undefined,
    showRequestTurn: null,
    prompts: null,
    skills: null,
    dry: false,
    diaryDay: false,
    diaryKind: null,
    diaryVoice: false,
    seed: null,
    date: null,
    draw: null,
    maxPictures: null,
    coreTools: false,
    loopTriggers: false,
    steps: false,
    noCache: false,
    inner: null,
    intention: null,
    hideChannels: [],
    hideMessages: [],
    answersDir: null,
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
    } else if (arg === '--triggers') out.triggers = pathValue(argv[(i += 1)]);
    else if (arg === '--snapshot') out.snapshot = pathValue(argv[(i += 1)]);
    else if (arg === '--out') out.outDir = pathValue(argv[(i += 1)]);
    else if (arg === '--spend') out.spend = pathValue(argv[(i += 1)]);
    else if (arg === '--answers-dir') out.answersDir = pathValue(argv[(i += 1)]);
    else if (arg === '--answers-timeout-min') out.answersTimeoutMin = intFlag(argv[(i += 1)], 1, 1440);
    else if (arg === '--errand-answers') out.errandAnswers = pathValue(argv[(i += 1)]);
    else if (arg === '--skills') out.skills = pathValue(argv[(i += 1)]);
    else if (arg === '--dry') out.dry = true;
    else if (arg === '--steps') out.steps = true;
    else if (arg === '--core-tools') out.coreTools = true;
    else if (arg === '--loop-triggers') out.loopTriggers = true;
    else if (arg === '--no-cache') out.noCache = true;
    else if (Object.hasOwn(DIARY_SWITCHES, arg)) out[DIARY_SWITCHES[arg]] = true;
    else if (arg === '--diary-kind') {
      const kind = argv[(i += 1)];
      if (!Object.hasOwn(DIARY_KINDS, kind ?? '')) throw new CliError(USAGE);
      out.diaryKind = kind;
    } else if (arg === '--inner') {
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
    } else if (arg === '--seed') {
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
    else if (arg === '--prompts') out.prompts = pathValue(argv[(i += 1)]);
    else if (arg === '--samples') out.samples = intFlag(argv[(i += 1)], 1, MAX_SAMPLES);
    else if (arg.startsWith('--')) throw new CliError(USAGE);
    else positional.push(arg);
  }
  if (out.steps && out.showRequestTurn === null) throw new CliError(USAGE);
  const [placeId, triggerId, extra] = positional;
  // --no-cache: the trigger runs send the persona's requests with the prompt-cache marker a live turn has; this one sends none.
  if (out.noCache && !out.loopTriggers) throw new CliError(USAGE);
  if (out.inner !== null) {
    // --intention for an intention's wake (the heartbeat takes none) and the flags of innerOnly; no positionals.
    if (
      positional.length > 0 ||
      (out.inner === 'heartbeat' ? out.intention !== null : out.intention === null) ||
      out.diaryDay ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.triggers !== null ||
      out.dry ||
      out.coreTools ||
      out.loopTriggers ||
      dayFlags(out)
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: out.samples ?? 1, placeId: null, triggerId: null };
  }
  if (innerOnly(out)) throw new CliError(USAGE);
  if (out.diaryDay) {
    // The day flags, --out and --spend only; no positionals; --max-pictures with --draw live only.
    if (
      positional.length > 0 ||
      out.skills !== null ||
      out.showRequestTurn !== null ||
      out.triggers !== null ||
      diaryKindMisused(out) ||
      out.snapshot !== null ||
      out.dry ||
      out.coreTools ||
      out.loopTriggers ||
      (out.maxPictures !== null && out.draw !== 'live')
    ) {
      throw new CliError(USAGE);
    }
    const draw = out.draw ?? 'fake';
    return {
      ...out,
      draw,
      maxPictures: draw === 'live' ? (out.maxPictures ?? DEFAULT_LIVE_PICTURES) : null,
      samples: out.samples ?? 1,
      placeId: null,
      triggerId: null,
    };
  }
  if (out.seed !== null || dayFlags(out)) throw new CliError(USAGE);
  if (out.skills !== null) {
    // The scenario file with the memory, output and prompt-layer flags, --spend and --dry only; no positionals.
    if (
      positional.length > 0 ||
      out.showRequestTurn !== null ||
      out.showRequest ||
      out.triggers !== null ||
      out.samples !== null ||
      out.loopTriggers
    ) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: 1, placeId: null, triggerId: null };
  }
  if (out.dry || out.coreTools) throw new CliError(USAGE);
  if (out.loopTriggers && out.showRequestTurn !== null) throw new CliError(USAGE);
  if (out.prompts !== null) throw new CliError(USAGE);
  if (out.showRequestTurn !== null) {
    // Only the memory and history flags go with it; no model request is made.
    if (positional.length > 0 || out.showRequest || out.triggers || out.samples !== null || out.outDir) {
      throw new CliError(USAGE);
    }
    return { ...out, samples: DEFAULT_SAMPLES, placeId: null, triggerId: null };
  }
  if (out.loopTriggers) {
    // One sample per trigger, the turn's steps recorded; the triggers from the file or the two positionals.
    if (out.samples !== null || out.showRequest) throw new CliError(USAGE);
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
  return {
    ...out,
    samples: out.samples ?? DEFAULT_SAMPLES,
    placeId,
    triggerId,
  };
}
