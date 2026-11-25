// The scenarios of `--skills`: the file's shape checked by parseScenarios, the estimates per scenario and per decision,
// the grants and the catalogue a scenario gives the persona, its trigger, and an errand's result with its files and budget.

import { createHash } from 'node:crypto';
import { isPlainObject } from '../../src/config.ts';
import { grant as accessGrant, revoke as accessRevoke } from '../../src/tools/operations/grants.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import { SNOWFLAKE } from './replay-args.ts';
import type { Scenario, Rec, TriggerLine } from './replay-types.ts';

// ---- skill scenarios (--skills) ----------------------------------------------------

/** The fields a scenario may have. */
const SCENARIO_KEYS = Object.freeze([
  'id',
  'placeId',
  'before',
  'author',
  'text',
  'steps',
  'taskResult',
  'grants',
  'runs',
]);

/** The fields of a task-result scenario's errand, and those of one of its files. */
const TASK_RESULT_KEYS = Object.freeze(['agent', 'goal', 'state', 'text', 'files', 'asker']);

const TASK_FILE_KEYS = Object.freeze(['name', 'contentType', 'bytes']);

/** The ends an errand's result turn follows (src/errands/store.ts: a cancelled one opens none). */
const TASK_RESULT_STATES = Object.freeze(['done', 'failed']);

/** An agent's name (src/agent-runner/profiles.ts: the profile's key), the longest result text, the most files. */
const AGENT_NAME = /^[A-Za-z0-9_-]{1,32}$/;

const MAX_TASK_TEXT = 20_000;

const MAX_TASK_FILES = 10;

/** A file name a handle may carry (src/errands/store.ts#parseFileHandle): no slash, no line break. */
const TASK_FILE_NAME = /^[^/\\\r\n]{1,200}$/;

/** The error code of a failed errand when it gives none (src/errands/store.ts#finish's). */
const TASK_FAILED_CODE = 'failed';

/** The fields a step of a multi-step scenario may have, and those of a burst message. */
const STEP_KEYS = Object.freeze(['author', 'text', 'gapMinutes', 'burst', 'self']);

const BURST_KEYS = Object.freeze(['author', 'text', 'self']);

/** The most steps a scenario may have, and the most messages a burst adds. */
const MAX_STEPS = 20;

const MAX_BURST = 10;

/** A step's default distance from the line before it, and its longest (minutes): a week. */
const DEFAULT_GAP_MINUTES = 1;

const MAX_GAP_MINUTES = 7 * 24 * 60;

/** How far apart the messages of one step (its message, then its burst) come in. */
export const BURST_SPACING_MS = 5_000;

const SCENARIO_ID = /^[A-Za-z0-9._-]{1,64}$/;

const MAX_RUNS = 10;

/** Discord's longest message: the most a scenario's text or canned result may hold. */
const MAX_SCENARIO_TEXT = 4000;

/** How long after the anchor message the invented one is written. */
export const SCENARIO_AFTER_MS = 60_000;

/** Discord's epoch, for the invented message's id (a snowflake of its moment). */
const DISCORD_EPOCH = 1420070400000n;

/**
 * The scenarios of a `--skills` file (`text`, its content): a non-empty JSON array of
 * `{ id, placeId, before?, author, text, grants, runs? }` -- `id` 1..64
 * of `A-Z a-z 0-9 . _ -`, unique; `placeId`, `author` and `before` (optional) message, channel
 * and member ids; `text` the invented message (1..4000 characters); `grants` a list of skill
 * names, groups or `*` (may be empty); `runs` 1..10 (default 1). A multi-step scenario has `steps` instead of
 * `author` / `text`: 1..20 of `{ author?, text?, gapMinutes?, burst? }` -- the step's
 * message (`author` and `text` together, or neither), then `burst`, 1..10 more `{ author, text }`
 * from anyone (at least one message per step), played as the live queue plays them (playSteps);
 * `gapMinutes` how long
 * after the line before it the step's first message comes (more than 0, at most a week, default
 * 1). A line of
 * the persona's own is seeded, no turn run for it (playSteps): a step `{ self: "<text>",
 * gapMinutes? }` (nothing else beside it), or a burst item `{ self: true, text }` (no author);
 * at least one step must hold a message that is not the persona's. Parsed, a step is `{ messages:
 * [{ author, text } | { self: true, text }], own, gapMinutes }` (`own`: its
 * first message is the step's own `author` / `text`, which tags the persona) and the scenario
 * has no `author` / `text`. A task-result scenario has `taskResult` instead of `author` /
 * `text` / `steps`: `{ agent, goal, state, text?, files?, asker }` -- `agent` an agent's name
 * (1..32 of `A-Z a-z 0-9 _ -`), `goal` what was asked (1..4000 characters), `state` `"done"` or
 * `"failed"`, `text` what it brought back (at most 20000 characters, default ''), `files` up to
 * 10 `{ name, contentType?, bytes? }` (a name of 1..200 characters without a slash or a line
 * break, unique; `contentType` text, default ''; `bytes` a whole number >= 0, default 0), `asker`
 * the member id who asked; its origin channel is the scenario's `placeId`. Parsed, it is
 * `{ agent, goal, state, text, files: [{ name, contentType, bytes }], asker }`. Any other field,
 * type or value is a CliError naming the scenario (and the step). Names are checked against the
 * registry later (scenarioGrants).
 */
export function parseScenarios(text: string): Array<Scenario> {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err: Untyped) {
    throw new CliError(`replay-cli: the scenario file is not JSON (${err.message})`);
  }
  if (!Array.isArray(data) || data.length === 0)
    throw new CliError('replay-cli: the scenario file must be a non-empty JSON array');
  const ids = new Set<Untyped>();
  return data.map((raw, index) => {
    const bad = (what: string) =>
      new CliError(`replay-cli: scenario ${index + 1}${typeof raw?.id === 'string' ? ` (${raw.id})` : ''}: ${what}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
    for (const key of Object.keys(raw)) if (!SCENARIO_KEYS.includes(key)) throw bad(`unknown field ${key}`);
    if (typeof raw.id !== 'string' || !SCENARIO_ID.test(raw.id))
      throw bad('id must be 1..64 characters of A-Z a-z 0-9 . _ -');
    if (ids.has(raw.id)) throw bad('the id is used twice');
    ids.add(raw.id);
    if (typeof raw.placeId !== 'string' || !SNOWFLAKE.test(raw.placeId)) throw bad('placeId must be a channel id');
    if (
      raw.before !== undefined &&
      raw.before !== null &&
      (typeof raw.before !== 'string' || !SNOWFLAKE.test(raw.before))
    )
      throw bad('before must be a message id or omitted');
    const multi = raw.steps !== undefined;
    const errand = raw.taskResult !== undefined;
    if (errand && (multi || raw.author !== undefined || raw.text !== undefined))
      throw bad('taskResult replaces author, text and steps: give one or the other');
    if (multi && (raw.author !== undefined || raw.text !== undefined))
      throw bad('steps replace author and text: give one or the other');
    const steps = multi ? parseSteps(raw.steps, bad) : null;
    const taskResult = errand ? parseTaskResult(raw.taskResult, bad) : null;
    const single = !multi && !errand;
    if (single && (typeof raw.author !== 'string' || !SNOWFLAKE.test(raw.author)))
      throw bad('author must be a member id');
    if (single && !isScenarioText(raw.text)) throw bad(`text must be 1..${MAX_SCENARIO_TEXT} characters`);
    if (!Array.isArray(raw.grants) || raw.grants.some((g: Untyped) => typeof g !== 'string' || !g.trim()))
      throw bad('grants must be a list of skill names, groups or "*"');
    const runs = raw.runs ?? 1;
    if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw bad(`runs must be a whole number 1..${MAX_RUNS}`);
    return {
      id: raw.id,
      placeId: raw.placeId,
      before: raw.before ?? null,
      ...(multi ? { steps } : errand ? { taskResult } : { author: raw.author, text: raw.text }),
      grants: raw.grants.map((g: Rec) => g.trim()),
      runs,
    };
  });
}

/** The `taskResult` of a task-result scenario (see parseScenarios), a CliError made by `bad` when wrong. */
function parseTaskResult(raw: Untyped, bad: Untyped) {
  const wrong = (what: string) => bad(`taskResult: ${what}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw wrong('not an object');
  for (const key of Object.keys(raw)) if (!TASK_RESULT_KEYS.includes(key)) throw wrong(`unknown field ${key}`);
  if (typeof raw.agent !== 'string' || !AGENT_NAME.test(raw.agent)) throw wrong("agent must be an agent's name");
  if (!isScenarioText(raw.goal)) throw wrong(`goal must be 1..${MAX_SCENARIO_TEXT} characters`);
  if (!TASK_RESULT_STATES.includes(raw.state))
    throw wrong(`state must be ${TASK_RESULT_STATES.map((state) => `"${state}"`).join(' or ')}`);
  const text = raw.text ?? '';
  if (typeof text !== 'string' || text.length > MAX_TASK_TEXT)
    throw wrong(`text must be text of at most ${MAX_TASK_TEXT} characters`);
  const files = raw.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_TASK_FILES)
    throw wrong(`files must be a list of at most ${MAX_TASK_FILES} files`);
  const names = new Set<Untyped>();
  const parsed = files.map((file, index) => {
    const where = `file ${index + 1}`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw wrong(`${where} is not an object`);
    for (const key of Object.keys(file))
      if (!TASK_FILE_KEYS.includes(key)) throw wrong(`${where}: unknown field ${key}`);
    if (
      typeof file.name !== 'string' ||
      !TASK_FILE_NAME.test(file.name) ||
      file.name.trim() !== file.name ||
      file.name === '.' ||
      file.name === '..'
    ) {
      throw wrong(`${where}: name must be 1..200 characters without a slash or a line break`);
    }
    if (names.has(file.name)) throw wrong(`${where}: the name is used twice`);
    names.add(file.name);
    const contentType = file.contentType ?? '';
    if (typeof contentType !== 'string' || contentType.length > 200) throw wrong(`${where}: contentType must be text`);
    const bytes = file.bytes ?? 0;
    if (!Number.isInteger(bytes) || bytes < 0) throw wrong(`${where}: bytes must be a whole number of 0 or more`);
    return { name: file.name, contentType, bytes };
  });
  if (typeof raw.asker !== 'string' || !SNOWFLAKE.test(raw.asker)) throw wrong('asker must be a member id');
  return { agent: raw.agent, goal: raw.goal, state: raw.state, text, files: parsed, asker: raw.asker };
}

/** Whether `value` is an invented message's text: 1..MAX_SCENARIO_TEXT characters, not blank. */
function isScenarioText(value: Untyped) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_SCENARIO_TEXT;
}

/** The `steps` of a multi-step scenario (see parseScenarios), each a CliError made by `bad` when wrong. */
function parseSteps(steps: Untyped, bad: Untyped) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)
    throw bad(`steps must be a list of 1..${MAX_STEPS} steps`);
  const parsed = steps.map((step, index) => {
    const wrong = (what: string) => bad(`step ${index + 1}: ${what}`);
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw wrong('not an object');
    for (const key of Object.keys(step)) if (!STEP_KEYS.includes(key)) throw wrong(`unknown field ${key}`);
    const message = (item: Untyped, where: string) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw wrong(`${where} is not an object`);
      for (const key of Object.keys(item)) if (!BURST_KEYS.includes(key)) throw wrong(`${where}: unknown field ${key}`);
      if (item.self !== undefined) {
        // A line of the persona, seeded: no author, no turn run for it.
        if (item.self !== true) throw wrong(`${where}: self must be true`);
        if (item.author !== undefined) throw wrong(`${where}: a line of the persona's has no author`);
        if (!isScenarioText(item.text)) throw wrong(`${where}: text must be 1..${MAX_SCENARIO_TEXT} characters`);
        return { self: true as const, text: item.text };
      }
      if (typeof item.author !== 'string' || !SNOWFLAKE.test(item.author))
        throw wrong(`${where}: author must be a member id`);
      if (!isScenarioText(item.text)) throw wrong(`${where}: text must be 1..${MAX_SCENARIO_TEXT} characters`);
      return { author: item.author, text: item.text };
    };
    const seeded = step.self !== undefined;
    if (seeded && Object.keys(step).some((key) => key !== 'self' && key !== 'gapMinutes'))
      throw wrong('self takes only gapMinutes beside it');
    if (seeded && !isScenarioText(step.self)) throw wrong(`self must be 1..${MAX_SCENARIO_TEXT} characters`);
    const own = step.author !== undefined || step.text !== undefined;
    const messages = seeded
      ? [{ self: true as const, text: step.self }]
      : own
        ? [message({ author: step.author, text: step.text }, 'the message')]
        : [];
    if (step.burst !== undefined) {
      if (!Array.isArray(step.burst) || step.burst.length === 0 || step.burst.length > MAX_BURST)
        throw wrong(`burst must be a list of 1..${MAX_BURST} messages`);
      step.burst.forEach((item: Untyped, i: number) => messages.push(message(item, `burst ${i + 1}`)));
    }
    if (messages.length === 0) throw wrong('needs author and text, or a burst');
    const gapMinutes = step.gapMinutes ?? DEFAULT_GAP_MINUTES;
    if (
      typeof gapMinutes !== 'number' ||
      !Number.isFinite(gapMinutes) ||
      gapMinutes <= 0 ||
      gapMinutes > MAX_GAP_MINUTES
    )
      throw wrong(`gapMinutes must be more than 0 and at most ${MAX_GAP_MINUTES}`);
    return { messages, own, gapMinutes };
  });
  if (!parsed.some(runsTurn))
    throw bad("steps: needs at least one step that runs the persona's turn (a message that is not theirs)");
  return parsed;
}

/** Whether a parsed step runs the persona's turn: it holds a message that is not a seeded line of theirs. */
export function runsTurn(step: Rec): boolean {
  return Array.isArray(step?.messages) && step.messages.some((message: Untyped) => message?.self !== true);
}

/**
 * The turns a `--skills` file may run at most, for the spend gate's estimate: a run is one turn, or for a multi-step
 * scenario one per message of every step (each run replays every step; every message of a burst may get its own turn,
 * playSteps), a seeded line of the persona none.
 * @param scenarios parseScenarios's.
 */
export function scenarioTurns(
  scenarios: Array<{ runs: number; steps?: Array<{ messages: Array<Rec> }> | null }>
): number {
  const turns = (step: Untyped) =>
    Array.isArray(step.messages) ? step.messages.filter((message: Untyped) => message?.self !== true).length : 1;
  const decisions = (scenario: { steps?: Array<{ messages: Array<Rec> }> | null }) =>
    Array.isArray(scenario.steps) ? scenario.steps.reduce((sum: number, step: Untyped) => sum + turns(step), 0) : 1;
  return scenarios.reduce((total, scenario) => total + scenario.runs * decisions(scenario), 0);
}

/**
 * A copy of `config` whose persona grants are exactly `names`: their user id (`selfId`) taken
 * off every `bot.access` entry, then granted on each name -- with the very grant and revoke
 * `/tools grant` and `/tools revoke` store (src/tools/operations/grants.ts). Another user's id stays. The names are used as
 * given (the caller expands `*` and groups, as `/tools grant` does); a name no grant opens
 * for the persona (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA) is stored too, so the gateway's own
 * refusal of it shows. `config` is never changed. Pure.
 * @param config  The live merged config.
 * @param selfId  The bot's own user id.
 * @param names  Skill names.
 */
export function personaGrantsConfig(
  config: Record<string, Untyped>,
  selfId: string,
  names: Array<string>
): Record<string, Untyped> {
  const copy = structuredClone(isPlainObject(config) ? config : {});
  copy.bot = isPlainObject(copy.bot) ? copy.bot : {};
  let access = isPlainObject(copy.bot.access) ? copy.bot.access : {};
  for (const key of Object.keys(access)) access = accessRevoke(access, key, { accountId: selfId });
  for (const name of new Set(Array.isArray(names) ? names : []))
    access = accessGrant(access, name, { accountId: selfId });
  copy.bot.access = access;
  return copy;
}

/**
 * The skill names a scenario's `grants` store for the persona, in order, de-duplicated: each
 * key expanded by `expand` (src/tools/operations/access.ts#expandPersonaGrant: a skill by name, a group or
 * `*` as its read skills), a name no grant opens for them kept (`refused`) so the gateway
 * refuses it as live. A key that names no skill is a CliError naming the scenario.
 */
export function scenarioGrants(
  scenario: { id: string; grants: Array<string> },
  expand: (key: string) => { names: Array<string>; refused: Array<string> } | null
): Array<string> {
  const names: Array<Untyped> = [];
  for (const key of scenario.grants) {
    const expanded = expand(key);
    if (!expanded) throw new CliError(`replay-cli: scenario ${scenario.id}: grants names no skill: ${key}`);
    for (const name of [...expanded.names, ...expanded.refused]) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The invented message of a scenario as a normalized history line (interfaces/discord/collect.ts#normalizeMessage's
 * shape): by `authorId` / `authorName` in `channel` at `at`, the text as given, tagging the
 * persona (`mentionedAccountIds`: `selfId`) unless `tagged` is false -- a burst's message, which
 * tags the persona only when its text holds their tag `<@selfId>` --, replying to nothing, without media.
 * Its id is the snowflake of its moment, so it sorts after every line before it. Pure.
 */
export function scenarioTrigger({
  text,
  authorId,
  authorName,
  channel,
  selfId,
  at,
  tagged = true,
}: {
  text: string;
  authorId: string;
  authorName: string;
  channel: { id: string; name?: string | null; topic?: string | null };
  selfId: string;
  at: number;
  tagged?: boolean;
}): TriggerLine {
  const tags = tagged || text.includes(`<@${selfId}>`) || text.includes(`<@!${selfId}>`);
  return {
    id: String((BigInt(Math.floor(at)) - DISCORD_EPOCH) << 22n),
    placeId: String(channel.id),
    channelName: channel.name ?? null,
    channelTopic: channel.topic ?? null,
    authorId: String(authorId),
    authorName,
    self: false,
    bot: false,
    content: text,
    ts: at,
    mentionedAccountIds: tags ? [String(selfId)] : [],
    mentionedChannelIds: [],
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

/**
 * The id of a task-result scenario's errand: `t` and 8 hex digits, as src/errands/store.ts names
 * a task, taken from the scenario's id so every run names the same
 * files. Pure.
 */
export function scenarioTaskId(scenarioId: string): string {
  return `t${createHash('sha256').update(String(scenarioId)).digest('hex').slice(0, 8)}`;
}

/**
 * A task-result scenario's errand as src/errands/store.ts keeps a finished task: its id
 * (scenarioTaskId), agent and goal; asked by `asker` (a member) in the scenario's channel, from
 * no message the persona can reply to (src/errands/turns.ts then opens an interjection); `group` scope;
 * ended at `at` in `state` (`failed` with the store's default code), its result's text and files
 * (no sources), not seen. A file has no path: nothing is on disk, and nothing reads one. Pure.
 */
export function scenarioTask(
  scenario: {
    id: string;
    placeId: string;
    taskResult: {
      agent: string;
      goal: string;
      state: string;
      text: string;
      files: Array<{ name: string; contentType: string; bytes: number }>;
      asker: string;
    };
  },
  { at }: { at: number }
): Rec {
  const errand = scenario.taskResult;
  return {
    id: scenarioTaskId(scenario.id),
    agent: errand.agent,
    goal: errand.goal,
    requester: { accountId: errand.asker, kind: 'member' },
    origin: { placeId: String(scenario.placeId), messageId: null },
    scope: 'group',
    state: errand.state,
    createdAt: at,
    startedAt: at,
    endedAt: at,
    usage: null,
    result: {
      text: errand.text,
      sources: [],
      files: errand.files.map((file) => ({
        path: null,
        name: file.name,
        contentType: file.contentType,
        bytes: file.bytes,
      })),
    },
    error: errand.state === 'done' ? null : TASK_FAILED_CODE,
    seen: false,
  };
}

/** `config` with features.coreTools on (`--core-tools`): a shallow copy, the live config untouched. Pure. */
export function withCoreTools(config: Untyped): { features: Untyped } {
  return { ...config, features: { ...(config?.features ?? {}), coreTools: true } };
}
