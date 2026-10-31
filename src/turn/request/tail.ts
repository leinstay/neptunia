// The end of a turn's request: `<now>` with the persona's recent time away, the user message's text parts in their
// three cache segments (the stable part, the profiles, the tail with the chat, the clock, the per-turn senses, the
// tempo and the task last), and what of the chat window went in for the journal. buildRequest
// (src/behavior/prompt.js) calls them last.

import { fill, formatDuration, formatNow, renderTranscript } from '../../format.js';
import { mediaParts } from '../../media/classify.js';
import { block, pulledMoment } from './text.ts';
import type { Senses } from './senses.ts';
import type { LabelGroup, Labels, Message, TranscriptItem } from './types.ts';

/** One text part of a request's user message, tagged with its cache segment but the tail. */
export type UserPart = { type: 'text'; text: string; cacheSegment?: 'stable' | 'profiles' };

/** The `<chat>` body: renderTranscript over the kept lines, which joins their texts under a date header. */
const chatText = (items: Array<TranscriptItem>, timezone: string, labels: Labels): string =>
  // renderTranscript has no declared types; it returns the joined text.
  renderTranscript(items, timezone, labels) as string;

/** One part of a message's media (src/media/classify.js#mediaParts). */
type MediaPart = { readonly attachments?: Array<{ readonly kind?: string; readonly previewText?: unknown } | null> };

/**
 * The body of `<now>`: the present moment (formatNow), then, when `periods` holds any (the
 * journal's off periods, src/memory/journal.js#offPeriods, newest first), `labels.journal.offLead`
 * and one line per period: `offPaused` or `offStopped` with `{from}` / `{to}` (the date and
 * the clock in `timezone`, as a pulled channel's header writes them) and `{length}`
 * (formatDuration). A period whose label is missing is left out; without the lead, or with no
 * line left, the clock stands alone. Per-turn: it sits in the tail, never in a cached part.
 */
export function nowBlock(now: number, timezone: string, labels: Labels, periods: unknown): string {
  const clock = formatNow(now, timezone, labels.locale);
  const l: LabelGroup = labels.journal ?? {};
  if (!Array.isArray(periods) || periods.length === 0 || typeof l.offLead !== 'string' || !l.offLead.trim())
    return clock;
  const lines: Array<string> = [];
  // The journal's off periods as given, read loosely: a period without its label or its times is left out.
  for (const period of periods as Array<{ kind?: unknown; from?: unknown; to?: unknown } | null>) {
    const template = period?.kind === 'paused' ? l.offPaused : period?.kind === 'stopped' ? l.offStopped : null;
    if (
      typeof template !== 'string' ||
      !template.trim() ||
      typeof period?.from !== 'number' ||
      !Number.isFinite(period.from) ||
      typeof period.to !== 'number' ||
      !Number.isFinite(period.to)
    )
      continue;
    lines.push(
      fill(template, {
        from: pulledMoment(period.from, timezone, labels.locale),
        to: pulledMoment(period.to, timezone, labels.locale),
        length: formatDuration(Math.max(0, period.to - period.from), labels.units),
      })
    );
  }
  return lines.length > 0 ? [clock, l.offLead, ...lines].join('\n') : clock;
}

/**
 * The user message's text parts from already-rendered blocks, in three cache
 * segments (see docs/prompt-contract.md, "Cache segments"): the stable part
 * (`cacheSegment: 'stable'`), what changes least first: the stable
 * `<senses>` lines, `<tools>` (`tools`: her tools described in text, the text
 * transport only, changing only with a grant or a skill text), `<self_facts>`, `<about_chat>`,
 * `<gifs>`, `<channel_directory>` (`channelDirectory`: the channels with their handles, changing
 * only when a channel is added, removed or renamed), `<directory>` (`directory`: the people
 * directory, changing only with a member's names or aliases); the profiles
 * (`cacheSegment: 'profiles'`: `<people>` with the interlocutor alone), then
 * the tail (no segment) with everything that changes from turn to turn -- a
 * second `<people>` with the other members first, `<emoji>` among it, its
 * ranking moves with use several times a day, `<gifs_recent>` (the listed GIFs
 * the persona posted lately, with their ages), `<skills>` (the catalogue, on
 * a question about what the persona can do) and `<people_now>` (what is current about each
 * person: status, voice, activity, attitude) right before `<chat>` -- `<now>`, the per-turn
 * `<senses>` lines, `<tempo>` and `<task>` last. `senses` is
 * renderSenses' two halves. A segment with no block is left
 * out; every part but the last ends with the blank line that separates
 * blocks, so the parts' texts joined with nothing (userText) are the whole
 * user text. `cacheSegment` is a neutral tag: src/llm/openrouter.js#withCacheMarker
 * turns it into the provider's marker under the cache policy and never sends it.
 * `errands`: the `<errands>` and `<errand_result>` bodies
 * (buildRequest's `input.errands`), in the tail before `<people_now>`. `diary` (a diary post only): the
 * `<diary>` block's intro, shown above its kept lines, the `<plan>` body and
 * the `<seeds>` body (a set post's seed combinations, right after the plan).
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function assembleUser({
  nowText,
  timezone,
  labels,
  senses,
  tools = '',
  channelDirectory = '',
  directory = '',
  kept,
  tempoText,
  task,
  chatItems,
  diary = null,
  errands = null,
  intentions = '',
  wake = '',
  places = '',
  previousThink = '',
}: {
  nowText: string;
  timezone: string;
  labels: Labels;
  senses: Senses;
  tools?: string;
  channelDirectory?: string;
  directory?: string;
  kept: Record<string, Array<string>>;
  tempoText: string;
  task: string;
  chatItems: Array<TranscriptItem> | null;
  diary?: { intro: string; plan: string; seeds: string } | null;
  errands?: { list: string; result: string } | null;
  intentions?: string;
  wake?: string;
  places?: string;
  previousThink?: string;
}): Array<UserPart> {
  const stable = [
    block('senses', senses.stable),
    // Her tools described in text (the text transport only; the native transport sends none): changes only when a grant or a skill text does.
    block('tools', tools),
    block('self_facts', kept.self.join('\n')),
    block('about_chat', kept.aboutChat.join('\n')),
    // Held per cache bucket; which of them the persona posted lately is in the tail (`<gifs_recent>`).
    block('gifs', (kept.gifs ?? []).join('\n')),
    // Which channel has which handle: changes only when a channel is added, removed or renamed.
    block('channel_directory', channelDirectory),
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
    // The GIFs of the cached `<gifs>` list the persona posted lately, with their ages: per turn.
    block('gifs_recent', (kept.gifsRecent ?? []).join('\n')),
    block('lore', kept.lore.join('\n\n')),
    // The last hours: one item, the header with the kept lines and moments, oldest first.
    block('recent', (kept.recent ?? []).join('\n')),
    // The persona's own exchanges on other channels: one item, the header and the episodes kept.
    block('participation', (kept.participation ?? []).join('\n')),
    // This channel's lines older than `<chat>`: one item, moving only when a stored line leaves the chat.
    block('earlier', (kept.earlier ?? []).join('\n')),
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
    // What the automatic memory prefetch found for this trigger (features.coreTools): per turn, next to the chat.
    block('retrieved', (kept.prefetch ?? []).join('\n')),
    // The persona's skills with her access here, when she was asked what she can do.
    block('skills', (kept.skills ?? []).join('\n')),
    // Her errands under way or newly finished, then the one whose end opened this turn: per turn (ages move).
    block('errands', errands?.list ?? ''),
    block('errand_result', errands?.result ?? ''),
    // Her intentions and the candidates proposed from her own lines (features.intentions): per turn.
    block('intentions', intentions),
    // An inner turn's reason to be awake (src/behavior/wake.ts, mode `inner` only): per turn.
    block('wake', wake),
    // The places page of an addressed turn (`context.places`; src/behavior/wake.ts#placesBlockText): per turn.
    block('places', places),
    // Her one previous think (src/behavior/previous-think.js): per turn, right before the people it concerns.
    block('previous_think', previousThink),
    // What is current about each person: the live snapshot and what changes from turn to turn
    // in memory. Tail only, right before the chat.
    block('people_now', (kept.peopleNow ?? []).join('\n')),
    block('chat', chatItems === null ? '' : chatText(chatItems, timezone, labels)),
    // The present moment after the history it dates, with the persona's recent time away (nowBlock).
    block('now', nowText),
    // The per-turn senses lines (renderSenses' `turn` half); the rest lead the stable part.
    block('senses', senses.turn),
    block('tempo', tempoText),
    block('task', task),
  ];
  const segments = [
    { blocks: stable, cacheSegment: 'stable' as const },
    { blocks: profiles, cacheSegment: 'profiles' as const },
    { blocks: tail, cacheSegment: null },
  ]
    .map(({ blocks, cacheSegment }) => ({ text: blocks.filter(Boolean).join('\n\n'), cacheSegment }))
    .filter((segment) => segment.text);
  return segments.map(({ text, cacheSegment }, i) => ({
    type: 'text' as const,
    text: i < segments.length - 1 ? `${text}\n\n` : text,
    ...(cacheSegment ? { cacheSegment } : {}),
  }));
}

/**
 * What of the chat window entered a turn's request, for the journal: the ids of the kept
 * transcript lines (oldest first), of the reply parents among them (prepended to the window
 * from outside it, `replyParent: true`) and of the kept messages whose text attachment was
 * previewed. `anchoredIds`: the reply parents `<earlier>` showed instead of `<chat>` (the
 * anchored window), counted first.
 */
export function seenOf({
  history,
  keptChat,
  anchoredIds = [],
}: {
  history: Array<Message>;
  keptChat: Array<{ id: string }>;
  anchoredIds?: Array<string>;
}): { messageIds: Array<string>; parents: Array<string>; parts: { filePreviews: Array<string> } } {
  const byId = new Map(history.map((message) => [message.id, message]));
  const messageIds = [...anchoredIds, ...keptChat.map((item) => item.id)].filter((id) => typeof id === 'string' && id);
  const keptMessages = messageIds.map((id) => byId.get(id)).filter((message): message is Message => Boolean(message));
  return {
    messageIds,
    parents: keptMessages.filter((message) => message.replyParent === true).map((message) => message.id),
    parts: {
      filePreviews: keptMessages
        .filter((message) =>
          // mediaParts gives the message's own parts, which it returns as plain objects.
          (mediaParts(message) as Array<MediaPart>).some((part) =>
            (part.attachments ?? []).some((a) => a?.kind === 'text' && typeof a.previewText === 'string')
          )
        )
        .map((message) => message.id),
    },
  };
}
