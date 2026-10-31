// The people of a turn's request: who `<people>` shows in full (the members asked about) and in short (the other
// participants), the room the members asked about get for their moments, the `<people_now>` entries that ride on
// their profiles, the people in voice without a profile, and `<attitudes>`. buildRequest (src/behavior/prompt.js)
// calls them.

import { liveFields, liveNotices, personRow, voiceOccupants } from '../../behavior/around.js';
import { fitSections } from '../../llm/budget.js';
import { topEpisodes } from '../../memory/index.js';
import { isWordChar, occursAsWholeWord } from '../../memory/mentions.ts';
import { topByRank } from '../../memory/ranking.js';
import { episodeKey, memberIdOf } from '../../memory/recent.js';
import { profileStateFields, renderAttitudes, renderProfileShown } from './profiles.ts';
import type { EpisodeOptions, Shown } from './profiles.ts';
import type { Base, Room } from './head.ts';
import type { Recent, RecentBuilt } from './memory.ts';
import { pulledAuthors } from './pulled.ts';
import type { PulledFits } from './pulled.ts';
import type { Ahead } from './sections.ts';
import type { Task } from './task.ts';
import type { Alias, Fit, MemoryRead, Message, Profile, RequestInput, Section } from './types.ts';

/** A profile list as given (store.listUserProfiles, the turn's other profiles): an array, anything else none. */
const profileList = (profiles: unknown): Array<Profile | null | undefined> =>
  // A caller's list of stored profiles, read loosely like any stored list.
  Array.isArray(profiles) ? (profiles as Array<Profile | null | undefined>) : [];

/** A profile's id as text, '' without one. */
const idOf = (profile: Profile | null | undefined): string =>
  profile?.id === undefined || profile?.id === null ? '' : String(profile.id);

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
function nameOccurs(haystackLower: string, nameLower: string): boolean {
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
function profileNames(
  profile: Profile | null | undefined,
  maxAliases: number | undefined,
  aliasHalfLifeDays: number | undefined
): Array<string> {
  const names: Array<string> = [];
  if (typeof profile?.names?.[0] === 'string') names.push(profile.names[0]);
  // topByRank keeps the profile's own aliases, which it returns as plain objects.
  for (const alias of topByRank(
    Array.isArray(profile?.aliases) ? profile.aliases : [],
    maxAliases,
    aliasHalfLifeDays
  ) as Array<Alias | null>) {
    if (typeof alias?.name === 'string') names.push(alias.name);
  }
  return names;
}

/**
 * The window that decides who the persona is being asked about (`<people>`
 * priority (b)): the trigger message plus the last `ASKED_ABOUT_SCAN_MESSAGES`
 * messages of `history` (trigger is usually already the newest of those, but
 * is added explicitly in case it is not). Real mention ids
 * (`normalizeMessage`'s `mentionedUserIds`, src/protocol/events.js#Message) are the
 * strongest signal; the plain lower-cased text is the fallback for a name/alias
 * match (`nameOccurs` above).
 */
function askedAboutWindow(
  history: Array<Message>,
  trigger: Message | null | undefined
): { mentionedIds: Set<string>; scanTextLower: string } {
  const recent = history.slice(-ASKED_ABOUT_SCAN_MESSAGES);
  const messages = trigger && !recent.some((m) => m.id === trigger.id) ? [...recent, trigger] : recent;
  const mentionedIds = new Set<string>();
  const texts: Array<string> = [];
  for (const message of messages) {
    for (const id of Array.isArray(message?.mentionedUserIds) ? message.mentionedUserIds : [])
      mentionedIds.add(String(id));
    if (typeof message?.content === 'string' && message.content) texts.push(message.content);
  }
  return { mentionedIds, scanTextLower: texts.join('\n').toLowerCase() };
}

/** Whether `profile` is named/@mentioned in the asked-about window (see `askedAboutWindow`). */
function isAskedAbout(
  profile: Profile,
  mentionedIds: Set<string>,
  scanTextLower: string,
  maxAliases: number | undefined,
  aliasHalfLifeDays: number | undefined
): boolean {
  const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
  if (id && mentionedIds.has(id)) return true;
  return profileNames(profile, maxAliases, aliasHalfLifeDays).some(
    (name) => name.length >= 3 && nameOccurs(scanTextLower, name.toLowerCase())
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
 * `maxAskedAbout` not a non-negative integer is no cap.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function splitPeople(
  otherProfiles: unknown,
  candidateProfiles: unknown,
  history: Array<Message>,
  trigger: Message | null | undefined,
  excludeId: string | number | null | undefined,
  maxAskedAbout: number | undefined,
  maxAliases: number | undefined,
  aliasHalfLifeDays: number | undefined,
  pulledAuthorIds: Array<string> = []
): { askedAbout: Array<Profile>; participants: Array<Profile> } {
  const { mentionedIds, scanTextLower } = askedAboutWindow(history, trigger);
  const cap =
    maxAskedAbout !== undefined && Number.isInteger(maxAskedAbout) && maxAskedAbout >= 0 ? maxAskedAbout : Infinity;
  const covered = new Set<string>();
  if (excludeId !== undefined && excludeId !== null) covered.add(String(excludeId));

  const askedAbout: Array<Profile> = [];
  const participants: Array<Profile> = [];

  for (const profile of profileList(otherProfiles)) {
    const id = idOf(profile);
    if (!profile || !id || covered.has(id)) continue;
    covered.add(id);
    if (askedAbout.length < cap && isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      askedAbout.push(profile);
    } else {
      participants.push(profile);
    }
  }

  for (const profile of profileList(candidateProfiles)) {
    if (askedAbout.length >= cap) break;
    const id = idOf(profile);
    if (!profile || !id || covered.has(id)) continue;
    if (isAskedAbout(profile, mentionedIds, scanTextLower, maxAliases, aliasHalfLifeDays)) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

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
    const profile = profileList(candidateProfiles).find((candidate) => idOf(candidate) === id);
    if (profile) {
      covered.add(id);
      askedAbout.push(profile);
    }
  }

  return { askedAbout, participants };
}

/** The interlocutor's profile and `<people_now>` entry, and the block's lead the fixed part pays for. */
export type InterlocutorBlocks = {
  avatarsOn: boolean;
  interlocutorShown: Shown;
  liveOf: (memberId: string | null) => Array<string>;
  interlocutorRowId: string | null;
  interlocutorRow: string;
  peopleNowHead: string;
  headReserved: boolean;
  peopleNowFixed: string;
};

/**
 * The interlocutor in full (`<people>` of the profiles part), their `<people_now>` entry with its live fields, and
 * the lead and notices of `<people_now>`.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function interlocutorOf(given: RequestInput & Base & Room & Task): InterlocutorBlocks {
  const { config, now, trigger, caps, cost, overheard } = given;
  const { labels, interlocutor, nameOf, timezone, handleFor, relationships, shownMoves, episodesOn } = given;
  const { liveOn, liveSnapshot, voiceChannelNameOf } = given;
  const episodesOpt = { enabled: episodesOn, cap: caps.interlocutor, cost };
  // The avatar line of every profile (features.avatars, exactly true: a paid `vision` request writes it).
  const avatarsOn = config.features?.avatars === true;
  const interlocutorShown = renderProfileShown(interlocutor, labels, {
    interlocutor: true,
    handle: handleFor(memberIdOf(interlocutor?.id)),
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
    supersededShownDays: config.memory?.supersededShownDays,
    avatars: avatarsOn,
  });
  // `<people_now>`: one entry per person with what is current about them -- a heading line led
  // by the person's mention handle (the join key with `<people>` and `<directory>`), then one
  // labelled field per line: the live snapshot (`liveOf`), then what memory holds that changes
  // from turn to turn (profileStateFields).
  const liveOf = (memberId: string | null) =>
    liveOn && liveSnapshot && memberId !== null
      ? liveFields(liveSnapshot, memberId, { labels, channelNameOf: voiceChannelNameOf, now })
      : [];
  // The interlocutor's entry, never cut, its heading tagged as the one talking to the persona
  // (on an overheard turn, as overheard): the tag describes the request, so it is never in the
  // cached profile. The trigger's author without a profile has an entry only for its live part.
  const interlocutorRowId = memberIdOf(interlocutor?.id) ?? memberIdOf(trigger?.authorId);
  const interlocutorFields =
    interlocutorRowId === null
      ? []
      : [
          ...liveOf(interlocutorRowId),
          ...profileStateFields(interlocutor, labels, { relationships, shownMoves, timezone, nameOf }),
        ];
  const interlocutorRow =
    interlocutorRowId === null || (!interlocutor && interlocutorFields.length === 0)
      ? ''
      : personRow(
          {
            handle: handleFor(interlocutorRowId),
            name: interlocutor?.names?.[0] ?? trigger?.authorName ?? '',
            mark: (overheard ? labels.peopleNow?.marks?.overheard : labels.peopleNow?.marks?.interlocutor) ?? '',
            fields: interlocutorFields,
          },
          labels
        );
  // The block's lead and notices (a stale snapshot, the presences intent off), rendered only when
  // an entry is shown: paid for with the fixed part when there is an interlocutor entry or a live
  // part (an entry is then all but certain), else after the fit, from what the request has left.
  const peopleNowHead = [labels.peopleNow?.lead ?? '', ...(liveOn ? liveNotices(liveSnapshot, labels) : [])]
    .filter(Boolean)
    .join('\n');
  const headReserved = Boolean(interlocutorRow) || liveOn;
  const peopleNowFixed = [headReserved ? peopleNowHead : '', interlocutorRow].filter(Boolean).join('\n\n');
  return {
    avatarsOn,
    interlocutorShown,
    liveOf,
    interlocutorRowId,
    interlocutorRow,
    peopleNowHead,
    headReserved,
    peopleNowFixed,
  };
}

/** Who `<people>` shows in full and in short, and how many moments each member asked about may show. */
export type AskedAbout = {
  askedAbout: Array<Profile>;
  participants: Array<Profile>;
  askedAboutEpisodes: number;
  episodeCount: (profile: Profile | null | undefined) => number;
  askedEpisodesOn: boolean;
  askedKeys: (counts: Array<number>) => Set<string>;
  askedIntended: Set<string>;
};

/**
 * `<people>` priority (b) and (c): the members the trigger or the last few messages name or mention, then the
 * authors of the pulled lines shown (rendered in full with their top moments), and the other active participants
 * (rendered compact).
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function askedAboutOf(given: RequestInput & Base & PulledFits): AskedAbout {
  const { config, history, trigger, labels, privateChat, interlocutor, episodesOn, pulledFits } = given;
  // <people> priority (b)/(c): who the trigger message / the last few
  // messages name or @mention (askedAbout, rendered FULL with their top
  // episodes, see below) vs. the other active participants (participants,
  // rendered COMPACT) -- see docs/prompt-contract.md, "Aliases". The authors
  // of the pulled lines shown join (b) after them, under the same cap.
  const { askedAbout, participants } = splitPeople(
    given.otherProfiles,
    given.candidateProfiles,
    history,
    trigger,
    interlocutor?.id,
    config.context.askedAboutProfiles,
    config.memory?.maxAliases,
    config.memory?.aliasHalfLifeDays,
    pulledAuthors(pulledFits)
  );
  // Each member asked about shows their top `context.askedAboutEpisodes` episodes (0 = off;
  // none in a private chat: another member's moments never reach it; none with an older labels
  // file that cannot render one).
  const askedAboutEpisodes =
    privateChat && config.features?.privateLikeServer === false ? 0 : (config.context.askedAboutEpisodes ?? 3);
  const episodeCount = (profile: Profile | null | undefined) =>
    Array.isArray(profile?.episodes) ? profile.episodes.length : 0;
  const episodeLabelsOn = Boolean(
    labels.profile?.episodes && labels.profile?.episode && labels.profile?.episodeNoQuote
  );
  const askedEpisodesOn =
    episodesOn &&
    episodeLabelsOn &&
    Number.isInteger(askedAboutEpisodes) &&
    askedAboutEpisodes > 0 &&
    askedAbout.some((profile) => episodeCount(profile) > 0);
  // The keys of the moments `<people>` shows for the members asked about: the top `counts[i]` of each.
  const askedKeys = (counts: Array<number>) =>
    new Set(
      askedAbout.flatMap((profile, i) =>
        topEpisodes(profile.episodes, counts[i]).map((ep) => episodeKey(memberIdOf(profile.id), ep))
      )
    );
  const askedIntended = askedKeys(askedAbout.map(() => (askedEpisodesOn ? askedAboutEpisodes : 0)));
  return { askedAbout, participants, askedAboutEpisodes, episodeCount, askedEpisodesOn, askedKeys, askedIntended };
}

/** The members asked about as placed in `<people>`'s room, and `<recent>` built again when they show fewer moments. */
export type Placed = {
  askedRows: Map<Profile, string>;
  tailRowOf: (profile: Profile | null | undefined, compact: boolean) => string;
  withRow: (text: string, row: string) => string;
  askedAboutItems: Array<string>;
  askedAboutReads: Array<Array<MemoryRead>>;
  askedLeftOut: number;
  recentBuilt: RecentBuilt | null;
  recentSection: Section | null;
  aheadOfPeople: Array<Section>;
};

/**
 * Episodes only fill what `<people>` has left once every member asked about is placed without them, as the budget
 * takes them in order, so no member asked about is ever cut for anyone's episodes; `<recent>` is built again when
 * `<people>` shows fewer moments than it left out.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function placeAskedAbout(
  given: RequestInput & Base & Room & InterlocutorBlocks & AskedAbout & Recent & Ahead
): Placed {
  const { config, now, labels, nameOf, timezone, handleFor, relationships, shownMoves, caps, cost, limit } = given;
  const { avatarsOn, liveOf, askedAbout, askedEpisodesOn, askedAboutEpisodes, episodeCount, askedKeys } = given;
  const { askedIntended, buildRecent, recentSectionOf, recentCap, aheadOfPeopleWith } = given;
  let { recentBuilt, recentSection } = given;
  let aheadOfPeople = aheadOfPeopleWith(recentSection);
  // Episodes only fill what `<people>` has left once every member asked about is placed
  // without them, as the budget takes them in order, so no member asked about is ever cut
  // for anyone's episodes; the earlier members take theirs first, each losing their lightest
  // first. That room is `caps.people`, or less when the sections ahead of `<people>` leave
  // less; measured only when an episode may be shown. The compact participants after them
  // get what is left.
  const peopleRoomCap = caps.people !== undefined && Number.isFinite(caps.people) ? caps.people : Infinity;
  // A tail person's `<people_now>` entry rides on their profile: one budget item, so the entry lives
  // and dies with the profile and is paid for with it (split again after the fit).
  const tailRowOf = (profile: Profile | null | undefined, compact: boolean) => {
    const id = memberIdOf(profile?.id);
    return personRow(
      {
        handle: handleFor(id),
        name: profile?.names?.[0] ?? id ?? '',
        fields: [
          ...liveOf(id),
          ...profileStateFields(profile, labels, { relationships, shownMoves, compact, timezone, nameOf }),
        ],
      },
      labels
    );
  };
  const withRow = (text: string, row: string) => (text && row ? `${text}\n${row}` : text);
  const askedRows = new Map(askedAbout.map((profile) => [profile, tailRowOf(profile, false)]));
  const renderAsked = (profile: Profile, episodes: EpisodeOptions | undefined) => {
    const shown = renderProfileShown(profile, labels, {
      handle: handleFor(memberIdOf(profile?.id)),
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
      supersededShownDays: config.memory?.supersededShownDays,
      avatars: avatarsOn,
    });
    return { ...shown, text: withRow(shown.text, askedRows.get(profile) ?? '') };
  };
  const askedBareShown = askedAbout.map((profile) => renderAsked(profile, undefined));
  const askedAboutBare = askedBareShown.map((shown) => shown.text);
  // What each asked-about rendering carried from memory (the collector), the same index as the items.
  const askedAboutReads = askedBareShown.map((shown) => shown.reads);
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
          askedAboutReads[i] = shown.reads;
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
      recentSection = recentSectionOf(
        recentBuilt,
        Math.min(recentCap, (measured.stats.recent?.used ?? 0) + (free - room))
      );
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
  return {
    askedRows,
    tailRowOf,
    withRow,
    askedAboutItems,
    askedAboutReads,
    askedLeftOut,
    recentBuilt,
    recentSection,
    aheadOfPeople,
  };
}

/** One `<people>` item: the member, their `<people_now>` entry, the profile with the entry under it, and its reads. */
export type PeopleEntry = { profile: Profile; row: string; text: string; reads: Array<MemoryRead> };

/** What `<people>` offers, how its kept items are found again, and the people in voice without a profile. */
export type PeopleOffered = {
  peopleOffered: Array<PeopleEntry>;
  profileTextOf: (entry: PeopleEntry) => string;
  peopleSection: Section;
  keptPeopleEntriesOf: (keptPeople: Array<string>) => Array<PeopleEntry>;
  keptPeopleOf: (keptPeople: Array<string>) => Array<Profile>;
  voiceRows: Array<string>;
};

/**
 * `<people>`'s items, each with the member it renders and their `<people_now>` entry, and the people in voice the
 * request shows no profile for.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function peopleOfferedOf(
  given: RequestInput & Base & Room & InterlocutorBlocks & AskedAbout & Placed
): PeopleOffered {
  const { config, now, labels, nameOf, handleFor, relationships, selfMemberId, caps, avatarsOn } = given;
  const { liveOn, liveSnapshot, voiceChannelNameOf, liveOf, interlocutorRowId } = given;
  const { askedAbout, participants, askedRows, askedAboutItems, askedAboutReads, tailRowOf, withRow } = given;
  // `<people>`'s items, each with the member it renders and their `<people_now>` entry (an empty
  // rendering is no item): the item's text is the profile with the entry under it.
  const peopleOffered = [
    ...askedAbout.map((profile, i) => ({
      profile,
      row: askedRows.get(profile) ?? '',
      text: askedAboutItems[i],
      reads: askedAboutReads[i],
    })),
    ...participants.map((profile) => {
      const row = tailRowOf(profile, true);
      const { text, reads } = renderProfileShown(profile, labels, {
        compact: true,
        handle: handleFor(memberIdOf(profile?.id)),
        relationships,
        maxAliases: config.memory?.maxAliases,
        aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
        addressHalfLifeDays: config.memory?.addressHalfLifeDays,
        interestHalfLifeDays: config.memory?.interestHalfLifeDays,
        confirmAfter: config.memory?.confirmAfter,
        staleDays: config.memory?.interestStaleDays,
        now,
        nameOf,
        avatars: avatarsOn,
      });
      return { profile, row, text: withRow(text, row), reads };
    }),
  ].filter((entry) => entry.text);
  /** An offered item's profile alone, its row taken off. */
  const profileTextOf = (entry: PeopleEntry) =>
    entry.row && entry.text.endsWith(`\n${entry.row}`) ? entry.text.slice(0, -(entry.row.length + 1)) : entry.text;
  const peopleSection: Section = { name: 'people', cap: caps.people, items: peopleOffered.map((entry) => entry.text) };
  // The offered items `<people>` keeps: a subsequence of them, in their order.
  const keptPeopleEntriesOf = (keptPeople: Array<string>) => {
    const shown: Array<PeopleEntry> = [];
    let next = 0;
    for (const entry of peopleOffered) {
      if (next < keptPeople.length && keptPeople[next] === entry.text) {
        shown.push(entry);
        next += 1;
      }
    }
    return shown;
  };
  const keptPeopleOf = (keptPeople: Array<string>) => keptPeopleEntriesOf(keptPeople).map((entry) => entry.profile);
  // The people in voice the request shows no profile for: one `<people_now>` entry each (the
  // live fields alone), the lowest priority of the request, capped by `context.around.maxTokens`.
  // None from a stale snapshot: who sits in voice is not known then.
  const rowIds = new Set(
    [interlocutorRowId, selfMemberId, ...peopleOffered.map((entry) => memberIdOf(entry.profile?.id))].filter(
      (id): id is string => Boolean(id)
    )
  );
  const voiceRows =
    liveOn && liveSnapshot && liveSnapshot.stale !== true
      ? voiceOccupants(liveSnapshot, { excludeIds: rowIds, nameOf, channelNameOf: voiceChannelNameOf })
          .map(({ memberId, name }) =>
            personRow({ handle: handleFor(memberId), name, fields: liveOf(memberId) }, labels)
          )
          .filter(Boolean)
      : [];
  return { peopleOffered, profileTextOf, peopleSection, keptPeopleEntriesOf, keptPeopleOf, voiceRows };
}

/**
 * `<attitudes>`: the top `context.attitudes` members by attitude strength (0 = no block), the interlocutor and the
 * members `<people>` shows left out.
 */
export function attitudesOf(given: RequestInput & Base & Room & Recent & Placed & PeopleOffered): string {
  const { config, labels, relationships, limit, cost, interlocutorId, aheadOfPeople, peopleSection, keptPeopleOf } =
    given;
  const attitudesMax = config.context.attitudes ?? 6;
  const attitudesOn =
    relationships &&
    Number.isInteger(attitudesMax) &&
    attitudesMax > 0 &&
    Boolean(labels.attitudes?.header && labels.attitudes?.line) &&
    Array.isArray(given.candidateProfiles) &&
    given.candidateProfiles.length > 0;
  let attitudesText = '';
  if (attitudesOn) {
    const peopleKept = keptPeopleOf(fitSections([...aheadOfPeople, peopleSection], limit, cost).kept.people);
    const skipIds = new Set(
      [interlocutorId, ...peopleKept.map((profile) => memberIdOf(profile?.id))].filter((id) => id !== null)
    );
    attitudesText = renderAttitudes(given.candidateProfiles, labels, { max: attitudesMax, skipIds });
  }
  return attitudesText;
}

/**
 * `<people>` shows the profiles kept; their rows join the interlocutor's and the voice rows in `<people_now>`, under
 * its lead and notices, paid now when the fixed part did not pay for it. Fills `fit`; the entries kept.
 */
export function keptPeopleNow(fit: Fit, given: Room & InterlocutorBlocks & Placed & PeopleOffered): Array<PeopleEntry> {
  const { kept, stats } = fit;
  let { used } = fit;
  const { limit, cost, interlocutorRow, headReserved, peopleNowHead, askedLeftOut } = given;
  const { keptPeopleEntriesOf, profileTextOf } = given;
  if (askedLeftOut > 0) stats.people = { ...stats.people, dropped: stats.people.dropped + askedLeftOut };
  // `<people>` shows the profiles kept; their rows join the interlocutor's and the voice rows in
  // `<people_now>`, under its lead and notices. No row, no block.
  const keptPeopleEntries = keptPeopleEntriesOf(kept.people ?? []);
  kept.people = keptPeopleEntries.map(profileTextOf);
  let peopleNowRows = [interlocutorRow, ...keptPeopleEntries.map((entry) => entry.row), ...(kept.around ?? [])].filter(
    Boolean
  );
  // A lead the fixed part did not pay for is paid now, from what the request has left; when it
  // does not fit, the rows are left out (the request only gets shorter).
  if (peopleNowRows.length > 0 && !headReserved && peopleNowHead) {
    const price = cost(peopleNowHead);
    if (used + price <= limit) {
      used += price;
      // A budget line of its own: `<people>` stays inside `context.caps.people`.
      stats.peopleNow = { used: price, kept: 1, dropped: 0 };
    } else {
      peopleNowRows = [];
    }
  }
  // A blank line between the people: each entry is a heading and its field lines.
  kept.peopleNow = peopleNowRows.length > 0 ? [[peopleNowHead, ...peopleNowRows].filter(Boolean).join('\n\n')] : [];
  fit.used = used;
  return keptPeopleEntries;
}

/**
 * The members whose profile the request shows: the interlocutor when its block was kept, then the ones `<people>`
 * kept (a subsequence of the offered items, in their order).
 */
export function peopleShownOf(
  kept: Fit['kept'],
  interlocutor: Profile | null | undefined,
  keptPeopleEntries: Array<PeopleEntry>
): Array<{ id: string; names: Array<string> }> {
  const peopleShown: Array<{ id: string; names: Array<string> }> = [];
  const showPerson = (profile: Profile | null | undefined) => {
    const id = memberIdOf(profile?.id);
    const names = Array.isArray(profile?.names) ? profile.names.filter((name) => typeof name === 'string') : [];
    if (id !== null) peopleShown.push({ id, names });
  };
  if ((kept.interlocutor ?? []).length > 0) showPerson(interlocutor);
  for (const entry of keptPeopleEntries) showPerson(entry.profile);
  return peopleShown;
}
