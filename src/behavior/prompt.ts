// Assembles one LLM request for a turn. Pure: takes already-fetched data and the live prompts and config, returns
// chat-completions messages. Every request is built on its turn frame (src/turn/request/frame.ts): buildRequest builds
// the head, the task, the senses and her own texts from the builders of src/turn/request/, and framedBuild
// (src/turn/request/framed.ts) lays out the frame's tags in their order under the token budget (docs/prompt-contract.md).
// The classifiers' transcript and the drawing prompt are built here too.

import { computeTempo, fill, formatTranscript, renderTempo, renderTranscript } from '../format.ts';
import type { VideoState } from '../format.ts';
import { requestHead, requestRoom } from '../turn/request/head.ts';
import { sensesOf } from '../turn/request/senses.ts';
import { framedRequest, kindOfRequest } from '../turn/request/frame.ts';
import { framedBuild } from '../turn/request/framed.ts';
import { taskOf } from '../turn/request/task.ts';
import { fillPromptTemplate } from '../turn/request/text.ts';
import { wakeTexts } from '../turn/request/wake.ts';

// The block builders live in src/turn/request/; their importers read them from here.
export { block, fillPromptTemplate, hasRequiredLabels } from '../turn/request/text.ts';
export { previousThinkBody } from '../turn/request/wake.ts';
export { profileStateFields, renderProfile } from '../turn/request/profiles.ts';
export { learnedConfig, learnedText } from '../turn/request/server.ts';
export {
  freezePerBucket,
  gifCaption,
  gifFieldChars,
  gifFields,
  gifFieldsLookup,
  gifLine,
} from '../turn/request/emoji-gifs.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  ClassifierTranscriptArg2,
  BuildDrawPromptInput,
  BuildRequestInput,
  BuildRequestResult,
} from './prompt-types.ts';
export { skillsInventoryText } from '../turn/request/senses.ts';
export { usesFollowUpTask } from '../turn/request/task.ts';
export { worldText } from '../turn/request/selfreflection.ts';

/**
 * The whole text of a user message's content: a string as it is; an array of
 * parts as its text parts' texts joined with nothing (assembleUser's parts
 * carry their own separators, so this is exactly the user text the model
 * reads); anything else ''. Pure.
 */
export function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: { type?: unknown; text?: unknown }) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: { text: string }) => part.text)
    .join('');
}

/**
 * The transcript body of an analyzer classifier's `<transcript>` block (the
 * route classifier, src/behavior/route.ts#routeContext; the re-watch and
 * lookup classifiers, src/behavior/turn.ts#classifierContext): `messages`
 * (already chosen by the caller, oldest first) rendered as the chat renders
 * them (src/format.ts) under the live `config` -- `bot.timezone`,
 * the transcript constants of src/format.ts -- with the media states the caller already has (`descriptions`, `videos`,
 * `reads`; each optional). The one copy of these options for the classifiers;
 * the caller wraps the body. Pure.
 */
export function classifierTranscript(
  messages: Array<Record<string, Untyped>>,
  { config, selfName, labels, descriptions, videos, reads }: ClassifierTranscriptArg2
): string {
  const items = formatTranscript(messages, {
    timezone: config.bot?.timezone,
    selfName,
    labels,
    seeReactions: true,
    // The caller's maps hold what the describer stored: captions, video states and page reads.
    descriptions: descriptions as Map<string, string> | undefined,
    videos: videos as Map<string, VideoState> | undefined,
    reads: reads as Map<string, string> | undefined,
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
 * `image.maxPromptChars` by the caller (src/behavior/turn.ts).
 *   `when`: the local date and time the picture is made at (src/format.ts#formatNow).
 */
export function buildDrawPrompt({ prompts, selfName, request, self, when = '' }: BuildDrawPromptInput): string {
  const appearance = self ? fillPromptTemplate(prompts?.appearance ?? '', { name: selfName }).trim() : '';
  const drawLabels = prompts?.labels?.draw;
  const whenLabel = drawLabels?.when;
  const whenText = when && whenLabel ? fill(whenLabel, { when }) : '';
  return fillPromptTemplate(prompts?.draw ?? '', { name: selfName, appearance, request: request ?? '', when: whenText })
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim();
}

/**
 * The request of one turn on its frame (`input.frame`, required: without one it throws). A heartbeat's and a
 * selfimprovement turn's request reads no chat, since her own time is in no place; their whereabouts are her own server,
 * and a selfreflection's are her own world, whatever place the turn rode in on. The result carries the messages, the
 * budget's line (`stats`), the cache segments, the archive's blocks, the transcript's numbers (`idByIndex`), the
 * handles of her `@` and `#` tags, the people shown and what of memory and of the chat window went in.
 */
export function buildRequest(input: BuildRequestInput): BuildRequestResult {
  // The transport anchor is not the chat of a wake of her own time. Memory and its wake remain available.
  const turnKind = kindOfRequest({
    frame: input.frame,
    mode: input.mode,
    triggerKind: input.triggerKind,
    wakeKind: input.wakeKind,
  });
  const ownTime = turnKind === 'heartbeat' || turnKind === 'selfimprovement';
  if (ownTime) input = { ...input, history: [], currentChannelId: null };
  // Her own time is at the command line of her own server, a selfreflection post in her own world (the owner's word of
  // 2026-11-06), whatever place the turn rode in on.
  const turnPlace = input.whereabouts ?? null;
  const ownPlace = ownTime
    ? { kind: 'server' as const }
    : turnKind === 'selfreflection' || turnKind === 'selfreflection_plan'
      ? { kind: 'world' as const }
      : null;
  const whereabouts = turnPlace && ownPlace ? ownPlace : turnPlace;
  const { currentChannelId = null } = input;
  // Every input, named once: the block builders of src/turn/request/ read theirs from it.
  const given = {
    config: input.config,
    prompts: input.prompts,
    calibrator: input.calibrator,
    mode: input.mode,
    now: input.now,
    selfName: input.selfName,
    selfId: input.selfId,
    history: input.history,
    trigger: input.trigger,
    triggerKind: input.triggerKind,
    taggedCall: input.taggedCall,
    placeMemory: input.placeMemory,
    interlocutor: input.interlocutor,
    dmChat: input.dmChat,
    privateProfile: input.privateProfile,
    otherProfiles: input.otherProfiles,
    candidateProfiles: input.candidateProfiles,
    nameOf: input.nameOf,
    currentChannelId,
    descriptions: input.descriptions,
    videos: input.videos,
    imageAnswers: input.imageAnswers,
    reads: input.reads,
    prefetch: input.prefetch,
    searchAvailable: input.searchAvailable,
    recallAvailable: input.recallAvailable,
    drawOn: input.drawOn,
    customEmoji: input.customEmoji,
    mediaPickText: input.mediaPickText,
    mediaCache: input.mediaCache,
    gifs: input.gifs,
    tasks: input.tasks,
    elsewhereDestination: input.elsewhereDestination,
    selfreflectionChannel: input.selfreflectionChannel,
    selfreflectionChannelIds: input.selfreflectionChannelIds,
    selfreflection: input.selfreflection,
    offPeriods: input.offPeriods,
    skillsInventory: input.skillsInventory,
    toolsGranted: input.toolsGranted,
    toolsBlock: input.toolsBlock,
    toolsTokens: input.toolsTokens,
    around: input.around,
    errands: input.errands,
    intentions: input.intentions,
    wake: input.wake,
    awake: input.awake,
    serviceInner: input.serviceInner,
    wakeKind: input.wakeKind,
    previousThink: input.previousThink,
    myDay: input.myDay,
    callMarks: input.callMarks,
    stableFreeze: input.stableFreeze,
    whereabouts,
    frame: input.frame,
    mind: input.mind,
    lookups: input.lookups,
    meanwhileReads: input.meanwhileReads,
    surroundings: input.surroundings,
    lessons: input.lessons,
    attitudes: input.attitudes,
    refLineOf: input.refLineOf,
    chatIdOf: input.chatIdOf,
    isSourceRetired: input.isSourceRetired,
    memberKeyOf: input.memberKeyOf,
    accountKeyOf: input.accountKeyOf,
    placePathOf: input.placePathOf,
  };
  // Each builder reads the input and what the builders before it gave, under the names they give it.
  const frame = input.frame;
  if (!framedRequest(frame)) throw new Error('buildRequest: a request is built on its turn frame');
  const base = requestHead(given);
  const { labels } = base;
  const tempo = computeTempo(given.history, given.now, given.trigger);
  const tempoText = ownTime ? '' : renderTempo(tempo, labels);
  const task = taskOf({ ...given, ...base });
  const senses = sensesOf({ ...given, ...base });
  const own = wakeTexts(given, labels);
  const room = requestRoom(given);
  return framedBuild(given, { frame, base, task, senses, own, room, tempo, tempoText });
}
