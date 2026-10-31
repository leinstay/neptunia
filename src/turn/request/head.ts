// The stable head of a turn's request: the labels, the clock and the switches it is built under, the merged profile
// of a private chat's partner, the mention and channel handles with their directories, the transcript's options,
// the system prompt and the chat's own lines, and the room the request's sections share. buildRequest
// (src/behavior/prompt.js) builds it first.

import {
  assignChannelHandles,
  assignHandles,
  channelDirectoryEntries,
  directoryEntries,
  memberNameMap,
  renderChannelDirectory,
  renderDirectory,
} from '../../behavior/handles.js';
import { voiceOccupants } from '../../behavior/around.js';
import { mergeProfiles } from '../../behavior/private.js';
import { isPlainObject } from '../../config.js';
import { formatTranscript } from '../../format.js';
import { requestTokenLimit, sectionCost } from '../../llm/budget.js';
import { cacheTtlMs } from '../../llm/openrouter.js';
import { gifHandleMap, normalizeGifs } from '../../memory/index.js';
import { memberIdOf } from '../../memory/recent.js';
import { emojiMax, freezePerBucket, gifFieldChars, gifFieldsMap } from './emoji-gifs.ts';
import type { Held } from './emoji-gifs.ts';
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

/** The live glance at the server's sidebar (src/behavior/around-store.ts), as `<people_now>` reads it. */
export type AroundSnapshot = {
  readonly presences: boolean;
  readonly stale: boolean;
  readonly voice: Map<string, object>;
  readonly presence: Map<string, object>;
};

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
  voiceChannelNameOf: ((channelId: string) => string | null) | undefined;
  selfMemberId: string | null;
  handleById: Map<string, string> | null;
  directoryText: string;
  memberNames: Map<string, Array<string>> | null;
  channelHandleById: Map<string, string> | null;
  channelDirectoryText: string;
  handleFor: (memberId: string | null) => string | null;
  nowText: string;
  relationships: boolean;
  shownMoves: number;
  episodesOn: boolean;
  loreOn: boolean;
  gifLibrary: ReturnType<typeof normalizeGifs> | null;
  gifsOn: boolean;
  customEmoji: Array<EmojiRef>;
  emojiOnce: boolean;
  formatOptions: FormatOptions;
  system: string;
  anchored: boolean;
  chatItems: Array<TranscriptItem>;
  idByIndex: Map<number, string>;
};

/** The room the request's sections share, its caps and the price of a text. */
export type Room = { caps: Caps; cost: Cost; limit: number };

/** The labels, switches, handles, transcript options, system prompt and chat lines of a request. */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function requestHead(given: RequestInput): Base {
  const { config, prompts, mode, now, selfName, history, neighbors, descriptions, videos, imageAnswers, reads } = given;
  const labels = requireLabels(prompts);
  const privateChat = Boolean(given.privateChat);
  // mergeProfiles lays the private layer over the public profile: the partner's profile, as stored.
  const merged = (): Profile | null =>
    mergeProfiles(
      given.interlocutor as Profile | null,
      given.privateProfile as object | null | undefined
    ) as Profile | null;
  const interlocutor = privateChat ? merged() : given.interlocutor;
  // The caller's resolver of a member id to a name.
  const nameOf: NameOf = typeof given.nameOf === 'function' ? (given.nameOf as NameOf) : () => null;
  const { timezone } = config.bot;
  // What memory changes inside the stable part (`<self_facts>`, `<gifs>`) is held for one cache
  // TTL bucket while the prompt cache is on (freezePerBucket): a memory batch or the persona's
  // GIF post rewrites the cached prefix at most once per bucket.
  const stableFreeze =
    config.features?.promptCache === true && given.stableFreeze instanceof Map
      ? // The caller's holder of what freezePerBucket keeps for this request.
        (given.stableFreeze as Map<string, Held<unknown>>)
      : null;
  const frozen = <T>(key: string, signature: string, compute: () => T): T =>
    freezePerBucket(stableFreeze, key, { now, bucketMs: cacheTtlMs(config), signature }, compute);
  // Mention handles (features.mentionHandles, a missing key counts as on): every member with a
  // stored profile gets one in `<directory>` (the stable part), the authors in view on their lines.
  const handlesOn = config.features?.mentionHandles !== false;
  // `<people_now>`'s live part (features.around, a missing key counts as on): the snapshot of
  // the gateway's voice states and presences, never in a private chat or a diary post.
  // The live glance as the turn hands it: checked to be an object with a snapshot below.
  const aroundInput = given.around as
    { snapshot?: AroundSnapshot | null; channelNameOf?: (channelId: string) => string | null } | null | undefined;
  const liveOn =
    config.features?.around !== false &&
    !privateChat &&
    mode !== 'diary' &&
    isPlainObject(aroundInput) &&
    Boolean(aroundInput?.snapshot) &&
    Boolean(labels.peopleNow);
  // liveOn holds only for an object with a snapshot.
  const liveSnapshot = liveOn ? aroundInput!.snapshot! : null;
  const voiceChannelNameOf = liveOn ? aroundInput!.channelNameOf : undefined;
  const selfMemberId = memberIdOf(given.selfId);
  // Everyone in a voice channel the audience may see, the persona aside: each gets a handle, so
  // their `<people_now>` entry joins by it like everyone's.
  const inVoice =
    liveOn && liveSnapshot
      ? voiceOccupants(liveSnapshot, {
          excludeIds: new Set([selfMemberId].filter((id): id is string => Boolean(id))),
          nameOf,
          channelNameOf: voiceChannelNameOf,
        }).map((occupant) => occupant.memberId)
      : [];
  const directory = handlesOn
    ? // The served guild's stored profiles, as the store lists them.
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
    .map(memberIdOf)
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
  const handleFor = (memberId: string | null) =>
    memberId !== null && handleById ? (handleById.get(memberId) ?? null) : null;
  // `<now>`: the clock, then the persona's recent time away (features.offPeriods, read now).
  const nowText = nowBlock(now, timezone, labels, config.features?.offPeriods !== false ? given.offPeriods : null);
  const relationships = config.features?.relationships !== false;
  // How many attitude moves follow the attitude in a `<people_now>` entry (profileStateFields).
  const shownMoves = config.relationships?.shownMoves ?? 4;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  // The GIF library: the switch (a missing key counts as on) and at least one entry.
  const gifLibrary = config.features?.gifs !== false && given.gifs ? normalizeGifs(given.gifs) : null;
  const gifsOn = gifLibrary !== null && Object.keys(gifLibrary.entries).length > 0;
  // The server's custom emoji: the switch (a missing key counts as on) and a non-empty index.
  const customEmoji: Array<EmojiRef> =
    config.features?.customEmoji !== false && Array.isArray(given.customEmoji)
      ? // The emoji index's list as the turn hands it (src/behavior/emoji-index.ts).
        (given.customEmoji as Array<EmojiRef>)
      : [];
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
    // neighbour and pulled channels alike.
    now,
    ageMinutes: config.context.ageAfterMinutes ?? 60,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context.reactionsPerMessage,
    // Who reacted to the persona's own lines, named like authors (features.reactionNames).
    reactionNames: config.features?.reactionNames !== false,
    reactionNamesMax: config.context.reactions?.maxNames ?? 5,
    replyQuoteChars: config.context.replyQuoteChars,
    emojiInline: !emojiOnce,
    descriptions,
    videos,
    reads,
    // A picture's second look on a question renders under its tag.
    imageAnswers,
    // Each author in view carries their mention handle (transcript.author).
    handles: handleById ?? undefined,
    memberNames: memberNames ?? undefined,
    // A message link to a line of the same rendering reads as its `#n` (features.messageLinks).
    messageNumbers: config.features?.messageLinks !== false,
    // Each channel a line mentions carries its handle (transcript.channel).
    channels: channelHandleById
      ? new Map(
          // assignChannelHandles gives every channel of the directory its handle.
          channelEntries.map((entry) => [entry.id, { handle: channelHandleById.get(entry.id)!, name: entry.name }])
        )
      : undefined,
    // A GIF the library knows carries its handle in the transcript.
    gifHandles: gifsOn ? gifHandleMap(gifLibrary) : undefined,
    // ...and its three caption fields, cut like the `<gifs>` list (transcript.gifKnownFields).
    gifFields:
      gifsOn && labels.transcript?.gifKnownFields && given.mediaCache
        ? gifFieldsMap(given.mediaCache, gifFieldChars(config.gifs))
        : undefined,
  };

  const nameFill = (text: unknown) => fillPromptTemplate(text, { name: selfName });
  const formatFill = nameFill;
  const system = [
    nameFill(prompts['system-prompt']),
    nameFill(prompts['character-card']),
    nameFill(prompts.rules),
    formatFill(prompts.format),
  ]
    .filter(Boolean)
    .join('\n\n');
  // The anchored window (features.anchoredWindow): the reply parents leave `<chat>` for
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
    selfMemberId,
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
    emojiOnce,
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
  // The prompt rail is the same with or without tools: requestTokenLimit (llm.maxRequestTokens x llm.safetyMargin). The output budget is separate.
  const limit = Math.max(0, requestTokenLimit(config) - TAG_OVERHEAD - toolsTokens - stepReserve);
  return { caps, cost, limit };
}
