// The participation pick classifier. The persona keeps slices of other
// channels around her own lines (src/memory/participation.ts); a turn shows a
// few of them in `<participation>`. Which few: by default the newest, but when
// the message she answers refers to an exchange elsewhere ("did you get what I
// said in the other channel?"), one cheap classifier call reads the chat
// around the turn and a numbered list of the stored episodes' headlines and
// answers the numbers that matter, or `none`. The picks go first in the
// request builder's selection (src/behavior/prompt.ts); the newest fill the
// rest. This module holds the decisions -- the settings and the switch, which
// turns may ask, the list, the request, the answer parser -- and the thin I/O
// side that reads the store and sends the one request through the rails of
// src/llm/openrouter.js. No wording of ours goes into the request: the prompt
// file says everything, the list lines carry structural fields only.

import { isPlainObject } from '../config.ts';
import { log } from '../log.ts';
import { formatDuration } from '../format.ts';
import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { oneLine } from '../memory/clamp.ts';
import { PARTICIPATION_DEFAULTS, episodeHeadlines, participationSettings } from '../memory/index.ts';
import { roleModel } from '../llm/roles.ts';
import { block, fillPromptTemplate, stableThenTail } from './prompt.ts';
import { routeCandidate, routeContext } from './route.ts';
import { isFiniteNumber, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { Snapshot } from './snapshot.ts';

/** The pick classifier's keys of the `participation` config group (config.json carries the same values). */
export const PARTICIPATION_PICK_DEFAULTS = Object.freeze({
  contextMessages: PARTICIPATION_DEFAULTS.contextMessages,
  maxOutputTokens: PARTICIPATION_DEFAULTS.maxOutputTokens,
  pickTimeoutMs: PARTICIPATION_DEFAULTS.pickTimeoutMs,
});

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value: unknown, fallback: number, min: number): number {
  return isFiniteNumber(value) && value >= min ? Math.floor(value) : fallback;
}

/**
 * The pick classifier's settings read from the live config, or null when
 * `features.participation` is false (a missing key counts as on).
 * `contextMessages` (the production value of the config cut of 2026-10-31), `maxOutputTokens` (at least 1) and
 * `pickTimeoutMs` (how long the turn waits for the pick before it goes on
 * without one, at least 1; `null` = no limit but the turn's own deadline)
 * fall back to PARTICIPATION_PICK_DEFAULTS when missing or unusable; floored.
 * @param config  The live config.
 */
export function participationPickSettings(
  config: Record<string, Untyped>
): { contextMessages: number; maxOutputTokens: number; pickTimeoutMs: number | null } | null {
  const p: Record<string, Untyped> = isPlainObject(config?.participation) ? config.participation : {};
  const d = PARTICIPATION_PICK_DEFAULTS;
  return {
    contextMessages: d.contextMessages,
    maxOutputTokens: intAtLeast(p.maxOutputTokens, d.maxOutputTokens, 1),
    pickTimeoutMs: p.pickTimeoutMs === null ? null : intAtLeast(p.pickTimeoutMs, d.pickTimeoutMs, 1),
  };
}

/**
 * Whether a turn may ask the pick classifier: a server turn that builds a
 * reply request -- a reply of any trigger kind, an interject, an initiate, a
 * noticed comment -- may; a private chat (no `<participation>` block there),
 * and a diary post may not.
 */
export function participationPickAllowed({
  mode = 'reply',
  triggerKind = null,
  privateChat = false,
}: { mode?: string; triggerKind?: string | null; privateChat?: boolean } = {}): boolean {
  if (privateChat === true || triggerKind === 'private') return false;
  return mode !== 'diary';
}

const noPipes = (text: string) => String(text ?? '').replaceAll('|', '/');

/** The real timer behind createParticipationPicker's `schedule`: `fn` once after `ms`; resolves a cancel function. */
function scheduleTimer(fn: () => void, ms: number) {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/** A pick past `participation.pickTimeoutMs`: logged, told to the turn's limits, nothing picked. */
function pickLate({
  placeId,
  offered,
  timeoutMs,
  limits,
}: {
  placeId: string | null;
  offered: Untyped;
  timeoutMs: number | null;
  limits: Untyped;
}) {
  log.info('participation: late', { channel: placeId, offered, timeoutMs });
  limits?.add?.({ kind: 'helper-timeout', where: 'participation-pick' });
  return [];
}

/** One headline of an episode (src/memory/participation.js#episodeHeadlines): its channel, its lines and its age. */
export type Headline = {
  id: string;
  placeId: string;
  ageMs: number;
  memberLines?: string;
  selfLines: string;
};

/**
 * The `<episodes>` lines: one per headline (src/memory/participation.ts#episodeHeadlines
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
 */
export function participationEpisodeList(
  headlines: Array<Headline>,
  {
    state,
    channelNameOf,
    units,
    selfName,
  }: {
    state: { episodes?: Array<Untyped> };
    channelNameOf: (placeId: string) => string | null;
    units: Untyped;
    selfName: string;
  }
): { lines: Array<string>; ages: Array<string>; ids: Array<string> } {
  const episodes = new Map((Array.isArray(state?.episodes) ? state.episodes : []).map((ep) => [ep.id, ep]));
  const lines = [];
  const ages = [];
  const ids = [];
  for (const headline of (Array.isArray(headlines) ? headlines : []).toReversed()) {
    const name = oneLine(channelNameOf(headline.placeId) ?? '');
    if (!name) continue;
    const member = episodes.get(headline.id)?.messages?.find((m: Untyped) => !m.self) ?? null;
    const memberPart =
      headline.memberLines && member ? `${oneLine(member.name)}: ${noPipes(headline.memberLines)}` : '';
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
 */
export function buildParticipationPickRequest({
  prompt,
  selfName,
  transcriptBlock = '',
  candidateBlock = '',
  lines,
  ages = [],
}: {
  prompt: string | null | undefined;
  selfName: string;
  transcriptBlock?: string;
  candidateBlock?: string;
  lines: Array<string>;
  ages?: Array<string>;
}): Array<{ role: string; content: string | Array<Record<string, Untyped>> }> | null {
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
 * @param count  How many lines the list had.
 */
export function parseParticipationPick(
  raw: unknown,
  count: number
): { indices: Array<number>; reason: 'pick' | 'none' | 'unknown-id' | 'empty' | 'unparsed' } {
  const first = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return { indices: [], reason: 'empty' };
  const text = first.replace(WRAPPING, '').trim().replace(TRAILING, '').trim();
  if (!text) return { indices: [], reason: 'empty' };
  const word = text
    .split(/\s+/u)[0]
    .replace(/[^\p{L}]/gu, '')
    .toLowerCase();
  if (word === 'none') return { indices: [], reason: 'none' };
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  const numbers = [];
  for (const part of parts) {
    const match = /^#?(\d+)\.?$/u.exec(part);
    if (!match) return { indices: [], reason: 'unparsed' };
    numbers.push(Number(match[1]));
  }
  const indices: Array<Untyped> = [];
  for (const n of numbers) {
    if (Number.isSafeInteger(n) && n >= 1 && n <= count && !indices.includes(n)) indices.push(n);
  }
  return indices.length > 0 ? { indices, reason: 'pick' } : { indices: [], reason: 'unknown-id' };
}

/**
 * The numbered `<episodes>` list of one pick for the pick hook below: the live headlines of the
 * place's stored episodes outside `channel` that pass `audience`
 * (src/memory/participation.ts#episodeHeadlines with the live
 * `participation` settings), rendered by participationEpisodeList with each
 * channel's stored note name, else the live channel's. `headlines` counts
 * the headlines before a nameless channel's are left out; `ages` are the
 * per-turn `<episode_ages>` lines. No request, no log.
 */
export function participationEpisodeOffer({
  store,
  placeId,
  channel,
  snapshot = null,
  audience,
  config,
  units,
  selfName,
  now,
}: {
  store: { getParticipation: (placeId: string) => Untyped; listChannels?: (placeId: string) => Array<Untyped> };
  placeId: string;
  channel: { id?: string; rootId?: string | null } | null | undefined;
  audience: (conversationId: string) => boolean;
  snapshot?: Snapshot | null;
  config: Record<string, Untyped>;
  units?: Untyped;
  selfName: string;
  now: number;
}): { headlines: number; lines: Array<string>; ages: Array<string>; ids: Array<string> } {
  const state = store.getParticipation(placeId);
  const headlines = episodeHeadlines(
    state,
    { excludeChannelId: channel?.id ?? null, audience, now },
    participationSettings(config)
  );
  if (headlines.length === 0) return { headlines: 0, lines: [], ages: [], ids: [] };
  const stored = typeof store.listChannels === 'function' ? store.listChannels(placeId) : [];
  const channelNameOf = (id: Untyped) =>
    oneLine((Array.isArray(stored) ? stored.find((entry) => entry?.id === id)?.name : '') ?? '') ||
    oneLine(snapshot?.get(String(id))?.name ?? '') ||
    null;
  const { lines, ages, ids } = participationEpisodeList(headlines, { state, channelNameOf, units, selfName });
  return { headlines: headlines.length, lines, ages, ids };
}

/**
 * The pick hook of the turn runner (src/behavior/turn.ts). Per call, with
 * `hot.config` / `hot.prompts` read at that moment: nothing (`[]`, no call,
 * no log) with `features.participation` off, on a turn participationPickAllowed
 * refuses, for a store without the participation store, or when no live
 * episode outside this channel passes `audience` (the predicate the turn's
 * `<participation>` block uses); `participation: skipped` (`reason:
 * 'no-prompt'`) without `prompts['participation-pick']`, (`reason:
 * 'no-candidate'`) without a message to judge (src/behavior/route.ts#routeCandidate).
 * Else one request on the classifier model (role `analyzer`, purpose
 * `participation-pick`, its answer capped at `participation.maxOutputTokens`,
 * the analyzer timeout and the client's hedge): the last
 * `participation.contextMessages` lines before the candidate as
 * `<transcript>` (src/behavior/route.ts#routeContext), the candidate, the
 * numbered `<episodes>` (participationEpisodeList: a channel's stored note
 * name, else the live channel's; oldest first) and their `<episode_ages>`. Logged `participation: classified`
 * (`channel`, `kind`, `offered` = the list length, `picked` = the episodes
 * picked, `parse`, `ms`). Resolves the picked episode ids in the answer's
 * order; never rejects: a failure logs `participation: failed` (`reason`: the
 * rail code, `error` for anything else). Counts and codes only. The request
 * gets `participation.pickTimeoutMs` (read now, on `schedule`; null = no limit
 * but the turn's own deadline): past it the request is aborted and nothing is
 * picked -- the turn shows the newest --, logged `participation: late`
 * (`channel`, `offered`, `timeoutMs`) and told to `limits` (the turn's
 * collector, if given) as a `helper-timeout` on `participation-pick`.
 *   `schedule`: runs `fn` once after `ms`, resolving a cancel function (default: setTimeout).
 */
export function createParticipationPicker({
  hot,
  store,
  llm,
  now = Date.now,
  schedule = scheduleTimer,
}: {
  hot: { config: Record<string, Untyped>; prompts: Record<string, Untyped> };
  store: Untyped;
  llm: { complete: (...args: Array<Untyped>) => Untyped };
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}): (args: {
  placeId: string;
  channel: { id?: string; rootId?: string | null } | null | undefined;
  history: Array<Untyped>;
  trigger: Untyped;
  triggerKind?: string | null;
  mode?: string;
  selfName: string;
  snapshot?: Snapshot | null;
  audience: (placeId: string) => boolean;
  limits?: { add: (...args: Array<Untyped>) => Untyped } | null;
}) => Promise<Array<string>> {
  return async function pickParticipation({
    placeId,
    channel,
    history,
    trigger = null,
    triggerKind = null,
    mode = 'reply',
    selfName,
    audience,
    snapshot = null,
    limits = null,
  }) {
    const conversationId = channel?.id ?? null;
    try {
      const config = hot.config;
      const settings = participationPickSettings(config);
      if (!settings) return [];
      if (!participationPickAllowed({ mode, triggerKind, privateChat: channel?.rootId == null })) return [];
      if (typeof store?.getParticipation !== 'function') return [];
      const at = now();
      const labels = hot.prompts?.labels;
      const { headlines, lines, ages, ids } = participationEpisodeOffer({
        store,
        placeId,
        channel,
        snapshot,
        audience,
        config,
        units: labels?.units,
        selfName,
        now: at,
      });
      if (headlines === 0) return [];
      const prompt = hot.prompts?.['participation-pick'];
      if (typeof prompt !== 'string' || !prompt.trim()) {
        log.info('participation: skipped', { channel: conversationId, reason: 'no-prompt' });
        return [];
      }
      const candidate = routeCandidate(history, trigger);
      if (!candidate) {
        log.info('participation: skipped', { channel: conversationId, reason: 'no-candidate' });
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
      const messages = buildParticipationPickRequest({
        prompt,
        selfName,
        transcriptBlock,
        candidateBlock,
        lines,
        ages,
      });
      if (!messages) return [];

      let completion;
      // The time limit: past it the request is aborted and the turn goes on without a pick.
      const timeoutMs = settings.pickTimeoutMs;
      const abort = timeoutMs === null ? null : new AbortController();
      let late = false;
      const cancel = abort
        ? schedule(() => {
            late = true;
            abort.abort();
          }, timeoutMs as number) // `abort` exists only for a numeric `timeoutMs`
        : null;
      try {
        completion = await llm.complete(messages, {
          model: roleModel(config, 'analyzer', 'participation-pick'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'participation-pick',
            signal: abort?.signal,
          }),
        });
      } catch (err) {
        if (late) return pickLate({ placeId: conversationId, offered: ids.length, timeoutMs, limits });
        log.warn('participation: failed', {
          channel: conversationId,
          reason: railReason(err),
          status: objOf(err).statusCode ?? null,
          name: objOf(err).name ?? null,
        });
        return [];
      } finally {
        cancel?.();
      }
      // An answer that came with the abort is not taken either: the turn was told there is none.
      if (late) return pickLate({ placeId: conversationId, offered: ids.length, timeoutMs, limits });
      const { indices, reason } = parseParticipationPick(completion?.text, ids.length);
      const picked = indices.map((n) => ids[n - 1]);
      log.info('participation: classified', {
        channel: conversationId,
        kind: triggerKind ?? null,
        offered: ids.length,
        picked: picked.length,
        parse: reason,
        ms: now() - at,
      });
      return picked;
    } catch (err) {
      log.warn('participation: failed', {
        channel: conversationId,
        reason: 'error',
        status: null,
        name: objOf(err).name ?? null,
      });
      return [];
    }
  };
}
