// The turn planner: one pre-reply analyzer call instead of four. Before the
// persona answers a message, four cheap classifiers used to read the same
// short transcript one after another -- the channel route
// (src/behavior/route-channel.js), the participation pick
// (src/behavior/participation-pick.js), the re-watch and the search
// classifier (both in src/behavior/turn.js). Behind `features.turnPlanner`
// (exactly true) one request carries all four lists and the transcript once
// (prompts/planner.md) and answers one labelled block per decision. This
// module holds the switch, the request, the strict parser -- each block read
// by the parser its old classifier used, with a state of its own so one bad
// block never spoils the others -- and the one I/O function that sends the
// request through the rails of src/llm/openrouter.js. The list lines are
// built by the old classifiers' own builders; no wording of ours goes in.

import { log } from '../log.js';
import { roleRequestOptions, railReason } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { parseParticipationPick } from './participation-pick.js';
import { block, fillPromptTemplate, stableThenTail } from './prompt.js';
import { parseLookupAnswer, recallSettings } from './recall.js';
import { parseRouteAnswer } from './route.js';
import { parseSkillsLines } from '../tools/discovery.ts';

/** The four blocks of a planner answer, in the order the prompt lists them. */
export const PLANNER_BLOCKS = Object.freeze(['channel', 'episodes', 'rewatch', 'lookup']);

/**
 * Whether the turn planner replaces the four pre-reply analyzer calls: `features.turnPlanner` exactly
 * true (config.json ships false), read from the live config at the moment of use.
 * @param {object|null|undefined} config
 * @returns {boolean}
 */
export function plannerOn(config) {
  return config?.features?.turnPlanner === true;
}

const REWATCH_QUESTION_CHARS = 300;
const REWATCH_RETRY = /^retry$/i;
// The ordinal column: `<n>`, tolerating a `#` before it or a `.` after it.
const REWATCH_ORDINAL = /^#?\s*(\d+)\.?$/;

/**
 * Parse the re-watch classifier's answer (prompts/rewatch.md): ONE line,
 * `none` or `<n> | <question>` (`<n> | retry` asks to try a video that did
 * not load again), where `<n>` is the 1-based ordinal of a `<media>` line
 * (1 = the first line: the newest video, the pictures after the videos;
 * ordinals, not ids, because the model miscopies long ids).
 * `#1` and `1.` are accepted as `1`. Only the first non-empty line counts;
 * `none` (any case), anything unparsable, an ordinal outside 1..`count` or an
 * empty question -> no pick. The question is trimmed and cut to 300
 * characters; `retry` is true when it is exactly `retry` (any case). The
 * caller maps `n` back to its candidate (`candidates[n - 1]`). `reason` is a
 * code safe to log: `none` (the model answered none), `empty` (no non-empty
 * line), `no-bar`, `unknown-id` (not an ordinal within 1..`count`; the name
 * predates ordinals and is kept for log continuity), `no-question` or `ok`.
 * It lives here so the planner reads the re-watch block with it without
 * importing the turn runner; src/behavior/turn.js re-exports it.
 * @param {string} raw
 * @param {number} count  How many lines the `<media>` block listed.
 * @returns {{ pick: { n: number, question: string, retry: boolean }|null,
 *   reason: 'none'|'empty'|'no-bar'|'unknown-id'|'no-question'|'ok' }}
 */
export function parseRewatchPickDetailed(raw, count) {
  const line = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return { pick: null, reason: 'empty' };
  if (/^none$/i.test(line)) return { pick: null, reason: 'none' };
  const bar = line.indexOf('|');
  if (bar === -1) return { pick: null, reason: 'no-bar' };
  const ordinal = REWATCH_ORDINAL.exec(line.slice(0, bar).trim());
  const n = ordinal ? Number(ordinal[1]) : NaN;
  const question = [...line.slice(bar + 1).trim()].slice(0, REWATCH_QUESTION_CHARS).join('').trim();
  if (!Number.isSafeInteger(n) || n < 1 || n > count) return { pick: null, reason: 'unknown-id' };
  if (!question) return { pick: null, reason: 'no-question' };
  return { pick: { n, question, retry: REWATCH_RETRY.test(question) }, reason: 'ok' };
}

/**
 * The planner's request: the system message is `prompt` with `{{name}}` (the
 * persona's display name), `{{today}}` (`YYYY-MM-DD`) and `{{skills}}` (the
 * registry's lines for skills discovery, src/tools/discovery.ts#skillsIndex;
 * '' with discovery off) filled; the user
 * message carries the input blocks in the prompt's order -- `<channels>`,
 * `<episodes>`, `<media>`, the transcript, `<candidate>` -- each left out when
 * it has no line. Laid out for the provider's prompt cache: the channel and
 * episode lists change only when a channel or an episode does (the episodes
 * oldest first, with no age), so they are the part tagged `cacheSegment:
 * 'stable'`; the episodes' ages (`<episode_ages>`, `episodeAgeLines`), the media
 * list, the transcript and the candidate are the per-turn tail. `transcriptBlock` is a whole
 * `<transcript>` block or ''. Null when the prompt is blank or there is no
 * candidate block.
 * @param {{ prompt: string|null|undefined, selfName: string, today: string, skills?: string, channelLines?: string[],
 *   episodeLines?: string[], episodeAgeLines?: string[], mediaLines?: string[], transcriptBlock?: string, candidateBlock: string }} params
 * @returns {{ role: string, content: string|object[] }[]|null}
 */
export function buildPlannerRequest({
  prompt,
  selfName,
  today,
  skills = '',
  channelLines = [],
  episodeLines = [],
  episodeAgeLines = [],
  mediaLines = [],
  transcriptBlock = '',
  candidateBlock,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (typeof candidateBlock !== 'string' || !candidateBlock) return null;
  const lines = (list) => (Array.isArray(list) ? list.join('\n') : '');
  const stable = [block('channels', lines(channelLines)), block('episodes', lines(episodeLines))]
    .filter(Boolean)
    .join('\n');
  // The ages only with the episodes they number.
  const ages =
    Array.isArray(episodeLines) && episodeLines.length > 0 ? block('episode_ages', lines(episodeAgeLines)) : '';
  const tail = [ages, block('media', lines(mediaLines)), String(transcriptBlock ?? '').trimEnd(), candidateBlock];
  return [
    {
      role: 'system',
      content: fillPromptTemplate(prompt, { name: selfName ?? '', today: today ?? '', skills: skills ?? '' }),
    },
    { role: 'user', content: stableThenTail(stable, tail, '\n') },
  ];
}

/** A labelled line of the answer: a list bullet or bold marks around the label are tolerated. */
const LINE_RE =
  /^(?:[-*•>]\s*)*\**\s*(channel|episodes|rewatch|lookup|web|server|who|when[-_ ]?role|when|recent|skills)\s*\**\s*:\s*\**\s*(.*)$/i;
/** The labels of the lookup block's own lines (src/behavior/recall.js#parseLookupAnswer). */
const LOOKUP_LABELS = new Set(['web', 'server', 'who', 'when', 'when-role', 'recent']);

/** A line's label in its one spelling: lower case, `when_role` / `when role` / `whenrole` as `when-role`. */
function labelOf(raw) {
  const label = raw.toLowerCase();
  return /^when.?role$/.test(label) ? 'when-role' : label;
}
const NONE_RE = /^none\b/i;
/** `<n> retry` and `<n> question: <text>`: the planner's re-watch forms. */
const REWATCH_RETRY_FORM = /^(#?\s*\d+\.?)\s+retry\s*$/i;
const REWATCH_QUESTION_FORM = /^(#?\s*\d+\.?)\s+question\s*:\s*(.*)$/i;

/** A block's verdict: `state` and the parser's own code. */
function verdict(state, parse, fields = {}) {
  return { state, parse, ...fields };
}

/** The channel block: one `channel:` line read by parseRouteAnswer (`earlier` included). */
function channelBlock(values, count) {
  if (values.length === 0) return verdict('missing', null, { index: null, direction: null });
  if (values.length > 1) return verdict('invalid', 'duplicate', { index: null, direction: null });
  const { index, reason, direction } = parseRouteAnswer(values[0], count);
  if (reason === 'pick') return verdict('ok', reason, { index, direction });
  return verdict(reason === 'none' ? 'none' : 'invalid', reason, { index: null, direction: null });
}

/**
 * The episodes block: one `episodes:` line read by parseParticipationPick. A
 * number outside the list makes the whole block invalid, unlike the old
 * classifier, which dropped it and kept the rest.
 */
function episodesBlock(values, count) {
  if (values.length === 0) return verdict('missing', null, { indices: [] });
  if (values.length > 1) return verdict('invalid', 'duplicate', { indices: [] });
  const { indices, reason } = parseParticipationPick(values[0], count);
  if (reason === 'none') return verdict('none', reason, { indices: [] });
  if (reason !== 'pick') return verdict('invalid', reason, { indices: [] });
  const all = parseParticipationPick(values[0], Number.MAX_SAFE_INTEGER).indices;
  if (all.length !== indices.length) return verdict('invalid', 'unknown-id', { indices: [] });
  return verdict('ok', reason, { indices });
}

/**
 * The re-watch block: one `rewatch:` line, `none`, `<n> retry` or
 * `<n> question: <text>`, turned into the re-watch classifier's own line
 * (`<n> | retry`, `<n> | <text>`) and read by parseRewatchPickDetailed.
 */
function rewatchBlock(values, count) {
  if (values.length === 0) return verdict('missing', null, { pick: null });
  if (values.length > 1) return verdict('invalid', 'duplicate', { pick: null });
  const value = values[0].trim();
  const retry = REWATCH_RETRY_FORM.exec(value);
  const question = retry ? null : REWATCH_QUESTION_FORM.exec(value);
  const line = retry ? `${retry[1]} | retry` : question ? `${question[1]} | ${question[2]}` : value;
  const { pick, reason } = parseRewatchPickDetailed(line, count);
  if (reason === 'ok') return verdict('ok', reason, { pick });
  return verdict(reason === 'none' ? 'none' : 'invalid', reason, { pick: null });
}

/**
 * The lookup block: either one `lookup: none` line, or its labelled lines
 * (`web:`, `server:`, `who:`, `when:`, `when-role:`, `recent:`, each at most once; a
 * `lookup:` line with nothing after it may head them, and a labelled line may
 * follow `lookup:` on the same line) read by parseLookupAnswer. Two `lookup:`
 * lines, a repeated label or `none` beside labelled lines is invalid.
 */
function lookupBlock(heads, labelled, options) {
  const empty = { web: null, server: null };
  if (heads.length === 0 && labelled.length === 0) return verdict('missing', null, empty);
  if (heads.length > 1) return verdict('invalid', 'duplicate', empty);
  const seen = new Set();
  for (const { label } of labelled) {
    if (seen.has(label)) return verdict('invalid', 'duplicate', empty);
    seen.add(label);
  }
  const head = heads.length === 1 ? heads[0].trim() : '';
  if (NONE_RE.test(head))
    return labelled.length > 0 ? verdict('invalid', 'conflict', empty) : verdict('none', 'none', empty);
  if (head) return verdict('invalid', 'unparsed', empty);
  if (labelled.length === 0) return verdict('invalid', 'empty', empty);
  const parsed = parseLookupAnswer(labelled.map(({ label, value }) => `${label}: ${value}`).join('\n'), options);
  if (parsed.reason === 'ok') return verdict('ok', 'ok', { web: parsed.web, server: parsed.server });
  return verdict(parsed.reason === 'none' ? 'none' : 'invalid', parsed.reason, empty);
}

/**
 * The planner's answer, block by block. Every non-empty line is read once:
 * `channel:`, `episodes:`, `rewatch:`, `lookup:`, the lookup block's
 * labelled lines and `skills:`; any other line is counted in `unknown` and
 * changes nothing. `skills` is no block of PLANNER_BLOCKS: an optional line
 * (skills discovery, src/tools/discovery.ts#parseSkillsLines over
 * `skillNames`), `missing` when absent, never a fallback.
 * Each block has a `state`: `ok` (a usable pick), `none` (the model said
 * none), `invalid` (present but unparsable, a number outside its list, a
 * repeated line) or `missing` (not answered), and `parse`, the code of the
 * parser that read it (`duplicate` for a repeated line; null when missing).
 * `counts` are the lengths of the lists the request carried (0 for a list it
 * did not carry: any number for it is then invalid). Indices are 1-based.
 * @param {unknown} raw
 * @param {{ counts?: { channels?: number, episodes?: number, media?: number }, timezone?: string,
 *   now?: number, maxForms?: number, skillNames?: string[] }} [options]
 * @returns {{ channel: { state: string, parse: string|null, index: number|null, direction: 'earlier'|null },
 *   episodes: { state: string, parse: string|null, indices: number[] },
 *   rewatch: { state: string, parse: string|null, pick: { n: number, question: string, retry: boolean }|null },
 *   lookup: { state: string, parse: string|null, web: string|null, server: object|null },
 *   skills: { state: string, inventory: boolean, names: string[] }, unknown: number }}
 */
export function parsePlannerAnswer(raw, { counts = {}, timezone = 'UTC', now, maxForms, skillNames } = {}) {
  const values = { channel: [], episodes: [], rewatch: [], lookup: [], skills: [] };
  const labelled = [];
  let unknown = 0;
  const take = (line) => {
    const match = LINE_RE.exec(line);
    if (!match) return false;
    const label = labelOf(match[1]);
    const value = match[2].replace(/\*+$/u, '').trim();
    if (LOOKUP_LABELS.has(label)) {
      labelled.push({ label, value });
    } else if (label === 'lookup' && LINE_RE.test(value) && LOOKUP_LABELS.has(labelOf(LINE_RE.exec(value)[1]))) {
      // `lookup: web: ...` on one line: the head with its first labelled line.
      values.lookup.push('');
      take(value);
    } else {
      values[label].push(value);
    }
    return true;
  };
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !take(trimmed)) unknown += 1;
  }
  const count = (key) => (Number.isSafeInteger(counts[key]) && counts[key] > 0 ? counts[key] : 0);
  return {
    channel: channelBlock(values.channel, count('channels')),
    episodes: episodesBlock(values.episodes, count('episodes')),
    rewatch: rewatchBlock(values.rewatch, count('media')),
    lookup: lookupBlock(values.lookup, labelled, { timezone, now, maxForms }),
    skills: parseSkillsLines(values.skills, skillNames),
    unknown,
  };
}

/** Every block in state `missing`: what a planner that never answered leaves. */
function allMissing() {
  return parsePlannerAnswer('');
}

/**
 * Ask the planner once. `offer` says which blocks this turn offered: the
 * three lists (`channels`, `episodes`, `media`: the old classifiers' lines;
 * an empty or absent list is not offered) and `lookup` (true when the search
 * classifier would have been asked). One request on the reasoning
 * model role (roleModel, role `analyzer`, purpose `planner`), its
 * answer capped at `web.search.classifierMaxOutputTokens`, a role
 * request (roleRequestOptions: the daily cap, the analyzer timeout, the
 * hedge). Resolves `{ outcome, reason, blocks }`, never rejects:
 * - `skipped` (`reason` `no-prompt`: no planner prompt; `nothing`: no block
 *   offered; `no-candidate`): no request, every block missing, no fallback
 *   recorded -- the turn goes on as if each old classifier had nothing to ask;
 * - `failed` (`reason` `classifier-failed`: the request threw or timed out;
 *   `empty`: a blank answer), logged `planner: failed` with the rail's code;
 * - `classified`, logged `planner: classified` with each block's state, the
 *   offered counts and the picks' counts.
 * Each offered block that is invalid or missing, or every offered block of a
 * failed call, adds a `helper-fallback` entry to `limits` (`where:
 * 'planner:<block>'`, `detail`: the state or the failure code); its consumer
 * then uses that block's safe default. Codes and counts only in the logs:
 * never a line, a query or a question. `skills` fills the prompt's
 * `{{skills}}` (buildPlannerRequest) and `skillNames` are the names its
 * `skills:` line may name (parsePlannerAnswer); the turn reads that line.
 * @param {{ llm: { complete: Function }, config: object, prompt: string|null|undefined, selfName: string,
 *   today: string, skills?: string, skillNames?: string[], offer: { channels?: string[], episodes?: string[], episodeAges?: string[],
 *   media?: string[], lookup?: boolean },
 *   transcriptBlock?: string, candidateBlock?: string|null, channelId?: string|null, kind?: string|null,
 *   now?: () => number, limits?: { add: Function }|null }} params
 * @returns {Promise<{ outcome: 'classified'|'failed'|'skipped', reason: string|null, blocks: ReturnType<typeof parsePlannerAnswer> }>}
 */
export async function askPlanner({
  llm,
  config,
  prompt,
  selfName,
  today,
  skills = '',
  skillNames,
  offer = {},
  transcriptBlock = '',
  candidateBlock = null,
  channelId = null,
  kind = null,
  now = Date.now,
  limits = null,
}) {
  const at = now();
  const list = (key) => (Array.isArray(offer[key]) ? offer[key] : []);
  const counts = { channels: list('channels').length, episodes: list('episodes').length, media: list('media').length };
  const offered = {
    channel: counts.channels > 0,
    episodes: counts.episodes > 0,
    rewatch: counts.media > 0,
    lookup: offer.lookup === true,
  };
  const skipped = (reason) => {
    log.info('planner: skipped', { channel: channelId, reason });
    return { outcome: 'skipped', reason, blocks: allMissing() };
  };
  if (!PLANNER_BLOCKS.some((name) => offered[name]))
    return { outcome: 'skipped', reason: 'nothing', blocks: allMissing() };
  if (typeof prompt !== 'string' || !prompt.trim()) return skipped('no-prompt');
  const messages = buildPlannerRequest({
    prompt,
    selfName,
    today,
    skills,
    channelLines: list('channels'),
    episodeLines: list('episodes'),
    episodeAgeLines: list('episodeAges'),
    mediaLines: list('media'),
    transcriptBlock,
    candidateBlock,
  });
  if (!messages) return skipped('no-candidate');
  const fellBack = (blocks, detailOf) => {
    for (const name of PLANNER_BLOCKS) {
      const detail = detailOf(blocks[name]);
      if (offered[name] && detail) limits?.add({ kind: 'helper-fallback', where: `planner:${name}`, detail });
    }
  };
  const failed = (reason, fields) => {
    log.warn('planner: failed', { channel: channelId, reason, ...fields });
    const blocks = allMissing();
    fellBack(blocks, () => reason);
    return { outcome: 'failed', reason, blocks };
  };

  const model = roleModel(config, 'analyzer', 'planner');
  let completion;
  try {
    completion = await llm.complete(messages, {
      model,
      ...roleRequestOptions(config, {
        role: 'analyzer',
        maxOutputTokens: config?.web?.search?.classifierMaxOutputTokens ?? 2000,
        purpose: 'planner',
      }),
    });
  } catch (err) {
    return failed('classifier-failed', {
      rail: railReason(err),
      status: err?.statusCode ?? null,
      name: err?.name ?? null,
    });
  }
  // Nothing at all (typically a reasoning model that spent its whole output cap thinking) is a failed call.
  if (!String(completion?.text ?? '').trim())
    return failed('empty', { rail: null, status: null, name: null, model: model ?? null });
  const blocks = parsePlannerAnswer(completion.text, {
    counts,
    timezone: config?.bot?.timezone,
    now: at,
    maxForms: recallSettings(config)?.maxForms,
    skillNames,
  });
  fellBack(blocks, (result) => (result.state === 'invalid' || result.state === 'missing' ? result.state : null));
  const states = Object.fromEntries(PLANNER_BLOCKS.map((name) => [name, offered[name] ? blocks[name].state : null]));
  const parses = Object.fromEntries(PLANNER_BLOCKS.map((name) => [name, blocks[name].parse]));
  const server = blocks.lookup.server;
  // Codes and counts only, never a line, a query, a form or a question.
  log.info('planner: classified', {
    channel: channelId,
    kind,
    states,
    parse: parses,
    offered: { ...counts, lookup: offered.lookup },
    picked: {
      channel: blocks.channel.index !== null,
      earlier: blocks.channel.direction === 'earlier',
      episodes: blocks.episodes.indices.length,
      rewatch: blocks.rewatch.pick ? (blocks.rewatch.pick.retry ? 'retry' : 'question') : null,
      web: Boolean(blocks.lookup.web),
      forms: server?.forms.length ?? 0,
      who: server?.who.length ?? 0,
      ranged: Boolean(server && (server.from !== null || server.to !== null)),
    },
    unknown: blocks.unknown,
    ms: now() - at,
  });
  return { outcome: 'classified', reason: null, blocks };
}
