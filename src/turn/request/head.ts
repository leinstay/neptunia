// The stable head of a turn's request: the labels, the clock and the switches it is built under, the merged profile
// of a private chat's partner, the mention handles of the chat's authors, the transcript's options, the system prompt
// and the chat's own lines, and the room the request's sections share. buildRequest
// (src/behavior/prompt.ts) builds it first.

import { assignHandles, memberNameMap } from '../../behavior/handles.ts';
import type { AroundSnapshot } from '../../behavior/around-store.ts';
import { mergeProfiles } from '../../behavior/private.ts';
import { isPlainObject } from '../../config.ts';
import { formatTranscript, reactorIdsOf } from '../../format.ts';
import { requestTokenLimit, sectionCost } from '../../llm/budget.ts';
import { rulesPromptOf } from '../../rules-list.ts';
import { cacheTtlMs } from '../../llm/openrouter.ts';
import { gifHandleMap, normalizeGifs } from '../../memory/index.ts';
import { accountIdOf } from '../../memory/recent.ts';
import { freezePerBucket, gifFieldChars, gifFieldsMap } from './emoji-gifs.ts';
import type { Held, MediaCache } from './emoji-gifs.ts';
import { orderedHistory } from '../history.ts';
import { spatialAwarenessText } from './spatial.ts';
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
  dmChat: boolean;
  interlocutor: Profile | null | undefined;
  nameOf: NameOf;
  timezone: string;
  frozen: <T>(key: string, signature: string, compute: () => T) => T;
  liveOn: boolean;
  liveSnapshot: AroundSnapshot | null;
  voiceChannelNameOf: ((placeId: string) => string | null) | undefined;
  selfAccountId: string | null;
  handleById: Map<string, string> | null;
  memberNames: Map<string, Array<string>> | null;
  handleFor: (accountId: string | null) => string | null;
  nowText: string;
  spatialText: string;
  relationships: boolean;
  shownMoves: number;
  episodesOn: boolean;
  loreOn: boolean;
  gifLibrary: ReturnType<typeof normalizeGifs> | null;
  gifsOn: boolean;
  customEmoji: Array<EmojiRef>;
  formatOptions: FormatOptions;
  system: string;
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

/** The members who wrote a line of `history` or reacted to one of hers, she and the bots aside. */
function authorsOf(history: ReadonlyArray<Message>): Array<string> {
  const ids = new Set<string>();
  for (const message of history)
    if (message && !message.self && !message.bot && message.authorId !== undefined && message.authorId !== null)
      ids.add(String(message.authorId));
  for (const id of reactorIdsOf(history as Array<Message>)) ids.add(id);
  return [...ids];
}

/** The labels, switches, handles, transcript options, system prompt and chat lines of a request. */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function requestHead(given: RequestInput): Base {
  const { config, prompts, mode, now, selfName, history, descriptions, videos, imageAnswers, reads } = given;
  const labels = requireLabels(prompts);
  const dmChat = Boolean(given.dmChat);
  // mergeProfiles lays the private layer over the public profile: the partner's profile, as stored. A partner known only
  // from this DM has no public profile, and the trigger gives the merged one its id and heading.
  const framed = given.frame ?? null;
  const counterpartName = framed ? framed.counterpart?.name : given.trigger?.authorName;
  const named = counterpartName ? [counterpartName] : [];
  const counterpartId = framed ? framed.answers?.authorId : given.trigger?.authorId;
  const privateOnly = given.privateProfile && counterpartId ? { id: counterpartId, names: named } : null;
  const merged = (): Profile | null =>
    mergeProfiles(
      given.interlocutor ?? privateOnly,
      given.privateProfile as object | null | undefined
    ) as Profile | null;
  const interlocutor = dmChat ? merged() : given.interlocutor;
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
  // The live line of a person in `<memory>`: the snapshot of the voice states and presences, never in a private chat
  // or a selfreflection post. The live glance as the turn hands it: checked to be an object with a snapshot below.
  const aroundInput = given.around as
    { snapshot?: AroundSnapshot | null; channelNameOf?: (placeId: string) => string | null } | null | undefined;
  const liveOn =
    !dmChat &&
    mode !== 'selfreflection' &&
    isPlainObject(aroundInput) &&
    Boolean(aroundInput?.snapshot) &&
    Boolean(labels.peopleNow);
  // liveOn holds only for an object with a snapshot.
  const liveSnapshot = liveOn ? aroundInput!.snapshot! : null;
  const voiceChannelNameOf = liveOn ? aroundInput!.channelNameOf : undefined;
  const selfAccountId = accountIdOf(given.selfId);
  // Mention handles: no directory up front, every author of the chat gets one on their lines; a person memory brings
  // to mind gets one when `<memory>` names them (src/turn/request/reader.ts).
  const handleById = assignHandles({ profiled: [], inView: authorsOf(history) });
  // The names each member in view goes by (the lines' authors and mentioned members): a mention reads as its handle in
  // the transcript, and a tag of hers that names one without the handle is marked (transcript.untagged).
  const memberNames = memberNameMap([], history);
  // A member's handle in this request: on their profile heading and at the start of their live line.
  const handleFor = (accountId: string | null) =>
    accountId !== null && handleById ? (handleById.get(accountId) ?? null) : null;
  // `<spatial_awareness>`: where she is and the time (src/turn/request/spatial.ts), with the owner's note read now. With
  // it the clock leaves `<now>`, so the time appears once; `<now>` keeps her recent time away.
  const spatialText = given.whereabouts
    ? spatialAwarenessText({
        whereabouts: given.whereabouts,
        now,
        timezone,
        labels,
        notes: config.spatial?.notes,
      })
    : '';
  const nowText = nowBlock(now, timezone, labels, given.offPeriods, spatialText === '');
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
    // The request's clock: a line shows its clock alone, in the chat, the neighbours and the pulled channels alike.
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
  // Every line and every call mark of hers in time order, once: formatTranscript numbers the messages as they stand.
  // The reply parents stay in `<chat>` with their numbers.
  const ordered = orderedHistory(history, given.callMarks ?? [], now) as Array<Message>;
  const chatItems = formatTranscript(ordered, formatOptions);
  const idByIndex = new Map(chatItems.map((item) => [item.index, item.id]));
  return {
    labels,
    dmChat,
    interlocutor,
    nameOf,
    timezone,
    frozen,
    liveOn,
    liveSnapshot,
    voiceChannelNameOf,
    selfAccountId,
    handleById,
    memberNames,
    handleFor,
    nowText,
    spatialText,
    relationships,
    shownMoves,
    episodesOn,
    loreOn,
    gifLibrary,
    gifsOn,
    customEmoji,
    formatOptions,
    system,
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
  const toolLoop = config.tools?.loop;
  const reserveRaw = toolLoop?.stepReserveTokens;
  const stepReserve =
    toolsExposed && reserveRaw !== undefined && Number.isFinite(reserveRaw) && reserveRaw > 0
      ? Math.floor(reserveRaw)
      : 0;
  // The prompt rail is the same with or without tools: requestTokenLimit (llm.maxRequestTokens x SAFETY_MARGIN). The output budget is separate.
  const limit = Math.max(0, requestTokenLimit(config) - TAG_OVERHEAD - toolsTokens - stepReserve);
  return { caps, cost, limit };
}
