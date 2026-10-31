// Assembles one LLM request for a turn. Pure: takes already-fetched data and
// the live prompts/config, returns chat-completions messages. The token budget
// is spent in this priority order (see src/llm/budget.js):
//   1. system prompt (persona + live rules + output format), task, clock, tempo, and the
//      interlocutor's `<people_now>` entry (what is current about them) — never cut
//   2. memory about the trigger's author (the person the persona is talking to, or the one overheard)
//   2b. what the persona looked up this turn (`<lookup>`, one piece: online,
//       in the server's own history, or both)
//   3. how this server talks + what the persona has said about itself
//   3b. lorebook entries matched by the transcript (`<lore>`)
//   4. the map of the server's channels
//   5. the channel transcript, newest messages first
//   5b. another channel pulled into this turn (`<channel_view>`, newest lines
//       first); on a routed turn -- a call from a channel the persona cannot
//       write in, answered here -- it goes right BEFORE the chat instead,
//       since the call itself lives in it
//   5b2. the anchored window (`<earlier>`, features.anchoredWindow): lines of the current
//       channel older than the chat that matter -- the reply parents (moved out of
//       `<chat>`, keeping their numbers) and the persona's saved stretch of it younger than
//       `participation.earlierHours`, open requests to her marked and ranked first --
//       capped by `context.caps.earlier`; rendered in the tail right after
//       `<participation>`; never in a private chat
//   5c. the last `memory.recentHours` (`<recent>`): the recent lines this
//       channel's audience may read, then members' moments of those hours that
//       `<people>` does not show, capped by `context.caps.recent`, ranked by who
//       the turn is about
//   5d. the persona's own exchanges on other channels (`<participation>`): the
//       episodes the pick classifier chose, then the newest, capped by
//       `context.caps.participation`; never in a private chat
//   6. memory about other people present in the transcript, each with their
//      `<people_now>` entry (the entry lives and dies with the profile)
//   6b. the members the persona feels most strongly about that the request
//       does not describe (`<attitudes>`, one piece: names and bands)
//   6c. a diary post only (mode `diary`): the persona's world (`<world>`, one piece, under
//       `diary.world`), then its past diary posts (`<diary>`, the oldest lines cut first);
//       the post's `<plan>` and a set post's `<seeds>` are never cut, and what its search found (`<found>`) ranks
//       right after `<lookup>`
//   7. neighbouring channels
//   8. the server's custom emoji (`<emoji>`)
//   9. the GIF library (`<gifs>`)
//  10. the `<people_now>` entries of the people in voice the request has no profile for,
//      capped by `context.around.maxTokens`
// The rendered order is different, and laid out for the provider's prompt
// cache: what changes least first, in three text parts -- the stable part
// (the senses that read only the config, her tools in text on the text transport, `<self_facts>`,
// `<about_chat>`, `<gifs>`, the people directory `<directory>`), the profiles (`<people>` with the interlocutor alone), then the
// tail that changes every turn, opening with a second `<people>` for everyone
// else, with `<people_now>` (what is current about each person) right before the chat,
// the clock, the per-turn senses, the tempo and the task last, where the model attends best (see assembleUser and
// docs/prompt-contract.md, "Cache segments"). A private chat (`privateChat`)
// drops the server map, the neighbouring channels and any pulled channel and
// sees its partner through the public and private profiles merged
// (src/behavior/private.js). Pictures of another channel are shown as
// captions only: nothing outside the turn's own channel is ever attached.
// buildRequest assembles the request from the block builders of src/turn/request/, one module per
// group of blocks. The diary's plan request, the classifiers' transcript and the drawing prompt are
// built here too.

import { createHash } from 'node:crypto';
import { fitSections, requestTokenLimit, sectionCost } from '../llm/budget.js';
import { computeTempo, fill, formatNow, formatTranscript, renderTempo, renderTranscript } from '../format.js';
import { RECENT_EPISODES_PER_MEMBER, recentSettings, recentView } from '../memory/recent.js';
import { renderKindsBlock } from './diary.ts';
import { diaryHistoryLines, diaryOf, worldText } from '../turn/request/diary.ts';
import { gifListOf, trimLists } from '../turn/request/emoji-gifs.ts';
import { requestHead, requestRoom } from '../turn/request/head.ts';
import {
  keptEarlier,
  keptParticipation,
  keptRecent,
  memorySections,
  memoryViews,
  recentEntries,
  recentOf,
} from '../turn/request/memory.ts';
import {
  askedAboutOf,
  attitudesOf,
  interlocutorOf,
  keptPeopleNow,
  peopleOfferedOf,
  peopleShownOf,
  placeAskedAbout,
} from '../turn/request/people.ts';
import { fitPulled, neighborItemsOf, pulledKeptOf, pulledView } from '../turn/request/pulled.ts';
import { collectReads, ordered } from '../turn/request/reads.ts';
import { aheadOf, fitAll, headSections } from '../turn/request/sections.ts';
import { sensesKept, sensesOf } from '../turn/request/senses.ts';
import { aboutChatItems, learnedConfig, loreItems, serverItems } from '../turn/request/server.ts';
import { assembleUser, seenOf } from '../turn/request/tail.ts';
import { finalTask, taskOf } from '../turn/request/task.ts';
import { TAG_OVERHEAD, block, fillPromptTemplate, requireLabels } from '../turn/request/text.ts';
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
  gifFieldsMap,
  gifLine,
  ownGifLines,
} from '../turn/request/emoji-gifs.ts';
export { skillsInventoryText } from '../turn/request/senses.ts';
export { usesFollowUpTask } from '../turn/request/task.ts';
export { worldText } from '../turn/request/diary.ts';

/**
 * An `analyzer` request's user content in two cache parts: the `stable` block (the
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
 * The transcript body of an analyzer classifier's `<transcript>` block (the
 * route classifier, src/behavior/route.js#routeContext; the re-watch and
 * lookup classifiers, src/behavior/turn.js#classifierContext): `messages`
 * (already chosen by the caller, oldest first) rendered as the chat renders
 * them (src/format.js) under the live `config` -- `bot.timezone`,
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
 *   `when`: the local date and time the picture is made at (src/format.js#formatNow).
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
 *   never listed in `<directory>`, and a reply parent that mentions it is addressed to her
 *   (`<earlier>`'s open requests). Omitted -> no profile is left out for being hers.
 * @param {object[]} input.history         Normalized channel messages, oldest first.
 * @param {{channelId?: string, channelName: string, messages: object[]}[]} input.neighbors
 *   `channelId` (see src/behavior/neighbors.ts#fetchNeighbors) is how `<server>` tells which
 *   stored channel note, if any, belongs to a neighbour that contributed to `<other_channels>` --
 *   omitted (an older/direct caller) simply means that neighbour never gets its note shown.
 * @param {object|null} input.trigger      Normalized message the turn answers (reply mode): a call,
 *   or an overheard line.
 * @param {string|null} input.triggerKind  src/behavior/turn.js#TriggerKind, null on a spontaneous turn.
 *   Its `labels.triggers` entry fills `{{trigger}}`. `overheard` (a line about the persona, said to
 *   someone else or to the room) takes `prompts.overheard` as its task text instead of
 *   `prompts[mode]` when that file is a non-empty string, falls back to the `followUp` then the
 *   `reply` label, and tags the author's `<people_now>` heading with `labels.peopleNow.marks.overheard`
 *   instead of `labels.peopleNow.marks.interlocutor`.
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
 * @param {{ id: string, name: string, category?: string|null }[]} [input.channelDirectory]  The text
 *   channels the persona can read (src/behavior/turn.js#channelDirectoryOf), [] or omitted for
 *   none. With features.mentionHandles on each gets a handle (src/behavior/handles.js#assignChannelHandles),
 *   listed in `<channel_directory>` (`labels.channelDirectory`, renderChannelDirectory, sorted by id:
 *   the stable part, before `<directory>`, never cut) and shown beside each channel a line mentions
 *   (`labels.transcript.channel`, src/format.js#formatTranscript); the request's
 *   `channelHandles` maps each handle back to its channel id.
 * @param {object[]} [input.loreEntries]   The guild's stored lorebook (store.getLore), [] when memory is off.
 * @param {string|null} [input.currentChannelId]  Id of the channel this turn happens in.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption (see
 *   src/behavior/turn.js, src/memory/describe.js): the only way a picture reaches the persona.
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
 * @param {{ status: 'ok'|'none'|'timeout'|'unavailable', basis: string[], excerpts: object[] }|null} [input.prefetch]
 *   The automatic memory prefetch of this turn (features.coreTools with features.memoryPrefetch:
 *   src/behavior/recall-run.js `prefetch`), rendered as `<retrieved>` in the tail right after
 *   `<lookup>` (prefetchText): `labels.prefetch.header`, the query basis, the caution and one
 *   `<excerpt>` per excerpt, or the status line when nothing qualified, the deadline passed or
 *   the search was unavailable. One piece, ahead of the chat, already bounded by
 *   `recall.prefetch.maxTokens`. Omitted or null (no prefetch ran: the switch off, a trivial or
 *   non-external trigger) -> no block and no budget section.
 * @param {boolean} [input.searchAvailable]  Whether a web search key is configured
 *   (lookup.hasSearch()); `senses.search` renders only when it is true.
 * @param {boolean} [input.recallAvailable]  Whether the search of the server's own history could
 *   run this turn (src/behavior/turn.js#recallAvailable, never in a private chat); `senses.recall`
 *   renders, right after the web search line, only when it is true (and never in a private chat).
 * @param {{ spent: boolean, userSpent: boolean }} [input.drawQuota]  The image client's
 *   quota for this turn (src/llm/images.js#quota); omitted -> no drawing line in `<senses>`.
 * @param {{ id: string, name: string, animated?: boolean }[]} [input.customEmoji]  The served
 *   guild's custom emoji (src/behavior/emoji-index.ts#createEmojiIndex's `list()`). With
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
 *   on (a missing key counts as on) and at least one entry, `<gifs>` renders (see `gifItems`;
 *   held per cache bucket with `stableFreeze`), the tail's `<gifs_recent>` names the listed GIFs
 *   the persona posted within `gifs.ownMarkHours` (ownGifLines, after `<emoji>`, paid from what
 *   the request has left), `<senses>` carries `senses.gifs`, and a GIF of the library in the
 *   transcript carries its handle (`transcript.gifKnownFields`/`gifKnown`/`gifKnownNoText`).
 *   Omitted or empty -> none of it.
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
 *   queuedOthers?: { author: string, text: string }[], added: string[], failedEarlier?: { author: string, messageId: string, link?: string, at: number, code: string }[] }|null} [input.tasks]  What else the trigger's author is waiting for, after
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
 *   With `features.anchoredWindow` exactly true the same `state` also gives `<earlier>` (see
 *   `anchorsView`): the current channel's episodes cut to their lines older than the window's
 *   first line, beside the reply parents of `history`, which then leave `<chat>`; budget section
 *   `earlier` right after the pulled block, capped by `context.caps.earlier` (2500 when unset).
 * @param {string|null} [input.diaryChannel]  The bare name of the diary channel (the persona's
 *   own, src/behavior/diary.ts) when one is set: `<senses>` gains `senses.diary` with
 *   `{channel}`. Omitted or null -> no line. `input.diaryChannelIds` (ids) are its places, marked in `<server>`.
 * @param {{ posts?: object[], plan?: { kind: string|null, brief: string, picture: boolean, topic?: string }|null,
 *   found?: string|null, seeds?: string }|null} [input.diary]  A diary post's own input, read only with `mode:
 *   'diary'` (whose task text is `prompts.diary`): `<world>` (prompts/world.md, `{{name}}` filled,
 *   only with `diary.world === true`, see `worldText`; one piece, fitted right after `<attitudes>`),
 *   `<diary>` (the past posts through src/behavior/diary.ts#renderDiaryBlock, the newest
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
 *   (src/tools/gateway.ts#listSkills), given on a turn whose question was what she can do (the
 *   classifier's `skills: inventory`): `<skills>` in the tail right before `<chat>`, one
 *   `labels.tools.line` per row (skillsInventoryText), budget section `skills` (one piece,
 *   after `found`). Omitted or null -> no `<skills>`.
 * @param {string[]|null} [input.toolsGranted]  The names of the tools exposed to her this turn
 *   (src/tools/discovery.ts#exposedSkillNames): only the in-turn ones (`web.search`, `web.read`,
 *   `media.look`, `memory.search`) matter here, to `<senses>` under `features.coreTools` (the search
 *   lines say she calls them). The tools themselves travel as the request's `tools`, not in a block.
 * @param {string|null} [input.toolsBlock]  The `<tools>` body (src/llm/tool-text.js#toolsBlockText), the text
 *   transport only: in the stable part where the three skills blocks used to stand, fixed, never cut.
 *   Omitted, null or '' -> no block (the native transport sends the tools as a request field).
 * @param {number|null} [input.toolsTokens]  The calibrated tokens the request's `tools` field costs
 *   (the native transport): taken off the room the sections share, so the request stays under the cap.
 * @param {{ snapshot: object, channelNameOf?: (channelId: string) => string|null }|null} [input.around]
 *   The live glance at the server's sidebar (src/behavior/around-store.ts): `snapshot` is the
 *   store's snapshot, `channelNameOf` the name of a voice channel the audience may see (else
 *   null: left out). It is the live part of `<people_now>`, in the tail right after `<skills>`
 *   and before `<chat>`, never in a cached part: one entry per person
 *   (src/behavior/around.js#personRow): a heading line with their mention handle and name, then
 *   one labelled field per line -- the interlocutor first (the heading tagged with
 *   `labels.peopleNow.marks.interlocutor`, or `.overheard` on an overheard turn; never cut), then
 *   the people of the tail `<people>` in their order (each entry one budget item with its
 *   profile), then the people in a voice channel the request has no profile for, by name (the
 *   lowest priority, capped by `context.around.maxTokens`, default 400; none from a stale
 *   snapshot). The live fields (liveFields: status, voice, current activity) come first, then
 *   for a profiled person the attitude, its moves and the message count (profileStateFields);
 *   `labels.peopleNow.lead` and the notices (liveNotices) open the block when it has an entry,
 *   the entries separated by a blank line. `features.around` off, a private chat, a diary post,
 *   an omitted or null input or no `labels.peopleNow`: no live fields, the fields of memory alone.
 * @param {{ list?: string, result?: string }|null} [input.errands]  The persona's errands
 *   (src/errands/blocks.ts, rendered by the turn): `list`, the `<errands>` block's body (her open
 *   errands and the finished ones she has not seen), and `result`, the `<errand_result>` block's
 *   body on the turn an errand's end opened. Both sit in the tail right before `<people_now>`,
 *   paid for with the fixed part and never cut; '' or a missing key leaves its block out.
 * @param {string|null} [input.intentions]  The `<intentions>` block's body (src/intentions/blocks.ts,
 *   rendered and cut to `context.caps.intentions` by the turn; features.intentions): in the tail
 *   right after `<errand_result>`, paid for with the fixed part and never cut here; '' or a missing
 *   key leaves the block out, so with the switch off the request is as it was.
 * @param {string|null} [input.wake]  An inner turn's `<wake>` body (src/behavior/wake.ts, rendered
 *   by the turn; mode `inner`, docs/inner-life.md): in the tail right after `<intentions>`, paid for
 *   with the fixed part and never cut; '' or null leaves it out, so every other turn is as it was.
 *   The task of mode `inner` is `prompts.inner`, like any mode's; on a heartbeat wake (`input.wakeKind`)
 *   it is `prompts.heartbeat` when that file is present and non-blank.
 * @param {string|null} [input.wakeKind]  An inner turn's wake kind (`heartbeat`, ...): a heartbeat takes
 *   `prompts.heartbeat` as its task text in place of `prompts.inner`; null or any other kind keeps the mode's.
 * @param {string|null} [input.places]  An addressed turn's `<places>` body (src/behavior/wake.ts#placesBlockText,
 *   rendered by the turn with `context.places` on; an inner turn carries the page inside `<wake>`):
 *   in the tail right after `<wake>`, paid for with the fixed part and never cut; '' or null leaves it out.
 * @param {{ text: string, relation: 'same'|'earlier', ageMs?: number }|null} [input.previousThink]  Her one
 *   previous think (src/behavior/previous-think.js, chosen by the turn under features.previousThink): in
 *   the tail right after `<places>`, paid for with the fixed part and never cut; null leaves it out.
 * @param {Map<string, object>|null} [input.stableFreeze]  The caller's long-lived holder of what
 *   the stable part shows from memory (src/behavior/turn.js keeps one per guild): with
 *   `features.promptCache` exactly true, `<self_facts>` (and `<gifs>`) render as they were at the
 *   first request of the current time bucket, one bucket being the cache TTL
 *   (src/llm/openrouter.js#cacheTtlMs: an hour for `llm.cache.ttl` `'1h'`), see freezePerBucket;
 *   a memory batch's change shows at the next bucket edge. Omitted, null or the cache off ->
 *   rendered from the input every time.
 * @returns {{ messages: object[], stats: object, segments: { segment: 'stable'|'profiles'|'tail', chars: number, hash: string }[],
 *   idByIndex: Map<number, string>, tempo: object, handles: Map<string, string>|null, channelHandles: Map<string, string>|null,
 *   pulledIds: Map<string, string>,
 *   pulledKept: { channelId: string, ids: string[], newestId: string, newestTs: number }[],
 *   pulledViews: { channelId: string, hashes: Map<string, string>, oldestTs: number, oldestId: string|number }[],
 *   peopleShown: { id: string, names: string[] }[],
 *   recent: { lines: number, episodes: number, cut: number, hidden: number, repeated: number,
 *     unnamed: number }|null,
 *   seen: { messageIds: string[], parents: string[], parts: { filePreviews: string[] } } }}
 *   The user message's content is always an array of text parts (assembleUser: the stable
 *   part, the profiles and the tail, each tagged with its `cacheSegment` but the tail; an empty
 *   one left out), never an image part: the persona sees pictures through the describer's
 *   captions only; userText reads its whole text. `idByIndex` maps chat AND pulled indices; `pulledIds` maps
 *   every pulled line's message id to its channel id (the output side reacts there, never
 *   replies across channels); `pulledKept` lists the channels whose block survived the budget,
 *   with the ids of the lines shown and the newest window line shown; `pulledViews` the same
 *   channels with each shown line's hash and the oldest window line's time (what the next view of
 *   that channel in this destination compares against: the PulledChannel's `seenBefore`,
 *   src/behavior/pull-fetch.ts#createPullViews). `peopleShown` lists the
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
 *   (src/format.js#formatTranscript); null with the switch off. `stats.pulled` is the
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
 *   `memoryReads` lists what the request carried from memory, `{ kind, id, block, ord }` each once, in the memory's own identity
 *   (an item's `itemId`, a channel id, a lore entry's id, a message id; see `noteItems`): the profile items shown,
 *   the channels, guild notes and lore kept, the lines and moments of `<recent>`, the `<participation>` episodes and
 *   what the prefetch offered. The per-turn record (src/memory/db/service.js) writes it; no text depends on it.
 *   `seen` (seenOf) names what of the chat window went in: the kept lines' ids, the reply
 *   parents among them and the messages whose text attachments were previewed -- for the
 *   journal's turn record.
 */
export function buildRequest(input) {
  // The transport anchor is not a heartbeat's current conversation. Memory and its wake remain available.
  const heartbeat = input.mode === 'inner' && input.wakeKind === 'heartbeat';
  if (heartbeat) input = { ...input, history: [], neighbors: [], pulled: null, currentChannelId: null };
  const { forced = false, channels = [], currentChannelId = null, lookup = null } = input;
  // Every input, named once: the block builders of src/turn/request/ read theirs from it.
  const given = {
    config: input.config,
    prompts: input.prompts,
    calibrator: input.calibrator,
    mode: input.mode,
    forced,
    now: input.now,
    selfName: input.selfName,
    selfId: input.selfId,
    history: input.history,
    neighbors: input.neighbors,
    trigger: input.trigger,
    triggerKind: input.triggerKind,
    taggedCall: input.taggedCall,
    guildMemory: input.guildMemory,
    interlocutor: input.interlocutor,
    privateChat: input.privateChat,
    privateProfile: input.privateProfile,
    otherProfiles: input.otherProfiles,
    candidateProfiles: input.candidateProfiles,
    nameOf: input.nameOf,
    channels,
    channelDirectory: input.channelDirectory,
    loreEntries: input.loreEntries,
    currentChannelId,
    descriptions: input.descriptions,
    neighborDescriptions: input.neighborDescriptions,
    videos: input.videos,
    imageAnswers: input.imageAnswers,
    reads: input.reads,
    lookup,
    prefetch: input.prefetch,
    searchAvailable: input.searchAvailable,
    recallAvailable: input.recallAvailable,
    drawQuota: input.drawQuota,
    customEmoji: input.customEmoji,
    mediaCache: input.mediaCache,
    gifs: input.gifs,
    pulled: input.pulled,
    source: input.source,
    focus: input.focus,
    tasks: input.tasks,
    elsewhereDestination: input.elsewhereDestination,
    readOnlyIds: input.readOnlyIds,
    recentLines: input.recentLines,
    recentAudience: input.recentAudience,
    participation: input.participation,
    diaryChannel: input.diaryChannel,
    diaryChannelIds: input.diaryChannelIds,
    diary: input.diary,
    offPeriods: input.offPeriods,
    skillsInventory: input.skillsInventory,
    toolsGranted: input.toolsGranted,
    toolsBlock: input.toolsBlock,
    toolsTokens: input.toolsTokens,
    around: input.around,
    errands: input.errands,
    intentions: input.intentions,
    wake: input.wake,
    wakeKind: input.wakeKind,
    places: input.places,
    previousThink: input.previousThink,
    stableFreeze: input.stableFreeze,
  };
  // Each builder reads the input and what the builders before it gave, under the names they give it; a later one
  // hands on a checked value under the input's own name (`privateChat`, `interlocutor`, `nameOf`, `source`).
  const base = requestHead(given);
  const { labels } = base;
  const view = pulledView({ ...given, ...base });
  const views = memoryViews({ ...given, ...base, ...view });
  // On a routed turn the call is not in this chat: its silence is measured to now, and its
  // last line being the persona's own is no sign that nobody answered the persona.
  const tempo = computeTempo(given.history, given.now, view.routed ? null : given.trigger);
  const tempoText = heartbeat
    ? ''
    : renderTempo(view.routed ? { ...tempo, lastIsOwn: false } : tempo, labels, given.config.context.tempo);
  const task = taskOf({ ...given, ...base, ...view });
  const senses = sensesOf({ ...given, ...base, ...views });
  const diary = diaryOf({ ...given, labels });
  const own = wakeTexts(given, labels);
  const room = requestRoom(given);
  const speaker = interlocutorOf({ ...given, ...base, ...room, ...task });
  const sections = headSections({
    ...given,
    ...base,
    ...view,
    ...task,
    ...senses,
    ...diary,
    ...own,
    ...room,
    ...speaker,
    tempoText,
  });
  const fits = fitPulled({ ...given, ...base, ...view, ...room, ...sections });
  const neighborItems = neighborItemsOf({ ...given, ...base, ...view, ...fits });
  const asked = askedAboutOf({ ...given, ...base, ...fits });
  const recent = recentOf({ ...given, ...base, ...room, ...speaker, ...sections, ...asked });
  const memory = memorySections({ ...views, ...room });
  const ahead = aheadOf({ ...view, ...sections, ...fits, ...memory });
  // The members asked about placed in `<people>`'s room; `<recent>` as built again for them.
  const placed = placeAskedAbout({ ...given, ...base, ...room, ...speaker, ...asked, ...recent, ...ahead });
  const people = peopleOfferedOf({ ...given, ...base, ...room, ...speaker, ...asked, ...placed });
  const attitudesText = attitudesOf({ ...given, ...base, ...room, ...recent, ...placed, ...people });
  const gifList = gifListOf({ ...given, ...base });
  const fit = fitAll({
    ...given,
    ...base,
    ...room,
    ...view,
    ...diary,
    ...placed,
    ...people,
    neighborItems,
    attitudesText,
    gifList,
  });
  // What the budget kept, made whole: each step only shortens the request, so the fit holds.
  trimLists(fit, { ...given, ...base, ...room, gifList });
  const keptPeopleEntries = keptPeopleNow(fit, { ...room, ...speaker, ...placed, ...people });
  // The memory-read collector, filled from what the request kept (see noteItems; `memoryReads` in the result).
  const memoryReads = [];
  const recentCounts = keptRecent(fit, placed.recentBuilt, memoryReads);
  keptParticipation(fit, views.participationBuilt, memoryReads);
  const earlierShown = keptEarlier(fit, { ...views, ...memory, labels });
  const sensesShown = sensesKept(fit, { ...given, ...base, ...views, ...room, ...senses });
  const peopleShown = peopleShownOf(fit.kept, base.interlocutor, keptPeopleEntries);
  collectReads(memoryReads, fit.kept, { ...given, ...speaker, ...sections }, keptPeopleEntries);
  const { pulledKept, pulledViews } = pulledKeptOf(fit, { ...view, ...fits });
  const taskText = finalTask(fit, { ...task, ...room }, pulledKept);

  const { chatItems, handleById, memberNames, channelHandleById } = base;
  const keptChat = chatItems.slice(chatItems.length - fit.kept.chat.length);
  const seen = seenOf({ history: given.history, keptChat, anchoredIds: earlierShown?.parentIds ?? [] });
  // The text parts (assembleUser's cache segments) are the whole user content: no image part
  // ever, the persona sees pictures through the describer's captions.
  const user = assembleUser({
    nowText: base.nowText,
    timezone: base.timezone,
    labels,
    senses: sensesShown,
    tools: senses.toolsText,
    channelDirectory: base.channelDirectoryText,
    directory: base.directoryText,
    kept: fit.kept,
    tempoText,
    task: taskText,
    chatItems: heartbeat ? null : keptChat,
    diary: diary.diaryParts,
    errands: own.errandsText,
    intentions: own.intentionsText,
    wake: own.wakeText,
    places: own.placesText,
    previousThink: own.previousThinkText,
  });

  return {
    messages: [
      { role: 'system', content: base.system },
      { role: 'user', content: user },
    ],
    stats: { ...fit.stats, used: fit.used, limit: room.limit },
    segments: user.map((part) => ({
      segment: part.cacheSegment ?? 'tail',
      chars: part.text.length,
      hash: createHash('sha1').update(part.text).digest('hex').slice(0, 8),
    })),
    idByIndex: base.idByIndex,
    tempo,
    pulledIds: view.pulledIds,
    pulledKept,
    pulledViews,
    peopleShown,
    recent: recentCounts,
    seen,
    // What the request carried from memory, `{ kind, id }` in the memory's own identity, each once (the per-turn record).
    memoryReads: ordered(memoryReads),
    // Handle -> member id, for the persona's `@handle` (null with features.mentionHandles off).
    handles: handleById ? new Map([...handleById].map(([id, handle]) => [handle, id])) : null,
    // Member id -> names, for the note on her tag that named a member without the handle (null with the handles off).
    memberNames: memberNames ?? null,
    // Channel handle -> channel id, for the persona's `#handle` (null with features.mentionHandles
    // off or no channel given).
    channelHandles: channelHandleById ? new Map([...channelHandleById].map(([id, handle]) => [handle, id])) : null,
  };
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
 * (src/behavior/diary.ts#renderKindsBlock over `kinds`, the use counted among
 * the newest `diary.historyPosts`) and `<seeds>` (`seedsText`, already
 * rendered by src/behavior/diary.ts#renderSeedsBlock), then `<topic>`
 * (`topicText`, the owner's topic already rendered by
 * src/behavior/diary.ts#renderTopicBlock; absent without one). Under the
 * request token limit `<now>`, `<kinds>`, `<seeds>` and `<topic>` are never cut, then in
 * priority order: `<diary>` (the oldest lines first), `<world>` (whole),
 * `<about_chat>`, `<server>`, `<recent>`, `<lore>` (each under its
 * `context.caps` entry). Pure.
 * @param {{ config: object, prompts: object, calibrator: object, now: number, selfName: string,
 *   history?: object[], guildMemory?: object|null, channels?: object[], loreEntries?: object[],
 *   currentChannelId?: string|null, diaryChannelIds?: Iterable<string>, recentLines?: object[]|null,
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
  const recentOn = Boolean(
    recentCfg && labels.recent?.header && labels.recent?.line && Array.isArray(input.recentLines)
  );
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
      isShown:
        typeof input.recentAudience === 'function'
          ? input.recentAudience
          : (channelId) => channelId === currentChannelId,
      perMember: RECENT_EPISODES_PER_MEMBER,
    });
    const { entries } = recentEntries(view.items, { labels, timezone, currentChannelId, channels, nameOf });
    if (entries.length > 0) recentBuilt = { header: fill(labels.recent.header, { hours: recentCfg.hours }), entries };
  }

  const channelIds = channels.map((channel) => channel?.id).filter(Boolean);
  const { kept, stats, used } = fitSections(
    [
      {
        name: 'fixed',
        required: true,
        items: [system, nowText, kindsText, seedsText, topicText, diaryIntro].filter(Boolean),
      },
      { name: 'diary', keep: 'newest', items: diaryLines },
      { name: 'world', items: [worldText(config, prompts, selfName)].filter(Boolean) },
      {
        name: 'aboutChat',
        cap: caps.aboutChat,
        items: aboutChatItems(input.guildMemory, labels, nameOf, learnedConfig(config)),
      },
      {
        name: 'server',
        cap: caps.server ?? 4000,
        keep: 'first',
        items: serverItems(
          channels,
          currentChannelId,
          channelIds,
          history,
          now,
          config.context?.channelActivity,
          labels,
          nameOf,
          new Set(),
          new Set(input.diaryChannelIds ?? [])
        ),
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
        items:
          config.features?.lore !== false
            ? loreItems(input.loreEntries, history, null, labels, config.lore, nameOf)
            : [],
      },
    ],
    limit,
    cost
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
