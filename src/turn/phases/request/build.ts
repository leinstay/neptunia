// The last step of a turn's request: her tools for the turn, the request input with every block named, the request
// built (twice for a heartbeat whose handles follow the request's own lines), the record of the memory rows it carried
// and what of the window the journal names as seen. The request phase (src/turn/phases/request.ts) runs it last.

import { buildRequest } from '../../../behavior/prompt.js';
import { diaryConversationIds } from '../../../behavior/mirror.ts';
import { turnRequestInput } from '../../../behavior/turn-input.js';
import { wakeBlockText } from '../../../behavior/wake.ts';
import { budgetDrops } from '../../../llm/budget.js';
import { toolsBlockText } from '../../../llm/tool-text.js';
import { estimateTools } from '../../../llm/tokens.js';
import { log } from '../../../log.js';
import { exposedSkillNames } from '../../../tools/discovery.ts';
import { buildTools } from '../../../tools/tools-json.ts';
import { SEARCH_HANDLE_GAP, defaultSkills, searchHandles } from '../../calls.ts';
import type { SearchRef } from '../../calls.ts';
import type { Draft } from '../../draft.ts';
import { droppedSections } from '../../journal.ts';
import { pickOtherProfiles } from '../../mentions.ts';
import { channelDirectoryOf } from '../../routing.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Gathered } from './gather.ts';
import type { Planned } from './planner.ts';
import type { Pulled } from './pulls.ts';
import type { Setup } from './setup.ts';
import type { Told } from './facts.ts';
import type { Waited } from './wait.ts';

/** The request as buildRequest builds it, with the parts its header names beside the typed ones. */
export type BuiltRequest = ReturnType<typeof buildRequest> & {
  memberNames?: Map<string, Array<string>> | null;
  memoryReads?: Array<unknown>;
};

/** The budget's line of a request: one entry per section (src/llm/budget.js). */
function statsOf(request: BuiltRequest): Record<string, { dropped?: number }> {
  return request.stats as Record<string, { dropped?: number }>;
}

/** The request built from an input turnRequestInput checked. */
function requestOf(input: Record<string, unknown>): BuiltRequest {
  // turnRequestInput refuses a key buildRequest does not read and an input left undefined, so the input is
  // buildRequest's own; the result carries the member names and the memory reads its header names too.
  return buildRequest(input as Parameters<typeof buildRequest>[0]);
}

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export function buildTurnRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  planned: Planned,
  pulled: Pulled,
  waited: Waited,
  gathered: Gathered,
  told: Told
): BuiltRequest {
  const { store, calibrator, skills, lookup, emoji, memoryReads, turnContextOf } = ctx;
  const { aroundInputFor, errandsInputFor, intentionsInputFor, placesInputFor, earlierThinkFor } = ctx;
  const { liveChannelName, diaryChannelName, stableFreezeOf, withSeenBefore, linkCalls, linkTriggers } = ctx;
  const { trigger = null, triggerKind = null, forced = false, source = null, focus = null } = params;
  const { taskResult = null } = params;
  const diaryParams = params.diary ?? null;
  const { channel, guildId, isPrivate } = opened;
  const { config, features, transport, memoryOn, selfId, selfName, now, snapshot } = setup;
  const { serverOn } = planned;
  const { finalMode } = pulled;
  const { participationShown, participationStage, participationAudienceOf } = waited;
  const { history, neighbors, descriptions, neighborDescriptions, videos, imageAnswers, reads } = gathered;
  const { lookupResult, prefetchResult, drawQuota, diaryPrep, pulled: pulledList, readOnlyIds } = gathered;
  const { destination, recent, prompts } = gathered;
  const { factsText, tasks, guildMemory, taggedCall, offPeriods, skillsInventory } = told;
  const pulled2 = pulledList;
  // Her tools, the same for every turn kind and pinned for this one (a grant removed meanwhile is still caught at each call):
  // the skills granted to her and the carried-over ones, as native tool definitions (or `<tools>` text). A diary post
  // has the same tools; only `draw.create` runs there (runSteps).
  draft.toolNames = exposedSkillNames({ config, selfId, registry: skills ?? defaultSkills() });
  draft.tools = buildTools(draft.toolNames, {
    registry: skills ?? defaultSkills(),
    texts: prompts?.tools,
    fill: { drawChars: config.image?.maxPromptChars ?? 1600 },
  });
  const toolsBlock = transport === 'text' ? toolsBlockText(draft.tools, prompts?.labels) : null;
  const toolsTokens = transport === 'native' ? estimateTools(draft.tools) : 0;
  // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
  // A heartbeat's lines carry handles (`#N`) numbered on past the request's own lines, like a memory.search's quotes:
  // the text is worded once with a provisional base, then again when the request says where its own numbering ends.
  const heartbeatRefs: Array<object> = Array.isArray(draft.inner?.wake?.heartbeat?.refs)
    ? (draft.inner.wake.heartbeat.refs as Array<object>)
    : [];
  const heartbeatHandleBase = heartbeatRefs.length > 0 ? SEARCH_HANDLE_GAP + 1 : null;
  let shownHeartbeatRefs: Array<number> = [];
  const wakeTextOf = (handleBase: number | null) =>
    wakeBlockText(draft.inner?.wake as Parameters<typeof wakeBlockText>[0], prompts?.labels, {
      locale: prompts?.labels?.locale,
      handleBase,
      onRefs: (refs) => (shownHeartbeatRefs = refs),
    });
  const requestInput = turnRequestInput({
    config,
    prompts,
    calibrator,
    mode: finalMode,
    forced: forced || (diaryPrep !== null && diaryParams?.forced === true),
    now,
    selfName,
    // `<directory>` never lists the persona's own profile.
    selfId,
    history,
    neighbors,
    trigger,
    triggerKind,
    taggedCall,
    guildMemory: guildMemory ?? {},
    interlocutor: memoryOn && trigger ? (store.getUser(guildId, trigger.authorId) ?? null) : null,
    // A private chat: the partner's private layer joins their public profile (only there).
    privateChat: isPrivate ? { userId: trigger?.authorId ?? null } : null,
    privateProfile: isPrivate && memoryOn && trigger ? (store.getPrivate(guildId, trigger.authorId) ?? null) : null,
    otherProfiles: memoryOn
      ? pickOtherProfiles(store, guildId, history, trigger?.authorId, config.context.otherProfiles)
      : [],
    candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
    nameOf: memoryOn ? (id: string) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
    channels: memoryOn ? store.listChannels(guildId) : [],
    // `<channel_directory>`: every text channel the persona can read, with its handle (none in a private chat).
    channelDirectory: channelDirectoryOf(isPrivate ? null : snapshot, config.bot),
    loreEntries: memoryOn ? store.getLore(guildId) : [],
    currentChannelId: channel.id,
    diaryChannelIds: diaryConversationIds(store),
    descriptions: descriptions ?? null,
    neighborDescriptions: neighborDescriptions ?? null,
    videos: videos ?? null,
    imageAnswers,
    reads: reads ?? null,
    lookup: lookupResult ?? null,
    // `<retrieved>`: the automatic memory prefetch of this trigger (null: none ran).
    prefetch: prefetchResult,
    searchAvailable:
      features.webLookup === true && typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
    // The search of the server's own history: the value the lookup stage used.
    recallAvailable: serverOn,
    drawQuota: drawQuota ?? null,
    // The `<emoji>` block: the index's emoji (ranked by guildMemory.emojiUsage) and their cached captions.
    customEmoji: emoji ? (emoji.list() ?? []) : [],
    // The `<gifs>` block and the transcript's GIF handles: the guild's library (features.gifs).
    gifs: features.gifs !== false && typeof store.getGifs === 'function' ? (store.getGifs(guildId) ?? null) : null,
    // The cached captions of both lists.
    mediaCache:
      emoji || (features.gifs !== false && typeof store.getGifs === 'function')
        ? (store.getMediaCache(guildId) ?? null)
        : null,
    // `<channel_view>`: the channels pulled into this turn (each with the last view of it
    // shown in this channel, when one is within context.pull.seenTtlMinutes), the one it is
    // about, the chat line put to the room, where a call from a read-only channel is answered.
    // The persona's lines there name the message that started their turn (linkTriggers) and
    // the skill calls she made there (linkCalls).
    pulled: withSeenBefore(
      pulled2.map((entry) =>
        Array.isArray(entry?.messages)
          ? {
              ...entry,
              // The marks keep every line as it was.
              messages: linkCalls(linkTriggers(entry.messages), {
                channel,
                snapshot,
                guildId,
              }) as typeof entry.messages,
            }
          : entry
      ),
      channel.id,
      now
    ),
    source,
    focus,
    tasks: tasks.input,
    elsewhereDestination: destination?.name ? { name: destination.name } : null,
    readOnlyIds,
    // `<recent>`: the last hours, its live lines and the members' moments (no block without the store).
    recentLines: recent.lines ?? null,
    recentAudience: recent.audience ?? null,
    // `<participation>`: the store read now, the classifier's picks when they came in time.
    participation: participationShown
      ? {
          state: store.getParticipation(guildId),
          pickedIds:
            participationStage?.done && Array.isArray(participationStage.value) ? participationStage.value : [],
          audience: participationAudienceOf,
          channelName: liveChannelName(channel, snapshot),
        }
      : null,
    // `<senses>`: where the persona keeps its diary, when one is set.
    diaryChannel: diaryChannelName(guildId, config, snapshot, finalMode === 'diary' ? channel : null),
    // A diary post: its past posts, its plan and what its search found.
    diary: diaryPrep
      ? { posts: diaryPrep.posts, plan: diaryPrep.plan, found: diaryPrep.found, seeds: diaryPrep.seeds ?? '' }
      : null,
    offPeriods,
    skillsInventory,
    // Her tools this turn: the in-turn ones for `<senses>`, the text transport's `<tools>` body, and what the native
    // transport's `tools` field costs the request (the room the sections share).
    toolsGranted: draft.toolNames,
    toolsBlock,
    toolsTokens,
    // `<people_now>`'s live part: the voice and status snapshot (null: none).
    around: aroundInputFor({ config, mode: finalMode, isPrivate, snapshot }),
    // `<errands>` and `<errand_result>`: her errands (none on a diary post).
    errands:
      finalMode === 'diary'
        ? null
        : errandsInputFor({ guildId, channel, isPrivate, taskResult, config, labels: prompts?.labels, now }),
    // `<intentions>`: hers and the proposed ones (features.intentions; none on a diary post).
    intentions:
      finalMode === 'diary'
        ? ''
        : intentionsInputFor({ guildId, channel, snapshot, isPrivate, config, labels: prompts?.labels, now }),
    // `<wake>`: an inner turn's reason to be awake (src/behavior/wake.ts); none on any other turn.
    wake: draft.inner ? wakeTextOf(heartbeatHandleBase) : factsText || null,
    // An inner turn's wake kind: a heartbeat takes `prompts.heartbeat` as its task text.
    wakeKind: draft.inner?.wake?.kind ?? null,
    // `<places>`: the places page on an addressed server turn, only with `context.places` exactly true (an inner turn has it in `<wake>`).
    places:
      !draft.inner && !isPrivate && finalMode !== 'diary'
        ? placesInputFor({ guildId, config, labels: prompts?.labels })
        : null,
    // Her one previous think: the latest finished turn tied to this place within the window (an inner turn imports none).
    previousThink: earlierThinkFor({ channel, guildId, isPrivate, draft, mode: finalMode }),
    // `<self_facts>` and `<gifs>` held per cache bucket, so a memory batch rewrites the cache once at most.
    stableFreeze: stableFreezeOf(guildId),
  });
  let request = requestOf(requestInput);
  if (heartbeatRefs.length > 0) {
    const floor = Math.max(0, ...request.idByIndex.keys());
    const base = floor + SEARCH_HANDLE_GAP + 1;
    if (base !== heartbeatHandleBase) {
      requestInput.wake = wakeTextOf(base);
      request = requestOf(requestInput);
    }
    // The handles the block kept resolve in this turn and in the steps of its loop (the registry of memory.search's quotes).
    draft.handleFloor = floor;
    searchHandles(draft).take(
      shownHeartbeatRefs
        .filter((index) => heartbeatRefs[index])
        .map((index) => ({ n: base + index, ...heartbeatRefs[index] }) as SearchRef)
    );
  }
  // What `<recent>` showed, held back or cut: counts only.
  if (request.recent) log.info('recent: shown', { channel: channel.id, ...request.recent });
  // The memory rows this request carried, for the database's per-turn record (deferred there; it never fails a turn).
  if (memoryReads && draft.started?.turnId && request.memoryReads?.length) {
    // One step: the steps of her tool loop add tool results to this request, never memory reads of their own.
    try {
      const readContext = turnContextOf(draft, channel) as { id?: string } | null | undefined;
      memoryReads({
        turnId: draft.started.turnId,
        step: 's0',
        guildId,
        reads: request.memoryReads,
        ...(readContext?.id ? { contextId: readContext.id } : {}),
      });
    } catch {
      /* a record, never a turn's failure */
    }
  }
  // The journal: what of the window went in, whose lines they were, what the budget dropped.
  if (draft.started && request.seen) {
    // The lines of the pulled channels whose block the request kept count as seen too, by channel.
    const pulledSeen = (request.pulledKept ?? []).map(({ channelId, ids }) => ({
      channelId,
      messageIds: [...ids],
    }));
    const pulledIdsSeen = pulledSeen.flatMap((entry) => entry.messageIds);
    draft.seen = {
      ...request.seen,
      messageIds: [...new Set([...request.seen.messageIds, ...pulledIdsSeen])],
      pulled: pulledSeen,
    };
    const keptIds = new Set(draft.seen.messageIds);
    const pulledLines = pulledSeen.flatMap(
      ({ channelId }) => pulled2.find((entry) => entry.channelId === channelId)?.messages ?? []
    );
    const authors = [...history, ...pulledLines]
      .filter((message) => keptIds.has(message.id) && !message.self)
      .map((message) => message.authorId);
    draft.participants = [
      ...new Set([...authors, trigger?.authorId].filter((id): id is string => typeof id === 'string' && Boolean(id))),
    ];
    draft.dropped = droppedSections(statsOf(request));
    budgetDrops(statsOf(request), draft.limits);
  }
  return request;
}
