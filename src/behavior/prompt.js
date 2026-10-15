// Assembles one LLM request for a turn. Pure: takes already-fetched data and
// the live prompts/config, returns chat-completions messages. The token budget
// is spent in this priority order (see src/llm/budget.js):
//   1. system prompt (persona + live rules + output format), task, clock, tempo — never cut
//   2. memory about the trigger's author (the person the persona is talking to, or the one overheard)
//   2b. what the persona looked up this turn (`<lookup>`, one piece: online,
//       in the server's own history, or both)
//   2c. what she sees at the corner of her eye (`<around>`, one piece: the live voice
//       channels and the scene's status and activities, `context.around.maxTokens`)
//   3. how this server talks + what the persona has said about itself
//   3b. lorebook entries matched by the transcript (`<lore>`)
//   4. the map of the server's channels
//   5. the channel transcript, newest messages first
//   5b. another channel pulled into this turn (`<channel_view>`, newest lines
//       first); on a routed turn -- a call from a channel the persona cannot
//       write in, answered here -- it goes right BEFORE the chat instead,
//       since the call itself lives in it
//   5c. the last `memory.recentHours` (`<recent>`): the recent lines this
//       channel's audience may read, then members' moments of those hours that
//       `<people>` does not show, capped by `context.caps.recent`, ranked by who
//       the turn is about
//   5d. the persona's own exchanges on other channels (`<participation>`): the
//       episodes the pick classifier chose, then the newest, capped by
//       `context.caps.participation`; never in a private chat
//   6. memory about other people present in the transcript
//   6b. the members the persona feels most strongly about that the request
//       does not describe (`<attitudes>`, one piece: names and bands)
//   6c. a diary post only (mode `diary`): the persona's world (`<world>`, one piece, under
//       `diary.world`), then its past diary posts (`<diary>`, the oldest lines cut first);
//       the post's `<plan>` and a set post's `<seeds>` are never cut, and what its search found (`<found>`) ranks
//       right after `<lookup>`
//   7. neighbouring channels
//   8. the server's custom emoji (`<emoji>`)
//   9. the GIF library (`<gifs>`)
// The rendered order is different, and laid out for the provider's prompt
// cache: what changes least first, in three text parts -- the stable part
// (the senses that read only the config, the skills protocol, the names of the
// skills granted to the persona, `<self_facts>`,
// `<about_chat>`, `<gifs>`, the people directory `<directory>`), the profiles (`<people>` with the interlocutor alone), then the
// tail that changes every turn, opening with a second `<people>` for everyone
// else, with the chat, the clock, the per-turn senses, the
// tempo and the task last, where the model attends best (see assembleUser and
// docs/prompt-contract.md, "Cache segments"). A private chat (`privateChat`)
// drops the server map, the neighbouring channels and any pulled channel and
// sees its partner through the public and private profiles merged
// (src/behavior/private.js). Pictures of another channel are shown as
// captions only: nothing outside the turn's own channel is ever attached.

import { createHash } from 'node:crypto';
import { fitSections, requestTokenLimit, sectionCost } from '../llm/budget.js';
import {
  computeTempo,
  fill,
  fillGifFields,
  formatClock,
  formatDate,
  formatDuration,
  formatNow,
  formatTranscript,
  renderTempo,
  renderTranscript,
} from '../discord/format.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay } from '../time.js';
import { affinityBand, roundScore, strongestMoves } from '../memory/affinity.js';
import { isConfirmed, isOpen, isStale } from '../memory/interests.js';
import { topByRank } from '../memory/ranking.js';
import { rankAddressed } from '../memory/addressed.js';
import { rankEmojiUsage } from '../memory/emoji-usage.js';
import { gifHandleMap, normalizeGifs, rankGifs } from '../memory/gifs.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { sortEpisodesForDisplay, topEpisodes } from '../memory/episodes.js';
import { RECENT_EPISODES_PER_MEMBER, episodeKey, foldText, memberIdOf, recentSettings, recentView } from '../memory/recent.js';
import { cutEpisode, participationSettings, selectEpisodes } from '../memory/participation.js';
import { matchLore } from '../memory/lore.js';
import { channelActivity, renderChannel } from '../memory/channels.js';
import { selectPictures, mediaProxyUrl, fitBox, mediaParts } from '../discord/media.js';
import { ID_DIGITS, fromTokens, isWordChar, occursAsWholeWord } from '../memory/mentions.js';
import { mergeProfiles } from './private.js';
import { assignHandles, directoryEntries, renderDirectory } from './handles.js';
import { gifWatchBlocker } from '../memory/gif-watch.js';
import { renderDiaryBlock, renderKindsBlock } from './diary.js';
import { alwaysListedOn, byFamily, discoveryOn } from '../skills/discovery.js';
import { isPlainObject } from '../config.js';
import { renderAround } from '../discord/around.js';

const TAG_OVERHEAD = 60;

/**
 * `body` wrapped in `<tag>` ... `</tag>` on lines of their own; '' for an
 * empty body, so a block with nothing to say drops out of a request. The one
 * copy: every request builder (chat, analyzer, warm-up) uses it.
 * @param {string} tag
 * @param {string} body
 * @returns {string}
 */
export function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/** `fromTokens(text, nameOf, 'chat')`, tolerating a non-string `text` and a
 * missing `nameOf` (an unresolved `<@id>` token is then left exactly as
 * stored) -- see docs/prompt-contract.md, "Members are referred to
 * by id, never by nickname". */
function resolveChatText(text, nameOf) {
  if (typeof text !== 'string') return text;
  return fromTokens(text, typeof nameOf === 'function' ? nameOf : () => null, 'chat');
}

/**
 * A member's remembered episodes (the interlocutor's, or the top few of a
 * member asked about) as `[heading, ...oneLinePerEpisode]`,
 * heaviest weight first then newest (see sortEpisodesForDisplay). `[]` when
 * there is nothing to show, or when `labels.profile` lacks any of
 * `episodes`/`episode`/`episodeNoQuote` — an older labels.json simply never
 * renders this, see docs/prompt-contract.md.
 */
function episodeLines(episodes, labels, nameOf) {
  const p = labels.profile;
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  if (!p.episodes || !p.episode || !p.episodeNoQuote) return [];
  const lines = sortEpisodesForDisplay(episodes).map((ep) =>
    fill(ep.quote ? p.episode : p.episodeNoQuote, {
      date: ep.date,
      what: resolveChatText(ep.what, nameOf),
      quote: ep.quote,
      feeling: resolveChatText(ep.feeling, nameOf),
    }),
  );
  return [p.episodes, ...lines];
}

/**
 * Keep `lines[0]` (the episodes heading) plus as many of the following lines
 * (already ordered heaviest-first) as fit `remaining` tokens, each priced by
 * `cost` -- the lightest ones are dropped first simply because they sort
 * last. `[]` when even the heading does not fit.
 */
function fitEpisodeLines(lines, remaining, cost) {
  if (lines.length === 0) return [];
  const [heading, ...rest] = lines;
  const headingCost = cost(heading);
  if (headingCost > remaining) return [];
  const kept = [heading];
  let used = headingCost;
  for (const line of rest) {
    const price = cost(line);
    if (used + price > remaining) break;
    kept.push(line);
    used += price;
  }
  return kept;
}

/**
 * Append `labels.profile.unsureMark`/`staleMark` to `text` per
 * docs/prompt-contract.md, "Confirmation"/"Dates come from the
 * messages": the unsure mark when `item` is below `marks.confirmAfter`, then
 * the stale mark when `item` is older than `marks.staleDays` (skipped
 * entirely for `marks.stale === false`, since details never go stale). Both
 * marks are OPT IN: `marks.confirmAfter`/`marks.staleDays` being anything
 * other than a plain number (i.e. omitted -- the direct-call/older-caller
 * case) never marks anything, so such a caller renders the text with no
 * mark at all. A missing label appends nothing.
 * @param {string} text
 * @param {{ weight?: number, lastSeen?: string|null }} item
 * @param {object} p  `labels.profile`.
 * @param {{ confirmAfter?: number, staleDays?: number, now?: number, stale?: boolean }} [marks]
 */
function markConfirmation(text, item, p, marks) {
  let out = text;
  if (typeof marks?.confirmAfter === 'number' && !isConfirmed(item, marks.confirmAfter) && p.unsureMark) {
    out += p.unsureMark;
  }
  if (marks?.stale !== false && typeof marks?.staleDays === 'number' && isStale(item, marks.now ?? Date.now(), marks.staleDays) && p.staleMark) {
    out += p.staleMark;
  }
  return out;
}

/** `memory.supersededShownDays` when it is missing (config.json carries the same). */
const DEFAULT_SUPERSEDED_SHOWN_DAYS = 7;

/** The day a claim is dated by in `<people>`: its `validFrom`, else the day of its `recordedAt`, else of its `firstSeen`; '' when none. */
function claimDay(item) {
  if (typeof item?.validFrom === 'string' && item.validFrom) return item.validFrom;
  for (const key of ['recordedAt', 'firstSeen']) {
    if (typeof item?.[key] === 'string' && item[key]) return item[key].slice(0, 10);
  }
  return '';
}

/**
 * The texts of ranked items (interests, details, aliases) with their validity applied, in
 * `ordered`'s order -- see docs/prompt-contract.md, "Validity". Only open items are expected
 * (the caller filters). An item whose successor-closed claims (`closed` entries of `kind` with
 * `supersededBy` = its `itemId`) are fresh -- its `recordedAt` younger than
 * `validity.shownDays` -- gets each of them once as `labels.profile.before` appended; a closed
 * claim never renders alone. Two open items sharing a `conflictSetId` render together, once,
 * through `labels.profile.conflict` with their days (the earlier first), at the place of the
 * first one ranked. A missing label leaves that part out (an older labels.json).
 * @param {object[]} ordered  The items shown, best first.
 * @param {object[]} open     Every open item of the list (a conflict partner may rank lower).
 * @param {(item: object) => string} render
 * @param {object} p  `labels.profile`.
 * @param {{ closed?: unknown, kind: string, now?: number, shownDays?: number, renderClosed: (item: object) => string }} validity
 * @returns {string[]}
 */
function validityTexts(ordered, open, render, p, validity) {
  const closed = (Array.isArray(validity.closed) ? validity.closed : []).filter((item) => item?.kind === validity.kind && typeof item.supersededBy === 'string');
  const shownDays = Number.isFinite(validity.shownDays) ? validity.shownDays : DEFAULT_SUPERSEDED_SHOWN_DAYS;
  const nowMs = Number.isFinite(validity.now) ? validity.now : Date.now();
  const withBefore = (item) => {
    const text = render(item);
    if (!p.before || closed.length === 0 || typeof item.itemId !== 'string') return text;
    const recordedMs = Date.parse(item.recordedAt ?? '');
    if (!Number.isFinite(recordedMs) || nowMs - recordedMs > shownDays * DAY_MS) return text;
    const before = closed.filter((old) => old.supersededBy === item.itemId).map((old) => fill(p.before, { text: validity.renderClosed(old) }));
    return before.length > 0 ? [text, ...before].join(' ') : text;
  };
  const done = new Set();
  const out = [];
  for (const item of ordered) {
    if (done.has(item)) continue;
    done.add(item);
    const partner =
      p.conflict && typeof item.conflictSetId === 'string' && item.conflictSetId
        ? open.find((other) => other !== item && !done.has(other) && other.conflictSetId === item.conflictSetId)
        : undefined;
    if (!partner) {
      out.push(withBefore(item));
      continue;
    }
    done.add(partner);
    const [a, b] = claimDay(partner) < claimDay(item) ? [partner, item] : [item, partner];
    out.push(fill(p.conflict, { a: withBefore(a), b: withBefore(b), dateA: claimDay(a), dateB: claimDay(b) }));
  }
  return out;
}

/**
 * One remembered interest as prompt text: `labels.profile.interestItem`
 * (`{topic}`/`{note}`) when the note is non-empty and the label exists,
 * `interestItemNoNote` (`{topic}`) when there is no note and that label
 * exists; otherwise the built-in `topic (note)` / bare `topic` form -- so an
 * older labels.json without these optional keys never breaks. Then
 * `markConfirmation` appends the unsure/stale marks, see above.
 */
function renderInterestItem(item, p, marks) {
  const note = resolveChatText(item.note, marks?.nameOf);
  const text = note
    ? p.interestItem
      ? fill(p.interestItem, { topic: item.topic, note })
      : `${item.topic} (${note})`
    : p.interestItemNoNote
      ? fill(p.interestItemNoNote, { topic: item.topic })
      : item.topic;
  return markConfirmation(text, item, p, marks);
}

/**
 * The `labels.profile.interests` line's `{text}`: the top `maxInterests`
 * stored interests (topic/note atomic items, see src/memory/interests.js) by
 * RANK (src/memory/ranking.js#topByRank, decayed with `marks.interestHalfLifeDays`),
 * in rank order -- see docs/prompt-contract.md, "More is stored than
 * shown, and rank decays with age". `''` when there is nothing to show.
 * `maxInterests` not an integer -> every stored interest renders (a stored
 * profile can hold more than a lowered live cap until the next analyzer
 * update evicts). `marks` (see `markConfirmation`) controls the unsure/stale
 * marks on each item; without `marks.interestHalfLifeDays` the rank is pure
 * weight (no decay). Only open items show; `marks.validity` (`{ closed, now,
 * shownDays }`) adds the closed claims and conflict sets, see `validityTexts`.
 */
function interestsText(interests, labels, maxInterests, marks) {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  const open = interests.filter(isOpen);
  const ordered = topByRank(open, maxInterests, marks?.interestHalfLifeDays);
  return validityTexts(ordered, open, (item) => renderInterestItem(item, labels.profile, marks), labels.profile, {
    ...marks?.validity,
    kind: 'interest',
    renderClosed: (item) => renderInterestItem(item, labels.profile, { nameOf: marks?.nameOf }),
  }).join('; ');
}

/**
 * The `labels.profile.details` line's `{text}`: the top `maxDetails` stored
 * detail items (`{ id, text, weight, firstSeen, lastSeen }`, see
 * src/memory/details.js) by RANK (decayed with `marks.detailHalfLifeDays`),
 * in rank order, each with the unsure mark appended when unconfirmed -- never
 * the stale mark, details do not go stale (see
 * docs/prompt-contract.md, "Dates come from the messages"). `''` when
 * there is nothing to show. `maxDetails` not an integer -> every stored
 * detail renders. Open items only, with the closed claims and conflict sets of
 * `marks.validity` (see `validityTexts`).
 */
function detailsText(details, labels, maxDetails, marks) {
  if (!Array.isArray(details) || details.length === 0) return '';
  const p = labels.profile;
  const open = details.filter(isOpen);
  const ordered = topByRank(open, maxDetails, marks?.detailHalfLifeDays);
  return validityTexts(ordered, open, (item) => markConfirmation(resolveChatText(item.text, marks?.nameOf) ?? '', item, p, { ...marks, stale: false }), p, {
    ...marks?.validity,
    kind: 'detail',
    renderClosed: (item) => resolveChatText(item.text, marks?.nameOf) ?? '',
  }).join('; ');
}

/**
 * The compact `<people>` interests line's `{text}`: just the top 5
 * stored interests BY RANK (see `interestsText` above), bare topics only --
 * no note, no unsure/stale marks. `''` when there is nothing to show. The 5
 * cap is fixed in code, not `maxInterests` -- a compact profile is meant to
 * cost a fraction of a full one regardless of how many interests are
 * configured to show for the interlocutor.
 */
function compactInterestsText(interests, labels, halfLifeDays) {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  return topByRank(interests.filter(isOpen), 5, halfLifeDays)
    .map((item) => item.topic)
    .join('; ');
}

/**
 * The `labels.profile.aliases` line's `{text}`: the top `maxAliases` stored
 * alias names (see src/memory/aliases.js) by RANK (decayed with
 * `aliasHalfLifeDays`), comma-separated -- see docs/prompt-contract.md,
 * "Aliases". `''` when there is nothing to show, or when
 * `labels.profile.aliases` is missing (an older labels.json never renders
 * this line). Alias names are never token-resolved -- they are literal
 * nicknames, not a reference to someone else. Open items only, with the closed
 * claims and conflict sets of `validity` (see `validityTexts`). `listed` (folded names,
 * src/memory/recent.js#foldText) leaves out the aliases another line already shows.
 */
function aliasesText(aliases, labels, maxAliases, aliasHalfLifeDays, validity, listed = null) {
  if (!labels.profile?.aliases) return '';
  if (!Array.isArray(aliases) || aliases.length === 0) return '';
  const open = aliases.filter(isOpen);
  const shown = listed ? open.filter((item) => !listed.has(foldText(item.name))) : open;
  return validityTexts(topByRank(shown, maxAliases, aliasHalfLifeDays), open, (item) => item.name, labels.profile, {
    ...validity,
    kind: 'alias',
    renderClosed: (item) => item.name,
  }).join(', ');
}

/** How many names the `labels.profile.addressed` line shows. */
const ADDRESSED_SHOWN = 5;

/**
 * A profile's name lines: with `addressedAs` entries and `labels.profile.addressed`, that line
 * first -- the top 5 names by the score decayed to `now` (src/memory/addressed.js#rankAddressed,
 * `addressHalfLifeDays`), names only -- then `labels.profile.aliases` with the stored aliases it
 * does not already list, if any; else the aliases line as before (`aliasesText`). Then, with a
 * stored `realName` and `labels.profile.realName`, that line, its replaced name riding on it
 * (`labels.profile.before`) while fresh, as a closed alias does. A missing label leaves its line out.
 * @returns {string[]}
 */
function nameLines(profile, labels, { maxAliases, aliasHalfLifeDays, addressHalfLifeDays, validity, now }) {
  const p = labels.profile;
  const lines = [];
  const addressed = p.addressed ? rankAddressed(profile.addressedAs, Number.isFinite(now) ? now : Date.now(), addressHalfLifeDays).slice(0, ADDRESSED_SHOWN) : [];
  if (addressed.length > 0) lines.push(fill(p.addressed, { text: addressed.join(', ') }));
  const listed = addressed.length > 0 ? new Set(addressed.map((name) => foldText(name))) : null;
  const aliasesLine = aliasesText(profile.aliases, labels, maxAliases, aliasHalfLifeDays, validity, listed);
  if (aliasesLine) lines.push(fill(p.aliases, { text: aliasesLine }));
  const realName = profile.realName;
  if (p.realName && typeof realName?.name === 'string' && realName.name) {
    const item = { name: realName.name, itemId: realName.itemId, recordedAt: realName.recordedAt };
    const [text] = validityTexts([item], [item], (claim) => claim.name, p, { ...validity, kind: 'realName', renderClosed: (claim) => claim.name });
    lines.push(fill(p.realName, { text }));
  }
  return lines;
}

/**
 * The moves behind an attitude, one `labels.profile.affinityMove` line each
 * (`{delta}` the move's `delta` as a signed integer, `{date}` its `YYYY-MM-DD`
 * in `timezone`, `{reason}` with `<@id>` tokens resolved): up to `max` of
 * `affinity.history`, chosen by src/memory/affinity.js#strongestMoves (the
 * strongest, both signs when there are both, never the reason the attitude
 * line already shows), oldest first. `[]` when the label is missing.
 */
function moveLines(affinity, labels, { max, timezone, nameOf }) {
  const label = labels.profile?.affinityMove;
  if (!label) return [];
  return strongestMoves(affinity.history, { max, currentReason: affinity.reason }).map((move) => {
    const delta = Math.round(Number.isFinite(move.delta) ? move.delta : move.appliedDelta);
    return fill(label, {
      delta: delta > 0 ? `+${delta}` : String(delta),
      date: zonedDay(Date.parse(move.ts), timezone),
      reason: resolveChatText(move.reason.trim(), nameOf),
    });
  });
}

/**
 * One person's memory as prompt text; '' when nothing has been learned yet.
 * When `relationships` is on and the profile carries a non-neutral (non-zero
 * score or non-empty reason) affinity, an attitude line is inserted right
 * after the heading — even when it ends up being the profile's only content,
 * since the persona's attitude toward someone is useful on its own.
 * Under it, `opts.shownMoves` (`relationships.shownMoves`) of the stored
 * moves that made that attitude, one `labels.profile.affinityMove` line each,
 * oldest first (see `moveLines`); omitted or 0 -> none. `opts.timezone`
 * (`bot.timezone`) dates them.
 *
 * For the interlocutor (`interlocutor: true`), right after the attitude line
 * (or right after the heading, if there is none), `opts.episodes.enabled`
 * additionally renders the caller's remembered episodes -- see
 * docs/prompt-contract.md, "<people>". Anyone else (a member the persona is
 * asked about) gets them in the same place only with `opts.episodes.max` a
 * positive integer, and then only the top `max` (src/memory/episodes.js#topEpisodes,
 * heaviest then newest); `max` never caps the interlocutor. Such a profile
 * with nothing else learned is shown by its episodes alone (no
 * `labels.profile.unknown` line). `opts.episodes.cap`/`.cost`
 * (when given) trim the episode list, heaviest-first, to fit that token
 * budget on top of the rest of the profile (for anyone but the interlocutor,
 * down to no heading at all when not one episode fits); without them every
 * episode renders. `opts.maxInterests`/`opts.maxDetails` cap how many interests/details
 * render, keeping the top-ranked ones (see `interestsText`/`detailsText`
 * above); omitted -> every stored item renders. `opts.interestHalfLifeDays`/
 * `opts.detailHalfLifeDays` (from `memory.interestHalfLifeDays`/
 * `memory.detailHalfLifeDays`) drive that rank's decay; omitted -> no decay,
 * ranked by weight alone. `opts.confirmAfter`/`opts.staleDays`/`opts.now`
 * (from `memory.confirmAfter`/`memory.interestStaleDays`, read by the caller
 * at the moment of use, and the injectable clock) drive the unsure/stale
 * marks on interests and details -- see `markConfirmation`; omitted, nothing
 * is ever marked.
 *
 * `opts.compact` renders the SHORT form used for `<people>` priority
 * (c), the other recent participants: current name, aliases, `character`
 * (as stored), the attitude line with at most ONE move under it (the
 * strongest, and none when `shownMoves` is 0: a bystander's "why" in one
 * line), and the top 5 interests (bare topics, no
 * note) -- no former names, no `style`, no `details`, no `relationship`, no
 * message count, no episodes even for the interlocutor. Never passed
 * alongside `interlocutor: true` in practice (the interlocutor is always
 * rendered in full), but `compact` wins over `interlocutor` for episodes
 * either way.
 *
 * `opts.mark` (default true) puts `labels.profile.interlocutorMark` on the
 * interlocutor's heading; false leaves the heading bare and changes nothing
 * else -- the author of an overheard line is rendered in full but is not
 * talking to the persona.
 *
 * Interests, details and aliases show open items only (`validTo` unset); the
 * profile's `closed` claims and conflict sets render as `validityTexts` says,
 * `opts.supersededShownDays` (`memory.supersededShownDays`, 7 when missing) the
 * window a closed claim rides on its successor.
 * @param {object|null} profile
 * @param {object} labels
 * @param {object} [opts]  The options above.
 * @returns {string}
 */
export function renderProfile(profile, labels, opts) {
  return renderProfileShown(profile, labels, opts).text;
}

/**
 * The `<attitudes>` block's one item: `labels.attitudes.header`, then one
 * `labels.attitudes.line` per member (`{name}` = the stored `names[0]`,
 * `{band}` = `labels.affinity.bands[affinityBand(score)]`, as the attitude
 * line of a profile shows it) -- the `max` members of `profiles` with the
 * largest `|affinity.score|`, warm and cool alike, rendered by the signed score
 * descending (warmest first, coolest last). A profile is skipped when its score
 * is not a finite number or is 0, its id is in `skipIds` (the interlocutor and
 * the members `<people>` shows) or was already taken, it has no name, or its
 * band has no label. Equal `|score|` keeps the input order. No score, no
 * reason. '' when `max` is not a positive integer, a label is missing or no
 * member is left, so the block drops out.
 * @param {object[]} profiles  Public member profiles (store.listUserProfiles).
 * @param {object} labels
 * @param {{ max: number, skipIds: Set<string> }} opts
 * @returns {string}
 */
function renderAttitudes(profiles, labels, { max, skipIds }) {
  const header = labels.attitudes?.header;
  const line = labels.attitudes?.line;
  const bands = labels.affinity?.bands;
  if (!header || !line || !bands || !Number.isInteger(max) || max <= 0) return '';
  const taken = new Set();
  const candidates = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const id = memberIdOf(profile?.id);
    const score = profile?.affinity?.score;
    const name = profile?.names?.[0];
    if (id === null || skipIds.has(id) || taken.has(id)) continue;
    if (!Number.isFinite(score) || score === 0 || typeof name !== 'string' || !name) continue;
    const band = bands[affinityBand(score)];
    if (!band) continue;
    taken.add(id);
    candidates.push({ score, text: fill(line, { name, band }) });
  }
  const top = candidates.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, max);
  if (top.length === 0) return '';
  top.sort((a, b) => b.score - a.score);
  return [header, ...top.map((entry) => entry.text)].join('\n');
}

/**
 * A member's message count as a profile shows it (`labels.profile.messageCount`):
 * rounded down to a multiple of 10 below 100 and of 100 from 100 up, so the
 * line does not change with every message the member writes and the cached
 * profiles of a request stay the same from turn to turn (docs/prompt-contract.md,
 * "Cache segments"). 0 for anything that is not a positive number, and for a
 * count below 10 -- no line then, as with no count at all. Pure.
 * @param {unknown} count  `profile.messageCount`.
 * @returns {number}
 */
function roundedMessageCount(count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const step = count < 100 ? 10 : 100;
  return Math.floor(count / step) * step;
}

/**
 * `renderProfile`'s text (`text`) and how many of the member's episodes it
 * shows (`episodes`): always the first that many in display order
 * (src/memory/episodes.js#topEpisodes), since a cap only ever drops the
 * lightest. 0 when none renders -- none stored, none fits, or an older labels
 * file without the episode labels -- so a block that must not repeat them
 * knows exactly which ones the request shows.
 * @returns {{ text: string, episodes: number }}
 */
function renderProfileShown(
  profile,
  labels,
  {
    interlocutor = false,
    mark: markInterlocutor = true,
    compact = false,
    relationships = false,
    episodes,
    maxInterests,
    maxDetails,
    maxAliases,
    aliasHalfLifeDays,
    addressHalfLifeDays,
    interestHalfLifeDays,
    detailHalfLifeDays,
    confirmAfter,
    staleDays,
    now,
    nameOf,
    shownMoves,
    timezone,
    supersededShownDays,
  } = {},
) {
  if (!profile) return { text: '', episodes: 0 };
  const p = labels.profile;
  const name = profile.names?.[0] ?? profile.id;
  const validity = { closed: profile.closed, now, shownDays: supersededShownDays };
  const marks = { confirmAfter, staleDays, now, interestHalfLifeDays, detailHalfLifeDays, nameOf, validity };

  const attitudeLines = [];
  const affinity = profile.affinity;
  const hasAffinity = relationships && affinity && (affinity.score !== 0 || Boolean(affinity.reason));
  if (hasAffinity) {
    attitudeLines.push(
      fill(p.affinity, {
        score: roundScore(affinity.score),
        band: labels.affinity?.bands?.[affinityBand(affinity.score)],
        reason: resolveChatText(affinity.reason, nameOf),
      }),
    );
    attitudeLines.push(...moveLines(affinity, labels, { max: compact ? Math.min(shownMoves ?? 0, 1) : shownMoves, timezone, nameOf }));
  }

  const restLines = [];
  if (!compact && profile.names?.length > 1) restLines.push(fill(p.formerNames, { names: profile.names.slice(1).join(', ') }));
  restLines.push(...nameLines(profile, labels, { maxAliases, aliasHalfLifeDays, addressHalfLifeDays, validity, now }));
  if (profile.character) restLines.push(fill(p.character, { text: resolveChatText(profile.character, nameOf) }));
  const interestsLine = compact
    ? compactInterestsText(profile.interests, labels, interestHalfLifeDays)
    : interestsText(profile.interests, labels, maxInterests, marks);
  if (interestsLine) restLines.push(fill(p.interests, { text: interestsLine }));
  if (!compact && profile.style) restLines.push(fill(p.style, { text: resolveChatText(profile.style, nameOf) }));
  const detailsLine = compact ? '' : detailsText(profile.details, labels, maxDetails, marks);
  if (detailsLine) restLines.push(fill(p.details, { text: detailsLine }));
  if (!compact && profile.relationship) restLines.push(fill(p.relationship, { text: resolveChatText(profile.relationship, nameOf) }));
  const hasContent = attitudeLines.length > 0 || restLines.length > 0;
  // Every episode for the interlocutor; the top `episodes.max` for a member asked about.
  const showEpisodes = !compact && episodes?.enabled && (interlocutor || (Number.isInteger(episodes.max) && episodes.max > 0));
  let renderedEpisodes = showEpisodes
    ? episodeLines(interlocutor ? profile.episodes : topEpisodes(profile.episodes, episodes.max), labels, nameOf)
    : [];
  if (!hasContent && interlocutor) restLines.push(p.unknown);
  const messagesShown = compact ? 0 : roundedMessageCount(profile.messageCount);
  if (messagesShown) restLines.push(fill(p.messageCount, { count: messagesShown }));

  const mark = interlocutor && markInterlocutor ? p.interlocutorMark : '';
  const heading = `## ${name}${mark}`;

  if (renderedEpisodes.length && typeof episodes.cap === 'number' && typeof episodes.cost === 'function') {
    const restText = [heading, ...attitudeLines, ...restLines].join('\n');
    renderedEpisodes = fitEpisodeLines(renderedEpisodes, episodes.cap - episodes.cost(restText), episodes.cost);
    // A member asked about never shows the episodes heading with no episode under it.
    if (!interlocutor && renderedEpisodes.length < 2) renderedEpisodes = [];
  }
  // Anyone but the interlocutor with nothing learned and no moment shown (none, or none fit): nothing to show.
  if (!hasContent && !interlocutor && renderedEpisodes.length === 0) return { text: '', episodes: 0 };

  // The episodes heading, then one line per episode.
  return { text: [heading, ...attitudeLines, ...renderedEpisodes, ...restLines].join('\n'), episodes: Math.max(0, renderedEpisodes.length - 1) };
}

/**
 * A stand-in channel entry for `serverItems` when the current channel has no
 * stored note yet (see below): Discord facts (name/category/topic) read off
 * whichever `history` message actually belongs to `currentChannelId` (every
 * message `buildRequest` is given for `<chat>` comes from that one channel,
 * see src/discord/collect.js#normalizeMessage) -- so the persona still knows
 * where it is even before the analyzer has touched this channel once. `null`
 * when no message carries a usable channel name (nothing to render then; a
 * channel with counters but no name never happens in practice).
 */
function currentChannelFallback(currentChannelId, history) {
  if (!currentChannelId) return null;
  const source = [...history].reverse().find((m) => m.channelId === currentChannelId && m.channelName);
  if (!source) return null;
  return {
    id: currentChannelId,
    name: source.channelName,
    category: source.channelCategory ?? null,
    topic: source.channelTopic ?? null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    lastMessageAt: null,
    topWriters: [],
  };
}

/**
 * Render the `<server>` block: ONLY the channels that matter for this turn --
 * the current channel first, marked via `labels.server.currentMark` (its
 * stored note in full, or -- when nothing is stored for it yet, see
 * `currentChannelFallback` above -- just its Discord facts and activity), then
 * the neighbour channels that actually contributed messages to
 * `<other_channels>` this turn, `neighborChannelIds` (matched by id, never by
 * name -- a rename or a same-named channel elsewhere must never cross-wire
 * two entries), each in full too. Every other stored channel note is left
 * out on purpose: on a large server most of them are irrelevant to this
 * reply and would eat most of the block's budget for nothing. A neighbour
 * id with no stored note is skipped, not synthesized -- unlike the current
 * channel, a neighbour the persona is not replying in does not need a
 * where-am-I fallback. A pulled channel (`<channel_view>`) joins the list
 * the same way: the caller puts its id ahead of the neighbours'. An entry
 * whose id is in `readOnlyIds` (a channel the bot can read but not write in)
 * carries `labels.server.readOnly` (src/memory/channels.js#renderChannel,
 * never on the current channel).
 */
function serverItems(channels, currentChannelId, neighborChannelIds, history, now, activityCfg, labels, nameOf, readOnlyIds = new Set(), diaryChannelId = null) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const current = byId.get(currentChannelId) ?? currentChannelFallback(currentChannelId, history);
  const neighborEntries = [...new Set(neighborChannelIds)]
    .filter((id) => id !== currentChannelId)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const ordered = current ? [current, ...neighborEntries] : neighborEntries;
  return ordered.map((channel) =>
    renderChannel(
      {
        ...channel,
        purpose: resolveChatText(channel.purpose, nameOf),
        topics: resolveChatText(channel.topics, nameOf),
        tone: resolveChatText(channel.tone, nameOf),
      },
      labels,
      {
        current: channel.id === currentChannelId,
        activity: channelActivity(channel, now, activityCfg),
        now,
        nameOf,
        readOnly: readOnlyIds.has(channel.id),
        // The persona's own diary (diary.channelId): marked so it is found by name like any channel.
        diary: diaryChannelId !== null && channel.id === diaryChannelId,
      },
    ),
  );
}

/** A stored `from`: a `<@id>`/`<@!id>` token or a bare id, in the shared id range. */
const TEACHER_ID_RE = new RegExp(`^(?:<@!?(${ID_DIGITS})>|(${ID_DIGITS}))$`);

/** The member id inside a stored `from` (`<@id>`/`<@!id>`, or a bare id), or null. */
function teacherId(from) {
  if (typeof from !== 'string') return null;
  const match = TEACHER_ID_RE.exec(from.trim());
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * The `learnedCfg` of `learnedText` read from the live config at the moment
 * of use: `memory.maxLearned` (default 20), `memory.learnedHalfLifeDays`
 * (default 720), `memory.confirmAfter` (unset when absent).
 * @param {object} config  The live config.
 * @returns {{ max: number, halfLifeDays: number, confirmAfter: number|undefined }}
 */
export function learnedConfig(config) {
  return {
    max: Number.isInteger(config.memory?.maxLearned) ? config.memory.maxLearned : 20,
    halfLifeDays: typeof config.memory?.learnedHalfLifeDays === 'number' ? config.memory.learnedHalfLifeDays : 720,
    confirmAfter: typeof config.memory?.confirmAfter === 'number' ? config.memory.confirmAfter : undefined,
  };
}

/**
 * The `labels.aboutChat.learned` line's `{text}`: the top `learnedCfg.max`
 * stored guild items (`{ id, text, from?, weight, firstSeen, lastSeen }`, the
 * same atomic items as a member's details) by RANK (decayed with
 * `learnedCfg.halfLifeDays`), in rank order, joined with `'; '`. Each item is
 * `aboutChat.learnedItem` (`{text}`/`{who}`) when its `from` resolves through
 * `nameOf` to a name, else `aboutChat.learnedItemNoFrom` (`{text}`); a missing
 * item label falls back to the next simpler form, then to the bare text. An
 * item below `learnedCfg.confirmAfter` gets `aboutChat.unsureMark` appended
 * when that label exists. `''` when there is nothing to show.
 * @param {object[]} learned      `guild.learned`.
 * @param {object} a              `labels.aboutChat`.
 * @param {{ max?: number, halfLifeDays?: number, confirmAfter?: number }} learnedCfg  See `learnedConfig`.
 * @param {(id: string) => (string|null)} [nameOf]
 * @returns {string}
 */
export function learnedText(learned, a, learnedCfg, nameOf) {
  if (!Array.isArray(learned) || learned.length === 0) return '';
  return topByRank(learned, learnedCfg.max, learnedCfg.halfLifeDays)
    .map((item) => {
      const text = resolveChatText(item?.text, nameOf) ?? '';
      const id = teacherId(item?.from);
      const who = id && typeof nameOf === 'function' ? nameOf(id) : null;
      const noFrom = a.learnedItemNoFrom ? fill(a.learnedItemNoFrom, { text }) : text;
      const line = who && a.learnedItem ? fill(a.learnedItem, { text, who }) : noFrom;
      return !isConfirmed(item, learnedCfg.confirmAfter) && a.unsureMark ? line + a.unsureMark : line;
    })
    .join('; ');
}

/**
 * The `<about_chat>` lines: how this server talks (`patterns`), how people
 * start conversations (`starters`), the in-jokes, then what people taught the
 * persona (`guild.learned`, see `learnedText` above) -- the last one only when
 * `labels.aboutChat.learned` exists, so an older labels.json simply never
 * renders it. Every stored text is token-resolved via `nameOf`.
 * `learnedCfg` carries `max`/`halfLifeDays`/`confirmAfter`, read by the
 * caller from `memory.maxLearned`/`memory.learnedHalfLifeDays`/
 * `memory.confirmAfter` at the moment of use.
 */
function aboutChatItems(guildMemory, labels, nameOf, learnedCfg = {}) {
  const a = labels.aboutChat;
  const items = [];
  if (guildMemory?.patterns) items.push(fill(a.patterns, { text: resolveChatText(guildMemory.patterns, nameOf) }));
  if (guildMemory?.starters) items.push(fill(a.starters, { text: resolveChatText(guildMemory.starters, nameOf) }));
  if (guildMemory?.injokes?.length) {
    items.push(fill(a.injokes, { text: guildMemory.injokes.map((text) => resolveChatText(text, nameOf)).join('; ') }));
  }
  if (a?.learned) {
    const text = learnedText(guildMemory?.learned, a, learnedCfg, nameOf);
    if (text) items.push(fill(a.learned, { text }));
  }
  return items;
}

/**
 * Render the `<lore>` block's entries: whatever `matchLore` (src/memory/lore.js)
 * surfaces from the last `lore.scanMessages` transcript messages plus the
 * trigger, via `labels.lore.entry`. `[]` when there is no stored lore, no
 * match, or `labels.lore.entry` is missing (an older labels.json never
 * breaks -- the block is simply omitted). `text` is token-resolved via
 * `nameOf`; `title` never is (it is the lorebook's identity, not a mention).
 */
function loreItems(loreEntries, history, trigger, labels, loreCfg, nameOf) {
  const entry = labels.lore?.entry;
  if (!entry) return [];
  const entries = Array.isArray(loreEntries) ? loreEntries : [];
  if (entries.length === 0) return [];

  const scan = Math.max(0, loreCfg?.scanMessages ?? 30);
  const recentTexts = history.slice(-scan).map((m) => m.content ?? '').filter(Boolean);
  if (trigger?.content) recentTexts.push(trigger.content);

  const matched = matchLore(entries, recentTexts, { maxMatches: loreCfg?.maxMatches ?? 8 });
  return matched.map((lore) => fill(entry, { title: lore.title, text: resolveChatText(lore.text, nameOf) }));
}

/**
 * The `<emoji>` section's items: `labels.emoji.header` first, then one line
 * per custom emoji -- the top-ranked ids of `guild.emojiUsage` (see
 * src/memory/emoji-usage.js#rankEmojiUsage) that the index still has, topped
 * up with the rest of the index in its own order (a fresh install with no
 * ranking yet shows the first `max` of the index), at most `max` lines. The
 * name is the index's current one. A helper caption cached under
 * `emoji:<id>` (the describer's cache; a `miss` entry has no text) renders
 * through `labels.emoji.entry` (`{name}`/`{text}`), otherwise
 * `labels.emoji.entryNoText` (`{name}`); a caption this request's
 * `describe(id)` knows comes first. Then, when `seen` is given and
 * `labels.emoji.seenInChat` and `entry` are set, the custom emoji of this
 * request's transcript (seenEmoji) not listed above that have a caption:
 * `seenInChat` as a sub-heading, one `entry` line each. `[]` when the index
 * is empty or the labels lack `header`/`entryNoText` (an older labels.json).
 * @param {{ id: string, name: string }[]} index  The index's emoji (createEmojiIndex().list()).
 * @param {unknown} usage           `guild.emojiUsage`.
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ max?: number, halfLifeDays?: number }} [emojiCfg]  `context.customEmoji`.
 * @param {{ seen?: { id: string, name: string }[], describe?: (id: string) => string }} [extra]
 * @returns {string[]}
 */
function emojiItems(index, usage, mediaCache, labels, emojiCfg, { seen = [], describe = () => '' } = {}) {
  const e = labels.emoji;
  if (!e?.header || !e.entryNoText) return [];
  const list = Array.isArray(index) ? index.filter((emoji) => emoji?.id && emoji.name) : [];
  if (list.length === 0) return [];
  const max = emojiMax(emojiCfg);
  const byId = new Map(list.map((emoji) => [String(emoji.id), emoji]));
  const chosen = [];
  const taken = new Set();
  const take = (emoji) => {
    if (!emoji || taken.has(String(emoji.id)) || chosen.length >= max) return;
    taken.add(String(emoji.id));
    chosen.push(emoji);
  };
  for (const used of rankEmojiUsage(usage, emojiCfg?.halfLifeDays ?? 30)) take(byId.get(used.id));
  for (const emoji of list) take(emoji);
  if (chosen.length === 0) return [];
  const captionOf = (id) => {
    const known = describe(String(id));
    if (known) return known;
    const cached = mediaCache?.[`emoji:${id}`];
    return cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
  };
  const lines = chosen.map((emoji) => {
    const text = captionOf(emoji.id);
    return text && e.entry ? fill(e.entry, { name: emoji.name, text }) : fill(e.entryNoText, { name: emoji.name });
  });
  const more = [];
  if (e.seenInChat && e.entry) {
    for (const emoji of seen) {
      const text = taken.has(String(emoji.id)) ? '' : captionOf(emoji.id);
      if (text) more.push(fill(e.entry, { name: emoji.name, text }));
    }
  }
  return [e.header, ...lines, ...(more.length > 0 ? [e.seenInChat, ...more] : [])];
}

/** The first non-blank caption under `key` in `maps` (each a Map or nothing), trimmed; '' when none. */
function emojiCaption(key, maps) {
  for (const map of maps) {
    const text = map instanceof Map ? map.get(key) : null;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/** `context.customEmoji.max` (30, config.json's value, when missing or unusable). */
function emojiMax(emojiCfg) {
  return Number.isInteger(emojiCfg?.max) && emojiCfg.max >= 0 ? emojiCfg.max : 30;
}

/**
 * The custom emoji used in `messageSets` (arrays of normalized messages, a
 * forwarded snapshot's emoji included), each id once, in order of first use.
 * @param {object[][]} messageSets
 * @returns {{ id: string, name: string }[]}
 */
function seenEmoji(messageSets) {
  const out = new Map();
  const add = (emojis) => {
    for (const emoji of Array.isArray(emojis) ? emojis : []) {
      if (emoji?.id && emoji.name && !out.has(String(emoji.id))) out.set(String(emoji.id), { id: String(emoji.id), name: emoji.name });
    }
  };
  for (const messages of messageSets) {
    for (const message of Array.isArray(messages) ? messages : []) {
      add(message?.emojis);
      for (const snapshot of message?.forwarded ?? []) add(snapshot?.emojis);
    }
  }
  return [...out.values()];
}

/**
 * The `<gifs>` section's items: `labels.gifs.header` first, then one line
 * per GIF of the library -- the top `gifsCfg.max` (default 40) by rank
 * (src/memory/gifs.js#rankGifs, `gifsCfg.halfLifeDays`, default 30), each
 * rendered by gifLine (the three caption fields through
 * `labels.gifs.entryFields`, an older one-line caption through
 * `labels.gifs.entry`, cut per field by `gifsCfg.reactionChars` /
 * `gifsCfg.actionChars` -- only here: the cached caption stays as stored --,
 * else `labels.gifs.entryNoText`). A GIF the persona posted within
 * `gifsCfg.ownMarkHours` (default 24; 0 = never) gets ` ` +
 * `labels.gifs.ownMarkRecent` appended: no relative time, so the line changes
 * only when the GIF enters or leaves that window (the GIF picker's list keeps
 * `labels.gifs.ownMark` with the age, see gifLine); no mark without that label.
 * `items` is `[]` when the library is empty or the labels lack
 * `header`/`entryNoText` (an older labels.json). `marked` holds the marked
 * lines: the budget keeps the list in rank order, and the request then renders
 * those lines after the unmarked ones (ownMarkedLast).
 * @param {unknown} gifs            The library (store.getGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ max?: number, halfLifeDays?: number, reactionChars?: number, actionChars?: number,
 *   ownMarkHours?: number }} [gifsCfg]  `config.gifs`.
 * @param {number} now
 * @returns {{ items: string[], marked: Set<string> }}
 */
function gifItems(gifs, mediaCache, labels, gifsCfg, now) {
  const marked = new Set();
  const g = labels.gifs;
  if (!g?.header || !g.entryNoText) return { items: [], marked };
  const max = Number.isInteger(gifsCfg?.max) && gifsCfg.max >= 0 ? gifsCfg.max : 25;
  const options = { ...gifFieldChars(gifsCfg), ownMarkHours: gifsCfg?.ownMarkHours ?? 24, now };
  const chosen = rankGifs(gifs, gifsCfg?.halfLifeDays ?? 30).slice(0, max);
  if (chosen.length === 0) return { items: [], marked };
  const lines = chosen.map((entry) => {
    // The bare line, then the ageless own-post mark: no relative time in the cached stable part.
    const line = gifLine(entry, mediaCache, labels, { ...options, ownMarkHours: 0 });
    if (!g.ownMarkRecent || ownPostAge(entry, options) === null) return line;
    const recent = `${line} ${g.ownMarkRecent}`;
    marked.add(recent);
    return recent;
  });
  return { items: [g.header, ...lines], marked };
}

/**
 * `items` (a kept `<gifs>` list: the header, then entry lines in rank order)
 * with the lines in `marked` moved after all the others, each group keeping
 * its order. The header stays first. Pure.
 * @param {string[]} items
 * @param {Set<string>} marked
 * @returns {string[]}
 */
function ownMarkedLast(items, marked) {
  if (items.length < 2 || marked.size === 0) return items;
  const [header, ...lines] = items;
  return [header, ...lines.filter((line) => !marked.has(line)), ...lines.filter((line) => marked.has(line))];
}

/**
 * `gifs.reactionChars` (40) and `gifs.actionChars` (70) of `gifsCfg`
 * (`config.gifs`), config.json's value when missing or not a number >= 0;
 * 0 = no cut. The one reader of both for the `<gifs>` list and the GIF picker.
 * @param {object|undefined} gifsCfg
 * @returns {{ reactionChars: number, actionChars: number }}
 */
export function gifFieldChars(gifsCfg) {
  const read = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
  return { reactionChars: read(gifsCfg?.reactionChars, 40), actionChars: read(gifsCfg?.actionChars, 70) };
}

/**
 * The one-line caption of a GIF library entry: the helper caption cached
 * under its `itemId` (the describer's cache; a `miss` entry has none), cut to
 * `actionChars` (0 = whole) at a word boundary, a cut marked with an ellipsis
 * (src/memory/clamp.js#clampWithEllipsis, a hard limit); '' when there is
 * none. Render time only, so a caption stored whole or stored cut renders the
 * same way. Whether an entry is captioned at all (the GIF picker lists only
 * those). Pure.
 * @param {{ itemId: string }} entry
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {number} actionChars
 * @returns {string}
 */
export function gifCaption(entry, mediaCache, actionChars) {
  const cached = mediaCache?.[entry?.itemId];
  return cached && !cached.miss && typeof cached.text === 'string' ? clampWithEllipsis(cached.text, actionChars) : '';
}

/**
 * The three caption fields of a GIF library entry described in that format
 * (src/memory/describe.js#parseGifDescription: the cache entry holds a
 * `reaction` or a `screen` string), each cut at render time like gifCaption
 * -- `reaction` and `screen` to `reactionChars`, `action` to `actionChars`
 * (0 = whole) --, `text` being the on-screen text; null for an entry in the
 * older one-line format, a miss or no entry, or when every field is empty. Pure.
 * @param {{ itemId: string }} entry
 * @param {object|null} mediaCache
 * @param {{ reactionChars: number, actionChars: number }} chars
 * @returns {{ reaction: string, action: string, text: string }|null}
 */
export function gifFields(entry, mediaCache, { reactionChars, actionChars }) {
  const cached = mediaCache?.[entry?.itemId];
  if (!cached || cached.miss || (typeof cached.reaction !== 'string' && typeof cached.screen !== 'string')) return null;
  const field = (value, chars) => (typeof value === 'string' ? clampWithEllipsis(value, chars) : '');
  const fields = {
    reaction: field(cached.reaction, reactionChars),
    action: field(cached.action, actionChars),
    text: field(cached.screen, reactionChars),
  };
  return fields.reaction || fields.action || fields.text ? fields : null;
}

/**
 * The transcript's view of the three-field GIF captions: every entry of the
 * describer cache in that format (gifFields, cut per field by `chars` like
 * the `<gifs>` list) as cache key -> `{ reaction, action, screen }`, ready
 * for formatTranscript's `gifFields` option (src/discord/format.js renders
 * `transcript.gifKnownFields` with them for a GIF of the library). Keys are
 * the item ids the transcript and `descriptions` use. Pure.
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {{ reactionChars: number, actionChars: number }} chars  gifFieldChars.
 * @returns {Map<string, { reaction: string, action: string, screen: string }>}
 */
export function gifFieldsMap(mediaCache, chars) {
  const map = new Map();
  for (const itemId of Object.keys(mediaCache ?? {})) {
    const fields = gifFields({ itemId }, mediaCache, chars);
    if (fields) map.set(itemId, { reaction: fields.reaction, action: fields.action, screen: fields.text });
  }
  return map;
}

/**
 * One line of a GIF library entry, as the `<gifs>` section shows it (gifItems,
 * with `ownMarkHours` 0: it adds its own ageless mark) and the GIF picker lists
 * it (src/behavior/gif-pick.js#renderGifLibrary): an
 * entry described in three fields (gifFields) through `labels.gifs.entryFields`
 * (`{id}`, `{reaction}`, `{action}`, `{text}` = the on-screen text; empty
 * fields left out, see src/discord/format.js#fillGifFields); an older one-line caption (gifCaption,
 * cut to `actionChars`) -- or a three-field one when the labels have no
 * `entryFields` -- through `labels.gifs.entry` (`{id}`/`{text}`); else
 * `labels.gifs.entryNoText` (`{id}`). A GIF the persona itself posted
 * (`ownLast`) no longer than `ownMarkHours` (0 = never) before `now` gets
 * ` ` + `labels.gifs.ownMark` appended, `{ago}` = that time through
 * formatDuration (`labels.units`); no mark without that label. The caller
 * checks that `labels.gifs` carries `entryNoText`. Pure.
 * @param {{ id: string, itemId: string, ownLast?: number }} entry
 * @param {object|null} mediaCache
 * @param {object} labels
 * @param {{ reactionChars: number, actionChars: number, ownMarkHours: number, now: number }} options
 * @returns {string}
 */
export function gifLine(entry, mediaCache, labels, { reactionChars, actionChars, ownMarkHours, now }) {
  const g = labels.gifs;
  const fields = g.entryFields ? gifFields(entry, mediaCache, { reactionChars, actionChars }) : null;
  const text = fields ? '' : gifCaption(entry, mediaCache, actionChars);
  const line = fields
    ? fillGifFields(g.entryFields, entry.id, fields)
    : text && g.entry
      ? fill(g.entry, { id: entry.id, text })
      : fill(g.entryNoText, { id: entry.id });
  const age = g.ownMark && labels.units ? ownPostAge(entry, { ownMarkHours, now }) : null;
  if (age === null) return line;
  return `${line} ${fill(g.ownMark, { ago: formatDuration(age, labels.units) })}`;
}

/** How long ago the persona posted `entry` when that is within `ownMarkHours` (0 = never) of `now`, else null. */
function ownPostAge(entry, { ownMarkHours, now }) {
  const age = Math.max(0, now - entry.ownLast);
  if (!Number.isFinite(ownMarkHours) || ownMarkHours <= 0 || !(entry.ownLast > 0) || age > ownMarkHours * HOUR_MS) return null;
  return age;
}

/**
 * The body of `<now>`: the present moment (formatNow), then, when `periods` holds any (the
 * journal's off periods, src/memory/journal.js#offPeriods, newest first), `labels.journal.offLead`
 * and one line per period: `offPaused` or `offStopped` with `{from}` / `{to}` (the date and
 * the clock in `timezone`, as a pulled channel's header writes them) and `{length}`
 * (formatDuration). A period whose label is missing is left out; without the lead, or with no
 * line left, the clock stands alone. Per-turn: it sits in the tail, never in a cached part.
 * @returns {string}
 */
function nowBlock(now, timezone, labels, periods) {
  const clock = formatNow(now, timezone, labels.locale);
  const l = labels.journal ?? {};
  if (!Array.isArray(periods) || periods.length === 0 || typeof l.offLead !== 'string' || !l.offLead.trim()) return clock;
  const lines = [];
  for (const period of periods) {
    const template = period?.kind === 'paused' ? l.offPaused : period?.kind === 'stopped' ? l.offStopped : null;
    if (typeof template !== 'string' || !template.trim() || !Number.isFinite(period.from) || !Number.isFinite(period.to)) continue;
    lines.push(
      fill(template, {
        from: pulledMoment(period.from, timezone, labels.locale),
        to: pulledMoment(period.to, timezone, labels.locale),
        length: formatDuration(Math.max(0, period.to - period.from), labels.units),
      }),
    );
  }
  return lines.length > 0 ? [clock, l.offLead, ...lines].join('\n') : clock;
}

/**
 * The user message's text parts from already-rendered blocks, in three cache
 * segments (see docs/prompt-contract.md, "Cache segments"): the stable part
 * (`cacheSegment: 'stable'`), what changes least first: the stable
 * `<senses>` lines, `<skills_protocol>` (`protocol`: static, the same for
 * every grant), `<skills_granted>` (`granted`: the names of the skills granted
 * to the persona, changing only with a grant), `<self_facts>`, `<about_chat>`,
 * `<gifs>`, `<directory>` (`directory`: the people directory, changing only with a
 * member's names or aliases); the profiles
 * (`cacheSegment: 'profiles'`: `<people>` with the interlocutor alone), then
 * the tail (no segment) with everything that changes from turn to turn -- a
 * second `<people>` with the other members first, `<emoji>` among it, its
 * ranking moves with use several times a day, `<skills>` (the catalogue, on
 * a question about what the persona can do) and `<around>` (the live voice and status glance) right before `<chat>` -- `<now>`, the per-turn
 * `<senses>` lines, `<tempo>` and `<task>` last. `senses` is
 * renderSenses' two halves. A segment with no block is left
 * out; every part but the last ends with the blank line that separates
 * blocks, so the parts' texts joined with nothing (userText) are the whole
 * user text. `cacheSegment` is a neutral tag: src/llm/openrouter.js#withCacheMarker
 * turns it into the provider's marker under the cache policy and never sends it.
 * Factored out so a fallback rendering (see `textFallback` below) can reuse
 * every block untouched except `<chat>`. `diary` (a diary post only): the
 * `<diary>` block's intro, shown above its kept lines, the `<plan>` body and
 * the `<seeds>` body (a set post's seed combinations, right after the plan).
 * A pulled channel's lines never carry
 * an `imageAttached`/`frameAttached` tag (nothing of another channel is
 * attached); `<other_channels>` lines can, when they hold an item attached for
 * the chat (see `textFallback`).
 * @returns {{ type: 'text', text: string, cacheSegment?: 'stable'|'profiles' }[]}
 */
function assembleUser({ nowText, timezone, labels, senses, protocol = '', granted = '', directory = '', kept, tempoText, task, chatItems, diary = null }) {
  const stable = [
    block('senses', senses.stable),
    // How the persona's skills reach her: static text, so a grant never changes this part.
    block('skills_protocol', protocol),
    // The names of the skills granted to her: changes only when a grant does.
    block('skills_granted', granted),
    block('self_facts', kept.self.join('\n')),
    block('about_chat', kept.aboutChat.join('\n')),
    // Own-marked entries last (ownMarkedLast).
    block('gifs', (kept.gifs ?? []).join('\n')),
    // Who can be mentioned and by which handle: changes only when a member's names or aliases do.
    block('directory', directory),
  ];
  // The interlocutor alone: constant while the same member talks to the persona.
  const profiles = [block('people', kept.interlocutor.join('\n\n'))];
  const tail = [
    // Everyone else `<people>` shows (asked about, then the compact participants): who they are
    // moves with every turn, so they open the tail, right where the one block stood.
    block('people', kept.people.join('\n\n')),
    block('server', kept.server.join('\n\n')),
    block('emoji', (kept.emoji ?? []).join('\n')),
    block('lore', kept.lore.join('\n\n')),
    // The last hours: one item, the header with the kept lines and moments, oldest first.
    block('recent', (kept.recent ?? []).join('\n')),
    // The persona's own exchanges on other channels: one item, the header and the episodes kept.
    block('participation', (kept.participation ?? []).join('\n')),
    // The members the persona feels most strongly about that `<people>` does not describe.
    block('attitudes', (kept.attitudes ?? []).join('\n')),
    block('other_channels', kept.neighbors.join('\n\n')),
    // Another channel pulled into this turn, one item per channel.
    block('channel_view', (kept.pulled ?? []).join('\n\n')),
    // A diary post: the persona's world, its past posts, this post's plan and what its search found.
    block('world', (kept.world ?? []).join('\n')),
    block('diary', (kept.diary ?? []).length > 0 ? [diary?.intro, ...kept.diary].filter(Boolean).join('\n') : ''),
    block('plan', diary?.plan ?? ''),
    block('seeds', diary?.seeds ?? ''),
    block('found', (kept.found ?? []).join('\n')),
    // Right before the chat it answers a question from.
    block('lookup', (kept.lookup ?? []).join('\n')),
    // The persona's skills with her access here, when she was asked what she can do.
    block('skills', (kept.skills ?? []).join('\n')),
    // What is going on at the edge of the persona's view right now: a live glance, tail only.
    block('around', (kept.around ?? []).join('\n')),
    block('chat', renderTranscript(chatItems, timezone, labels)),
    // The present moment after the history it dates, with the persona's recent time away (nowBlock).
    block('now', nowText),
    // The per-turn senses lines (renderSenses' `turn` half); the rest lead the stable part.
    block('senses', senses.turn),
    block('tempo', tempoText),
    block('task', task),
  ];
  const segments = [
    { blocks: stable, cacheSegment: 'stable' },
    { blocks: profiles, cacheSegment: 'profiles' },
    { blocks: tail, cacheSegment: null },
  ]
    .map(({ blocks, cacheSegment }) => ({ text: blocks.filter(Boolean).join('\n\n'), cacheSegment }))
    .filter((segment) => segment.text);
  return segments.map(({ text, cacheSegment }, i) => ({
    type: 'text',
    text: i < segments.length - 1 ? `${text}\n\n` : text,
    ...(cacheSegment ? { cacheSegment } : {}),
  }));
}

/**
 * A helper request's user content in two cache parts: the `stable` block (the
 * bulk that repeats between calls) tagged `cacheSegment: 'stable'` and
 * followed by `separator`, then the per-turn blocks joined with `separator`
 * and untagged. Empty blocks are left out; with no per-turn block the stable
 * part has no trailing separator. The parts' texts joined with nothing
 * (userText) are the old single string. A blank `stable` gives the plain
 * joined string. Pure.
 * @param {string} stable
 * @param {string[]} tail
 * @param {string} separator
 * @returns {string|{ type: 'text', text: string, cacheSegment?: 'stable' }[]}
 */
export function stableThenTail(stable, tail, separator) {
  const rest = tail.filter(Boolean).join(separator);
  if (!stable) return rest;
  if (!rest) return [{ type: 'text', text: stable, cacheSegment: 'stable' }];
  return [
    { type: 'text', text: stable + separator, cacheSegment: 'stable' },
    { type: 'text', text: rest },
  ];
}

/**
 * The whole text of a user message's content: a string as it is; an array of
 * parts as its text parts' texts joined with nothing (assembleUser's parts
 * carry their own separators, so this is exactly the user text the model
 * reads); anything else ''. Pure.
 * @param {unknown} content
 * @returns {string}
 */
export function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Fill the double-brace `{{key}}` placeholders of a prompt file (the prompt
 * contract's form; labels.json uses single braces, see fill() in
 * src/discord/format.js). The one `{{key}}` filler of the codebase: a key
 * present in `values` (an own property) with a non-null value is replaced by
 * `String(value)`; a key that is absent, null or undefined leaves its
 * placeholder untouched. A missing template reads as ''.
 * @param {string|null|undefined} template
 * @param {object} [values]
 * @returns {string}
 */
export function fillPromptTemplate(template, values) {
  const source = values ?? {};
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) =>
    Object.hasOwn(source, key) && source[key] != null ? String(source[key]) : all,
  );
}

/**
 * The transcript body of a helper classifier's `<transcript>` block (the
 * route classifier, src/behavior/route.js#routeContext; the re-watch and
 * lookup classifiers, src/behavior/turn.js#classifierContext): `messages`
 * (already chosen by the caller, oldest first) rendered as the chat renders
 * them (src/discord/format.js) under the live `config` -- `bot.timezone`,
 * `context.gapMarkerMinutes`, `context.maxMessageChars` (800, config.json's
 * value, when missing), `features.seeReactions`, `context.reactionsPerMessage`
 * -- with the media states the caller already has (`descriptions`, `videos`,
 * `reads`; each optional). The one copy of these options for the classifiers;
 * the caller wraps the body. Pure.
 * @param {object[]} messages
 * @param {{ config: object, selfName: string, labels: object, descriptions?: Map<string, unknown>,
 *   videos?: Map<string, unknown>, reads?: Map<string, unknown> }} params
 * @returns {string}
 */
export function classifierTranscript(messages, { config, selfName, labels, descriptions, videos, reads }) {
  const items = formatTranscript(messages, {
    timezone: config.bot?.timezone,
    gapMinutes: config.context?.gapMarkerMinutes,
    maxChars: config.context?.maxMessageChars ?? 2000,
    selfName,
    labels,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context?.reactionsPerMessage,
    replyQuoteChars: config.context?.replyQuoteChars,
    descriptions,
    videos,
    reads,
  });
  return renderTranscript(items, config.bot?.timezone, labels);
}

/**
 * The drawing sub-process's prompt (prompts/draw.md): `{{name}}` and
 * `{{request}}` filled, `{{appearance}}` filled with prompts/appearance.md
 * (its own `{{name}}` filled) for a picture the persona is in, else blanked;
 * `{{when}}` filled with `labels.draw.when` (`{when}`: the local time) when
 * `when` is given, else blanked; then runs of blank lines collapse to one and
 * the result is trimmed. `request` is expected already clamped to
 * `image.maxPromptChars` by the caller (src/behavior/turn.js).
 * @param {{ prompts: object, selfName: string, request: string, self: boolean, when?: string }} args
 *   `when`: the local date and time the picture is made at (src/discord/format.js#formatNow).
 * @returns {string}
 */
export function buildDrawPrompt({ prompts, selfName, request, self, when = '' }) {
  const appearance = self ? fillPromptTemplate(prompts?.appearance ?? '', { name: selfName }).trim() : '';
  const whenLabel = prompts?.labels?.draw?.when;
  const whenText = when && whenLabel ? fill(whenLabel, { when }) : '';
  return fillPromptTemplate(prompts?.draw ?? '', { name: selfName, appearance, request: request ?? '', when: whenText })
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim();
}

/**
 * Whether `labels` (prompts.labels) can render a request at all: an object
 * with `transcript`. The startup check (src/index.js) and every request
 * builder use this one test.
 * @param {unknown} labels
 * @returns {boolean}
 */
export function hasRequiredLabels(labels) {
  return Boolean(labels) && typeof labels === 'object' && Boolean(labels.transcript);
}

// How the task labels list several items inline: `{others}` and `{added}` sit inside a sentence.
const TASK_ITEM_JOIN = '; ';

/** `texts` as `<n>. <text>` items, numbered from `first`. */
function numberedItems(texts, first) {
  return texts.map((text, i) => `${first + i}. ${text}`);
}

/**
 * The task labels for buildRequest's `input.tasks` (see there), joined by a
 * blank line: `labels.task.missed` (a recovery turn's messages, `{missed}`:
 * `<n>. <author>: <text>` joined by `; `), then `labels.task.part` (or,
 * without a usable part, `labels.task.queued`), then
 * `labels.task.queuedOthers`, then `labels.task.added`. '' when nothing applies.
 * @param {{ part?: { index: number, total?: number, parts: string[] }|null, queued?: string[],
 *   queuedOthers?: { author: string, text: string }[], added?: string[],
 *   missed?: { author: string, text: string }[] }|null|undefined} tasks
 * @param {object} labels
 * @returns {string}
 */
function renderTasks(tasks, labels) {
  if (!tasks) return '';
  const queued = Array.isArray(tasks.queued) ? tasks.queued : [];
  const added = Array.isArray(tasks.added) ? tasks.added : [];
  const texts = [];
  // A recovery turn's messages left unanswered earlier (src/behavior/missed.js), first.
  const missed = Array.isArray(tasks.missed) ? tasks.missed.filter((item) => item && item.text) : [];
  if (missed.length > 0 && labels.task?.missed) {
    const items = numberedItems(missed.map((item) => `${item.author ?? ''}: ${item.text}`), 1);
    texts.push(fill(labels.task.missed, { missed: items.join(TASK_ITEM_JOIN) }));
  }
  const part = tasks.part;
  const parts = Array.isArray(part?.parts) ? part.parts : [];
  const usablePart = Boolean(part) && Number.isInteger(part.index) && part.index >= 1 && part.index <= parts.length;
  if (usablePart && labels.task?.part) {
    const otherParts = numberedItems(parts, 1).filter((_, i) => i + 1 !== part.index);
    const others = [...otherParts, ...numberedItems(queued, parts.length + 1)].join(TASK_ITEM_JOIN);
    texts.push(fill(labels.task.part, { index: part.index, total: part.total ?? parts.length, part: parts[part.index - 1], others }));
  } else if (!usablePart && queued.length > 0 && labels.task?.queued) {
    texts.push(fill(labels.task.queued, { others: numberedItems(queued, 1).join(TASK_ITEM_JOIN) }));
  }
  const others = Array.isArray(tasks.queuedOthers) ? tasks.queuedOthers.filter((call) => call && call.text) : [];
  if (others.length > 0 && labels.task?.queuedOthers) {
    const items = numberedItems(others.map((call) => `${call.author ?? ''}: ${call.text}`), 1);
    texts.push(fill(labels.task.queuedOthers, { others: items.join(TASK_ITEM_JOIN) }));
  }
  if (added.length > 0 && labels.task?.added) texts.push(fill(labels.task.added, { added: added.join(TASK_ITEM_JOIN) }));
  return texts.join('\n\n');
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!hasRequiredLabels(labels)) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Hostname of `url` without a leading `www.`, or '' for an unparsable URL. */
function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The web part of `<lookup>`: what the persona looked up online this turn
 * (src/web/lookup.js#search) -- `labels.lookup.header` with the query, then
 * the condensed text and `labels.lookup.sources` with the distinct sites, or
 * `labels.lookup.none` when nothing useful came back. '' when an older
 * labels.json has no `labels.lookup.header`.
 * @param {{ query: string, text: string, sources?: { site?: string, url?: string }[] }} lookup
 * @param {object} labels
 */
function renderWebLookup(lookup, labels) {
  const l = labels.lookup;
  if (!l?.header) return '';
  const lines = [fill(l.header, { query: lookup.query ?? '' })];
  const text = String(lookup.text ?? '').trim();
  if (!text) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  lines.push(text);
  const sources = Array.isArray(lookup.sources) ? lookup.sources : [];
  const sites = [...new Set(sources.map((source) => source?.site || siteOf(source?.url)).filter(Boolean))];
  if (sites.length > 0 && l.sources) lines.push(fill(l.sources, { list: sites.join(', ') }));
  return lines.join('\n');
}

/**
 * The server part of `<lookup>`: what the search of the server's own history
 * found this turn (src/behavior/recall-run.js) -- `labels.lookup.serverHeader`,
 * then the summary text, then, when a stretch came back and the labels have
 * `labels.lookup.stretch`, that label with `{date}` (the day of the stretch's
 * first line as `YYYY-MM-DD` in `timezone`: with its year, a stretch may be
 * years old) and `{channel}` (its channel's
 * name), followed by the stretch's lines as they are. '' when there is no
 * server part, nothing to show, or an older labels.json has no
 * `labels.lookup.serverHeader`.
 * @param {{ text?: string|null, stretch?: { channelName?: string|null, startTs: number, lines: string }|null }|null|undefined} server
 * @param {object} labels
 * @param {string} timezone
 * @returns {string}
 */
function renderServerLookup(server, labels, timezone) {
  const l = labels.lookup;
  if (!server || !l?.serverHeader) return '';
  const lines = [];
  const text = String(server.text ?? '').trim();
  if (text) lines.push(text);
  const stretch = server.stretch;
  if (l.stretch && typeof stretch?.lines === 'string' && stretch.lines.trim() && Number.isFinite(stretch.startTs)) {
    lines.push(fill(l.stretch, { date: zonedDay(stretch.startTs, timezone), channel: String(stretch.channelName ?? '') }), stretch.lines);
  }
  return lines.length > 0 ? [l.serverHeader, ...lines].join('\n') : '';
}

/**
 * The `<lookup>` block body as candidates in order of preference, for the
 * budget to take the first that fits (all of them one piece, never split).
 * `lookup` is the turn's `lookup` input: the web search's result
 * (src/web/lookup.js#search) and, under `server`, the server search's
 * (renderServerLookup); either may be missing. The web part alone renders
 * exactly as it did before the server part existed (no part header); the
 * server part alone renders under its header. With both, the block is
 * `labels.lookup.bothNote` (when present), `labels.lookup.webHeader` (when
 * present) over the web part, then the server part -- followed by the web
 * part alone and the server part alone as smaller fallbacks. [] when there is
 * no lookup or the labels can render neither part.
 * @param {object|null} lookup
 * @param {object} labels
 * @param {string} timezone
 * @returns {string[]}
 */
function lookupCandidates(lookup, labels, timezone) {
  if (!lookup || typeof lookup !== 'object') return [];
  const { server, ...webPart } = lookup;
  const web = Object.keys(webPart).length > 0 ? renderWebLookup(webPart, labels) : '';
  const serverText = renderServerLookup(server, labels, timezone);
  if (!web || !serverText) return [web || serverText].filter(Boolean);
  const l = labels.lookup;
  const whole = [l.bothNote, l.webHeader, web, serverText].filter(Boolean).join('\n');
  return [whole, web, serverText];
}

/**
 * Render the `<senses>` lines from `labels.senses`: which lines are true
 * under the live config (see docs/prompt-contract.md, "`<senses>`"), in two
 * halves for the prompt cache: `stable`, the lines that read only the config,
 * the prompts and the server's lists (the same on every turn of a day), and
 * `turn`, the lines that depend on this turn -- `senses.recall` (the server
 * search's daily caps), the drawing line (the quotas), `senses.participation`
 * (whether `<participation>` is shown) and `senses.privateChat` (this turn is
 * a private chat). Each half keeps the lines in the order described below.
 * Both are '' when `labels.senses` is missing entirely, so an older
 * deployment's labels.json never breaks — the block is simply omitted.
 * `drawQuota` (`{ spent, userSpent }` from the image client's quota(), or
 * undefined when no image client is wired) picks the drawing line.
 * `privateChat` adds `senses.privateChat`; outside a private chat,
 * `features.privateMessages === true` adds `senses.privateAware` instead.
 * `recallAvailable` (outside a private chat) adds `senses.recall` right after the search line.
 * `customEmoji` (the `<emoji>` block is possible) adds `senses.customEmoji`;
 * `gifs` (features.gifs on and a non-empty library) adds `senses.gifs` right after it.
 * `gifWatching` (GIFs are watched now, src/memory/gif-watch.js#gifWatchBlocker)
 * swaps `senses.gifDescribed` for `senses.gifWatched` when the labels have it.
 * Right after the files line, `senses.time` (how to read clock times, line
 * ages and gap markers), private chats included, when the label is a non-empty string.
 * Outside a private chat, after it: `senses.channels` (the
 * persona sees only the channels this request shows), then, with
 * `participation` (the request shows `<participation>`), `senses.participation`, then, with an
 * `elsewhereDestination` (`{ name }`, where a call from a read-only channel is
 * answered), `senses.elsewhere` with `{destination}`. With a `diaryChannel`
 * (the bare name of the diary channel; the label carries the `#`),
 * `senses.diary` with `{channel}` follows. A missing label adds nothing.
 * @returns {{ stable: string, turn: string }}
 */
function renderSenses(
  config,
  labels,
  {
    searchAvailable = false,
    recallAvailable = false,
    drawQuota,
    privateChat = false,
    customEmoji = false,
    gifs = false,
    gifWatching = false,
    elsewhereDestination = null,
    diaryChannel = null,
    participation = false,
  } = {},
) {
  const senses = labels.senses;
  if (!senses) return { stable: '', turn: '' };
  const visionOn = config.features?.vision !== false;
  const describedOn = config.features?.mediaDescriptions === true;
  const lines = [];
  // The lines that change from turn to turn: they stay out of the cached part.
  const turnLines = [];
  if (visionOn) lines.push(senses.imageSee);
  lines.push(describedOn ? senses.imageDescribed : senses.imageBlind);
  // A watched GIF (its animation, not one frame); an older labels.json
  // without the line keeps the one-frame one.
  const gifDescribedLine = gifWatching ? (senses.gifWatched ?? senses.gifDescribed) : senses.gifDescribed;
  lines.push(describedOn ? gifDescribedLine : senses.gifBlind);
  // Watching a video needs the describer on too; an older labels.json
  // without the video-watching lines falls back to the still-frame ones.
  const videoOn = describedOn && config.features?.videoDescriptions !== false;
  lines.push(videoOn ? (senses.videoWatch ?? senses.videoDescribed) : describedOn ? senses.videoDescribed : senses.videoBlind);
  // The second look on a question (features.videoRewatch, a missing key
  // counts as on); an older labels.json without the line shows nothing.
  if (videoOn && config.features?.videoRewatch !== false && senses.videoRewatch) lines.push(senses.videoRewatch);

  // Stickers get their own lines (a picture-format one behaves like an
  // image); senses.lottie only shows up alongside them -- an animated
  // built-in (Lottie) sticker is never a picture, name only, regardless of
  // vision/mediaDescriptions.
  const stickerLines = [];
  if (visionOn) stickerLines.push(senses.stickerSee);
  stickerLines.push(describedOn ? senses.stickerDescribed : senses.stickerBlind);
  const shownStickerLines = stickerLines.filter(Boolean);
  lines.push(...shownStickerLines);
  if (shownStickerLines.length > 0) lines.push(senses.lottie);
  // The server's custom emoji (`customEmoji`: features.customEmoji on and a
  // non-empty index); an older labels.json without the line shows nothing.
  if (customEmoji && senses.customEmoji) lines.push(senses.customEmoji);
  // The GIF library (`gifs`: features.gifs on and a non-empty library); an
  // older labels.json without the line shows nothing.
  if (gifs && senses.gifs) lines.push(senses.gifs);

  // The web lookup (features.webLookup -- a missing key counts as OFF, it
  // costs money and needs a key): the links line stays as it is and the
  // read-excerpt line follows it; the search line follows only when a search
  // key is configured (`searchAvailable`). An older labels.json without
  // either line shows nothing extra.
  const webOn = config.features?.webLookup === true;
  const readOn = webOn && config.web?.links?.enabled !== false;
  const searchOn = webOn && config.web?.search?.enabled !== false && searchAvailable === true;
  lines.push(senses.voice, videoOn ? (senses.linksWatch ?? senses.links) : senses.links);
  if (readOn && senses.linksRead) lines.push(senses.linksRead);
  if (searchOn && senses.search) lines.push(senses.search);
  // The search of the server's own message history (`recallAvailable`: a server
  // turn where the runner is available; its own switch, not the web one); an
  // older labels.json without the line shows nothing.
  // Per turn: the runner's daily caps can close it within a day.
  if (recallAvailable === true && senses.recall) turnLines.push(senses.recall);
  // Drawing (features.imageGeneration, a missing key counts as on) needs the
  // image client (`drawQuota` present): one line, the spent forms first. An
  // older labels.json without senses.draw shows nothing. Per turn: the quotas
  // move within a day, and the member's one with the author.
  if (drawQuota && config.features?.imageGeneration !== false && senses.draw) {
    turnLines.push(drawQuota.spent ? senses.drawSpent : drawQuota.userSpent ? senses.drawSpentUser : senses.draw);
  }
  lines.push(senses.files);
  // How to read clock times, line ages and gap markers; private chats too.
  if (typeof senses.time === 'string' && senses.time) lines.push(senses.time);
  // Which channels the persona sees, and where it answers a call from one it
  // cannot write in: a server turn only.
  if (!privateChat && senses.channels) lines.push(senses.channels);
  // The persona's own exchanges on other channels (`<participation>`), only while the block is
  // there: per turn.
  if (!privateChat && participation === true && senses.participation) turnLines.push(senses.participation);
  if (!privateChat && senses.elsewhere && typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name) {
    lines.push(fill(senses.elsewhere, { destination: elsewhereDestination.name }));
  }
  // Where the persona keeps its diary, so it can speak of it anywhere.
  if (senses.diary && typeof diaryChannel === 'string' && diaryChannel) lines.push(fill(senses.diary, { channel: diaryChannel }));
  // Private chat: the one line for this conversation (per turn), or -- on the
  // server, with the feature on -- the rule about what was said in private.
  if (privateChat) turnLines.push(senses.privateChat);
  else if (config.features?.privateMessages === true) lines.push(senses.privateAware);
  return { stable: lines.filter(Boolean).join('\n'), turn: turnLines.filter(Boolean).join('\n') };
}

/**
 * The whole `<senses>` text of `senses` (renderSenses' halves), as the budget
 * counts it: the same characters as one block of every line.
 * @param {{ stable: string, turn: string }} senses
 * @returns {string}
 */
function sensesWhole(senses) {
  return [senses.stable, senses.turn].filter(Boolean).join('\n');
}

/**
 * The `<skills_protocol>` body: `labels.skills.protocol` trimmed, '' when missing. Static on
 * purpose (the skills design): no skill row and no grant, so the stable part it sits in stays
 * byte-identical while the owner allows or denies skills.
 * @param {object} labels
 * @returns {string}
 */
function skillsProtocolText(labels) {
  const text = labels.skills?.protocol;
  return typeof text === 'string' ? text.trim() : '';
}

// Notation of `<skills_granted>`: how the names of one family are joined.
const GRANTED_NAME_SEPARATOR = ', ';

/**
 * The `<skills_granted>` body: `labels.skills.granted.lead` (when set), then one
 * `labels.skills.granted.line` per family -- `{family}` the part of the name before its first dot,
 * `{names}` the rest of each name joined by ', ' (a name without a dot stands whole) -- the
 * families and names in the order given (src/skills/discovery.js#grantedSkillNames: sorted by
 * name). Names only: the detailed rows stay in `<skills>`. '' without a name or without
 * `labels.skills.granted.line`. Depends on nothing but `names` and the labels, so the stable part
 * it sits in stays byte-identical between turns until a grant changes.
 * @param {string[]|null|undefined} names
 * @param {object} labels
 * @returns {string}
 */
function skillsGrantedText(names, labels) {
  const l = labels.skills?.granted;
  if (!Array.isArray(names) || !isPlainObject(l) || typeof l.line !== 'string' || !l.line) return '';
  const groups = byFamily(names.filter((name) => typeof name === 'string' && name).map((name) => ({ name })));
  if (groups.length === 0) return '';
  const lines = groups.map((group) => {
    const family = group[0].name.split('.')[0];
    const rest = group.map(({ name }) => (name.includes('.') ? name.slice(name.indexOf('.') + 1) : name));
    return fill(l.line, { family, names: rest.join(GRANTED_NAME_SEPARATOR) });
  });
  const lead = typeof l.lead === 'string' ? l.lead.trim() : '';
  return [lead, ...lines].filter(Boolean).join('\n');
}

// Notation of an argument's allowed values in `<skills>`: separator, and the mark of a cut list.
const ARG_VALUE_SEPARATOR = '|';
const ARG_VALUES_MORE = '…';

/**
 * The `{args}` of one `labels.skills.line`: `forms.list` with `{list}` filled by the arguments
 * (src/skills/discovery.js#skillArgs, in their order) joined by ', ', each its name wrapped in
 * turn by `forms.values` (`{arg}`, `{values}`: the values joined by '|', '…' after a cut list),
 * else by `forms.range` (`{arg}`, `{min}`, `{max}`; a bound the schema leaves open is ''), then
 * `forms.body` (`{arg}`) for the option a `<call>` body fills, then `forms.required` (`{arg}`);
 * a form the labels lack leaves the text as it was. '' without arguments or without `forms.list`.
 * @param {object[]|undefined} args
 * @param {object|undefined} forms  `labels.skills.args`.
 * @returns {string}
 */
function skillArgsText(args, forms) {
  if (!Array.isArray(args) || args.length === 0 || !isPlainObject(forms) || typeof forms.list !== 'string' || !forms.list) return '';
  const wrap = (key, text, values) => (typeof forms[key] === 'string' && forms[key] ? fill(forms[key], { ...values, arg: text }) : text);
  const one = (arg) => {
    let text = String(arg.name);
    if (Array.isArray(arg.values) && arg.values.length > 0) {
      text = wrap('values', text, { values: [...arg.values, ...(arg.more ? [ARG_VALUES_MORE] : [])].join(ARG_VALUE_SEPARATOR) });
    } else if (Number.isFinite(arg.minimum) || Number.isFinite(arg.maximum)) {
      text = wrap('range', text, { min: Number.isFinite(arg.minimum) ? arg.minimum : '', max: Number.isFinite(arg.maximum) ? arg.maximum : '' });
    }
    if (arg.body === true) text = wrap('body', text);
    if (arg.required === true) text = wrap('required', text);
    return text;
  };
  return fill(forms.list, { list: args.filter((arg) => typeof arg?.name === 'string').map(one).join(', ') });
}

/**
 * The `<skills>` body, compact whatever the size of the catalogue: only the rows the persona may
 * use now (`allowed`), grouped by family (src/skills/discovery.js#byFamily, an empty line between
 * families), one `labels.skills.line` each with `{name}`, `{title}`, `{whenToUse}`, `{access}`
 * and `{args}` filled; `{access}` is `labels.skills.access[<the row's reason>]`, else
 * `labels.skills.access.allowed`; `{args}` is skillArgsText of the row's `args`. A row without a
 * title (no texts in the skills layer yet) is its name alone. Rows marked `proposed` (the skills
 * a classifier named for this turn, not the whole catalogue): a line for each allowed one, then
 * the names of the others in one `labels.skills.proposedOff` line (`{names}`; none without that
 * label). '' without an allowed row and nothing to name, or without `labels.skills.line`.
 * Deterministic: the rows' order (the registry's) and their arguments' (the schema's) decide it.
 * @param {{ name: string, title?: string, whenToUse?: string, allowed: boolean, reason: string, proposed?: boolean, args?: object[] }[]|null|undefined} rows
 * @param {object} labels
 * @returns {string}
 */
export function skillsInventoryText(rows, labels) {
  const l = labels.skills;
  if (!Array.isArray(rows) || rows.length === 0 || typeof l?.line !== 'string' || !l.line) return '';
  const access = isPlainObject(l.access) ? l.access : {};
  const word = (row) => access[row.reason] ?? access.allowed ?? '';
  const named = rows.filter((row) => row && typeof row.name === 'string');
  const line = (row) => (row.title ? fill(l.line, { name: row.name, title: row.title, whenToUse: row.whenToUse ?? '', access: word(row), args: skillArgsText(row.args, l.args) }) : row.name);
  const open = byFamily(named.filter((row) => row.allowed === true)).map((group) => group.map(line).join('\n'));
  if (!named.every((row) => row.proposed === true)) return open.join('\n\n');
  const off = named.filter((row) => row.allowed !== true).map((row) => row.name);
  const offLine = off.length > 0 && typeof l.proposedOff === 'string' && l.proposedOff ? fill(l.proposedOff, { names: off.join(', ') }) : '';
  return [open.join('\n\n'), offLine].filter(Boolean).join('\n');
}

/** The status words of a `<result>` block (src/skills/executors.js#RESULT_STATUSES; `refused` the old word for `denied`). */
const RESULT_STATUSES = new Set(['ok', 'denied', 'not_configured', 'invalid', 'unknown', 'partial', 'failed', 'refused']);

/** The label a status without its own `labels.skills.result.<status>` is told with. */
const RESULT_LABEL_FALLBACK = Object.freeze({ denied: 'refused', invalid: 'refused', not_configured: 'failed', partial: 'failed' });

/**
 * The `<result skill="<name>" status="<status>">` block of the one follow-up request after a
 * skill call (src/behavior/turn.js): `labels.skills.result[<status>]` (else the nearest label,
 * RESULT_LABEL_FALLBACK) with `{reason}` filled
 * by `labels.skills.result.reasons[<code>]` (else `.reasons.other`, else the code itself), then
 * the call's data when it has any -- `data.text` (a read's answer, or what an operation answered,
 * its error or refusal included), or `data.rows` as skillsInventoryText renders the catalogue --
 * cut to `maxChars` (clampWithEllipsis). Before all that, one
 * `labels.skills.result.alreadyPosted` line (`{text}`) per item of `posted`: what the persona
 * already posted this turn (none without that label). '' for no result. Every word from the
 * labels; the skill name and status are protocol tokens.
 * @param {{ skill: string, status: string, code?: string|null, data?: { text?: string, rows?: object[] }|null }} result
 * @param {object} labels
 * @param {{ maxChars?: number, posted?: string[] }} [options]
 * @returns {string}
 */
export function skillResultBlock(result, labels, { maxChars = 2000, posted = [] } = {}) {
  if (!result || typeof result.skill !== 'string') return '';
  const status = RESULT_STATUSES.has(result.status) ? result.status : 'failed';
  const words = isPlainObject(labels?.skills?.result) ? labels.skills.result : {};
  const reasons = isPlainObject(words.reasons) ? words.reasons : {};
  const code = typeof result.code === 'string' && result.code ? result.code : '';
  const reason = reasons[code] ?? reasons.other ?? code;
  const word = typeof words[status] === 'string' ? words[status] : words[RESULT_LABEL_FALLBACK[status]];
  const lead = typeof word === 'string' ? fill(word, { reason }) : '';
  let data = '';
  if (result.data) {
    data = Array.isArray(result.data.rows) ? skillsInventoryText(result.data.rows, labels) : String(result.data.text ?? '');
    if (Number.isFinite(maxChars) && maxChars > 0) data = clampWithEllipsis(data, maxChars);
  }
  const said = typeof words.alreadyPosted === 'string' && words.alreadyPosted
    ? (Array.isArray(posted) ? posted : []).filter((text) => typeof text === 'string' && text).map((text) => fill(words.alreadyPosted, { text }))
    : [];
  const body = [...said, [lead, data].filter(Boolean).join('\n') || code].join('\n');
  return `<result skill="${result.skill}" status="${status}">\n${body}\n</result>`;
}

/**
 * The reply request `messages` (system, user) once more with `resultBlock` in its tail: right
 * before the `<task>` block of the user message's last text part, else at that part's end. The
 * parts before it -- the cached ones -- are untouched, so the follow-up reuses the provider's
 * prompt cache. A fresh array; `messages` is not changed.
 * @param {{ role: string, content: string|object[] }[]} messages
 * @param {string} resultBlock
 * @returns {{ role: string, content: string|object[] }[]}
 */
export function withSkillResult(messages, resultBlock) {
  if (!resultBlock || !Array.isArray(messages) || messages.length < 2) return messages;
  const insert = (text) => {
    const at = text.lastIndexOf('<task>\n');
    return at === -1 ? `${text}\n\n${resultBlock}` : `${text.slice(0, at)}${resultBlock}\n\n${text.slice(at)}`;
  };
  const user = messages[1];
  let content;
  if (typeof user.content === 'string') content = insert(user.content);
  else {
    const parts = [...user.content];
    let last = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i]?.type === 'text') {
        last = i;
        break;
      }
    }
    if (last === -1) parts.push({ type: 'text', text: resultBlock });
    else parts[last] = { ...parts[last], text: insert(parts[last].text) };
    content = parts;
  }
  return [messages[0], { ...user, content }, ...messages.slice(2)];
}

const ASKED_ABOUT_SCAN_MESSAGES = 5;

/**
 * Whether `nameLower` (already lower-cased) is "named" inside `haystackLower`
 * for the purpose of pulling someone into `<people>` -- see
 * docs/prompt-contract.md, "Aliases". A name of 4+ characters also
 * matches at the START of a longer word (a declined/compound form of a short
 * nickname, e.g. `vert` inside `vertexia`, still counts); a name of exactly
 * 3 characters (the caller's minimum, see `isAskedAbout` below) must match a
 * WHOLE word, so a short unrelated word is never swallowed as a false-positive
 * prefix (`max` must not match `maximum`).
 */
function nameOccurs(haystackLower, nameLower) {
  if (nameLower.length < 4) return occursAsWholeWord(haystackLower, nameLower);
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(nameLower, from);
    if (at === -1) return false;
    if (!isWordChar(haystackLower[at - 1])) return true;
    from = at + 1;
  }
}

/** A profile's current name plus its top-ranked shown aliases -- everything it can be recognised by. */
function profileNames(profile, maxAliases, aliasHalfLifeDays) {
  const names = [];
  if (typeof profile?.names?.[0] === 'string') names.push(profile.names[0]);
  for (const alias of topByRank(Array.isArray(profile?.aliases) ? profile.aliases : [], maxAliases, aliasHalfLifeDays)) {
    if (typeof alias?.name === 'string') names.push(alias.name);
  }
  return names;
}

/**
 * The window that decides who the persona is being asked about (`<people>`
 * priority (b)): the trigger message plus the last `ASKED_ABOUT_SCAN_MESSAGES`
 * messages of `history` (trigger is usually already the newest of those, but
 * is added explicitly in case it is not). Real mention ids
 * (`normalizeMessage`'s `mentionedUserIds`, see src/discord/collect.js) are the
 * strongest signal; the plain lower-cased text is the fallback for a name/alias
 * match (`nameOccurs` above).
 * @param {object[]} history
 * @param {object|null} trigger
 * @returns {{ mentionedIds: Set<string>, scanTextLower: string }}
 */
function askedAboutWindow(history, trigger) {
  const recent = history.slice(-ASKED_ABOUT_SCAN_MESSAGES);
  const messages = trigger && !recent.some((m) => m.id === trigger.id) ? [...recent, trigger] : recent;
  const mentionedIds = new Set();
  const texts = [];
  for (const message of messages) {
    for (const id of Array.isArray(message?.mentionedUserIds) ? message.mentionedUserIds : []) mentionedIds.add(String(id));
    if (typeof message?.content === 'string' && message.content) texts.push(message.content);
  }
  return { mentionedIds, scanTextLower: texts.join('\n').toLowerCase() };
}

/** Whether `profile` is named/@mentioned in the asked-about window (see `askedAboutWindow`). */
function isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays) {
  const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
  if (id && mentionedIds.has(id)) return true;
  return profileNames(profile, maxAliases, aliasHalfLifeDays).some(
    (name) => name.length >= 3 && nameOccurs(scanTextLower, name.toLowerCase()),
  );
}

/**
 * Split the people who may appear in `<people>` into `askedAbout` (priority
 * (b): rendered FULL, ahead of everyone else) and `participants` (priority
 * (c): the other active participants, rendered COMPACT) -- see
 * docs/prompt-contract.md, "<people>"/"Aliases".
 *
 * `otherProfiles` (the active participants, most relevant first) are checked
 * against the asked-about window first, in order; a match is promoted into
 * `askedAbout` (up to `maxAskedAbout`), everyone else lands in `participants`.
 * `candidateProfiles` (every known profile in the guild) are then checked for
 * a SILENT member who is named/@mentioned but never spoke -- only ever added
 * to `askedAbout`, never to `participants` (a candidate who neither spoke nor
 * was asked about has no place in this request at all). `excludeId` (the
 * interlocutor, already rendered separately in full) is skipped in both.
 * Last, the authors of the lines shown from another channel
 * (`pulledAuthorIds`, most relevant first) are asked-about candidates too,
 * after everyone the chat names and under the same cap: a participant among
 * them is promoted, a silent member is taken from `candidateProfiles`.
 * @param {object[]} otherProfiles
 * @param {object[]} candidateProfiles
 * @param {object[]} history
 * @param {object|null} trigger
 * @param {string|number|null|undefined} excludeId
 * @param {number} [maxAskedAbout]        Not a non-negative integer -> no cap.
 * @param {number} [maxAliases]
 * @param {number} [aliasHalfLifeDays]
 * @param {string[]} [pulledAuthorIds]
 * @returns {{ askedAbout: object[], participants: object[] }}
 */
function splitPeople(
  otherProfiles,
  candidateProfiles,
  history,
  trigger,
  excludeId,
  maxAskedAbout,
  maxAliases,
  aliasHalfLifeDays,
  pulledAuthorIds = [],
) {
  const { mentionedIds, scanTextLower } = askedAboutWindow(history, trigger);
  const cap = Number.isInteger(maxAskedAbout) && maxAskedAbout >= 0 ? maxAskedAbout : Infinity;
  const covered = new Set();
  if (excludeId !== undefined && excludeId !== null) covered.add(String(excludeId));

  const askedAbout = [];
  const participants = [];

  for (const profile of Array.isArray(otherProfiles) ? otherProfiles : []) {
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || covered.has(id)) continue;
    covered.add(id);
    if (askedAbout.length < cap && isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      askedAbout.push(profile);
    } else {
      participants.push(profile);
    }
  }

  for (const profile of Array.isArray(candidateProfiles) ? candidateProfiles : []) {
    if (askedAbout.length >= cap) break;
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || covered.has(id)) continue;
    if (isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

  const idOf = (profile) => (profile?.id === undefined || profile?.id === null ? '' : String(profile.id));
  for (const authorId of pulledAuthorIds) {
    if (askedAbout.length >= cap) break;
    const id = String(authorId);
    if (excludeId !== undefined && excludeId !== null && id === String(excludeId)) continue;
    if (askedAbout.some((profile) => idOf(profile) === id)) continue;
    const at = participants.findIndex((profile) => idOf(profile) === id);
    if (at !== -1) {
      askedAbout.push(...participants.splice(at, 1));
      continue;
    }
    if (covered.has(id)) continue;
    const profile = (Array.isArray(candidateProfiles) ? candidateProfiles : []).find((candidate) => idOf(candidate) === id);
    if (profile) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

  return { askedAbout, participants };
}

/**
 * The `<recent>` items of a view (src/memory/recent.js#recentView), in its
 * order, each with its text and its time (`at`). A line renders through
 * `labels.recent.lineIn` (`{date}` `{time}` `{channel}` `{text}`) when it comes
 * from another channel whose name the channel map (`channels`) holds and the
 * label exists, else through `labels.recent.line` (`{date}` `{time}` `{text}`);
 * a moment through `labels.recent.episode` (`{date}` `{name}` `{what}`) --
 * the caller offers none without that label -- left out and counted
 * (`unnamed`) when the member has no name (`nameOf` gives none and the profile
 * stores none). A line's `{date}` and `{time}` are the transcript's own forms
 * of its time; a moment's `{date}` is its stored `YYYY-MM-DD` (the day it
 * happened) in the transcript's date form, never its `at` moved through a time
 * zone. Every stored `<@id>` token becomes the member's name (`nameOf`). No
 * quote and no feeling: a moment is named, not replayed.
 * @returns {{ entries: { kind: 'line'|'episode', at: number, text: string }[], unnamed: number }}
 */
function recentEntries(items, { labels, timezone, currentChannelId, channels, nameOf }) {
  const r = labels.recent;
  const channelNames = new Map(
    (Array.isArray(channels) ? channels : []).filter((channel) => channel?.id && channel.name).map((channel) => [channel.id, channel.name]),
  );
  const entries = [];
  let unnamed = 0;
  for (const item of items) {
    if (item.kind === 'line') {
      const date = formatDate(item.at, timezone, labels.locale);
      const text = resolveChatText(item.line.text, nameOf);
      const time = formatClock(item.at, timezone, labels.locale);
      const channel = item.line.channelId !== currentChannelId ? channelNames.get(item.line.channelId) : undefined;
      const rendered = channel && r.lineIn ? fill(r.lineIn, { date, time, channel, text }) : fill(r.line, { date, time, text });
      entries.push({ kind: 'line', at: item.at, text: rendered });
      continue;
    }
    if (!r.episode) continue;
    const name = nameOf(item.profileId) || item.name;
    if (!name) {
      unnamed += 1;
      continue;
    }
    const date = calendarDate(item.episode.date, labels.locale);
    entries.push({ kind: 'episode', at: item.at, text: fill(r.episode, { date, name, what: resolveChatText(item.episode.what, nameOf) }) });
  }
  return { entries, unnamed };
}

/** The words of `text` a `<participation>` line is matched by: its folded words (foldText) of 4+ letters. */
function matchWords(text) {
  return new Set(
    foldText(text)
      .split(/\P{L}+/u)
      .filter((word) => [...word].length >= 4),
  );
}

/**
 * The `<participation>` block's pieces before the budget: the slices of other
 * channels around the persona's own lines (src/memory/participation.js), or
 * null when there is no block to build -- a private chat, `features.participation`
 * off (a missing key counts as on), no `labels.participation.header` or
 * `labels.participation.episode`, or no `participation.state`. The episodes are
 * src/memory/participation.js#selectEpisodes's (`pickedIds` first, then the
 * newest; `participation.shown`, `participation.perChannel`, never the current
 * channel, only channels `audience` accepts). A line whose message id is in
 * `shownIds` (already in `<chat>`, `<other_channels>` or `<channel_view>`) is
 * dropped (counted in `deduped`); an episode left without a line of the
 * persona is dropped, and so is every episode of a channel with no name (the
 * stored note's, else `channelName(id)`). Each episode is cut to
 * `participation.episodeChars` (cutEpisode) keeping the lines that share a
 * word of 4+ letters with `candidateText`; a run of cut lines renders
 * `labels.participation.skipped` (`{count}`), nothing without the label. An
 * episode renders `labels.participation.episode` (`{when}`: the age of its
 * newest own line, formatDuration), then its lines in the transcript's form
 * without a `#n` index or a reply quote: the clock time, as
 * `transcript.timeAged` once the line is `ageMinutes` old, the author
 * (`labels.self` for the persona), the text, and a stored caption as
 * `transcript.imageDescribed`. A channel's line is `labels.participation.channel`
 * (`{channel}` `{purpose}`: the stored note's purpose) or, with no purpose,
 * `labels.participation.channelNoPurpose`. `episodes` come in budget priority
 * (the picks in their order, then the newest), each with `budgetText` (its
 * channel line and its own text: what the budget pays for) and `rank` (its
 * place in the selection's display order).
 * @returns {{ header: string, episodes: { id: string, channelId: string, channelLine: string, text: string,
 *   budgetText: string, rank: number, lastOwnAt: number }[], offered: number, deduped: number }|null}
 */
function participationView(participation, { config, labels, privateChat, currentChannelId, channels, shownIds, candidateText, now, timezone, selfName, nameOf, ageMinutes }) {
  const p = labels.participation;
  if (privateChat || config.features?.participation === false) return null;
  if (!p?.header || !p.episode) return null;
  if (!participation || typeof participation !== 'object' || !participation.state) return null;
  const settings = participationSettings(config);
  const pickedIds = Array.isArray(participation.pickedIds) ? participation.pickedIds : [];
  const groups = selectEpisodes(
    participation.state,
    { pickedIds, excludeChannelId: currentChannelId, audience: participation.audience, now },
    settings,
  );
  const stored = new Map((Array.isArray(channels) ? channels : []).filter((channel) => channel?.id).map((channel) => [channel.id, channel]));
  const liveName = typeof participation.channelName === 'function' ? participation.channelName : () => null;
  const words = matchWords(candidateText);
  const selfLabel = fill(labels.self, { name: selfName });
  const agedTemplate = labels.transcript?.timeAged;
  const renderLine = (message) => {
    const clock = formatClock(message.ts, timezone, labels.locale);
    const age = now - message.ts;
    const time = agedTemplate && age >= ageMinutes * MINUTE_MS ? fill(agedTemplate, { clock, age: formatDuration(age, labels.units) }) : `[${clock}]`;
    const caption = message.caption && labels.transcript?.imageDescribed ? fill(labels.transcript.imageDescribed, { text: message.caption }) : '';
    const body = [resolveChatText(message.text, nameOf), caption].filter(Boolean).join(' ');
    return `${time} ${message.self ? selfLabel : message.name}: ${body}`.trimEnd();
  };
  const episodes = [];
  let offered = 0;
  let deduped = 0;
  let rank = 0;
  for (const group of groups) {
    offered += group.episodes.length;
    const note = stored.get(group.channelId);
    const name = oneLine(note?.name ?? '') || oneLine(liveName(group.channelId) ?? '');
    if (!name) continue;
    const purpose = oneLine(note?.purpose ?? '');
    const channelLine = purpose && p.channel ? fill(p.channel, { channel: name, purpose }) : p.channelNoPurpose ? fill(p.channelNoPurpose, { channel: name }) : '';
    for (const episode of group.episodes) {
      const messages = episode.messages.filter((message) => !shownIds.has(message.id));
      deduped += episode.messages.length - messages.length;
      if (!messages.some((message) => message.self)) continue;
      const keepIds =
        words.size > 0 ? messages.filter((message) => [...matchWords(message.text)].some((word) => words.has(word))).map((message) => message.id) : [];
      const lines = cutEpisode({ messages }, { maxChars: settings.episodeChars, keepIds }).map((item) =>
        'skipped' in item ? (p.skipped ? fill(p.skipped, { count: item.skipped }) : '') : renderLine(item.message),
      );
      const text = [fill(p.episode, { when: formatDuration(Math.max(0, now - episode.lastOwnAt), labels.units) }), ...lines.filter(Boolean)].join('\n');
      episodes.push({
        id: episode.id,
        channelId: group.channelId,
        channelLine,
        text,
        budgetText: [channelLine, text].filter(Boolean).join('\n'),
        rank,
        lastOwnAt: episode.lastOwnAt,
      });
      rank += 1;
    }
  }
  // Budget priority: the picks in their order, then the newest; the display order stays the selection's.
  const pickIndex = (id) => {
    const at = pickedIds.indexOf(id);
    return at === -1 ? Infinity : at;
  };
  episodes.sort((a, b) => pickIndex(a.id) - pickIndex(b.id) || b.lastOwnAt - a.lastOwnAt);
  return { header: fill(p.header, { hours: settings.hours }), episodes, offered, deduped };
}

/**
 * The `<participation>` block's text from the episodes the budget kept: the
 * header, then per channel (in the selection's order) its channel line once
 * and its episodes. '' when none was kept.
 */
function participationText(view, keptEpisodes) {
  if (keptEpisodes.length === 0) return '';
  const lines = [view.header];
  let channelId = null;
  for (const episode of [...keptEpisodes].sort((a, b) => a.rank - b.rank)) {
    if (episode.channelId !== channelId && episode.channelLine) lines.push(episode.channelLine);
    channelId = episode.channelId;
    lines.push(episode.text);
  }
  return lines.join('\n');
}

/** A stored `YYYY-MM-DD` in the transcript's date form (`formatDate`), read as that calendar day:
 * its noon formatted in UTC, so no zone moves it to a neighbouring day. */
function calendarDate(ymd, locale) {
  return formatDate(Date.parse(`${ymd}T12:00:00.000Z`), 'UTC', locale);
}

/**
 * Another channel shown to a turn: the record src/discord/pull-fetch.js#fetchPull
 * returns (the one definition), read here and never changed. This module reads
 * it a little more loosely than the producer writes it: `earlierPingIds` may
 * also be an array, `channelName` null falls back to the channel id, and a
 * missing `descriptions`, `olderNotShown`, `picturesNotSeen`, `earlierPingIds`
 * or `pingState` reads as empty.
 * @typedef {import('../discord/pull-fetch.js').PulledChannel} PulledChannel
 */

/** `{from}` / `{to}` of a pulled channel's header: the date and the clock of `ts`, joined as `<now>` joins them. */
function pulledMoment(ts, timezone, locale) {
  return `${formatDate(ts, timezone, locale)}, ${formatClock(ts, timezone, locale)}`;
}

/** Ids as strings, from a Set or an array; anything else is empty. */
function idSet(value) {
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(list.map(String));
}

/** The state of message `id` in a pulled channel's `pingState` (a Map), or null. */
function pingStateOf(pingState, id) {
  const state = pingState instanceof Map ? pingState.get(String(id)) : null;
  return typeof state === 'string' ? state : null;
}

/**
 * The ids of the members who wrote the lines a request may show -- `history`, then every
 * `messages` list of each of `sources` (the pulled channels, the neighbours) -- never the
 * persona's own lines or a bot's, each once (src/behavior/handles.js#assignHandles' `inView`).
 * @param {object[]} history
 * @param {unknown[]} sources  Lists of `{ messages }` entries; anything else is skipped.
 * @returns {string[]}
 */
function authorsInView(history, sources) {
  const ids = new Set();
  const add = (messages) => {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message || message.self || message.bot || message.authorId === undefined || message.authorId === null) continue;
      ids.add(String(message.authorId));
    }
  };
  add(history);
  for (const source of sources) for (const entry of Array.isArray(source) ? source : []) add(entry?.messages);
  return [...ids];
}

/**
 * The pulled channels a request can show: entries with a channel id and at
 * least one message with an id and a time, one per channel (the first wins),
 * never the turn's own channel; each message once, oldest first.
 * @param {PulledChannel[]|unknown} pulled
 * @param {string|null} currentChannelId
 * @returns {{ entry: PulledChannel, channelId: string, name: string, messages: object[] }[]}
 */
function usablePulled(pulled, currentChannelId) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(pulled) ? pulled : []) {
    const channelId = typeof entry?.channelId === 'string' ? entry.channelId : '';
    if (!channelId || seen.has(channelId) || channelId === currentChannelId) continue;
    const byId = new Map();
    for (const message of Array.isArray(entry.messages) ? entry.messages : []) {
      if (message?.id === undefined || message?.id === null || !Number.isFinite(message.ts)) continue;
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
    if (byId.size === 0) continue;
    seen.add(channelId);
    const messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
    out.push({ entry, channelId, name: entry.channelName || channelId, messages });
  }
  return out;
}

/**
 * Every pulled channel's transcript items: ordinary chat lines
 * (`formatOptions`, so `context.maxMessageChars`), numbered on from
 * `firstIndex` and on again after each earlier channel, with the channel's own
 * captions joined to the turn's and NO attachment marker (nothing of another
 * channel is attached). A line that called the persona gets
 * `labels.pull.pingAnswered` / `pingUnanswered` / `pingSkipped` after one
 * space, by its `pingState` -- never the turn's trigger, and a state without
 * its label gets no mark (a skipped call never reads as unanswered).
 */
function pulledTranscripts(pulledChannels, { formatOptions, descriptions, firstIndex, triggerId, labels }) {
  const marks = new Map([
    ['answered', labels.pull?.pingAnswered],
    ['unanswered', labels.pull?.pingUnanswered],
    ['skipped', labels.pull?.pingSkipped],
  ]);
  let offset = firstIndex;
  return pulledChannels.map((channel) => {
    const own = channel.entry.descriptions;
    const captions = own instanceof Map && own.size > 0 ? new Map([...own, ...(descriptions ?? [])]) : descriptions;
    const items = formatTranscript(channel.messages, { ...formatOptions, attachedIndex: undefined, descriptions: captions, indexOffset: offset });
    offset += channel.messages.length;
    for (const item of items) {
      if (triggerId !== null && item.id === triggerId) continue;
      const mark = marks.get(pingStateOf(channel.entry.pingState, item.id));
      if (mark) item.text = `${item.text} ${mark}`;
    }
    return { ...channel, items, earlierIds: idSet(channel.entry.earlierPingIds) };
  });
}

/**
 * A short hash of what a pulled line is rendered from: its text, its
 * attachments and links, its stickers and its forwarded parts -- not its
 * reactions, its age or its index, which change without the message changing.
 * An edited message hashes differently.
 * @param {object} message  A normalized message.
 * @returns {string}
 */
function pulledLineHash(message) {
  const ids = (list, key) => (Array.isArray(list) ? list.map((item) => String(item?.[key] ?? item?.url ?? item?.name ?? '')) : []);
  const forwarded = Array.isArray(message.forwarded) ? message.forwarded.map((part) => [part?.content ?? '', ids(part?.attachments, 'id')]) : [];
  const source = JSON.stringify([message.content ?? '', ids(message.attachments, 'id'), ids(message.links, 'url'), ids(message.stickers, 'id'), forwarded]);
  return createHash('sha1').update(source).digest('hex').slice(0, 12);
}

/**
 * The view of the same source channel last shown in this destination channel
 * (src/discord/pull-fetch.js#createPullViews, attached by src/behavior/turn.js
 * as the entry's `seenBefore`), or null when there is none or it is unusable.
 * @returns {{ hashes: Map<string, string>, oldestTs: number, shownAt: number }|null}
 */
function seenBeforeOf(entry) {
  const seen = entry?.seenBefore;
  if (!seen || !(seen.hashes instanceof Map) || !Number.isFinite(seen.shownAt)) return null;
  return { hashes: seen.hashes, oldestTs: Number.isFinite(seen.oldestTs) ? seen.oldestTs : Infinity, shownAt: seen.shownAt };
}

/**
 * One pulled channel as its `<channel_view>` item, cut to `budget` tokens.
 * The item: `labels.pull.header` (`{channel}`, `{from}` = the first window line
 * kept, `{to}` = the window's newest line, `{ago}` = how long before `now` that
 * one was written: the channel's real span and age, whatever is cut), then --
 * with `seenOn` and a previous view of this channel in this destination
 * (`entry.seenBefore`) -- one line of fact about the lines kept against
 * it: `labels.pull.seenBefore` (`{fresh}` = lines not shown then or changed
 * since, by id and pulledLineHash; `{older}` = those older than the oldest
 * window line shown then; `{ago}` = how long before `now` it was shown) or,
 * with nothing fresh, `labels.pull.seenSame` (`{ago}`); no line without the
 * label. Then -- each when it applies and its label exists -- `labels.server.readOnly`,
 * `labels.pull.olderNotShown` (older messages exist, or window lines older
 * than the first one kept were cut here), `labels.pull.picturesNotSeen`
 * `{count}`; then the earlier calls under `labels.pull.earlierPings` (`{date}`
 * = the oldest one's date); then the window's lines, with
 * `labels.pull.olderNotShown` again between two kept lines whose lines in
 * between were cut (the trigger kept, newer lines cut, the newest ones kept).
 * What is kept: the trigger's line first, then the window's lines newest first
 * while they fit, then the earlier calls newest first. The trigger's line --
 * with the window's newest line when the trigger sits before the window, so
 * the header has a span -- may take up to `ceiling` even past `budget` (a call
 * is never lost to the share or the cap); then nothing else is kept. Null when
 * no window line fits: a header alone is never shown.
 * `seen` counts what the seen line said (null without one); `hashes` and
 * `oldestTs` are this view as the next one compares against it, `oldestId`
 * the line an earlier page starts before.
 * @returns {{ text: string, ids: Array<string|number>, newestId: string|number, newestTs: number,
 *   hashes: Map<string, string>, oldestTs: number, oldestId: string|number, seen: { fresh: number, older: number }|null }|null}
 */
function fitPulledChannel(channel, { budget, ceiling = budget, cost, labels, timezone, now, readOnly, triggerId, seenOn = false }) {
  const p = labels.pull;
  const windowItems = channel.items.filter((item) => !channel.earlierIds.has(String(item.id)));
  const earlierItems = channel.items.filter((item) => channel.earlierIds.has(String(item.id)));
  if (windowItems.length === 0) return null;
  const notSeen = Number.isFinite(channel.entry.picturesNotSeen) ? Math.max(0, Math.floor(channel.entry.picturesNotSeen)) : 0;
  const newestWindow = windowItems.at(-1);
  const windowAt = new Map(windowItems.map((item, i) => [item.id, i]));
  const hashById = new Map(channel.messages.map((message) => [String(message.id), pulledLineHash(message)]));
  const previous = seenOn ? seenBeforeOf(channel.entry) : null;

  // The kept lines against the previous view: new or changed ones, and those of them older than it.
  const seenCounts = (keep) => {
    if (!previous) return null;
    const fresh = channel.items.filter((item) => keep.has(item.id) && previous.hashes.get(String(item.id)) !== hashById.get(String(item.id)));
    return { fresh: fresh.length, older: fresh.filter((item) => item.ts < previous.oldestTs).length };
  };
  const seenLine = (counts) => {
    if (!counts) return null;
    const ago = formatDuration(Math.max(0, now - previous.shownAt), labels.units);
    if (counts.fresh === 0) return p.seenSame ? fill(p.seenSame, { ago }) : null;
    return p.seenBefore ? fill(p.seenBefore, { fresh: counts.fresh, older: counts.older, ago }) : null;
  };

  const render = (keep) => {
    const keptWindow = windowItems.filter((item) => keep.has(item.id));
    if (keptWindow.length === 0) return null;
    const keptEarlier = earlierItems.filter((item) => keep.has(item.id));
    const lines = [
      fill(p.header, {
        channel: channel.name,
        from: pulledMoment(keptWindow[0].ts, timezone, labels.locale),
        to: pulledMoment(newestWindow.ts, timezone, labels.locale),
        ago: formatDuration(Math.max(0, now - newestWindow.ts), labels.units),
      }),
    ];
    const seen = seenLine(seenCounts(keep));
    if (seen) lines.push(seen);
    if (readOnly && labels.server?.readOnly) lines.push(fill(labels.server.readOnly));
    const older = channel.entry.olderNotShown === true || keptWindow[0] !== windowItems[0];
    if (older && p.olderNotShown) lines.push(fill(p.olderNotShown));
    if (notSeen > 0 && p.picturesNotSeen) lines.push(fill(p.picturesNotSeen, { count: notSeen }));
    if (keptEarlier.length > 0) {
      if (p.earlierPings) lines.push(fill(p.earlierPings, { date: formatDate(keptEarlier[0].ts, timezone, labels.locale) }));
      lines.push(...keptEarlier.map((item) => item.text));
    }
    keptWindow.forEach((item, i) => {
      // Lines cut between two kept ones are not shown either.
      if (i > 0 && windowAt.get(item.id) - windowAt.get(keptWindow[i - 1].id) > 1 && p.olderNotShown) lines.push(fill(p.olderNotShown));
      lines.push(item.text);
    });
    return lines.join('\n');
  };
  const fitted = (keep) => {
    const kept = windowItems.filter((item) => keep.has(item.id));
    const newest = kept.at(-1);
    const ids = [...earlierItems, ...windowItems].filter((item) => keep.has(item.id)).map((item) => item.id);
    const counts = seenCounts(keep);
    return {
      text: render(keep),
      ids,
      newestId: newest.id,
      newestTs: newest.ts,
      hashes: new Map(ids.map((id) => [String(id), hashById.get(String(id))])),
      oldestTs: kept[0].ts,
      oldestId: kept[0].id,
      seen: seenLine(counts) ? counts : null,
    };
  };

  const keep = new Set();
  const pinned = triggerId !== null ? channel.items.find((item) => item.id === triggerId) : undefined;
  if (pinned) {
    const floor = new Set([pinned.id, ...(windowAt.has(pinned.id) ? [] : [newestWindow.id])]);
    const floorCost = cost(render(floor));
    if (floorCost <= ceiling) {
      if (floorCost > budget) return fitted(floor);
      for (const id of floor) keep.add(id);
    }
  }
  if (!(budget > 0)) return null;
  for (const group of [windowItems, earlierItems]) {
    for (let i = group.length - 1; i >= 0; i -= 1) {
      const { id } = group[i];
      if (keep.has(id)) continue;
      keep.add(id);
      const text = render(keep);
      if (text !== null && cost(text) <= budget) continue;
      keep.delete(id);
      break;
    }
  }
  const text = render(keep);
  if (text === null || cost(text) > budget) return null;
  return fitted(keep);
}

/**
 * The authors of the pulled lines kept (`fitPulledChannel`'s `ids` over each
 * channel's `messages`), newest line first, each once: members only, never the
 * persona and never a bot.
 * @param {{ ids: Array<string|number>, messages: object[] }[]} pulledFits
 * @returns {string[]}
 */
function pulledAuthors(pulledFits) {
  const out = [];
  for (const fit of pulledFits) {
    const byId = new Map(fit.messages.map((message) => [message.id, message]));
    for (const id of [...fit.ids].reverse()) {
      const message = byId.get(id);
      if (!message || message.self || message.bot || message.authorId === undefined || message.authorId === null) continue;
      const authorId = String(message.authorId);
      if (!out.includes(authorId)) out.push(authorId);
    }
  }
  return out;
}

/**
 * Whether a turn's task text is `prompts['follow-up']` instead of `prompts.reply`: a reply-mode
 * turn answering a follow-up (`followUp`: an untagged line the address classifier marked as said
 * to the persona) or an untagged `reply` (a Discord reply to the persona's line with no typed tag,
 * `taggedCall` exactly false -- src/behavior/mention.js#isTaggedCall, as decideMention reads it).
 * A mention, a tagged reply (or one whose tagged state is unknown), a name call, an overheard
 * line, a routed call and a private chat keep their usual task. Pure.
 * @param {{ mode: string, triggerKind: string|null|undefined, taggedCall?: boolean|null,
 *   routed?: boolean, privateChat?: boolean }} turn
 * @returns {boolean}
 */
export function usesFollowUpTask({ mode, triggerKind, taggedCall = null, routed = false, privateChat = false }) {
  if (mode !== 'reply' || routed || privateChat) return false;
  return triggerKind === 'followUp' || (triggerKind === 'reply' && taggedCall === false);
}

/**
 * Whether the one request after a skill call continues the turn (buildRequest's `continuation`:
 * the turn's history as it stands now with the call's mark on her line, `labels.task.continue`)
 * rather than repeating the reply request with a `<result>` block that lists what she already
 * posted: `features.followUpContinuation` on (a missing key counts as on), the call marks on
 * (`features.callMarkers`, a missing key counts as on; `labels.transcript.called` set: the mark is
 * how she reads the outcome) and `labels.task.continue` set. Pure.
 * @param {object} config  The live config, read by the caller now.
 * @param {object} labels  The labels the request is built with.
 * @returns {boolean}
 */
export function continuesTurn(config, labels) {
  const features = config?.features ?? {};
  if (features.followUpContinuation === false || features.callMarkers === false) return false;
  const task = labels?.task?.continue;
  const called = labels?.transcript?.called;
  return typeof task === 'string' && task.trim() !== '' && typeof called === 'string' && called !== '';
}

/**
 * What of the chat window entered a turn's request, for the journal: the ids of the kept
 * transcript lines (oldest first), of the reply parents among them (prepended to the window
 * from outside it, `replyParent: true`), of the messages whose pictures went in as image parts
 * and of the kept messages whose text attachment was previewed.
 * @param {{ history: object[], keptChat: { id: string }[], pictures: { messageId?: string }[] }} input
 * @returns {{ messageIds: string[], parents: string[], parts: { images: string[], filePreviews: string[] } }}
 */
function seenOf({ history, keptChat, pictures }) {
  const byId = new Map(history.map((message) => [message.id, message]));
  const messageIds = keptChat.map((item) => item.id).filter((id) => typeof id === 'string' && id);
  const keptMessages = messageIds.map((id) => byId.get(id)).filter(Boolean);
  const images = [];
  for (const picture of pictures) {
    if (typeof picture.messageId === 'string' && picture.messageId && !images.includes(picture.messageId)) images.push(picture.messageId);
  }
  return {
    messageIds,
    parents: keptMessages.filter((message) => message.replyParent === true).map((message) => message.id),
    parts: {
      images,
      filePreviews: keptMessages
        .filter((message) =>
          mediaParts(message).some((part) => (part.attachments ?? []).some((a) => a?.kind === 'text' && typeof a.previewText === 'string')),
        )
        .map((message) => message.id),
    },
  };
}

/**
 * @param {object} input
 * @param {object} input.config            Live config.
 * @param {object} input.prompts           Live prompts keyed by file name.
 * @param {object} input.calibrator
 * @param {'reply'|'interject'|'initiate'|'elsewhere'} input.mode  `prompts[mode]` is the task
 *   text; `elsewhere` (a noticed comment on a read-only channel) takes `prompts.elsewhere`.
 * @param {boolean} [input.forced]  True for an owner-forced turn (`/nep interject`, `/nep
 *   initiate`): when `prompts.forced` is a non-empty string, its filled text is appended to the
 *   task text (same placeholders as `prompts[mode]`) so the model knows `<skip/>` is not the
 *   expected outcome this time. Missing `prompts.forced` -> the task text is left as it is.
 * @param {number} input.now
 * @param {string} input.selfName
 * @param {string|null} [input.selfId]  The persona's own user id: her stored profile, if any, is
 *   never listed in `<directory>`. Omitted -> no profile is left out for being hers.
 * @param {object[]} input.history         Normalized channel messages, oldest first.
 * @param {{channelId?: string, channelName: string, messages: object[]}[]} input.neighbors
 *   `channelId` (see src/discord/collect.js#fetchNeighbors) is how `<server>` tells which
 *   stored channel note, if any, belongs to a neighbour that contributed to `<other_channels>` --
 *   omitted (an older/direct caller) simply means that neighbour never gets its note shown.
 * @param {object|null} input.trigger      Normalized message the turn answers (reply mode): a call,
 *   or an overheard line.
 * @param {string|null} input.triggerKind  src/behavior/turn.js#TriggerKind, null on a spontaneous turn.
 *   Its `labels.triggers` entry fills `{{trigger}}`. `overheard` (a line about the persona, said to
 *   someone else or to the room) takes `prompts.overheard` as its task text instead of
 *   `prompts[mode]` when that file is a non-empty string, falls back to the `followUp` then the
 *   `reply` label, and renders the author's profile without `labels.profile.interlocutorMark`.
 *   `followUp` and an untagged `reply` take `prompts['follow-up']` instead of `prompts.reply`
 *   (usesFollowUpTask) when that file is a non-empty string; missing or blank, `prompts.reply`.
 * @param {boolean|null} [input.taggedCall]  Whether the trigger tags the persona
 *   (src/behavior/mention.js#isTaggedCall); read only for a `reply` trigger: exactly false makes it
 *   an untagged reply. Null or missing counts as tagged.
 * @param {object} input.guildMemory
 * @param {object|null} input.interlocutor Profile of the trigger's author (the public one).
 * @param {{ userId: string }|null} [input.privateChat]  Set for a private (DM) turn: the
 *   interlocutor renders as `mergeProfiles(interlocutor, privateProfile)`, `<server>` and
 *   `<other_channels>` are omitted, `prompts.private` (when present) is appended to the task
 *   text (same placeholders as `prompts[mode]`), and `<senses>` carries `senses.privateChat`.
 * @param {object|null} [input.privateProfile]  The DM partner's private layer
 *   (store.getPrivate); read only when `privateChat` is set.
 * @param {object[]} input.otherProfiles   Profiles of other people in the transcript, most relevant first.
 * @param {object[]} [input.candidateProfiles]  Every member profile known in the guild
 *   (store.listUserProfiles), scanned to pull a silent member into `<people>` by a
 *   real mention/name/alias in the trigger or the last few messages (see `splitPeople`
 *   above); [] or omitted -> nobody is pulled in. Also the source of `<attitudes>` (see
 *   `renderAttitudes`): the top `context.attitudes` (6 when unset, 0 = no block) of them by
 *   `|affinity.score|`, the interlocutor and the members `<people>` keeps left out, in a
 *   private chat too; budget section `attitudes`, one piece capped by
 *   `context.caps.attitudes` (400 when unset), fitted right after `<people>`.
 * @param {(id: string) => (string|null)} [input.nameOf]  Resolves a member id to their
 *   current stored name, for turning every `<@id>` token this request renders into
 *   display text -- see docs/prompt-contract.md, "Members are referred to by
 *   id, never by nickname". Omitted -> tokens render exactly as stored.
 * @param {object[]} [input.channels]      The server's channel map (store.listChannels), [] when memory is off.
 * @param {object[]} [input.loreEntries]   The guild's stored lorebook (store.getLore), [] when memory is off.
 * @param {string|null} [input.currentChannelId]  Id of the channel this turn happens in.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption, for pictures
 *   NOT selected to be attached, and for attached ones too with features.attachedDescriptions
 *   (see src/behavior/turn.js, src/memory/describe.js).
 * @param {Map<string, string>} [input.neighborDescriptions]  Item id -> the caption the
 *   describer's cache already held for a picture in a neighbour's lines
 *   (src/memory/describe.js#cachedDescriptions); used for `<other_channels>` only, alongside
 *   `descriptions`. Omitted -> a neighbour picture shows a caption only when `descriptions` has one.
 * @param {Map<string, object>} [input.videos]  Item id -> video state from the video describer
 *   (src/memory/describe.js#describeVideos), passed to formatTranscript.
 * @param {Map<string, { question: string, text: string }>|null} [input.imageAnswers]  Picture or GIF id ->
 *   a second look on a question (src/memory/describe.js#relookImage / #rewatchGif), passed to formatTranscript.
 * @param {Map<string, string>} [input.reads]  Link id -> the excerpt the web lookup read from that
 *   page (src/web/lookup.js#readLinks), passed to formatTranscript.
 * @param {{ query?: string, text?: string, sources?: object[], cached?: boolean,
 *   server?: { text: string|null, stretch: { channelId: string, channelName: string|null, startTs: number,
 *   lines: string }|null, people: object[] } }|null} [input.lookup]  What was looked up this turn,
 *   rendered as `<lookup>` (see `lookupCandidates`): the web search's result
 *   (src/web/lookup.js#search) as it is, and under `server` what the search of the server's own
 *   history found (src/behavior/recall-run.js; src/behavior/turn.js adds the key only when it found
 *   something). A web result without `server` renders exactly as before the server part existed;
 *   the server part needs `labels.lookup.serverHeader`, its stretch `labels.lookup.stretch`.
 * @param {boolean} [input.searchAvailable]  Whether a web search key is configured
 *   (lookup.hasSearch()); `senses.search` renders only when it is true.
 * @param {boolean} [input.recallAvailable]  Whether the search of the server's own history could
 *   run this turn (src/behavior/turn.js#recallAvailable, never in a private chat); `senses.recall`
 *   renders, right after the web search line, only when it is true (and never in a private chat).
 * @param {{ spent: boolean, userSpent: boolean }} [input.drawQuota]  The image client's
 *   quota for this turn (src/llm/images.js#quota); omitted -> no drawing line in `<senses>`.
 * @param {string} [input.drawReason]  For `triggerKind: 'drawFailed'`: the failure reason,
 *   rendered through `labels.draw.reasons` into `labels.triggers.drawFailed`'s `{reason}`.
 * @param {{ id: string, name: string, animated?: boolean }[]} [input.customEmoji]  The served
 *   guild's custom emoji (src/discord/emoji.js#createEmojiIndex's `list()`). With
 *   `features.customEmoji` on (a missing key counts as on) and a non-empty list, `<emoji>`
 *   renders (ranked by `guildMemory.emojiUsage`, see `emojiItems`) and `<senses>` carries
 *   `senses.customEmoji`. Omitted or [] -> neither. With `labels.emoji.seenInChat` (and
 *   `entry`) set, the transcript's lines keep a custom emoji as a bare `:name:` and `<emoji>`
 *   describes the described ones not in its top list once, under that sub-heading; without
 *   it they keep the inline `transcript.emojiDescribed` tag.
 * @param {object|null} [input.mediaCache]  The describer cache (store.getMediaCache), read only
 *   for the `emoji:<id>` captions of `<emoji>`, the GIF captions of `<gifs>` and the three
 *   caption fields of a library GIF in the transcript (`transcript.gifKnownFields`, see
 *   gifFieldsMap).
 * @param {object|null} [input.gifs]  The guild's GIF library (store.getGifs). With `features.gifs`
 *   on (a missing key counts as on) and at least one entry, `<gifs>` renders (see `gifItems`),
 *   `<senses>` carries `senses.gifs`, and a GIF of the library in the transcript carries its
 *   handle (`transcript.gifKnownFields`/`gifKnown`/`gifKnownNoText`). Omitted or empty -> none of it.
 * @param {PulledChannel[]} [input.pulled]  Other channels pulled into this turn, rendered as
 *   `<channel_view>` (one item per channel, see `fitPulledChannel`) after `<other_channels>`:
 *   lines numbered on after the chat's (and after each earlier pulled channel), captions only
 *   (nothing of another channel is attached for vision), budget section `pulled` capped by
 *   `context.caps.pulled` (4000 when unset) and fitted right after the chat -- right before it
 *   on a routed turn. The block's room is shared evenly between the channels; a trigger that
 *   lives in a pulled channel (a routed call) keeps its line and the header past the share and
 *   the cap whenever the request has room for them. A pulled channel whose block is shown
 *   leaves `<other_channels>` (one dropped by the budget stays there); its stored note joins
 *   `<server>` right after the current channel either way; the authors of its kept lines are
 *   asked-about candidates for `<people>` (see `splitPeople`). No `labels.pull.header` -> no block.
 * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [input.source]  The channel a
 *   routed call or a noticed comment comes from (it is among `pulled`). It fills the task's
 *   `{{channel}}` (its name) and `{{destination}}` (this channel's name: the one the chat's
 *   messages carry, else `elsewhereDestination`'s, else the channel map's, else ''). `routed`:
 *   the trigger is looked up in the pulled lines; when its line is shown, its index fills
 *   `{{target}}` and `labels.elsewhere.called` (`{channel}` `{destination}`, left out while the
 *   destination has no name) follows the mode's task text -- when it is not, `{{target}}` is ''
 *   and no called text follows. The pulled block is fitted before the chat, and `<tempo>` is
 *   measured to `now` without saying that nobody answered the persona.
 * @param {object|null} [input.focus]  A message of the chat put to everyone present (a room
 *   question): `labels.room.focus` (`{author}` `{target}`) follows the task text when it is in
 *   the chat.
 * @param {{ part: { index: number, total: number, parts: string[] }|null, queued: string[],
 *   queuedOthers?: { author: string, text: string }[], added: string[] }|null} [input.tasks]  What else the trigger's author is waiting for, after
 *   the task text (src/behavior/turn.js). `part`: this turn answers one part of a message that
 *   holds several requests (src/behavior/split.js) -- `labels.task.part` with `{index}` (1-based),
 *   `{total}`, `{part}` (the part answered now) and `{others}` (every other part, then each of
 *   `queued`, as `<n>. <text>` items numbered on, joined by `; `). `queued`: the author's other
 *   calls still waiting for their own turns -- without a part, `labels.task.queued` with
 *   `{others}` (them, `<n>. <text>` items from 1, joined by `; `). `queuedOthers`: other members'
 *   calls waiting in this channel -- `labels.task.queuedOthers` with `{others}` (`<n>. <author>:
 *   <text>` items from 1, joined by `; `), on a part too. `added`: later messages of the
 *   author about this same call -- `labels.task.added` with `{added}` (their texts joined by `; `).
 *   A label missing (an older labels file) or a part outside its parts adds nothing for it.
 * @param {{ name: string }|null} [input.elsewhereDestination]  Where a call from a read-only
 *   channel is answered: `<senses>` gains `senses.elsewhere` with `{destination}`.
 * @param {Set<string>|string[]} [input.readOnlyIds]  Channels the bot can read but not write in:
 *   their `<server>` entries (never the current channel's) carry `labels.server.readOnly`, as do
 *   pulled channels whose record says `readOnly`. A private chat ignores `pulled`, `source`,
 *   `focus`, `elsewhereDestination` and `readOnlyIds`; with none of them given the request is
 *   the one built before pulled channels existed, save `senses.channels` on a server turn.
 * @param {object[]} [input.recentLines]  The guild's recent lines (store.getRecent(guildId).lines;
 *   an empty array for a store that holds none). With it an array, `features.recent` on (a
 *   missing key counts as on) and `labels.recent.header` and `labels.recent.line` present,
 *   `<recent>` renders after `<self_facts>` whenever the last `memory.recentHours` (72 when
 *   unset) hold an item this turn may show: `labels.recent.header` (`{hours}`), then the items
 *   kept, oldest first (see `recentEntries`). The items are chosen by
 *   src/memory/recent.js#recentView in its order -- the lines `recentAudience` accepts, the ones
 *   about the trigger's author, the interlocutor or a member asked about first; then up to
 *   two moments per member inside the window (src/memory/recent.js#RECENT_EPISODES_PER_MEMBER),
 *   those members first (none without `labels.recent.episode`) -- under `context.caps.recent` (1200
 *   when unset), ranked right after the chat and the pulled block and ahead of `<people>`; a
 *   header without an item, or items without the header, make no block. The moments
 *   `<people>` shows are left out: the interlocutor's that its block keeps and those of a
 *   member asked about. One that `<people>` cuts comes back here, in the room this block took
 *   plus what the request has beyond `<people>`'s room, so `<people>` never loses room to it,
 *   and a member asked about that `<people>` could not place gets the room it frees. A private
 *   chat shows no member's moment. The switch off, the labels missing, or the input omitted or
 *   not an array (the replay sandbox): no block, the request as before.
 * @param {(channelId: string|null) => boolean} [input.recentAudience]  Whether a recent line from
 *   that channel may be shown in this turn (src/behavior/turn.js decides it from the channels'
 *   audiences). Omitted -> only the lines of `currentChannelId`.
 * @param {{ state: object, pickedIds?: string[], audience?: (channelId: string) => boolean,
 *   channelName?: (channelId: string) => (string|null) }|null} [input.participation]  The
 *   persona's own exchanges on other channels, rendered as `<participation>` right after
 *   `<recent>` (see `participationView`): `state` is the guild's participation store
 *   (store.getParticipation), `pickedIds` the pick classifier's episode ids
 *   (src/behavior/participation-pick.js; [] or omitted: the newest are shown), `audience` the
 *   channels this turn may show them from (the `<recent>` and neighbour rule:
 *   context.pull.sameAudience), and `channelName` a channel's live name when its stored note has
 *   none. The selection happens here (src/memory/participation.js#selectEpisodes), so the
 *   block's dedup against the chat, the neighbours and the pulled channels is this builder's.
 *   Budget section `participation`, capped by `context.caps.participation` (6000 when unset),
 *   right after `recent`; one item per episode, the header first. Never in a private chat;
 *   none with `features.participation` false or without `labels.participation.header` and
 *   `labels.participation.episode`. While it is shown, `<senses>` carries `senses.participation`.
 * @param {string|null} [input.diaryChannel]  The bare name of the diary channel (the persona's
 *   own, src/behavior/diary.js) when one is set: `<senses>` gains `senses.diary` with
 *   `{channel}`. Omitted or null -> no line.
 * @param {{ posts?: object[], plan?: { kind: string|null, brief: string, picture: boolean, topic?: string }|null,
 *   found?: string|null, seeds?: string }|null} [input.diary]  A diary post's own input, read only with `mode:
 *   'diary'` (whose task text is `prompts.diary`): `<world>` (prompts/world.md, `{{name}}` filled,
 *   only with `diary.world === true`, see `worldText`; one piece, fitted right after `<attitudes>`),
 *   `<diary>` (the past posts through src/behavior/diary.js#renderDiaryBlock, the newest
 *   `diary.historyPosts` (150 when unset) oldest first, fitted after `<world>` and losing its
 *   oldest lines first), `<plan>` (`labels.diary.plan`, then the plan as one JSON line with `kind`,
 *   `brief`, `picture` and, with an owner's topic, `topic`; never cut), `<seeds>` (`seeds`, a set
 *   post's seed combinations already rendered; right after `<plan>`, never cut; absent when
 *   empty) and `<found>` (`labels.diary.found`, then what the search
 *   found; one piece, fitted right after `<lookup>`). They render after `<channel_view>` and before
 *   `<chat>`. `<world>` never renders outside a diary post.
 * @param {{ kind: 'paused'|'stopped', from: number, to: number }[]|null} [input.offPeriods]  The
 *   persona's recent time away (src/memory/journal.js#offPeriods, newest first): with
 *   `features.offPeriods` on (a missing key counts as on), `<now>` gains `labels.journal.offLead`
 *   and one `offPaused` / `offStopped` line per period (nowBlock). Omitted, null or empty -> none.
 * @param {{ name: string, title: string, whenToUse: string, allowed: boolean, reason: string }[]|null} [input.skillsInventory]
 *   The persona's skills catalogue for this requester and conversation
 *   (src/skills/gateway.js#listSkills), given on a turn whose question was what she can do (the
 *   classifier's `skills: inventory`): `<skills>` in the tail right before `<chat>`, one
 *   `labels.skills.line` per row (skillsInventoryText), budget section `skills` (one piece,
 *   after `found`). Whatever the input, with `features.skills` and `features.skillsDiscovery`
 *   on (a missing key counts as on) the stable part carries `<skills_protocol>`
 *   (`labels.skills.protocol`, fixed, never cut, static: the same for every grant); with either
 *   off neither block renders. Omitted or null -> no `<skills>`.
 * @param {string[]|null} [input.skillsGranted]  The names of the skills granted to the persona
 *   (src/skills/discovery.js#grantedSkillNames: her grants and the registry only, sorted), on
 *   every turn: with `features.skillsAlwaysListed` on as well (a missing key counts as on;
 *   src/skills/discovery.js#alwaysListedOn) `<skills_granted>` in the stable part right after
 *   `<skills_protocol>`, one `labels.skills.granted.line` per family after
 *   `labels.skills.granted.lead` (skillsGrantedText), fixed, never cut. Omitted, null or empty
 *   -> no block.
 * @param {{ snapshot: object, sceneMemberIds?: string[], channelNameOf?: (channelId: string) => string|null }|null} [input.around]
 *   The live glance at the server's sidebar (src/discord/around.js): `snapshot` is the
 *   store's snapshot, `sceneMemberIds` the interlocutor first, then whoever spoke last,
 *   `channelNameOf` the name of a voice channel the audience may see (else null: left out).
 *   `<around>` in the tail right before `<chat>`, never in a cached part, rendered by
 *   renderAround to at most `context.around.maxTokens` (default 200) and fitted as one piece
 *   right after `<skills>` in the budget order, so it displaces other context and never adds
 *   above the rail. Needs `labels.around`; `features.around` off, a private chat, an empty
 *   snapshot, or an omitted or null input -> no block.
 * @param {{ skill: string }|null} [input.continuation]  The same turn continued after the
 *   persona's skill call (src/behavior/turn.js#followUp under continuesTurn): the request is the
 *   turn's own, rebuilt over the turn's history as it stands now (her lines of the turn with the
 *   call's mark), and its task text is `labels.task.continue` with `{skill}` filled, alone -- no
 *   mode prompt, no `task.*`, private, forced, routed or room text. Every other block is built as
 *   for the turn, so the stable and profile parts stay the same. Omitted or null (or the label
 *   missing or blank) -> the task as usual.
 * @returns {{ messages: object[], stats: object, segments: { segment: 'stable'|'profiles'|'tail', chars: number, hash: string }[],
 *   idByIndex: Map<number, string>, tempo: object, handles: Map<string, string>|null,
 *   pictures: object[], textFallback: object[]|null, pulledIds: Map<string, string>,
 *   pulledKept: { channelId: string, ids: string[], newestId: string, newestTs: number }[],
 *   pulledViews: { channelId: string, hashes: Map<string, string>, oldestTs: number, oldestId: string|number }[],
 *   peopleShown: { id: string, names: string[] }[],
 *   recent: { lines: number, episodes: number, cut: number, hidden: number, repeated: number,
 *     unnamed: number }|null,
 *   seen: { messageIds: string[], parents: string[], parts: { images: string[], filePreviews: string[] } } }}
 *   The user message's content is always an array: its text parts (assembleUser: the stable
 *   part, the profiles and the tail, each tagged with its `cacheSegment` but the tail; an empty
 *   one left out), then one image_url part per attached picture; userText reads its whole text.
 *   `pictures` are the ones attached as image_url parts; `textFallback` is the same text parts
 *   with every attached picture rendered blind or described and no image part (null when nothing
 *   is attached), for a provider that rejects them. `idByIndex` maps chat AND pulled indices; `pulledIds` maps
 *   every pulled line's message id to its channel id (the output side reacts there, never
 *   replies across channels); `pulledKept` lists the channels whose block survived the budget,
 *   with the ids of the lines shown and the newest window line shown; `pulledViews` the same
 *   channels with each shown line's hash and the oldest window line's time (what the next view of
 *   that channel in this destination compares against: the PulledChannel's `seenBefore`,
 *   src/discord/pull-fetch.js#createPullViews). `peopleShown` lists the
 *   members whose profile the request shows (the interlocutor when its block was kept, then those
 *   `<people>` kept, in its order) with their stored names: whose `@name` the reply may resolve
 *   with features.mentionHandles off (src/behavior/turn.js#resolveMentions). `handles` maps
 *   every mention handle of the request to its member id (src/behavior/turn.js#renderPost): with
 *   features.mentionHandles on (a missing key counts as on) each member of `candidateProfiles`
 *   (the stored profiles of the served guild, never `selfId`'s) that has a name or an open
 *   alias gets one and is listed in `<directory>` -- `labels.directory.lead`, then one
 *   `labels.directory.line` / `lineAliases` per member (src/behavior/handles.js#renderDirectory),
 *   last in the stable part and never cut -- and every other author of the chat, the pulled
 *   channels and the neighbours (never the persona, never a bot; a private chat: the chat only)
 *   gets one from the same derivation, shown on their lines through `labels.transcript.author`
 *   (src/discord/format.js#formatTranscript); null with the switch off. `stats.pulled` is the
 *   block's budget line: `used`, `kept` (channels shown), `dropped` (channels offered and not
 *   shown, the budget's cut or a missing header label), `lines` (lines offered) and `linesCut`
 *   (lines offered and not shown), plus `seenFresh` / `seenOlder` (summed over the channels shown
 *   with a seen line) when one was. `recent` counts what `<recent>` did, null when it was off or
 *   its view held nothing (no item, none hidden, repeated or unnamed): `lines` and `episodes`
 *   shown, `cut` (items offered and not shown), `hidden` (lines `recentAudience` refused),
 *   `repeated` (moments in the window left out as shown in `<people>`) and `unnamed` (moments
 *   left out because their member has no name); `stats.recent` (only when an item was offered)
 *   counts the items, not the header. `stats.participation` (only when the block was built)
 *   adds to the budget line `offered` (episodes selected), `shown`, `cut` (offered and not
 *   shown: a channel without a name, an episode left without an own line by the dedup, the
 *   budget's cut) and `deduped` (lines left out as already shown elsewhere in the request).
 *   `seen` (seenOf) names what of the chat window went in: the kept lines' ids, the reply
 *   parents among them, the messages whose pictures are image parts and whose text
 *   attachments were previewed -- for the journal's turn record.
 */
export function buildRequest(input) {
  const { config, prompts, calibrator, mode, forced = false, now, selfName, history, neighbors, trigger, triggerKind, channels = [], currentChannelId = null, descriptions, videos, imageAnswers, reads, lookup = null } = input;
  const labels = requireLabels(prompts);
  const privateChat = Boolean(input.privateChat);
  const interlocutor = privateChat ? mergeProfiles(input.interlocutor, input.privateProfile) : input.interlocutor;
  const nameOf = typeof input.nameOf === 'function' ? input.nameOf : () => null;
  const { timezone } = config.bot;
  // Mention handles (features.mentionHandles, a missing key counts as on): every member with a
  // stored profile gets one in `<directory>` (the stable part), the authors in view on their lines.
  const handlesOn = config.features?.mentionHandles !== false;
  const directory = handlesOn ? directoryEntries(input.candidateProfiles ?? [], { selfId: input.selfId ?? null }) : [];
  const handleById = handlesOn
    ? assignHandles({ profiled: directory.map((entry) => entry.id), inView: authorsInView(history, privateChat ? [] : [input.pulled, neighbors]) })
    : null;
  const directoryText = handleById ? renderDirectory(directory, handleById, labels) : '';
  // `<now>`: the clock, then the persona's recent time away (features.offPeriods, read now).
  const nowText = nowBlock(now, timezone, labels, config.features?.offPeriods !== false ? input.offPeriods : null);
  const relationships = config.features?.relationships !== false;
  // How many attitude moves show under the attitude line (renderProfile).
  const shownMoves = config.relationships?.shownMoves ?? 4;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const visionCfg = config.context.vision ?? {};
  const visionOn = config.features?.vision !== false;
  // Only this channel's pictures are attached: a trigger in another channel (a routed call)
  // is shown as captions, like every pulled line.
  const pictures = visionOn ? selectPictures({ trigger, history, visionCfg, now, channelId: currentChannelId }) : [];
  const attachedIndex = new Map(pictures.map((picture, i) => [picture.itemId, i + 1]));
  // The GIF library: the switch (a missing key counts as on) and at least one entry.
  const gifLibrary = config.features?.gifs !== false && input.gifs ? normalizeGifs(input.gifs) : null;
  const gifsOn = Boolean(gifLibrary) && Object.keys(gifLibrary.entries).length > 0;
  // The server's custom emoji: the switch (a missing key counts as on) and a non-empty index.
  const customEmoji = config.features?.customEmoji !== false && Array.isArray(input.customEmoji) ? input.customEmoji : [];
  // A custom emoji of the transcript is described once, in `<emoji>` (emojiItems), when that
  // block can carry it; otherwise its lines keep the inline `transcript.emojiDescribed` tag.
  const emojiLabels = labels.emoji;
  const emojiOnce =
    Boolean(emojiLabels?.header && emojiLabels.entryNoText && emojiLabels.entry && emojiLabels.seenInChat) &&
    emojiMax(config.context.customEmoji) > 0 &&
    customEmoji.some((emoji) => emoji?.id && emoji.name);
  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    labels,
    // An old line carries its age against the same clock as `<now>` and `<tempo>`: the chat,
    // its blind variant, neighbour and pulled channels alike.
    now,
    ageMinutes: config.context.ageAfterMinutes ?? 60,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context.reactionsPerMessage,
    replyQuoteChars: config.context.replyQuoteChars,
    emojiInline: !emojiOnce,
    attachedIndex,
    descriptions,
    videos,
    reads,
    // A picture's second look on a question renders under its tag.
    imageAnswers,
    // Each author in view carries their mention handle (transcript.author).
    handles: handleById ?? undefined,
    // A GIF the library knows carries its handle in the transcript.
    gifHandles: gifsOn ? gifHandleMap(gifLibrary) : undefined,
    // ...and its three caption fields, cut like the `<gifs>` list (transcript.gifKnownFields).
    gifFields:
      gifsOn && labels.transcript?.gifKnownFields && input.mediaCache
        ? gifFieldsMap(input.mediaCache, gifFieldChars(config.gifs))
        : undefined,
  };

  const nameFill = (text) => fillPromptTemplate(text, { name: selfName });
  // format.md also names the brief limit: `{{drawChars}}` is the live image.maxPromptChars (1600 = config.json).
  const formatFill = (text) => nameFill(fillPromptTemplate(text, { drawChars: config.image?.maxPromptChars ?? 1600 }));
  const system = [
    nameFill(prompts['system-prompt']),
    nameFill(prompts['character-card']),
    nameFill(prompts.rules),
    formatFill(prompts.format),
  ]
    .filter(Boolean)
    .join('\n\n');
  const chatItems = formatTranscript(history, formatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));

  // Another channel pulled into this turn (`<channel_view>`): never in a private chat, and
  // shown only when the labels can head it. Its lines are numbered on after the chat's and
  // map back through idByIndex and pulledIds. A routed turn answers a call that lives there.
  const source = privateChat ? null : (input.source ?? null);
  const routed = source?.reason === 'routed';
  const offered = usablePulled(input.pulled, currentChannelId);
  const pulledChannels = labels.pull?.header ? offered : [];
  const chatTrigger = trigger ? (chatItems.find((item) => item.id === trigger.id) ?? null) : null;
  const pulledTriggerId = trigger && !chatTrigger ? trigger.id : null;
  const pulledSets = pulledTranscripts(pulledChannels, { formatOptions, descriptions, firstIndex: history.length, triggerId: pulledTriggerId, labels });
  const pulledIds = new Map();
  for (const channel of pulledSets) {
    for (const item of channel.items) {
      idByIndex.set(item.index, item.id);
      pulledIds.set(item.id, channel.channelId);
    }
  }

  // `<participation>`: the persona's own exchanges on other channels (never in a private chat).
  // A line already shown in the chat, a neighbour or a pulled channel is not shown again.
  const shownIds = new Set([
    ...history.map((message) => message.id),
    ...pulledChannels.flatMap((channel) => channel.messages.map((message) => message.id)),
    ...(privateChat ? [] : neighbors ?? []).flatMap((neighbor) => (neighbor.messages ?? []).map((message) => message.id)),
  ]);
  const participationCandidate = trigger ?? [...history].reverse().find((message) => !message.self && !message.bot) ?? null;
  const participationBuilt = participationView(input.participation, {
    config,
    labels,
    privateChat,
    currentChannelId,
    channels,
    shownIds,
    candidateText: participationCandidate?.content ?? '',
    now,
    timezone,
    selfName,
    nameOf,
    ageMinutes: config.context.ageAfterMinutes ?? 60,
  });
  const participationOffered = Boolean(participationBuilt && participationBuilt.episodes.length > 0);

  // On a routed turn the call is not in this chat: its silence is measured to now, and its
  // last line being the persona's own is no sign that nobody answered the persona.
  const tempo = computeTempo(history, now, routed ? null : trigger);
  const tempoText = renderTempo(routed ? { ...tempo, lastIsOwn: false } : tempo, labels, config.context.tempo);

  // The trigger's line in another channel (a routed call), when a pulled channel holds it.
  const pulledTrigger =
    pulledTriggerId !== null ? (pulledSets.flatMap((channel) => channel.items).find((item) => item.id === pulledTriggerId) ?? null) : null;
  // A follow-up (triggerKind: 'followUp') falls back to labels.triggers.reply
  // when an older labels.json has no dedicated label yet -- see prompt-contract.md.
  // An overheard line (triggerKind: 'overheard') falls back to the follow-up's label, then reply's.
  // A failed drawing (triggerKind: 'drawFailed') names its reason through labels.draw.reasons.
  const overheard = triggerKind === 'overheard';
  const rawTriggerLabel = overheard
    ? (labels.triggers?.overheard ?? labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
    : triggerKind === 'followUp'
      ? (labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
      : (labels.triggers?.[triggerKind] ?? '');
  const triggerLabel =
    triggerKind === 'drawFailed'
      ? fill(rawTriggerLabel, { reason: labels.draw?.reasons?.[input.drawReason] ?? input.drawReason ?? '' })
      : rawTriggerLabel;
  // A turn about another channel (routed or noticed) names both channels in its task: the
  // source, and this one, where the words go (its live name first).
  const sourceChannel = source ? (offered.find((channel) => channel.channelId === source.channelId) ?? null) : null;
  const here = sourceChannel
    ? (currentChannelFallback(currentChannelId, history)?.name ??
      (input.elsewhereDestination?.name || null) ??
      channels.find((channel) => channel?.id === currentChannelId)?.name ??
      '')
    : '';
  // An overheard turn has its own task text (prompts.overheard) INSTEAD of the mode's; without
  // it (missing or blank) the mode's text frames the line as said to the persona: degraded.
  const overheardTask = overheard && typeof prompts.overheard === 'string' && prompts.overheard.trim() ? prompts.overheard : null;
  // A follow-up or an untagged reply has its own task text (prompts['follow-up']) INSTEAD of
  // reply.md; without it (missing or blank) reply.md frames it, as before the file existed.
  const followUpPrompt = prompts['follow-up'];
  const followUpTask =
    usesFollowUpTask({ mode, triggerKind, taggedCall: input.taggedCall, routed, privateChat }) &&
    typeof followUpPrompt === 'string' &&
    followUpPrompt.trim()
      ? followUpPrompt
      : null;
  // A line put to everyone present (a room question), found in the chat.
  const focus = privateChat ? null : (input.focus ?? null);
  const focusItem = focus ? chatItems.find((item) => item.id === focus.id) : null;
  const focusText = focusItem && labels.room?.focus ? fill(labels.room.focus, { author: focus.authorName ?? '', target: `#${focusItem.index}` }) : '';
  // What else the author waits for: the part answered now and the rest, their queued calls, and
  // their later messages about this call.
  const tasksText = renderTasks(input.tasks, labels);
  // The same turn continued after the persona's skill call: its own task text, alone.
  const continueLabel = labels.task?.continue;
  const continueTask =
    input.continuation && typeof continueLabel === 'string' && continueLabel.trim() ? fill(continueLabel, { skill: input.continuation.skill ?? '' }) : '';
  // The task text. `callShown`: whether the pulled trigger's line made it into
  // `<channel_view>` -- a task never points at a line the request does not show.
  const composeTask = (callShown) => {
    if (continueTask) return continueTask;
    const callItem = chatTrigger ?? (callShown ? pulledTrigger : null);
    const taskValues = {
      name: selfName,
      author: trigger?.authorName ?? '',
      trigger: triggerLabel,
      target: callItem ? `#${callItem.index}` : '',
      ...(sourceChannel ? { channel: sourceChannel.name, destination: here } : {}),
    };
    const baseTask = fillPromptTemplate(overheardTask ?? followUpTask ?? prompts[mode] ?? '', taskValues);
    // Owner-forced turn (`/nep interject`/`/nep initiate`): tell the model
    // `<skip/>` is not the expected outcome this time -- optional, missing
    // prompts.forced (an older/undeployed labels layer) leaves the task as-is.
    const forcedText = forced && typeof prompts.forced === 'string' && prompts.forced.trim() ? fillPromptTemplate(prompts.forced, taskValues) : '';
    // Private chat: prompts.private follows the mode prompt; a missing file adds nothing.
    const privateText =
      privateChat && typeof prompts.private === 'string' && prompts.private.trim() ? fillPromptTemplate(prompts.private, taskValues) : '';
    // A routed call: where it came from and where the words go follow the mode's text, while
    // the call is shown and this channel has a name.
    const calledText =
      routed && sourceChannel && callItem && here && labels.elsewhere?.called
        ? fill(labels.elsewhere.called, { channel: sourceChannel.name, destination: here })
        : '';
    return [baseTask, calledText, focusText, tasksText, privateText, forcedText].filter(Boolean).join('\n\n');
  };
  // Fitted as if the call's line is shown: the pulled block keeps it whenever the request has
  // room for it (see fitPulledChannel); checked once the budget is spent.
  const fittedTask = composeTask(true);

  const sensesOptions = {
    searchAvailable: input.searchAvailable === true,
    recallAvailable: input.recallAvailable === true,
    drawQuota: input.drawQuota,
    privateChat,
    customEmoji: customEmoji.length > 0,
    gifs: gifsOn,
    // Whether a GIF in the transcript was watched rather than seen in one frame, under the live config and prompts.
    gifWatching: gifWatchBlocker(config, prompts) === null,
    elsewhereDestination: input.elsewhereDestination ?? null,
    diaryChannel: typeof input.diaryChannel === 'string' ? input.diaryChannel : null,
    // Fitted as if `<participation>` is shown; checked once the budget is spent.
    participation: participationOffered,
  };
  let senses = renderSenses(config, labels, sensesOptions);
  // The persona's skills (features.skills and features.skillsDiscovery, read now): the protocol,
  // static, in the stable part; the catalogue with her access only on a turn whose question was
  // what she can do (`skillsInventory`), in the tail.
  const skillsShown = discoveryOn(config);
  const protocolText = skillsShown ? skillsProtocolText(labels) : '';
  // The names of the skills granted to her, on every turn (features.skillsAlwaysListed): in the
  // stable part, so they hang on her grants only.
  const grantedText = alwaysListedOn(config) ? skillsGrantedText(input.skillsGranted, labels) : '';
  const inventoryText = skillsShown ? skillsInventoryText(input.skillsInventory, labels) : '';

  // A diary post (mode `diary`): the persona's world (under `diary.world`), its past posts, the
  // post's plan and what its search found. None of it in any other mode.
  const diaryMode = mode === 'diary';
  const diaryInput = diaryMode && input.diary && typeof input.diary === 'object' ? input.diary : null;
  const worldItem = diaryMode ? worldText(config, prompts, selfName) : '';
  const diaryLines = diaryInput ? diaryHistoryLines(diaryInput.posts, labels, config) : [];
  const diaryIntro = diaryLines.length > 0 ? (labels.diary?.intro ?? '') : '';
  const planText = diaryInput ? planBody(diaryInput.plan, labels) : '';
  const foundText =
    diaryInput && typeof diaryInput.found === 'string' && diaryInput.found.trim()
      ? [labels.diary?.found, diaryInput.found.trim()].filter(Boolean).join('\n')
      : '';
  // A set post's seed combinations (already rendered by src/behavior/diary.js#renderSeedsBlock).
  const seedsText = diaryInput && typeof diaryInput.seeds === 'string' ? diaryInput.seeds.trim() : '';
  const diaryParts = diaryMode ? { intro: diaryIntro, plan: planText, seeds: seedsText } : null;

  // A private chat has no neighbouring channels (and no server map, below).
  const offeredNeighbors = privateChat ? [] : neighbors;
  const pulledChannelIds = new Set(pulledChannels.map((channel) => channel.channelId));
  // Channels the bot can read but not write in, marked in `<server>` and on a pulled header.
  const givenReadOnly = input.readOnlyIds instanceof Set || Array.isArray(input.readOnlyIds) ? input.readOnlyIds : [];
  const readOnlyIds = new Set([
    ...(privateChat ? [] : givenReadOnly),
    ...pulledChannels.filter((channel) => channel.entry.readOnly === true).map((channel) => channel.channelId),
  ]);

  const caps = config.context.caps;
  const cost = sectionCost(calibrator);
  const limit = requestTokenLimit(config) - pictures.length * (visionCfg.tokensPerImage ?? 400) - TAG_OVERHEAD;

  const episodesOpt = { enabled: episodesOn, cap: caps.interlocutor, cost };
  const interlocutorShown = renderProfileShown(interlocutor, labels, {
    interlocutor: true,
    // The author of an overheard line is not talking to the persona.
    mark: !overheard,
    relationships,
    episodes: episodesOpt,
    maxInterests: config.memory?.maxInterests,
    maxDetails: config.memory?.maxDetails,
    maxAliases: config.memory?.maxAliases,
    aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
    addressHalfLifeDays: config.memory?.addressHalfLifeDays,
    interestHalfLifeDays: config.memory?.interestHalfLifeDays,
    detailHalfLifeDays: config.memory?.detailHalfLifeDays,
    confirmAfter: config.memory?.confirmAfter,
    staleDays: config.memory?.interestStaleDays,
    now,
    nameOf,
    shownMoves,
    timezone,
    supersededShownDays: config.memory?.supersededShownDays,
  });
  const fixedSection = {
    name: 'fixed',
    required: true,
    // The skills granted to her, the people directory, a diary post's plan, its seeds and its `<diary>` intro are never cut.
    items: [system, fittedTask, nowText, sensesWhole(senses), tempoText, ...[protocolText, grantedText, directoryText, planText, seedsText, diaryIntro].filter(Boolean)],
  };
  const interlocutorSection = { name: 'interlocutor', cap: caps.interlocutor, items: [interlocutorShown.text].filter(Boolean) };
  // `<lookup>`: one piece. With both a web and a server part, the first candidate that fits the
  // room the two sections ahead of it leave (the whole block, else the web part alone, else the
  // server part alone); so a server part never costs the web part its place, and the block as a
  // whole stays one item the main pass keeps or drops like before.
  const lookupOptions = lookupCandidates(lookup, labels, timezone);
  let lookupItem = lookupOptions[0] ?? '';
  if (lookupOptions.length > 1) {
    const room = limit - fitSections([fixedSection, interlocutorSection], limit, cost).used;
    lookupItem = lookupOptions.find((text) => cost(text) <= room) ?? lookupItem;
  }
  // The sections fitted ahead of the chat, in priority order.
  // `<around>` (features.around, a missing key counts as on; never in a private chat): the live
  // snapshot of the voice channels and of the scene's status and activities, rendered to at most
  // `context.around.maxTokens` and then fitted as one piece like what was looked up.
  const aroundInput = input.around;
  const aroundMax = config.context.around?.maxTokens;
  const aroundText =
    config.features?.around !== false && !privateChat && isPlainObject(aroundInput) && aroundInput.snapshot
      ? renderAround({
          snapshot: aroundInput.snapshot,
          sceneMemberIds: aroundInput.sceneMemberIds ?? [],
          nameOf,
          channelNameOf: aroundInput.channelNameOf,
          labels,
          maxTokens: Number.isFinite(aroundMax) ? aroundMax : 200,
          estimate: cost,
        })
      : '';
  const head = [
    fixedSection,
    interlocutorSection,
    // One piece, never split: already bounded by web.search.summaryChars and
    // recall.answerChars / recall.stretchChars, and ahead of the chat so a
    // tight budget trims old messages first.
    { name: 'lookup', items: [lookupItem].filter(Boolean) },
    // A diary post's search result: one piece, bounded by web.search.summaryChars.
    { name: 'found', items: [foundText].filter(Boolean) },
    // The skills catalogue, asked for: one piece, ahead of the chat like what was looked up.
    { name: 'skills', items: [inventoryText].filter(Boolean) },
    // What she sees of the voice channels and the scene's activities: one piece, already cut to
    // `context.around.maxTokens`, ranked with what was looked up so it displaces, never adds.
    { name: 'around', items: [aroundText].filter(Boolean) },
    {
      name: 'aboutChat',
      cap: caps.aboutChat,
      items: aboutChatItems(input.guildMemory, labels, nameOf, learnedConfig(config)),
    },
    {
      name: 'self',
      cap: caps.aboutChat,
      items: (input.guildMemory?.self ?? []).map((fact) => `- ${resolveChatText(fact, nameOf)}`),
    },
    {
      name: 'lore',
      cap: caps.lore,
      keep: 'first',
      items: loreOn ? loreItems(input.loreEntries, history, trigger, labels, config.lore, nameOf) : [],
    },
    {
      name: 'server',
      cap: caps.server ?? 4000,
      keep: 'first',
      items: privateChat
        ? []
        : serverItems(
            channels,
            currentChannelId,
            // A pulled channel's note right after the current channel's, then the neighbours'
            // (each once). Fitted ahead of the pulled block, so it cannot hang on its cut.
            [...pulledChannelIds, ...offeredNeighbors.map((n) => n.channelId).filter(Boolean)],
            history,
            now,
            config.context.channelActivity,
            labels,
            nameOf,
            readOnlyIds,
            config.diary?.channelId || null,
          ),
    },
  ];
  const chatSection = { name: 'chat', keep: 'newest', items: chatItems.map((item) => item.text) };

  // The pulled block's room: what the sections fitted ahead of it leave (the chat included,
  // except on a routed turn), at most context.caps.pulled, shared evenly between the
  // channels. Each channel is cut to its share here -- the call's own line may go past the
  // share and the cap, never past what the request has left (`free`, exactly what the main
  // pass leaves the block) -- so the main pass keeps every channel whole and the block can
  // never fail the request.
  const pulledCap = caps.pulled ?? 4000;
  const pulledFits = [];
  let pulledTaken = 0;
  if (pulledSets.length > 0) {
    const ahead = routed ? head : [...head, chatSection];
    const free = Math.max(0, limit - fitSections(ahead, limit, cost).used);
    const room = Math.min(pulledCap, free);
    const share = Math.floor(room / pulledSets.length);
    for (const channel of pulledSets) {
      const fitted = fitPulledChannel(channel, {
        budget: Math.min(share, Math.max(0, room - pulledTaken)),
        ceiling: free - pulledTaken,
        cost,
        labels,
        timezone,
        now,
        readOnly: readOnlyIds.has(channel.channelId),
        triggerId: pulledTriggerId,
        // features.pullSeenMarker (a missing key counts as on), read now.
        seenOn: config.features?.pullSeenMarker !== false,
      });
      if (!fitted) continue;
      pulledTaken += cost(fitted.text);
      pulledFits.push({ ...fitted, channelId: channel.channelId, messages: channel.messages });
    }
  }
  const pulledSection = { name: 'pulled', cap: Math.max(pulledCap, pulledTaken), keep: 'first', items: pulledFits.map((fit) => fit.text) };

  // The neighbours, cut shorter than the chat (context.neighborMessageChars); a channel whose
  // pulled block is shown is not shown again among them, one whose block was cut still is.
  const neighborChars = config.context.neighborMessageChars ?? 300;
  // The neighbours' own cached captions join the chat's for their lines only, so the
  // chat keeps exactly the captions this turn gave it.
  const neighborDescriptions =
    input.neighborDescriptions instanceof Map && input.neighborDescriptions.size > 0
      ? new Map([...input.neighborDescriptions, ...(descriptions ?? [])])
      : descriptions;
  const shownPulledIds = new Set(pulledFits.map((fit) => fit.channelId));
  const neighborItems = offeredNeighbors
    .filter((neighbor) => !shownPulledIds.has(neighbor.channelId))
    .map(
      ({ channelName, messages }) =>
        `# ${channelName}\n${formatTranscript(messages, { ...formatOptions, maxChars: neighborChars, descriptions: neighborDescriptions })
          .map((item) => item.text.replace(/^#\d+ /gm, ''))
          .join('\n')}`,
    );

  // <people> priority (b)/(c): who the trigger message / the last few
  // messages name or @mention (askedAbout, rendered FULL with their top
  // episodes, see below) vs. the other active participants (participants,
  // rendered COMPACT) -- see docs/prompt-contract.md, "Aliases". The authors
  // of the pulled lines shown join (b) after them, under the same cap.
  const { askedAbout, participants } = splitPeople(
    input.otherProfiles,
    input.candidateProfiles,
    history,
    trigger,
    interlocutor?.id,
    config.context.askedAboutProfiles,
    config.memory?.maxAliases,
    config.memory?.aliasHalfLifeDays,
    pulledAuthors(pulledFits),
  );
  // Each member asked about shows their top `context.askedAboutEpisodes` episodes (0 = off;
  // none in a private chat: another member's moments never reach it; none with an older labels
  // file that cannot render one).
  const askedAboutEpisodes = privateChat && config.features?.privateLikeServer === false ? 0 : (config.context.askedAboutEpisodes ?? 3);
  const episodeCount = (profile) => (Array.isArray(profile?.episodes) ? profile.episodes.length : 0);
  const episodeLabelsOn = Boolean(labels.profile?.episodes && labels.profile?.episode && labels.profile?.episodeNoQuote);
  const askedEpisodesOn =
    episodesOn &&
    episodeLabelsOn &&
    Number.isInteger(askedAboutEpisodes) &&
    askedAboutEpisodes > 0 &&
    askedAbout.some((profile) => episodeCount(profile) > 0);
  // The keys of the moments `<people>` shows for the members asked about: the top `counts[i]` of each.
  const askedKeys = (counts) =>
    new Set(askedAbout.flatMap((profile, i) => topEpisodes(profile.episodes, counts[i]).map((ep) => episodeKey(memberIdOf(profile.id), ep))));
  const askedIntended = askedKeys(askedAbout.map(() => (askedEpisodesOn ? askedAboutEpisodes : 0)));

  // `<recent>`: the last `memory.recentHours`, built when the caller hands the store's lines
  // over (an array, empty for a store without one; the replay sandbox hands none) with the
  // switch on and the labels present, and shown when the window holds an item this turn may
  // show. The lines `recentAudience` accepts (by default this channel's alone), then the
  // moments of the window (none in a private chat, none without the episode label), the ones
  // about the people this turn is about first: the trigger's author, the interlocutor and the
  // members asked about. A moment `<people>` shows is left out: those the interlocutor's block
  // keeps (none when the budget drops the block), and those of the members asked about --
  // ranked before `<people>` is fitted, the block first leaves out every moment `<people>` may
  // show them by and is built again below when `<people>` shows fewer.
  const recentCfg = recentSettings(config);
  const recentOn = Boolean(recentCfg && labels.recent?.header && labels.recent?.line && Array.isArray(input.recentLines));
  const recentCap = caps.recent ?? 1200;
  const interlocutorId = memberIdOf(interlocutor?.id);
  const recentFocus = [trigger?.authorId, interlocutorId, ...askedAbout.map((profile) => profile?.id)].map(memberIdOf).filter(Boolean);
  const recentAudience = typeof input.recentAudience === 'function' ? input.recentAudience : (channelId) => channelId === currentChannelId;
  const recentProfiles =
    recentOn && !privateChat && episodesOn && labels.recent.episode && Array.isArray(input.candidateProfiles) ? input.candidateProfiles : [];
  const interlocutorKeys = new Set(
    recentProfiles.length > 0 &&
    interlocutorId !== null &&
    interlocutorShown.episodes > 0 &&
    fitSections([fixedSection, interlocutorSection], limit, cost).kept.interlocutor.length > 0
      ? topEpisodes(interlocutor.episodes, interlocutorShown.episodes).map((ep) => episodeKey(interlocutorId, ep))
      : [],
  );
  const buildRecent = (askedShown) => {
    const view = recentView({
      lines: input.recentLines,
      profiles: recentProfiles,
      now,
      hours: recentCfg.hours,
      focusIds: recentFocus,
      excludeEpisodeKeys: new Set([...interlocutorKeys, ...askedShown]),
      isShown: recentAudience,
      perMember: RECENT_EPISODES_PER_MEMBER,
    });
    const { entries, unnamed } = recentEntries(view.items, { labels, timezone, currentChannelId, channels, nameOf });
    return { header: fill(labels.recent.header, { hours: recentCfg.hours }), entries, hidden: view.hidden, repeated: view.repeated, unnamed };
  };
  // One item per entry after the header, in the view's order: the budget keeps them from the top.
  const recentSectionOf = (built, cap) =>
    built && built.entries.length > 0 ? { name: 'recent', cap, keep: 'first', items: [built.header, ...built.entries.map((entry) => entry.text)] } : null;
  let recentBuilt = recentOn ? buildRecent(askedIntended) : null;
  let recentSection = recentSectionOf(recentBuilt, recentCap);
  // `<participation>`: the header, then one item per episode in budget priority, each paying for
  // its channel line (the block renders a channel line once per channel, so never more).
  const participationSection = participationOffered
    ? {
        name: 'participation',
        cap: caps.participation ?? 6000,
        keep: 'first',
        items: [participationBuilt.header, ...participationBuilt.episodes.map((episode) => episode.budgetText)],
      }
    : null;

  // The sections fitted ahead of `<people>`, in priority order: the one list both the main
  // pass and the room of the asked-about members' episodes (below) are measured on. The
  // pulled block right after the chat; ahead of it on a routed turn, whose call lives there;
  // then the last hours, then the persona's exchanges elsewhere.
  const aheadOfRecent = [...head, ...(routed ? [pulledSection, chatSection] : [chatSection, pulledSection])];
  const aheadOfPeopleWith = (recentSec) => [...aheadOfRecent, ...(recentSec ? [recentSec] : []), ...(participationSection ? [participationSection] : [])];
  let aheadOfPeople = aheadOfPeopleWith(recentSection);
  // Episodes only fill what `<people>` has left once every member asked about is placed
  // without them, as the budget takes them in order, so no member asked about is ever cut
  // for anyone's episodes; the earlier members take theirs first, each losing their lightest
  // first. That room is `caps.people`, or less when the sections ahead of `<people>` leave
  // less; measured only when an episode may be shown. The compact participants after them
  // get what is left.
  const peopleRoomCap = Number.isFinite(caps.people) ? caps.people : Infinity;
  const renderAsked = (profile, episodes) =>
    renderProfileShown(profile, labels, {
      relationships,
      episodes,
      maxInterests: config.memory?.maxInterests,
      maxDetails: config.memory?.maxDetails,
      maxAliases: config.memory?.maxAliases,
      aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
      addressHalfLifeDays: config.memory?.addressHalfLifeDays,
      interestHalfLifeDays: config.memory?.interestHalfLifeDays,
      detailHalfLifeDays: config.memory?.detailHalfLifeDays,
      confirmAfter: config.memory?.confirmAfter,
      staleDays: config.memory?.interestStaleDays,
      now,
      nameOf,
      shownMoves,
      timezone,
      supersededShownDays: config.memory?.supersededShownDays,
    });
  const askedAboutBare = askedAbout.map((profile) => renderAsked(profile, undefined).text);
  let askedAboutItems = askedAboutBare;
  // Members asked about the second placement below leaves out (see there): offered, not shown.
  let askedLeftOut = 0;
  if (askedEpisodesOn) {
    const measured = fitSections(aheadOfPeople, limit, cost);
    const free = Math.max(0, limit - measured.used);
    const room = Math.min(peopleRoomCap, free);
    let spare = room;
    // Who the budget keeps without episodes: one that does not fit is skipped, the next tried.
    const placed = askedAboutBare.map((text) => {
      const price = text ? cost(text) : 0;
      if (price > spare) return false;
      spare -= price;
      return true;
    });
    // How many of each member's top episodes their rendering shows.
    const shownCounts = askedAbout.map(() => 0);
    askedAboutItems = askedAbout.map((profile, i) => {
      const bare = askedAboutBare[i];
      if (!placed[i]) return bare;
      const base = bare ? cost(bare) : 0;
      // The most of the top episodes whose rendering fits what is spare.
      for (let max = Math.min(askedAboutEpisodes, episodeCount(profile)); max > 0; max -= 1) {
        const shown = renderAsked(profile, { enabled: true, max });
        const extra = (shown.text ? cost(shown.text) : 0) - base;
        if (extra <= spare) {
          spare -= extra;
          shownCounts[i] = shown.episodes;
          return shown.text;
        }
      }
      return bare;
    });
    const askedShown = askedKeys(shownCounts);
    if (recentBuilt && askedShown.size < askedIntended.size) {
      // `<recent>` again, now leaving out only the moments `<people>` shows: the ones it cuts
      // come back, ranked anew, in the room the block took plus what the request has beyond
      // `<people>`'s room -- so `<people>` keeps at least the room its members were placed in.
      recentBuilt = buildRecent(askedShown);
      recentSection = recentSectionOf(recentBuilt, Math.min(recentCap, (measured.stats.recent?.used ?? 0) + (free - room)));
      aheadOfPeople = aheadOfPeopleWith(recentSection);
      // The room `<people>` has now (never less than `room`): the members placed above keep their
      // rendering, and one that was not is tried bare (their moments are in `<recent>` now) in
      // what is left, never at the cost of a member placed after it. One that the budget would
      // still take where it stands, squeezing such a member out, is left out of the block.
      const roomNow = Math.min(peopleRoomCap, Math.max(0, limit - fitSections(aheadOfPeople, limit, cost).used));
      const prices = askedAboutItems.map((text) => (text ? cost(text) : 0));
      let reserved = prices.reduce((sum, price, i) => sum + (placed[i] ? price : 0), 0);
      let left = roomNow;
      askedAboutItems = askedAboutItems.map((text, i) => {
        if (placed[i]) {
          left -= prices[i];
          reserved -= prices[i];
          return text;
        }
        if (!text) return text;
        if (prices[i] <= left - reserved) {
          left -= prices[i];
          return text;
        }
        if (prices[i] > left) return text;
        askedLeftOut += 1;
        return '';
      });
    }
  }

  // `<people>`'s items, each with the member it renders (an empty rendering is no item).
  const peopleOffered = [
    ...askedAbout.map((profile, i) => ({ profile, text: askedAboutItems[i] })),
    ...participants.map((profile) => ({
      profile,
      text: renderProfile(profile, labels, {
        compact: true,
        relationships,
        maxAliases: config.memory?.maxAliases,
        aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
        addressHalfLifeDays: config.memory?.addressHalfLifeDays,
        interestHalfLifeDays: config.memory?.interestHalfLifeDays,
        confirmAfter: config.memory?.confirmAfter,
        staleDays: config.memory?.interestStaleDays,
        now,
        nameOf,
        shownMoves,
        timezone,
      }),
    })),
  ].filter((entry) => entry.text);
  const peopleSection = { name: 'people', cap: caps.people, items: peopleOffered.map((entry) => entry.text) };
  // The members `<people>` keeps: a subsequence of the offered items, in their order.
  const keptPeopleOf = (keptPeople) => {
    const shown = [];
    let next = 0;
    for (const entry of peopleOffered) {
      if (next < keptPeople.length && keptPeople[next] === entry.text) {
        shown.push(entry.profile);
        next += 1;
      }
    }
    return shown;
  };
  // `<attitudes>`: the top `context.attitudes` members by attitude strength (0 = no block), out
  // of every public profile of the guild, a private chat included. The interlocutor and the
  // members `<people>` shows carry their full attitude line there and are left out; `<people>`
  // is fitted ahead of this block, so what it keeps is measured without it.
  const attitudesMax = config.context.attitudes ?? 6;
  const attitudesOn =
    relationships &&
    Number.isInteger(attitudesMax) &&
    attitudesMax > 0 &&
    Boolean(labels.attitudes?.header && labels.attitudes?.line) &&
    Array.isArray(input.candidateProfiles) &&
    input.candidateProfiles.length > 0;
  let attitudesText = '';
  if (attitudesOn) {
    const peopleKept = keptPeopleOf(fitSections([...aheadOfPeople, peopleSection], limit, cost).kept.people);
    const skipIds = new Set([interlocutorId, ...peopleKept.map((profile) => memberIdOf(profile?.id))].filter((id) => id !== null));
    attitudesText = renderAttitudes(input.candidateProfiles, labels, { max: attitudesMax, skipIds });
  }
  const gifList = gifsOn ? gifItems(gifLibrary, input.mediaCache ?? null, labels, config.gifs, now) : { items: [], marked: new Set() };
  const budgetFit = fitSections(
    [
      ...aheadOfPeople,
      peopleSection,
      // One piece, kept or dropped whole: right below the people it leaves out.
      { name: 'attitudes', cap: caps.attitudes ?? 400, items: [attitudesText].filter(Boolean) },
      // A diary post: the persona's world whole, then its past posts, the oldest cut first.
      { name: 'world', items: [worldItem].filter(Boolean) },
      { name: 'diary', keep: 'newest', items: diaryLines },
      { name: 'neighbors', cap: caps.neighbors, items: neighborItems },
      // Lowest priority: a list to pick from, trimmed from the bottom (least used last).
      {
        name: 'emoji',
        cap: caps.emoji ?? 800,
        keep: 'first',
        items: emojiItems(customEmoji, input.guildMemory?.emojiUsage, input.mediaCache ?? null, labels, config.context.customEmoji, {
          seen: emojiOnce ? seenEmoji([history, ...pulledChannels.map((channel) => channel.messages), ...offeredNeighbors.map((neighbor) => neighbor.messages)]) : [],
          describe: (id) => emojiCaption(`emoji:${id}`, [descriptions, input.neighborDescriptions, ...pulledChannels.map((channel) => channel.entry.descriptions)]),
        }),
      },
      // Below even the emoji: the GIF library, trimmed the same way (least used last).
      {
        name: 'gifs',
        cap: caps.gifs ?? 900,
        keep: 'first',
        items: gifList.items,
      },
    ],
    limit,
    cost,
  );
  const { kept, stats } = budgetFit;
  let { used } = budgetFit;
  // The emoji seen in the chat lost to the cap leave no sub-heading of their own behind.
  if (emojiOnce && kept.emoji.length > 0 && kept.emoji.at(-1) === labels.emoji.seenInChat) kept.emoji = kept.emoji.slice(0, -1);
  // The header alone, or entries without their header, make no block.
  if (kept.emoji.length < 2 || kept.emoji[0] !== labels.emoji?.header) kept.emoji = [];
  if (kept.gifs.length < 2 || kept.gifs[0] !== labels.gifs?.header) kept.gifs = [];
  // The budget kept the GIFs in rank order; the ones carrying the own-post mark render last.
  kept.gifs = ownMarkedLast(kept.gifs, gifList.marked);
  if (askedLeftOut > 0) stats.people = { ...stats.people, dropped: stats.people.dropped + askedLeftOut };
  // `<recent>` as one piece: the header, then the entries kept (a subsequence of the offered
  // ones, in their order) oldest first. The header alone, or entries without it, make no block.
  let recent = null;
  if (recentBuilt) {
    const keptRecent = kept.recent ?? [];
    const shown = [];
    if (keptRecent.length >= 2 && keptRecent[0] === recentBuilt.header) {
      let next = 1;
      for (const entry of recentBuilt.entries) {
        if (next < keptRecent.length && keptRecent[next] === entry.text) {
          shown.push(entry);
          next += 1;
        }
      }
    }
    shown.sort((a, b) => a.at - b.at);
    kept.recent = shown.length > 0 ? [[recentBuilt.header, ...shown.map((entry) => entry.text)].join('\n')] : [];
    if (stats.recent) stats.recent = { ...stats.recent, kept: shown.length, dropped: recentBuilt.entries.length - shown.length };
    // Counted only when the view held something: an item, or one hidden, repeated or unnamed.
    const { entries, hidden, repeated, unnamed } = recentBuilt;
    if (entries.length > 0 || hidden + repeated + unnamed > 0) {
      recent = {
        lines: shown.filter((entry) => entry.kind === 'line').length,
        episodes: shown.filter((entry) => entry.kind === 'episode').length,
        cut: entries.length - shown.length,
        hidden,
        repeated,
        unnamed,
      };
    }
  }
  // `<participation>` as one piece: the header, then the episodes kept (a subsequence of the
  // offered items, in their order) regrouped by channel in display order. The header alone, or
  // episodes without it, make no block.
  if (participationBuilt) {
    const keptItems = kept.participation ?? [];
    const shown = [];
    if (keptItems.length >= 2 && keptItems[0] === participationBuilt.header) {
      let next = 1;
      for (const episode of participationBuilt.episodes) {
        if (next < keptItems.length && keptItems[next] === episode.budgetText) {
          shown.push(episode);
          next += 1;
        }
      }
    }
    const text = participationText(participationBuilt, shown);
    kept.participation = text ? [text] : [];
    stats.participation = {
      ...(stats.participation ?? { used: 0, kept: 0, dropped: 0 }),
      offered: participationBuilt.offered,
      shown: shown.length,
      cut: participationBuilt.offered - shown.length,
      deduped: participationBuilt.deduped,
    };
  }
  // The senses line names `<participation>` only when the block is there. The request only gets
  // shorter, so the fit holds.
  if (participationOffered && (kept.participation ?? []).length === 0) {
    const fitted = sensesWhole(senses);
    senses = renderSenses(config, labels, { ...sensesOptions, participation: false });
    const saved = cost(fitted) - cost(sensesWhole(senses));
    stats.fixed.used -= saved;
    used -= saved;
  }
  // The members whose profile the request shows: the interlocutor when its block was kept, then
  // the ones `<people>` kept (a subsequence of the offered items, in their order).
  const peopleShown = [];
  const showPerson = (profile) => {
    const id = memberIdOf(profile?.id);
    const names = Array.isArray(profile?.names) ? profile.names.filter((name) => typeof name === 'string') : [];
    if (id !== null) peopleShown.push({ id, names });
  };
  if ((kept.interlocutor ?? []).length > 0) showPerson(interlocutor);
  for (const profile of keptPeopleOf(kept.people ?? [])) showPerson(profile);
  // The pulled channels whose block survived, with what of them was shown.
  const keptPulled = new Set(kept.pulled);
  const pulledKept = pulledFits
    .filter((fit) => keptPulled.has(fit.text))
    .map(({ channelId, ids, newestId, newestTs }) => ({ channelId, ids, newestId, newestTs }));
  // The block's budget line counts what was offered and not shown too: a channel cut whole,
  // or lines cut inside a channel shown.
  const pulledShownLines = pulledKept.reduce((sum, shown) => sum + shown.ids.length, 0);
  const pulledLines = offered.reduce((sum, channel) => sum + channel.messages.length, 0);
  stats.pulled = { ...stats.pulled, dropped: offered.length - pulledKept.length, lines: pulledLines, linesCut: pulledLines - pulledShownLines };
  // What each kept channel showed, for the next view of it in this channel to compare against;
  // the seen lines' counts join the budget line only when one was shown.
  const keptFits = pulledFits.filter((fit) => keptPulled.has(fit.text));
  const pulledViews = keptFits.map(({ channelId, hashes, oldestTs, oldestId }) => ({ channelId, hashes, oldestTs, oldestId }));
  const seenFits = keptFits.filter((fit) => fit.seen);
  if (seenFits.length > 0) {
    stats.pulled.seenFresh = seenFits.reduce((sum, fit) => sum + fit.seen.fresh, 0);
    stats.pulled.seenOlder = seenFits.reduce((sum, fit) => sum + fit.seen.older, 0);
  }

  // A call whose line did not make it into the block is not pointed at: the task loses its
  // target and the called text. The request only gets shorter, so the fit holds.
  const callShown = pulledKept.some((shown) => shown.ids.includes(pulledTrigger?.id));
  const task = pulledTrigger && !callShown ? composeTask(false) : fittedTask;
  if (task !== fittedTask) {
    const saved = cost(fittedTask) - cost(task);
    stats.fixed.used -= saved;
    used -= saved;
  }

  const keptChat = chatItems.slice(chatItems.length - kept.chat.length);
  const seen = seenOf({ history, keptChat, pictures });
  const user = assembleUser({ nowText, timezone, labels, senses, protocol: protocolText, granted: grantedText, directory: directoryText, kept, tempoText, task, chatItems: keptChat, diary: diaryParts });

  // A provider that rejects the images (see src/behavior/turn.js's 4xx
  // retry) must never resend a <chat> claiming a picture is attached with
  // nothing actually attached: `textFallback` re-renders the SAME kept
  // messages with attachedIndex dropped, so imageAttached/frameAttached fall
  // back to their blind/described forms. Only `<chat>` is re-rendered: the
  // pulled lines never carry an attachment marker (rendered without
  // attachedIndex from the start), but `<other_channels>` lines are rendered
  // with it, so a neighbour line holding an item that is attached for the
  // chat (the same sticker or link id) shows the attached marker in both
  // renderings -- a known gap, left as it is. Computed only when there is
  // anything to fall back from.
  let textFallback = null;
  if (pictures.length) {
    const chatItemsBlind = formatTranscript(history, { ...formatOptions, attachedIndex: undefined });
    const keptChatBlind = chatItemsBlind.slice(chatItemsBlind.length - kept.chat.length);
    textFallback = assembleUser({ nowText, timezone, labels, senses, protocol: protocolText, granted: grantedText, directory: directoryText, kept, tempoText, task, chatItems: keptChatBlind, diary: diaryParts });
  }

  // A sticker's URL is already fully sized (see src/discord/media.js
  // stickerUrl: `size=`, not width/height/format) -- the media proxy must
  // never touch it again. Any other picture of known size gets its longer
  // side scaled to at most `context.vision.imageSize`, the aspect kept
  // (fitBox: the proxy crops any box of another aspect); of unknown size no
  // size at all, the original served under `context.vision.maxBytes`.
  const pictureUrl = (picture) =>
    picture.kind === 'sticker'
      ? picture.url
      : mediaProxyUrl(picture.url, { ...(fitBox(picture.width, picture.height, visionCfg.imageSize) ?? {}), format: 'webp' });

  // The text parts (assembleUser's cache segments), then the pictures: an array with or without them.
  const content = [
    ...user,
    ...pictures.map((picture) => ({
      type: 'image_url',
      image_url: { url: pictureUrl(picture) },
    })),
  ];

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    stats: { ...stats, used, limit, images: pictures.length },
    segments: user.map((part) => ({
      segment: part.cacheSegment ?? 'tail',
      chars: part.text.length,
      hash: createHash('sha1').update(part.text).digest('hex').slice(0, 8),
    })),
    idByIndex,
    tempo,
    pictures,
    textFallback,
    pulledIds,
    pulledKept,
    pulledViews,
    peopleShown,
    recent,
    seen,
    // Handle -> member id, for the persona's `@handle` (null with features.mentionHandles off).
    handles: handleById ? new Map([...handleById].map(([id, handle]) => [handle, id])) : null,
  };
}

/**
 * The `<world>` block's body of a diary request (the plan and the post):
 * prompts/world.md with `{{name}}` filled, only while `diary.world === true`
 * in `config` (the live config, read at the moment of use); '' with the
 * switch off or the file missing or blank. Never part of an ordinary turn:
 * only the diary's two requests call it.
 * @param {object} config
 * @param {object} prompts
 * @param {string} selfName
 * @returns {string}
 */
export function worldText(config, prompts, selfName) {
  if (config?.diary?.world !== true) return '';
  const text = prompts?.world;
  if (typeof text !== 'string' || !text.trim()) return '';
  return fillPromptTemplate(text, { name: selfName }).trim();
}

/** The `<diary>` block's post lines (no intro), oldest first: the newest `diary.historyPosts` (150). */
function diaryHistoryLines(posts, labels, config) {
  const body = renderDiaryBlock(posts, labels, { timezone: config.bot?.timezone, max: config.diary?.historyPosts ?? 150 });
  if (!body) return [];
  const lines = body.split('\n');
  const intro = labels.diary?.intro;
  return intro && lines[0] === intro ? lines.slice(1) : lines;
}

/** The `<plan>` block's body: `labels.diary.plan`, then the plan as one JSON line (`topic` only
 * when the owner gave one); '' without a plan. */
function planBody(plan, labels) {
  if (!plan || typeof plan !== 'object') return '';
  const kind = typeof plan.kind === 'string' ? plan.kind : '';
  const brief = typeof plan.brief === 'string' ? plan.brief : '';
  const topic = typeof plan.topic === 'string' ? plan.topic : '';
  if (!kind && !brief && !topic) return '';
  const line = { kind, brief, picture: plan.picture === true, ...(topic ? { topic } : {}) };
  return [labels.diary?.plan, JSON.stringify(line)].filter(Boolean).join('\n');
}

/**
 * The diary's plan request (prompts/diary-plan.md, sent on the classifier
 * model by src/behavior/turn.js): the system message is the plan prompt with
 * `{{name}}` filled; the user message carries, in this order, `<now>`,
 * `<server>` (the stored channel map, the diary channel first as the current
 * one), `<about_chat>`, `<recent>` (the lines `recentAudience` accepts and the
 * members' moments of the last `memory.recentHours`, oldest first; needs
 * `labels.recent.header` and `line`), `<lore>` (the entries the diary
 * channel's lines match), `<world>` (`worldText`, under `diary.world`),
 * `<diary>` (the past posts, as in the post request), `<kinds>`
 * (src/behavior/diary.js#renderKindsBlock over `kinds`, the use counted among
 * the newest `diary.historyPosts`) and `<seeds>` (`seedsText`, already
 * rendered by src/behavior/diary.js#renderSeedsBlock), then `<topic>`
 * (`topicText`, the owner's topic already rendered by
 * src/behavior/diary.js#renderTopicBlock; absent without one). Under the
 * request token limit `<now>`, `<kinds>`, `<seeds>` and `<topic>` are never cut, then in
 * priority order: `<diary>` (the oldest lines first), `<world>` (whole),
 * `<about_chat>`, `<server>`, `<recent>`, `<lore>` (each under its
 * `context.caps` entry). Pure.
 * @param {{ config: object, prompts: object, calibrator: object, now: number, selfName: string,
 *   history?: object[], guildMemory?: object|null, channels?: object[], loreEntries?: object[],
 *   currentChannelId?: string|null, recentLines?: object[]|null,
 *   recentAudience?: ((channelId: string|null) => boolean)|null, candidateProfiles?: object[],
 *   nameOf?: ((id: string) => (string|null))|null, posts?: object[], kinds?: Record<string, number>,
 *   seedsText?: string, topicText?: string }} input
 * @returns {{ messages: { role: string, content: string }[], stats: object }}
 */
export function buildDiaryPlanRequest(input) {
  const { config, prompts, calibrator, now, selfName, currentChannelId = null, seedsText = '', topicText = '' } = input;
  const labels = requireLabels(prompts);
  const timezone = config.bot?.timezone;
  const nameOf = typeof input.nameOf === 'function' ? input.nameOf : () => null;
  const history = Array.isArray(input.history) ? input.history : [];
  const channels = Array.isArray(input.channels) ? input.channels : [];
  const posts = Array.isArray(input.posts) ? input.posts : [];
  const caps = config.context?.caps ?? {};
  const cost = sectionCost(calibrator);
  const limit = Math.max(0, requestTokenLimit(config) - TAG_OVERHEAD);

  const system = fillPromptTemplate(prompts['diary-plan'] ?? '', { name: selfName }).trim();
  const nowText = formatNow(now, timezone, labels.locale);
  const kindsText = renderKindsBlock(input.kinds, posts, labels, { window: config.diary?.historyPosts ?? 150 });
  const diaryLines = diaryHistoryLines(posts, labels, config);
  const diaryIntro = diaryLines.length > 0 ? (labels.diary?.intro ?? '') : '';

  // `<recent>`: the lines of the last hours this channel's audience may read, then the members' moments.
  const recentCfg = recentSettings(config);
  const recentOn = Boolean(recentCfg && labels.recent?.header && labels.recent?.line && Array.isArray(input.recentLines));
  let recentBuilt = null;
  if (recentOn) {
    const episodesOn = Boolean(labels.recent.episode) && config.features?.episodes !== false;
    const profiles = episodesOn && Array.isArray(input.candidateProfiles) ? input.candidateProfiles : [];
    const view = recentView({
      lines: input.recentLines,
      profiles,
      now,
      hours: recentCfg.hours,
      focusIds: [],
      excludeEpisodeKeys: new Set(),
      isShown: typeof input.recentAudience === 'function' ? input.recentAudience : (channelId) => channelId === currentChannelId,
      perMember: RECENT_EPISODES_PER_MEMBER,
    });
    const { entries } = recentEntries(view.items, { labels, timezone, currentChannelId, channels, nameOf });
    if (entries.length > 0) recentBuilt = { header: fill(labels.recent.header, { hours: recentCfg.hours }), entries };
  }

  const channelIds = channels.map((channel) => channel?.id).filter(Boolean);
  const { kept, stats, used } = fitSections(
    [
      { name: 'fixed', required: true, items: [system, nowText, kindsText, seedsText, topicText, diaryIntro].filter(Boolean) },
      { name: 'diary', keep: 'newest', items: diaryLines },
      { name: 'world', items: [worldText(config, prompts, selfName)].filter(Boolean) },
      { name: 'aboutChat', cap: caps.aboutChat, items: aboutChatItems(input.guildMemory, labels, nameOf, learnedConfig(config)) },
      {
        name: 'server',
        cap: caps.server ?? 4000,
        keep: 'first',
        items: serverItems(channels, currentChannelId, channelIds, history, now, config.context?.channelActivity, labels, nameOf, new Set(), config.diary?.channelId || null),
      },
      {
        name: 'recent',
        cap: caps.recent ?? 1200,
        keep: 'first',
        items: recentBuilt ? [recentBuilt.header, ...recentBuilt.entries.map((entry) => entry.text)] : [],
      },
      {
        name: 'lore',
        cap: caps.lore,
        keep: 'first',
        items: config.features?.lore !== false ? loreItems(input.loreEntries, history, null, labels, config.lore, nameOf) : [],
      },
    ],
    limit,
    cost,
  );

  // `<recent>` as one piece: the header, then the entries kept, oldest first; the header alone is no block.
  let recentText = '';
  if (recentBuilt && kept.recent.length >= 2 && kept.recent[0] === recentBuilt.header) {
    const keptTexts = new Set(kept.recent.slice(1));
    const shown = recentBuilt.entries.filter((entry) => keptTexts.has(entry.text)).sort((a, b) => a.at - b.at);
    recentText = [recentBuilt.header, ...shown.map((entry) => entry.text)].join('\n');
  }
  const user = [
    block('now', nowText),
    block('server', kept.server.join('\n\n')),
    block('about_chat', kept.aboutChat.join('\n')),
    block('recent', recentText),
    block('lore', kept.lore.join('\n\n')),
    block('world', kept.world.join('\n')),
    block('diary', kept.diary.length > 0 ? [diaryIntro, ...kept.diary].filter(Boolean).join('\n') : ''),
    block('kinds', kindsText),
    block('seeds', seedsText),
    block('topic', topicText),
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stats: { ...stats, used, limit },
  };
}
