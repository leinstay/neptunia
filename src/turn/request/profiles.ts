// One member as the request shows them: the durable profile of `<people>` (names, aliases, avatar, interests,
// details, the relationship and the remembered moments, with the unsure, stale and replaced-claim marks), the
// `<attitudes>` list, and what is current about a member for their `<people_now>` entry. The people blocks
// (src/turn/request/people.ts) and the memory session (src/memory/db/session.js, through renderProfile) call them.

import { fill } from '../../format.js';
import {
  affinityBand,
  isConfirmed,
  isOpen,
  isStale,
  normalizeAvatar,
  rankAddressed,
  roundScore,
  sortEpisodesForDisplay,
  strongestMoves,
  topEpisodes,
} from '../../memory/index.js';
import { topByRank } from '../../memory/ranking.js';
import { foldText, memberIdOf } from '../../memory/recent.js';
import { DAY_MS, zonedDay } from '../../time.js';
import { fieldLine } from '../../behavior/around.js';
import { noteItems } from './reads.ts';
import { resolveChatText } from './text.ts';
import type {
  Affinity,
  Alias,
  Claim,
  Cost,
  Detail,
  Episode,
  Interest,
  Labels,
  LabelGroup,
  MemoryRead,
  Move,
  NameOf,
  Profile,
} from './types.ts';

/** The validity a claim list renders with: the profile's closed claims, the day it is rendered on and their window. */
type Validity = { closed?: unknown; now?: number; shownDays?: number };

/** A list's validity with its kind and how one of its closed claims renders. */
type ValidityOf<T> = Validity & { kind: string; renderClosed: (item: T) => string };

/** The unsure and stale marks of a claim, the fading of its rank, the names and the collector it renders with. */
type Marks = {
  confirmAfter?: number;
  staleDays?: number;
  now?: number;
  stale?: boolean;
  interestHalfLifeDays?: number;
  detailHalfLifeDays?: number;
  nameOf?: NameOf;
  validity?: Validity;
  reads?: Array<MemoryRead>;
};

/** Which of a member's episodes a profile shows: all, the top `max`, and the room they may take. */
export type EpisodeOptions = { enabled: boolean; max?: number; cap?: number; cost?: Cost };

/** How renderProfileShown renders a profile (see renderProfile). */
export type ShowOptions = {
  interlocutor?: boolean;
  compact?: boolean;
  handle?: string | null;
  relationships?: boolean;
  episodes?: EpisodeOptions;
  maxInterests?: number;
  maxDetails?: number;
  maxAliases?: number;
  aliasHalfLifeDays?: number;
  addressHalfLifeDays?: number;
  interestHalfLifeDays?: number;
  detailHalfLifeDays?: number;
  confirmAfter?: number;
  staleDays?: number;
  now?: number;
  nameOf?: NameOf;
  supersededShownDays?: number;
  avatars?: boolean;
};

/** A profile's text, how many of its episodes it shows and what it carried from memory. */
export type Shown = { text: string; episodes: number; reads: Array<MemoryRead> };

/** `value` when it is a finite number, else `fallback`. */
const finiteOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

/** topByRank over typed items: it keeps the items it is given, in rank order, and returns them as plain objects. */
const ranked = <T extends object>(items: Array<T>, n: number | undefined, halfLifeDays: number | undefined): Array<T> =>
  topByRank(items, n, halfLifeDays) as Array<T>;

/** sortEpisodesForDisplay over a profile's episodes: the same episodes, heaviest then newest. */
const displayOrder = (episodes: Array<Episode>): Array<Episode> => sortEpisodesForDisplay(episodes) as Array<Episode>;

/** The stored profiles of a list as given: an array of profiles, anything else none. */
const profilesOf = (profiles: unknown): Array<Profile | null | undefined> =>
  // A caller's profile list (store.listUserProfiles), read loosely like any stored list.
  Array.isArray(profiles) ? (profiles as Array<Profile | null | undefined>) : [];

/**
 * A member's remembered episodes (the interlocutor's, or the top few of a
 * member asked about) as `[heading, ...oneLinePerEpisode]`,
 * heaviest weight first then newest (see sortEpisodesForDisplay). `[]` when
 * there is nothing to show, or when `labels.profile` lacks any of
 * `episodes`/`episode`/`episodeNoQuote` — an older labels.json simply never
 * renders this, see docs/prompt-contract.md.
 */
function episodeLines(episodes: unknown, labels: Labels, nameOf: NameOf | undefined): Array<string> {
  const p = labels.profile;
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  if (!p.episodes || !p.episode || !p.episodeNoQuote) return [];
  const lines = displayOrder(episodes as Array<Episode>).map((ep) =>
    fill(ep.quote ? p.episode : p.episodeNoQuote, {
      date: ep.date,
      what: resolveChatText(ep.what, nameOf),
      quote: ep.quote,
      feeling: resolveChatText(ep.feeling, nameOf),
    })
  );
  return [p.episodes, ...lines];
}

/**
 * Keep `lines[0]` (the episodes heading) plus as many of the following lines
 * (already ordered heaviest-first) as fit `remaining` tokens, each priced by
 * `cost` -- the lightest ones are dropped first simply because they sort
 * last. `[]` when even the heading does not fit.
 */
function fitEpisodeLines(lines: Array<string>, remaining: number, cost: Cost): Array<string> {
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
 */
function markConfirmation(text: string, item: Claim, p: LabelGroup, marks: Marks | undefined): string {
  let out = text;
  if (typeof marks?.confirmAfter === 'number' && !isConfirmed(item, marks.confirmAfter) && p.unsureMark) {
    out += p.unsureMark;
  }
  if (
    marks?.stale !== false &&
    typeof marks?.staleDays === 'number' &&
    isStale(item, marks.now ?? Date.now(), marks.staleDays) &&
    p.staleMark
  ) {
    out += p.staleMark;
  }
  return out;
}

/** `memory.supersededShownDays` when it is missing (config.json carries the same). */
const DEFAULT_SUPERSEDED_SHOWN_DAYS = 7;

/** The day a claim is dated by in `<people>`: its `validFrom`, else the day of its `recordedAt`, else of its `firstSeen`; '' when none. */
function claimDay(item: Claim): string {
  if (typeof item?.validFrom === 'string' && item.validFrom) return item.validFrom;
  for (const key of ['recordedAt', 'firstSeen'] as const) {
    const value = item?.[key];
    if (typeof value === 'string' && value) return value.slice(0, 10);
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
 * `ordered` holds the items shown, best first; `open` every open item of the list (a conflict partner may rank lower).
 */
function validityTexts<T extends Claim>(
  ordered: Array<T>,
  open: Array<T>,
  render: (item: T) => string,
  p: LabelGroup,
  validity: ValidityOf<T>
): Array<string> {
  // `profile.closed` as stored: the closed claims of every kind, read loosely like any stored list.
  const stored = (Array.isArray(validity.closed) ? validity.closed : []) as Array<T | null | undefined>;
  const closed = stored.filter(
    (item): item is T => item?.kind === validity.kind && typeof item.supersededBy === 'string'
  );
  const shownDays = finiteOr(validity.shownDays, DEFAULT_SUPERSEDED_SHOWN_DAYS);
  const nowMs = finiteOr(validity.now, Date.now());
  const withBefore = (item: T) => {
    const text = render(item);
    if (!p.before || closed.length === 0 || typeof item.itemId !== 'string') return text;
    const recordedMs = Date.parse(item.recordedAt ?? '');
    if (!Number.isFinite(recordedMs) || nowMs - recordedMs > shownDays * DAY_MS) return text;
    const before = closed
      .filter((old) => old.supersededBy === item.itemId)
      .map((old) => fill(p.before, { text: validity.renderClosed(old) }));
    return before.length > 0 ? [text, ...before].join(' ') : text;
  };
  const done = new Set<T>();
  const out: Array<string> = [];
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
function renderInterestItem(item: Interest, p: LabelGroup, marks: Marks | undefined): string {
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
function interestsText(
  interests: Array<Interest> | undefined,
  labels: Labels,
  maxInterests: number | undefined,
  marks: Marks
): string {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  const open = interests.filter(isOpen);
  const ordered = ranked(open, maxInterests, marks?.interestHalfLifeDays);
  noteItems(marks?.reads, 'claim', ordered);
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
function detailsText(
  details: Array<Detail> | undefined,
  labels: Labels,
  maxDetails: number | undefined,
  marks: Marks
): string {
  if (!Array.isArray(details) || details.length === 0) return '';
  const p = labels.profile;
  const open = details.filter(isOpen);
  const ordered = ranked(open, maxDetails, marks?.detailHalfLifeDays);
  noteItems(marks?.reads, 'claim', ordered);
  return validityTexts(
    ordered,
    open,
    (item) => markConfirmation(resolveChatText(item.text, marks?.nameOf) ?? '', item, p, { ...marks, stale: false }),
    p,
    {
      ...marks?.validity,
      kind: 'detail',
      renderClosed: (item) => resolveChatText(item.text, marks?.nameOf) ?? '',
    }
  ).join('; ');
}

/**
 * The compact `<people>` interests line's `{text}`: just the top 5
 * stored interests BY RANK (see `interestsText` above), bare topics only --
 * no note, no unsure/stale marks. `''` when there is nothing to show. The 5
 * cap is fixed in code, not `maxInterests` -- a compact profile is meant to
 * cost a fraction of a full one regardless of how many interests are
 * configured to show for the interlocutor.
 */
function compactInterestsText(
  interests: Array<Interest> | undefined,
  labels: Labels,
  halfLifeDays: number | undefined,
  reads: Array<MemoryRead> | null = null
): string {
  if (!Array.isArray(interests) || interests.length === 0) return '';
  const top = ranked(interests.filter(isOpen), 5, halfLifeDays);
  noteItems(reads, 'claim', top);
  return top.map((item) => item.topic).join('; ');
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
function aliasesText(
  aliases: Array<Alias> | undefined,
  labels: Labels,
  maxAliases: number | undefined,
  aliasHalfLifeDays: number | undefined,
  validity: Validity,
  listed: Set<string> | null = null,
  reads: Array<MemoryRead> | null = null
): string {
  if (!labels.profile?.aliases) return '';
  if (!Array.isArray(aliases) || aliases.length === 0) return '';
  const open = aliases.filter(isOpen);
  const shown = listed ? open.filter((item) => !listed.has(foldText(item.name))) : open;
  const ordered = ranked(shown, maxAliases, aliasHalfLifeDays);
  noteItems(reads, 'claim', ordered);
  return validityTexts(ordered, open, (item) => item.name, labels.profile, {
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
 */
function nameLines(
  profile: Profile,
  labels: Labels,
  {
    maxAliases,
    aliasHalfLifeDays,
    addressHalfLifeDays,
    validity,
    now,
    reads = null,
  }: {
    maxAliases: number | undefined;
    aliasHalfLifeDays: number | undefined;
    addressHalfLifeDays: number | undefined;
    validity: Validity;
    now: number;
    reads?: Array<MemoryRead> | null;
  }
): Array<string> {
  const p = labels.profile;
  const lines: Array<string> = [];
  const addressed = p.addressed
    ? rankAddressed(profile.addressedAs, Number.isFinite(now) ? now : Date.now(), addressHalfLifeDays).slice(
        0,
        ADDRESSED_SHOWN
      )
    : [];
  if (addressed.length > 0) lines.push(fill(p.addressed, { text: addressed.join(', ') }));
  const listed = addressed.length > 0 ? new Set(addressed.map((name) => foldText(name))) : null;
  const aliasesLine = aliasesText(profile.aliases, labels, maxAliases, aliasHalfLifeDays, validity, listed, reads);
  if (aliasesLine) lines.push(fill(p.aliases, { text: aliasesLine }));
  const realName = profile.realName;
  if (p.realName && typeof realName?.name === 'string' && realName.name) {
    const item: Alias = { name: realName.name, itemId: realName.itemId, recordedAt: realName.recordedAt };
    const [text] = validityTexts([item], [item], (claim) => claim.name, p, {
      ...validity,
      kind: 'realName',
      renderClosed: (claim) => claim.name,
    });
    lines.push(fill(p.realName, { text }));
  }
  return lines;
}

/**
 * A profile's avatar line (`features.avatars`, src/memory/avatars.js): `labels.profile.avatar`
 * (`{text}`) for a described avatar, `labels.profile.avatarDefault` for the platform's default one.
 * '' when nothing valid is stored or the label is missing. Changes only when the avatar does.
 */
function avatarLine(stored: unknown, p: LabelGroup): string {
  const avatar = normalizeAvatar(stored);
  if (!avatar) return '';
  // normalizeAvatar's default form carries `default: true` and no text.
  if ('default' in avatar) return typeof p?.avatarDefault === 'string' ? p.avatarDefault : '';
  return p?.avatar ? fill(p.avatar, { text: avatar.text }) : '';
}

/**
 * The moves behind an attitude, one `labels.peopleNow.move` phrase each
 * (`{delta}` the move's `delta` as a signed integer, `{date}` its `YYYY-MM-DD`
 * in `timezone`, `{reason}` with `<@id>` tokens resolved): up to `max` of
 * `affinity.history`, chosen by src/memory/affinity.js#strongestMoves (the
 * strongest, both signs when there are both, never the reason the attitude
 * part already shows), oldest first. `[]` when the label is missing.
 */
function moveParts(
  affinity: Affinity,
  labels: Labels,
  { max, timezone, nameOf }: { max: number; timezone: string | undefined; nameOf: NameOf | undefined }
): Array<string> {
  const label = labels.peopleNow?.move;
  if (!label) return [];
  // strongestMoves keeps moves of `affinity.history`, which it returns as plain objects.
  const moves = strongestMoves(affinity.history, { max, currentReason: affinity.reason }) as Array<Move>;
  return moves.map((move) => {
    const delta = Math.round(move.delta !== undefined && Number.isFinite(move.delta) ? move.delta : move.appliedDelta);
    return fill(label, {
      delta: delta > 0 ? `+${delta}` : String(delta),
      date: zonedDay(Date.parse(move.ts), timezone),
      reason: resolveChatText(move.reason.trim(), nameOf),
    });
  });
}

/**
 * One person's DURABLE memory as prompt text (the `<people>` form, see docs/prompt-contract.md,
 * "<people>"): '' when nothing has been learned yet. What changes from turn to turn -- the
 * attitude with its moves, the message count, whether this person is the one talking to the
 * persona, the live snapshot -- is never here: it is the person's `<people_now>` entry
 * (`profileStateFields`). So the text depends on stored values only, and
 * on the clock only by the day: the stale and replaced-claim marks and the order of the names
 * people use read `opts.now` cut to the start of its UTC day (`profileDay`), the ranks of
 * interests, details and aliases use absolute dates (src/memory/ranking.js#rank), and no age is
 * relative. The interlocutor's copy sits in a cached part of the request and must stay
 * byte-identical while the same member talks to the persona.
 *
 * `opts.handle` (the member's mention handle, src/behavior/handles.js, without the `@`; omitted
 * or null: none) follows the name on the heading as `(@handle)`: the same token `<directory>`
 * lists and the person's `<people_now>` entry starts with, so the three join by it.
 *
 * A profile with no durable content is still shown (the heading alone) when
 * `opts.relationships` is on and it carries a non-neutral attitude (non-zero
 * score or a non-empty reason): its entry says how the persona feels.
 *
 * For the interlocutor (`interlocutor: true`), right after the heading,
 * `opts.episodes.enabled` additionally renders the caller's remembered episodes -- see
 * docs/prompt-contract.md, "<people>". Anyone else (a member the persona is
 * asked about) gets them in the same place only with `opts.episodes.max` a
 * positive integer, and then only the top `max` (src/memory/episodes.js#topEpisodes,
 * heaviest then newest); `max` never caps the interlocutor. Such a profile
 * with nothing else learned is shown by its episodes alone (no
 * `labels.profile.unknown` line). The interlocutor with no durable content gets
 * `labels.profile.unknown`. `opts.episodes.cap`/`.cost`
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
 * (as stored) and the top 5 interests (bare topics, no
 * note) -- no former names, no `style`, no `details`, no `relationship`,
 * no episodes even for the interlocutor. Never passed
 * alongside `interlocutor: true` in practice (the interlocutor is always
 * rendered in full), but `compact` wins over `interlocutor` for episodes
 * either way.
 *
 * Interests, details and aliases show open items only (`validTo` unset); the
 * profile's `closed` claims and conflict sets render as `validityTexts` says,
 * `opts.supersededShownDays` (`memory.supersededShownDays`, 7 when missing) the
 * window a closed claim rides on its successor.
 */
export function renderProfile(profile: Profile | null | undefined, labels: Labels, opts?: ShowOptions): string {
  return renderProfileShown(profile, labels, opts).text;
}

/**
 * The `<attitudes>` block's one item: `labels.attitudes.header`, then one
 * `labels.attitudes.line` per member (`{name}` = the stored `names[0]`,
 * `{band}` = `labels.affinity.bands[affinityBand(score)]`, as the attitude
 * of a `<people_now>` entry shows it) -- the `max` members of `profiles` with the
 * largest `|affinity.score|`, warm and cool alike, rendered by the signed score
 * descending (warmest first, coolest last). A profile is skipped when its score
 * is not a finite number or is 0, its id is in `skipIds` (the interlocutor and
 * the members `<people>` shows) or was already taken, it has no name, or its
 * band has no label. Equal `|score|` keeps the input order. No score, no
 * reason. '' when `max` is not a positive integer, a label is missing or no
 * member is left, so the block drops out.
 * `profiles` are the public member profiles (store.listUserProfiles).
 */
export function renderAttitudes(
  profiles: unknown,
  labels: Labels,
  { max, skipIds }: { max: number; skipIds: Set<string> }
): string {
  const header = labels.attitudes?.header;
  const line = labels.attitudes?.line;
  const bands = labels.affinity?.bands;
  if (!header || !line || !bands || !Number.isInteger(max) || max <= 0) return '';
  const taken = new Set<string>();
  const candidates: Array<{ score: number; text: string }> = [];
  for (const profile of profilesOf(profiles)) {
    const id = memberIdOf(profile?.id);
    const score = profile?.affinity?.score;
    const name = profile?.names?.[0];
    if (id === null || skipIds.has(id) || taken.has(id)) continue;
    if (typeof score !== 'number' || !Number.isFinite(score) || score === 0 || typeof name !== 'string' || !name)
      continue;
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
 * A member's message count as their `<people_now>` entry shows it: rounded down to a multiple of
 * 10 from 10 up to 100 and of 100 from 100 up -- a rough figure, not a running tally; a count
 * below 10 as it is. 0 for anything that is not a positive number. Pure.
 * `count` is `profile.messageCount`.
 */
function roundedMessageCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 0;
  if (count < 10) return Math.floor(count);
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
 * `reads` holds the items the text carries from memory (the collector, see `noteItems`).
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function renderProfileShown(
  profile: Profile | null | undefined,
  labels: Labels,
  {
    interlocutor = false,
    compact = false,
    handle = null,
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
    supersededShownDays,
    avatars = false,
  }: ShowOptions = {}
): Shown {
  if (!profile) return { text: '', episodes: 0, reads: [] };
  const p = labels.profile;
  const name = profile.names?.[0] ?? profile.id;
  // The clock by the day only: the profile text must not change within a day.
  const day = profileDay(now);
  const validity = { closed: profile.closed, now: day, shownDays: supersededShownDays };
  // What this rendering carried from memory (the collector, see noteItems).
  const reads: Array<MemoryRead> = [];
  const marks: Marks = {
    confirmAfter,
    staleDays,
    now: day,
    interestHalfLifeDays,
    detailHalfLifeDays,
    nameOf,
    validity,
    reads,
  };

  const restLines: Array<string> = [];
  if (!compact && profile.names && profile.names.length > 1)
    restLines.push(fill(p.formerNames, { names: profile.names.slice(1).join(', ') }));
  restLines.push(
    ...nameLines(profile, labels, { maxAliases, aliasHalfLifeDays, addressHalfLifeDays, validity, now: day, reads })
  );
  // What their avatar looks like (`features.avatars`): shown, but not something learned about them.
  const avatarText = avatars ? avatarLine(profile.avatar, p) : '';
  if (avatarText) restLines.push(avatarText);
  if (profile.character) restLines.push(fill(p.character, { text: resolveChatText(profile.character, nameOf) }));
  const interestsLine = compact
    ? compactInterestsText(profile.interests, labels, interestHalfLifeDays, reads)
    : interestsText(profile.interests, labels, maxInterests, marks);
  if (interestsLine) restLines.push(fill(p.interests, { text: interestsLine }));
  if (!compact && profile.style) restLines.push(fill(p.style, { text: resolveChatText(profile.style, nameOf) }));
  const detailsLine = compact ? '' : detailsText(profile.details, labels, maxDetails, marks);
  if (detailsLine) restLines.push(fill(p.details, { text: detailsLine }));
  if (!compact && profile.relationship)
    restLines.push(fill(p.relationship, { text: resolveChatText(profile.relationship, nameOf) }));
  const hasContent = restLines.length > (avatarText ? 1 : 0);
  // Every episode for the interlocutor; the top `episodes.max` for a member asked about.
  const showEpisodes =
    !compact && episodes?.enabled && (interlocutor || (Number.isInteger(episodes.max) && (episodes.max ?? 0) > 0));
  const episodeSource: Array<Episode> | undefined = showEpisodes
    ? interlocutor
      ? profile.episodes
      : // topEpisodes keeps the profile's own episodes, which it returns as plain objects.
        (topEpisodes(profile.episodes, episodes.max ?? 0) as Array<Episode>)
    : [];
  let renderedEpisodes = showEpisodes ? episodeLines(episodeSource, labels, nameOf) : [];
  if (!hasContent && interlocutor) restLines.push(p.unknown);

  // The mention handle joins the profile with its `<directory>` line and `<people_now>` entry.
  const heading = handle ? `## ${name} (@${handle})` : `## ${name}`;

  if (renderedEpisodes.length && typeof episodes?.cap === 'number' && typeof episodes.cost === 'function') {
    const restText = [heading, ...restLines].join('\n');
    renderedEpisodes = fitEpisodeLines(renderedEpisodes, episodes.cap - episodes.cost(restText), episodes.cost);
    // A member asked about never shows the episodes heading with no episode under it.
    if (!interlocutor && renderedEpisodes.length < 2) renderedEpisodes = [];
  }
  // Anyone but the interlocutor with nothing learned, no attitude and no moment shown (none, or
  // none fit): nothing to show. With an attitude alone the heading stands for the entry.
  if (!hasContent && !interlocutor && renderedEpisodes.length === 0 && !hasAttitude(profile, relationships))
    return { text: '', episodes: 0, reads: [] };

  // The episodes heading, then one line per episode.
  const shownEpisodes = Math.max(0, renderedEpisodes.length - 1);
  if (shownEpisodes > 0) noteItems(reads, 'episode', displayOrder(episodeSource ?? []).slice(0, shownEpisodes));
  return { text: [heading, ...renderedEpisodes, ...restLines].join('\n'), episodes: shownEpisodes, reads };
}

/**
 * The start of `now`'s UTC day (`Date.now()` when `now` is not a number): the one clock a
 * profile's text reads, so it stays the same all day long.
 */
function profileDay(now: number | undefined): number {
  const ms = finiteOr(now, Date.now());
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Whether `relationships` is on and `profile` carries a non-neutral attitude (a non-zero score or a reason). */
function hasAttitude(profile: Profile | null | undefined, relationships: boolean): boolean {
  const affinity = profile?.affinity;
  return Boolean(relationships && affinity && (affinity.score !== 0 || Boolean(affinity.reason)));
}

/**
 * What is current about one person in memory, as the field lines of their `<people_now>` entry
 * (src/behavior/around.js#fieldLine), for a profiled person only. With `relationships` on:
 * `attitude`, the attitude through `labels.peopleNow.attitude` (`{score}` rounded, `{band}` from
 * `labels.affinity.bands`, `{reason}` with `<@id>` tokens resolved) when it is non-neutral
 * (`hasAttitude`), else `values.none`; then, with an attitude and `shownMoves` a positive integer
 * (at most 1 for a `compact` profile), `moves`: the moves behind it (`moveParts`) joined by `; `,
 * or `values.none`. Then, for anyone not `compact`, `messages`: the rounded message count
 * (`roundedMessageCount`), or `values.none`. A missing label leaves its line out. `[]` without a
 * profile or labels. Pure.
 */
export function profileStateFields(
  profile: Profile | null | undefined,
  labels: Labels,
  {
    relationships = false,
    shownMoves,
    compact = false,
    timezone,
    nameOf,
  }: {
    relationships?: boolean;
    shownMoves?: number;
    compact?: boolean;
    timezone?: string;
    nameOf?: NameOf;
  } = {}
): Array<string> {
  const n = labels?.peopleNow;
  if (!profile || !n) return [];
  const none = n.values?.none ?? '';
  const lines: Array<string> = [];
  if (relationships) {
    const affinity = profile.affinity;
    const shown = hasAttitude(profile, relationships);
    const attitude =
      shown && affinity && n.attitude
        ? fill(n.attitude, {
            score: roundScore(affinity.score),
            band: labels.affinity?.bands?.[affinityBand(affinity.score)],
            reason: resolveChatText(affinity.reason, nameOf),
          })
        : none;
    lines.push(fieldLine(labels, 'attitude', attitude));
    const max = compact ? Math.min(shownMoves ?? 0, 1) : shownMoves;
    if (shown && affinity && max !== undefined && Number.isInteger(max) && max > 0) {
      lines.push(fieldLine(labels, 'moves', moveParts(affinity, labels, { max, timezone, nameOf }).join('; ') || none));
    }
  }
  if (!compact) {
    const count = roundedMessageCount(profile.messageCount);
    lines.push(fieldLine(labels, 'messages', count ? String(count) : none));
  }
  return lines.filter(Boolean);
}
