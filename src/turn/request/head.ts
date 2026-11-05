// The stable head of a turn's request: the labels, the clock and the switches it is built under, the merged profile
// of a private chat's partner, the mention and channel handles with their directories, the transcript's options,
// the system prompt and the chat's own lines, and the room the request's sections share. buildRequest
// (src/behavior/prompt.ts) builds it first.

import {
  assignChannelHandles,
  assignHandles,
  channelDirectoryEntries,
  directoryEntries,
  memberNameMap,
  renderChannelDirectory,
  renderDirectory,
} from '../../behavior/handles.ts';
import type { AroundSnapshot } from '../../behavior/around-store.ts';
import { voiceOccupants } from '../../behavior/around.ts';
import { mergeProfiles } from '../../behavior/private.ts';
import { isPlainObject } from '../../config.ts';
import { formatTranscript } from '../../format.ts';
import { requestTokenLimit, sectionCost } from '../../llm/budget.ts';
import { rulesPromptOf } from '../../rules-list.ts';
import { cacheTtlMs } from '../../llm/openrouter.ts';
import { gifHandleMap, normalizeGifs } from '../../memory/index.ts';
import { accountIdOf } from '../../memory/recent.ts';
import { freezePerBucket, gifFieldChars, gifFieldsMap } from './emoji-gifs.ts';
import type { Held, MediaCache } from './emoji-gifs.ts';
import { anchoredOn } from './memory.ts';
import { authorsInView } from './pulled.ts';
import { nowBlock } from './tail.ts';
import { TAG_OVERHEAD, fillPromptTemplate, requireLabels } from './text.ts';
import type {
  Caps,
  Cost,
  EmojiRef,
  FormatOptions,
  Labels,
  Message,
  NameOf,
  Profile,
  RequestInput,
  TranscriptItem,
} from './types.ts';
import { RELATIONSHIP_LIMITS } from '../../memory/text-limits.ts';

/** What the rest of the request is built on: the labels, the switches, the handles, the transcript and the chat. */
export type Base = {
  labels: Labels;
  privateChat: boolean;
  interlocutor: Profile | null | undefined;
  nameOf: NameOf;
  timezone: string;
  frozen: <T>(key: string, signature: string, compute: () => T) => T;
  liveOn: boolean;
  liveSnapshot: AroundSnapshot | null;
  voiceChannelNameOf: ((placeId: string) => string | null) | undefined;
  selfAccountId: string | null;
  handleById: Map<string, string> | null;
  directoryText: string;
  memberNames: Map<string, Array<string>> | null;
  channelHandleById: Map<string, string> | null;
  channelDirectoryText: string;
  handleFor: (accountId: string | null) => string | null;
  nowText: string;
  relationships: boolean;
  shownMoves: number;
  episodesOn: boolean;
  loreOn: boolean;
  gifLibrary: ReturnType<typeof normalizeGifs> | null;
  gifsOn: boolean;
  customEmoji: Array<EmojiRef>;
  formatOptions: FormatOptions;
  system: string;
  anchored: boolean;
  chatItems: Array<TranscriptItem>;
  idByIndex: Map<number, string>;
};

/** The room the request's sections share, its caps and the price of a text. */
export type Room = { caps: Caps; cost: Cost; limit: number };

/**
 * `descriptions` with the cached caption of every custom emoji of `history` it lacks: the turn describes what it gathers,
 * and the cache knows an emoji the turn did not ask about.
 */
function withEmojiCaptions(
  descriptions: Map<string, string> | undefined,
  history: ReadonlyArray<Message>,
  mediaCache: unknown
): Map<string, string> | undefined {
  const cache = mediaCache as MediaCache | null | undefined;
  if (!cache) return descriptions;
  const known = new Map(descriptions ?? []);
  for (const message of history) {
    for (const emoji of [
      ...(message.emojis ?? []),
      ...(message.forwarded ?? []).flatMap((part) => part?.emojis ?? []),
    ]) {
      const key = `emoji:${emoji?.id}`;
      const cached = cache[key];
      if (!known.has(key) && cached && !cached.miss && typeof cached.text === 'string' && cached.text.trim())
        known.set(key, cached.text.trim());
    }
  }
  return known;
}

/** The labels, switches, handles, transcript options, system prompt and chat lines of a request. */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function requestHead(given: RequestInput): Base {
  const { config, prompts, mode, now, selfName, history, neighbors, descriptions, videos, imageAnswers, reads } = given;
  const labels = requireLabels(prompts);
  const privateChat = Boolean(given.privateChat);
  // mergeProfiles lays the private layer over the public profile: the partner's profile, as stored. A partner known only
  // from this DM has no public profile, and the trigger gives the merged one its id and heading.
  const named = given.trigger?.authorName ? [given.trigger.authorName] : [];
  const privateOnly = given.privateProfile && given.trigger ? { id: given.trigger.authorId, names: named } : null;
  const merged = (): Profile | null =>
    mergeProfiles(
      (given.interlocutor ?? privateOnly) as Profile | null,
      given.privateProfile as object | null | undefined
    ) as Profile | null;
  const interlocutor = privateChat ? merged() : given.interlocutor;
  // The caller's resolver of a member id to a name.
  const nameOf: NameOf = typeof given.nameOf === 'function' ? (given.nameOf as NameOf) : () => null;
  const { timezone } = config.bot;
  // What memory changes inside the stable part (`<self_facts>`) is held for one cache
  // TTL bucket while the prompt cache is on (freezePerBucket): a memory batch or the persona's
  // GIF post rewrites the cached prefix at most once per bucket.
  const stableFreeze =
    given.stableFreeze instanceof Map
      ? // The caller's holder of what freezePerBucket keeps for this request.
        (given.stableFreeze as Map<string, Held<unknown>>)
      : null;
  const frozen = <T>(key: string, signature: string, compute: () => T): T =>
    freezePerBucket(stableFreeze, key, { now, bucketMs: cacheTtlMs(config), signature }, compute);
  // Mention handles: every member with a
  // stored profile gets one in `<directory>` (the stable part), the authors in view on their lines.
  const handlesOn = true;
  // `<people_now>`'s live part: the snapshot of
  // the gateway's voice states and presences, never in a private chat or a diary post.
  // The live glance as the turn hands it: checked to be an object with a snapshot below.
  const aroundInput = given.around as
    { snapshot?: AroundSnapshot | null; channelNameOf?: (placeId: string) => string | null } | null | undefined;
  const liveOn =
    !privateChat &&
    mode !== 'diary' &&
    isPlainObject(aroundInput) &&
    Boolean(aroundInput?.snapshot) &&
    Boolean(labels.peopleNow);
  // liveOn holds only for an object with a snapshot.
  const liveSnapshot = liveOn ? aroundInput!.snapshot! : null;
  const voiceChannelNameOf = liveOn ? aroundInput!.channelNameOf : undefined;
  const selfAccountId = accountIdOf(given.selfId);
  // Everyone in a voice channel the audience may see, the persona aside: each gets a handle, so
  // their `<people_now>` entry joins by it like everyone's.
  const inVoice =
    liveOn && liveSnapshot
      ? voiceOccupants(liveSnapshot, {
          excludeIds: new Set([selfAccountId].filter((id): id is string => Boolean(id))),
          nameOf,
          channelNameOf: voiceChannelNameOf,
        }).map((occupant) => occupant.accountId)
      : [];
  const directory = handlesOn
    ? // The served place's stored profiles, as the store lists them.
      directoryEntries((given.candidateProfiles ?? []) as Iterable<object>, { selfId: given.selfId ?? null })
    : [];
  // The interlocutor and the other people a profile is offered for are in view too, so every
  // `<people_now>` entry has a handle even for a member the directory does not list.
  const offeredIds = [
    interlocutor?.id,
    ...(Array.isArray(given.otherProfiles)
      ? (given.otherProfiles as Array<Profile | null | undefined>).map((profile) => profile?.id)
      : []),
  ]
    .map(accountIdOf)
    .filter((id): id is string => Boolean(id));
  const handleById = handlesOn
    ? assignHandles({
        profiled: directory.map((entry) => entry.id),
        inView: [...authorsInView(history, privateChat ? [] : [given.pulled, neighbors]), ...offeredIds, ...inVoice],
      })
    : null;
  const directoryText = handleById ? renderDirectory(directory, handleById, labels) : '';
  // The names each member in view goes by (the directory's, the lines' authors and mentioned members): a mention reads
  // as its handle in the transcript, and a tag of hers that names one without the handle is marked (transcript.untagged).
  const memberNames = handleById
    ? memberNameMap(
        directory,
        [
          history,
          ...(privateChat
            ? []
            : [given.pulled, neighbors].flatMap((source) =>
                // The pulled channels and the neighbours as given: lists of entries with their messages.
                (Array.isArray(source) ? (source as Array<{ messages?: Array<Message> } | null | undefined>) : []).map(
                  (entry) => entry?.messages
                )
              )),
        ]
          .flat()
          .filter((message): message is Message => Boolean(message))
      )
    : null;
  // Channel handles (features.mentionHandles too): each text channel the persona can read
  // (`channelDirectory`) gets one, listed in `<channel_directory>` (the stable part) and shown
  // beside every channel a line mentions.
  const channelEntries = handlesOn ? channelDirectoryEntries(given.channelDirectory ?? []) : [];
  const channelHandleById =
    channelEntries.length > 0 ? assignChannelHandles(channelEntries.map((entry) => entry.id)) : null;
  const channelDirectoryText = channelHandleById
    ? renderChannelDirectory(channelEntries, channelHandleById, labels)
    : '';
  // A member's handle in this request (null with the switch off or none given): on their profile
  // heading and at the start of their `<people_now>` entry, as `<directory>` lists it.
  const handleFor = (accountId: string | null) =>
    accountId !== null && handleById ? (handleById.get(accountId) ?? null) : null;
  // `<now>`: the clock, then the persona's recent time away.
  const nowText = nowBlock(now, timezone, labels, given.offPeriods);
  const relationships = true;
  // How many attitude moves follow the attitude in a `<people_now>` entry (profileStateFields).
  const shownMoves = RELATIONSHIP_LIMITS.shownMoves;
  const episodesOn = true;
  const loreOn = true;
  // The GIF library, for the handles of the transcript: at least one entry.
  const gifLibrary = given.gifs ? normalizeGifs(given.gifs) : null;
  const gifsOn = gifLibrary !== null && Object.keys(gifLibrary.entries).length > 0;
  // The server's custom emoji: the switch (a missing key counts as on) and a non-empty index.
  const customEmoji: Array<EmojiRef> = Array.isArray(given.customEmoji)
    ? // The emoji index's list as the turn hands it (src/behavior/emoji-index.ts).
      (given.customEmoji as Array<EmojiRef>)
    : [];
  // A custom emoji of the transcript carries its description in the line: the persona's turn lists no emoji.
  const described = withEmojiCaptions(descriptions, history, given.mediaCache);
  const formatOptions = {
    timezone,
    selfName,
    labels,
    // An old line carries its age against the same clock as `<now>` and `<tempo>`: the chat,
    // neighbour and pulled channels alike.
    now,
    seeReactions: true,
    // Who reacted to the persona's own lines, named like authors.
    reactionNames: true,
    descriptions: described,
    videos,
    reads,
    // A picture's second look on a question renders under its tag.
    imageAnswers,
    // Each author in view carries their mention handle (transcript.author).
    handles: handleById ?? undefined,
    memberNames: memberNames ?? undefined,
    // A message link to a line of the same rendering reads as its `#n`.
    messageNumbers: true,
    // Each channel a line mentions carries its handle (transcript.channel).
    channels: channelHandleById
      ? new Map(
          // assignChannelHandles gives every channel of the directory its handle.
          channelEntries.map((entry) => [entry.id, { handle: channelHandleById.get(entry.id)!, name: entry.name }])
        )
      : undefined,
    // A GIF the library knows carries its handle in the transcript.
    gifHandles: gifsOn ? gifHandleMap(gifLibrary) : undefined,
    // ...and its three caption fields, cut for display (transcript.gifKnownFields).
    gifFields:
      gifsOn && labels.transcript?.gifKnownFields && given.mediaCache
        ? gifFieldsMap(given.mediaCache, gifFieldChars())
        : undefined,
  };

  const nameFill = (text: unknown) => fillPromptTemplate(text, { name: selfName });
  const formatFill = nameFill;
  const system = [
    nameFill(prompts['system-prompt']),
    nameFill(prompts['character-card']),
    nameFill(rulesPromptOf(prompts.rules)),
    formatFill(prompts.format),
  ]
    .filter(Boolean)
    .join('\n\n');
  // The anchored window: the reply parents leave `<chat>` for
  // `<earlier>` but keep their numbers, so a reply marker or a link in the chat still names them.
  const anchored = anchoredOn(config, labels, privateChat);
  const chatOptions = anchored
    ? // formatTranscript hands back the messages of `history`.
      { ...formatOptions, skip: (message: object) => (message as Message).replyParent === true }
    : formatOptions;
  const chatItems = formatTranscript(history, chatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));
  if (anchored) history.forEach((message, i) => message.replyParent === true && idByIndex.set(i + 1, message.id));
  return {
    labels,
    privateChat,
    interlocutor,
    nameOf,
    timezone,
    frozen,
    liveOn,
    liveSnapshot,
    voiceChannelNameOf,
    selfAccountId,
    handleById,
    directoryText,
    memberNames,
    channelHandleById,
    channelDirectoryText,
    handleFor,
    nowText,
    relationships,
    shownMoves,
    episodesOn,
    loreOn,
    gifLibrary,
    gifsOn,
    customEmoji,
    formatOptions,
    system,
    anchored,
    chatItems,
    idByIndex,
  };
}

/** The room the sections share: the cap less the tags, the tools field and the step reserve. */
export function requestRoom(given: RequestInput): Room {
  const { config, calibrator } = given;
  const caps = config.context.caps;
  const cost = sectionCost(calibrator);
  // The room the sections share: the cap less the tag overhead, what the request's tools field costs (native) and,
  // when tools are exposed on either transport, the step reserve (`tools.loop.stepReserveTokens`): the room the
  // continuation request after a call needs for her answer, the results and the note.
  const tokensGiven = given.toolsTokens;
  const toolsTokens =
    typeof tokensGiven === 'number' && Number.isFinite(tokensGiven) && tokensGiven > 0 ? Math.floor(tokensGiven) : 0;
  const toolsExposed = toolsTokens > 0 || (typeof given.toolsBlock === 'string' && given.toolsBlock.trim() !== '');
  const reserveRaw = config.tools?.loop?.stepReserveTokens;
  const stepReserve =
    toolsExposed && reserveRaw !== undefined && Number.isFinite(reserveRaw) && reserveRaw > 0
      ? Math.floor(reserveRaw)
      : 0;
  // The prompt rail is the same with or without tools: requestTokenLimit (llm.maxRequestTokens x SAFETY_MARGIN). The output budget is separate.
  const limit = Math.max(0, requestTokenLimit(config) - TAG_OVERHEAD - toolsTokens - stepReserve);
  return { caps, cost, limit };
}
