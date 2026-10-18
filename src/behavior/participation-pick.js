// The participation pick classifier. The persona keeps slices of other
// channels around her own lines (src/memory/participation.js); a turn shows a
// few of them in `<participation>`. Which few: by default the newest, but when
// the message she answers refers to an exchange elsewhere ("did you get what I
// said in the other channel?"), one cheap classifier call reads the chat
// around the turn and a numbered list of the stored episodes' headlines and
// answers the numbers that matter, or `none`. The picks go first in the
// request builder's selection (src/behavior/prompt.js); the newest fill the
// rest. This module holds the decisions -- the settings and the switch, which
// turns may ask, the list, the request, the answer parser -- and the thin I/O
// side that reads the store and sends the one request through the rails of
// src/llm/openrouter.js. No wording of ours goes into the request: the prompt
// file says everything, the list lines carry structural fields only.

import { isPlainObject } from '../config.js';
import { log } from '../log.js';
import { formatDuration } from '../format.js';
import { helperRequestOptions, railReason } from '../llm/openrouter.js';
import { oneLine } from '../memory/clamp.js';
import { PARTICIPATION_DEFAULTS, episodeHeadlines, participationSettings } from '../memory/index.js';
import { roleModel } from '../llm/roles.js';
import { block, fillPromptTemplate, stableThenTail } from './prompt.js';
import { routeCandidate, routeContext } from './route.js';

/** The pick classifier's keys of the `participation` config group (config.json carries the same values). */
export const PARTICIPATION_PICK_DEFAULTS = Object.freeze({
  contextMessages: PARTICIPATION_DEFAULTS.contextMessages,
  maxOutputTokens: PARTICIPATION_DEFAULTS.maxOutputTokens,
});

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/**
 * The pick classifier's settings read from the live config, or null when
 * `features.participation` is false (a missing key counts as on).
 * `contextMessages` (0 sends no transcript) and `maxOutputTokens` (at least 1)
 * fall back to PARTICIPATION_PICK_DEFAULTS when missing or unusable; floored.
 * @param {object} config  The live config.
 * @returns {{ contextMessages: number, maxOutputTokens: number }|null}
 */
export function participationPickSettings(config) {
  if (config?.features?.participation === false) return null;
  const p = isPlainObject(config?.participation) ? config.participation : {};
  const d = PARTICIPATION_PICK_DEFAULTS;
  return {
    contextMessages: intAtLeast(p.contextMessages, d.contextMessages, 0),
    maxOutputTokens: intAtLeast(p.maxOutputTokens, d.maxOutputTokens, 1),
  };
}

/**
 * Whether a turn may ask the pick classifier: a server turn that builds a
 * reply request -- a reply of any trigger kind, an interject, an initiate, a
 * noticed comment -- may; a private chat (no `<participation>` block there),
 * a diary post and a `drawFailed` turn (it only says the picture failed: no
 * classifier is paid for a second time) may not.
 * @param {{ mode?: string, triggerKind?: string|null, privateChat?: boolean }} [turn]
 * @returns {boolean}
 */
export function participationPickAllowed({ mode = 'reply', triggerKind = null, privateChat = false } = {}) {
  if (privateChat === true || triggerKind === 'private') return false;
  if (mode === 'diary') return false;
  return triggerKind !== 'drawFailed';
}

const noPipes = (text) => String(text ?? '').replaceAll('|', '/');

/**
 * The `<episodes>` lines: one per headline (src/memory/participation.js#episodeHeadlines
 * gives them newest first; listed here oldest first, so a new episode appends a line and the
 * cached list keeps its prefix), numbered from 1 -- `n | #channel | member: line | persona:
 * line`. The member part is the first other member's name (from the episode in `state`) and
 * all the members' lines (`memberLines`), empty when the episode has none; the persona part is
 * `selfName` and all her lines (`selfLines`). No age in them: the list is the cached part of
 * the request, so the ages are `ages`, one `n | when` line per episode (`when`: its age through
 * formatDuration with `units`) for the per-turn `<episode_ages>` block. A `|` inside a text
 * becomes `/` so the columns stay readable. A headline whose channel has no name
 * (`channelNameOf`) is left out. Structural fields only: no words of ours.
 * `ids[n - 1]` is the episode of line `n`.
 * @param {object[]} headlines
 * @param {{ state: { episodes?: object[] }, channelNameOf: (channelId: string) => (string|null),
 *   units: object, selfName: string }} options
 * @returns {{ lines: string[], ages: string[], ids: string[] }}
 */
export function participationEpisodeList(headlines, { state, channelNameOf, units, selfName }) {
  const episodes = new Map((Array.isArray(state?.episodes) ? state.episodes : []).map((ep) => [ep.id, ep]));
  const lines = [];
  const ages = [];
  const ids = [];
  for (const headline of (Array.isArray(headlines) ? headlines : []).toReversed()) {
    const name = oneLine(channelNameOf(headline.channelId) ?? '');
    if (!name) continue;
    const member = episodes.get(headline.id)?.messages?.find((m) => !m.self) ?? null;
    const memberPart = headline.memberLines && member ? `${oneLine(member.name)}: ${noPipes(headline.memberLines)}` : '';
    const n = ids.length + 1;
    lines.push(`${n} | #${name} | ${memberPart} | ${selfName}: ${noPipes(headline.selfLines)}`);
    ages.push(`${n} | ${formatDuration(headline.ageMs, units)}`);
    ids.push(headline.id);
  }
  return { lines, ages, ids };
}

/**
 * The pick classifier's request: the system message is `prompt` with
 * `{{name}}` filled with the persona's display name; the user message is two
 * text parts: the `<episodes>` block (the lines, one per line, oldest first;
 * they change only when an episode is added or expires, so this part is tagged
 * `cacheSegment: 'stable'`), then the `<episode_ages>` block (`ages`, the
 * episodes' ages: per call, omitted when empty), the `transcriptBlock` (may be
 * '') and the `candidateBlock`. Null when the prompt is blank or there is no line.
 * @param {{ prompt: string|null|undefined, selfName: string, transcriptBlock?: string,
 *   candidateBlock?: string, lines: string[], ages?: string[] }} params
 * @returns {{ role: string, content: string|object[] }[]|null}
 */
export function buildParticipationPickRequest({ prompt, selfName, transcriptBlock = '', candidateBlock = '', lines, ages = [] }) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const agesBlock = Array.isArray(ages) ? block('episode_ages', ages.join('\n')) : '';
  const user = stableThenTail(block('episodes', lines.join('\n')), [agesBlock, transcriptBlock, candidateBlock], '\n');
  return [
    { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
    { role: 'user', content: user },
  ];
}

/** Quotes that may wrap the whole answer. */
const WRAPPING = /^["'`«“‘]+|["'`»”’]+$/gu;
/** Punctuation that may trail the answer. */
const TRAILING = /[.;:!?…]+$/u;

/**
 * The classifier's answer: its first non-empty line, wrapping quotes and
 * trailing punctuation stripped, split on commas and spaces. `none` as the
 * first word (any case) -> `none`; nothing -> `empty`; every part a number
 * (`3`, `#3`, `3.`) -> the numbers within `1..count` in their order, each
 * once (`pick`), or `unknown-id` when none is; anything else -> `unparsed`.
 * Only `pick` carries indices (1-based).
 * @param {unknown} raw
 * @param {number} count  How many lines the list had.
 * @returns {{ indices: number[], reason: 'pick'|'none'|'unknown-id'|'empty'|'unparsed' }}
 */
export function parseParticipationPick(raw, count) {
  const first = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return { indices: [], reason: 'empty' };
  const text = first.replace(WRAPPING, '').trim().replace(TRAILING, '').trim();
  if (!text) return { indices: [], reason: 'empty' };
  const word = text.split(/\s+/u)[0].replace(/[^\p{L}]/gu, '').toLowerCase();
  if (word === 'none') return { indices: [], reason: 'none' };
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  const numbers = [];
  for (const part of parts) {
    const match = /^#?(\d+)\.?$/u.exec(part);
    if (!match) return { indices: [], reason: 'unparsed' };
    numbers.push(Number(match[1]));
  }
  const indices = [];
  for (const n of numbers) {
    if (Number.isSafeInteger(n) && n >= 1 && n <= count && !indices.includes(n)) indices.push(n);
  }
  return indices.length > 0 ? { indices, reason: 'pick' } : { indices: [], reason: 'unknown-id' };
}

/**
 * The numbered `<episodes>` list of one pick, shared by the pick hook below
 * and the turn planner (src/behavior/planner.js): the live headlines of the
 * guild's stored episodes outside `channel` that pass `audience`
 * (src/memory/participation.js#episodeHeadlines with the live
 * `participation` settings), rendered by participationEpisodeList with each
 * channel's stored note name, else the live channel's. `headlines` counts
 * the headlines before a nameless channel's are left out; `ages` are the
 * per-turn `<episode_ages>` lines. No request, no log.
 * @param {{ store: object, guildId: string, channel: object, audience: (channelId: string) => boolean,
 *   config: object, units: object, selfName: string, now: number }} params
 * @returns {{ headlines: number, lines: string[], ages: string[], ids: string[] }}
 */
export function participationEpisodeOffer({ store, guildId, channel, audience, config, units, selfName, now }) {
  const state = store.getParticipation(guildId);
  const headlines = episodeHeadlines(state, { excludeChannelId: channel?.id ?? null, audience, now }, participationSettings(config));
  if (headlines.length === 0) return { headlines: 0, lines: [], ages: [], ids: [] };
  const stored = typeof store.listChannels === 'function' ? store.listChannels(guildId) : [];
  const channelNameOf = (id) =>
    oneLine((Array.isArray(stored) ? stored.find((entry) => entry?.id === id)?.name : '') ?? '') ||
    oneLine(channel?.guild?.channels?.cache?.get?.(id)?.name ?? '') ||
    null;
  const { lines, ages, ids } = participationEpisodeList(headlines, { state, channelNameOf, units, selfName });
  return { headlines: headlines.length, lines, ages, ids };
}

/**
 * The pick hook of the turn runner (src/behavior/turn.js). Per call, with
 * `hot.config` / `hot.prompts` read at that moment: nothing (`[]`, no call,
 * no log) with `features.participation` off, on a turn participationPickAllowed
 * refuses, for a store without the participation store, or when no live
 * episode outside this channel passes `audience` (the predicate the turn's
 * `<participation>` block uses); `participation: skipped` (`reason:
 * 'no-prompt'`) without `prompts['participation-pick']`, (`reason:
 * 'no-candidate'`) without a message to judge (src/behavior/route.js#routeCandidate).
 * Else one request on the classifier model (role `analyzer`, purpose
 * `participation-pick`, its answer capped at `participation.maxOutputTokens`,
 * the helper timeout and the client's hedge): the last
 * `participation.contextMessages` lines before the candidate as
 * `<transcript>` (src/behavior/route.js#routeContext), the candidate, the
 * numbered `<episodes>` (participationEpisodeList: a channel's stored note
 * name, else the live channel's; oldest first) and their `<episode_ages>`. Logged `participation: classified`
 * (`channel`, `kind`, `offered` = the list length, `picked` = the episodes
 * picked, `parse`, `ms`). Resolves the picked episode ids in the answer's
 * order; never rejects: a failure logs `participation: failed` (`reason`: the
 * rail code, `error` for anything else). Counts and codes only.
 * @param {{ hot: { config: object, prompts: object }, store: object, llm: { complete: Function },
 *   now?: () => number }} deps
 * @returns {(args: { guildId: string, channel: object, history: object[], trigger: object|null,
 *   triggerKind?: string|null, mode?: string, selfName: string,
 *   audience: (channelId: string) => boolean }) => Promise<string[]>}
 */
export function createParticipationPicker({ hot, store, llm, now = Date.now }) {
  return async function pickParticipation({ guildId, channel, history, trigger = null, triggerKind = null, mode = 'reply', selfName, audience }) {
    const channelId = channel?.id ?? null;
    try {
      const config = hot.config;
      const settings = participationPickSettings(config);
      if (!settings) return [];
      if (!participationPickAllowed({ mode, triggerKind, privateChat: !channel?.guild })) return [];
      if (typeof store?.getParticipation !== 'function') return [];
      const at = now();
      const labels = hot.prompts?.labels;
      const { headlines, lines, ages, ids } = participationEpisodeOffer({ store, guildId, channel, audience, config, units: labels?.units, selfName, now: at });
      if (headlines === 0) return [];
      const prompt = hot.prompts?.['participation-pick'];
      if (typeof prompt !== 'string' || !prompt.trim()) {
        log.info('participation: skipped', { channel: channelId, reason: 'no-prompt' });
        return [];
      }
      const candidate = routeCandidate(history, trigger);
      if (!candidate) {
        log.info('participation: skipped', { channel: channelId, reason: 'no-candidate' });
        return [];
      }
      if (lines.length === 0) return [];
      const { transcriptBlock, candidateBlock } = routeContext({
        history,
        candidate,
        contextMessages: settings.contextMessages,
        config,
        labels,
        selfName,
      });
      const messages = buildParticipationPickRequest({ prompt, selfName, transcriptBlock, candidateBlock, lines, ages });
      if (!messages) return [];

      let completion;
      try {
        completion = await llm.complete(messages, {
          model: roleModel(config, 'analyzer', 'participation-pick'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: settings.maxOutputTokens, purpose: 'participation-pick' }),
        });
      } catch (err) {
        log.warn('participation: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null, name: err?.name ?? null });
        return [];
      }
      const { indices, reason } = parseParticipationPick(completion?.text, ids.length);
      const picked = indices.map((n) => ids[n - 1]);
      log.info('participation: classified', { channel: channelId, kind: triggerKind ?? null, offered: ids.length, picked: picked.length, parse: reason, ms: now() - at });
      return picked;
    } catch (err) {
      log.warn('participation: failed', { channel: channelId, reason: 'error', status: null, name: err?.name ?? null });
      return [];
    }
  };
}
