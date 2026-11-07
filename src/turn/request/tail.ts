// The end of a turn's request: `<now>` with the persona's recent time away, the user message's text parts in their
// three cache segments (the stable part, the profiles, the tail with the chat, the clock, the per-turn senses, the
// tempo and the task last), and what of the chat window went in for the journal. buildRequest
// (src/behavior/prompt.ts) calls them last.

import { fill, formatDuration, formatNow, renderTranscript } from '../../format.ts';
import { mediaParts } from '../../media/classify.ts';
import { block, pulledMoment } from './text.ts';
import type { Senses } from './senses.ts';
import type { LabelGroup, Labels, Message, TranscriptItem } from './types.ts';

/** One text part of a request's user message, tagged with its cache segment but the tail. */
export type UserPart = { type: 'text'; text: string; cacheSegment?: 'stable' | 'profiles' };

/** A cache segment of the user message by its name. */
export type BlockSegment = 'stable' | 'profiles' | 'tail';

/** One block of the user message as it goes out, empty when it has nothing. `section` is its budget section when it has one. */
export type ListedBlock = {
  readonly name: string;
  readonly segment: BlockSegment;
  readonly source: string;
  readonly section?: string;
  readonly text: string;
  readonly offKind?: boolean;
};

/**
 * What the archive keeps of a block: the tag it goes out under, which is not yet the frame's `BlockName`, its size with
 * the tags, its segment, its producer and why it holds what it holds.
 */
export type BlockRecord = {
  readonly name: string;
  readonly chars: number;
  readonly segment: BlockSegment;
  readonly source: string;
  readonly reason: 'empty' | 'kept' | 'cut' | 'not_for_kind';
};

type Unsegmented = Omit<ListedBlock, 'segment'>;

/** A block from a rendered body. */
const listed = (name: string, source: string, body: string): Unsegmented => ({ name, source, text: block(name, body) });

/** A block from what the budget kept of its section. */
const fitted = (name: string, section: string, kept: Record<string, Array<string>>, joint = '\n'): Unsegmented => ({
  name,
  source: `kept.${section}`,
  section,
  text: block(name, (kept[section] ?? []).join(joint)),
});

/** The rendered bodies `assembleUser` lays out. */
export type UserBlocksInput = {
  nowText: string;
  spatial?: string;
  timezone: string;
  labels: Labels;
  senses: Senses;
  tools?: string;
  skillIndex?: string;
  channelDirectory?: string;
  directory?: string;
  kept: Record<string, Array<string>>;
  tempoText: string;
  task: string;
  chatItems: Array<TranscriptItem> | null;
  selfreflection?: {
    intro: string;
    plan: string;
    seeds: string;
    publicationPlaces: string;
    audienceRefused: string;
  } | null;
  errands?: { list: string; result: string } | null;
  intentions?: string;
  wake?: string;
  places?: string;
  previousThink?: string;
};

/** The `<chat>` body: renderTranscript over the kept lines, which joins their texts under a date header. */
const chatText = (items: Array<TranscriptItem>, timezone: string, labels: Labels): string =>
  renderTranscript(items, timezone, labels);

/** One part of a message's media (src/media/classify.ts#mediaParts). */
type MediaPart = { readonly attachments?: Array<{ readonly kind?: string; readonly previewText?: unknown } | null> };

/**
 * The body of `<now>`: the present moment (formatNow), then, when `periods` holds any (the
 * journal's off periods, src/memory/journal.ts#offPeriods, newest first), `labels.journal.offLead`
 * and one line per period: `offPaused` or `offStopped` with `{from}` / `{to}` (the date and
 * the clock in `timezone`, as a pulled channel's header writes them) and `{length}`
 * (formatDuration). A period whose label is missing is left out; without the lead, or with no
 * line left, the clock stands alone. `withClock` false (the request carries `<spatial_awareness>`, which holds the
 * time) leaves the clock out, and with no period line the body is ''. Per-turn: it sits in the tail, never in a cached
 * part.
 */
export function nowBlock(now: number, timezone: string, labels: Labels, periods: unknown, withClock = true): string {
  const clock = withClock ? formatNow(now, timezone, labels.locale) : '';
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
  return lines.length > 0 ? [clock, l.offLead, ...lines].filter(Boolean).join('\n') : clock;
}

/**
 * The blocks of the user message from already-rendered bodies, in three cache
 * segments (see docs/prompt-contract.md, "Cache segments"): the stable part
 * (`cacheSegment: 'stable'`), what changes least first: the stable
 * `<senses>` lines, `<tools>` (`tools`: her tools described in text, the text
 * transport only, changing only with a grant or a tool text), `<skills>` (`skillIndex`: the index of her active
 * skills, changing only when one is activated or disabled), `<self_facts>`, `<about_chat>`,
 * `<channel_directory>` (`channelDirectory`: the channels with their handles, changing
 * only when a channel is added, removed or renamed), `<directory>` (`directory`: the people
 * directory, changing only with a member's names or aliases); the profiles
 * (`cacheSegment: 'profiles'`: `<people>` with the interlocutor alone), then
 * the tail (no segment) with everything that changes from turn to turn -- a
 * second `<people>` with the other members first, `<tool_catalogue>` (the catalogue, on
 * a question about what the persona can do) and `<people_now>` (what is current about each
 * person: status, voice, activity, attitude) right before `<chat>` -- `<spatial_awareness>`, `<now>`, the per-turn
 * `<senses>` lines, `<tempo>` and `<task>` last. `senses` is
 * renderSenses' two halves. A segment with no block is left
 * out; every part but the last ends with the blank line that separates
 * blocks, so the parts' texts joined with nothing (userText) are the whole
 * user text. `cacheSegment` is a neutral tag: src/llm/openrouter.ts#withCacheMarker
 * turns it into the provider's marker under the cache policy and never sends it.
 * `errands`: the `<errands>` and `<errand_result>` bodies
 * (buildRequest's `input.errands`), in the tail before `<people_now>`. `selfreflection` (a selfreflection post only): the
 * `<diary>` block's intro, shown above its kept lines, the `<plan>` body and
 * the `<seeds>` body (a set post's seed combinations, right after the plan), the `<publication_places>` body after them and the `<audience_refused>` body, a refused audience she has not heard of.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.ts in stage 5d, a pure move
function userBlocks({
  nowText,
  spatial = '',
  timezone,
  labels,
  senses,
  tools = '',
  skillIndex = '',
  channelDirectory = '',
  directory = '',
  kept,
  tempoText,
  task,
  chatItems,
  selfreflection = null,
  errands = null,
  intentions = '',
  wake = '',
  places = '',
  previousThink = '',
}: UserBlocksInput): Array<ListedBlock> {
  const stable: Array<ListedBlock> = [
    listed('senses', 'senses.stable', senses.stable),
    // Her tools described in text (the text transport only; the native transport sends none): changes only when a grant or a skill text does.
    listed('tools', 'toolsBlock', tools),
    // The index of her active skills, one line each: changes only when a skill is activated, disabled or granted a tool.
    listed('skills', 'skillIndex', skillIndex),
    fitted('self_facts', 'self', kept),
    fitted('about_chat', 'aboutChat', kept),
    // Which channel has which handle: changes only when a channel is added, removed or renamed.
    listed('channel_directory', 'channelDirectory', channelDirectory),
    // Who can be mentioned and by which handle: changes only when a member's names or aliases do.
    listed('directory', 'directory', directory),
  ].map((one) => ({ ...one, segment: 'stable' as const }));
  // The interlocutor alone: constant while the same member talks to the persona.
  const profiles: Array<ListedBlock> = [fitted('people', 'interlocutor', kept, '\n\n')].map((one) => ({
    ...one,
    segment: 'profiles' as const,
  }));
  const chat: Unsegmented =
    chatItems === null
      ? { name: 'chat', source: 'kept.chat', section: 'chat', text: '', offKind: true }
      : {
          name: 'chat',
          source: 'kept.chat',
          section: 'chat',
          text: block('chat', chatText(chatItems, timezone, labels)),
        };
  const tail: Array<ListedBlock> = [
    // Everyone else `<people>` shows (asked about, then the compact participants): who they are
    // moves with every turn, so they open the tail, right where the one block stood.
    fitted('people', 'people', kept, '\n\n'),
    fitted('server', 'server', kept, '\n\n'),
    fitted('lore', 'lore', kept, '\n\n'),
    // The last hours: one item, the header with the kept lines and moments, oldest first.
    fitted('recent', 'recent', kept),
    // The persona's own exchanges on other channels: one item, the header and the episodes kept.
    fitted('participation', 'participation', kept),
    // This channel's lines older than `<chat>`: one item, moving only when a stored line leaves the chat.
    fitted('earlier', 'earlier', kept),
    // The members the persona feels most strongly about that `<people>` does not describe.
    fitted('attitudes', 'attitudes', kept),
    fitted('other_channels', 'neighbors', kept, '\n\n'),
    // Another channel pulled into this turn, one item per channel.
    fitted('channel_view', 'pulled', kept, '\n\n'),
    // A selfreflection post: the persona's world, its past posts, this post's plan and what its search found.
    fitted('world', 'world', kept),
    {
      name: 'diary',
      source: 'kept.selfreflection',
      section: 'selfreflection',
      text: block(
        'diary',
        (kept.selfreflection ?? []).length > 0
          ? [selfreflection?.intro, ...kept.selfreflection].filter(Boolean).join('\n')
          : ''
      ),
    },
    listed('plan', 'selfreflection.plan', selfreflection?.plan ?? ''),
    listed('seeds', 'selfreflection.seeds', selfreflection?.seeds ?? ''),
    listed('publication_places', 'selfreflection.publicationPlaces', selfreflection?.publicationPlaces ?? ''),
    listed('audience_refused', 'selfreflection.audienceRefused', selfreflection?.audienceRefused ?? ''),
    fitted('found', 'found', kept),
    // Right before the chat it answers a question from.
    fitted('lookup', 'lookup', kept),
    // What the automatic memory prefetch found for this trigger: per turn, next to the chat.
    fitted('retrieved', 'prefetch', kept),
    // The catalogue of her tools with her access here, when she was asked what she can do.
    fitted('tool_catalogue', 'tool_catalogue', kept),
    // Her errands under way or newly finished, then the one whose end opened this turn: per turn (ages move).
    listed('errands', 'errands.list', errands?.list ?? ''),
    listed('errand_result', 'errands.result', errands?.result ?? ''),
    // Her intentions and the candidates proposed from her own lines: per turn.
    listed('intentions', 'intentions', intentions),
    // An inner turn's reason to be awake (src/behavior/wake.ts, mode `inner` only): per turn.
    listed('wake', 'wake', wake),
    // The places page of an addressed turn (`context.places`; src/behavior/wake.ts#placesBlockText): per turn.
    listed('places', 'places', places),
    // Her one previous think (src/behavior/previous-think.ts): per turn, right before the people it concerns.
    listed('previous_think', 'previousThink', previousThink),
    // What is current about each person: the live snapshot and what changes from turn to turn
    // in memory. Tail only, right before the chat.
    fitted('people_now', 'peopleNow', kept),
    chat,
    // Where she is and the present moment (src/turn/request/spatial.ts): per turn, so never in a cached part.
    listed('spatial_awareness', 'spatial', spatial),
    // The present moment after the history it dates, with the persona's recent time away (nowBlock).
    listed('now', 'now', nowText),
    // The per-turn senses lines (renderSenses' `turn` half); the rest lead the stable part.
    listed('senses', 'senses.turn', senses.turn),
    listed('tempo', 'tempo', tempoText),
    listed('task', 'task', task),
  ].map((one) => ({ ...one, segment: 'tail' as const }));
  return [...stable, ...profiles, ...tail];
}

/** The user message's text parts from its listed blocks: see `userBlocks` for the order and the segments. */
function userParts(blocks: ReadonlyArray<ListedBlock>): Array<UserPart> {
  const segments = (['stable', 'profiles', 'tail'] as const)
    .map((segment) => ({
      text: blocks
        .filter((one) => one.segment === segment)
        .map((one) => one.text)
        .filter(Boolean)
        .join('\n\n'),
      cacheSegment: segment === 'tail' ? null : segment,
    }))
    .filter((segment) => segment.text);
  return segments.map(({ text, cacheSegment }, i) => ({
    type: 'text' as const,
    text: i < segments.length - 1 ? `${text}\n\n` : text,
    ...(cacheSegment ? { cacheSegment } : {}),
  }));
}

/**
 * What the archive keeps of each listed block (src/llm/archive.ts): its size and why it holds what it holds. A block the
 * budget shortened or emptied (`stats`, a section's `dropped`) is `cut`, a block this kind of turn never has `not_for_kind`.
 */
function blockRecords(
  blocks: ReadonlyArray<ListedBlock>,
  stats: Readonly<Record<string, { readonly dropped?: number } | undefined>>
): Array<BlockRecord> {
  return blocks.map(({ name, segment, source, section, text, offKind }) => {
    const cut = section !== undefined && (stats[section]?.dropped ?? 0) > 0;
    const reason = offKind === true ? 'not_for_kind' : cut ? 'cut' : text ? 'kept' : 'empty';
    return { name, chars: text.length, segment, source, reason };
  });
}

/**
 * The user message of a request and the archive's record of it: `parts` go to the provider, `blocks` name every block
 * listed, an empty one with no characters. `stats` is the budget's fit.
 */
export function assembleUser(
  given: UserBlocksInput,
  stats: Readonly<Record<string, { readonly dropped?: number } | undefined>>
): { parts: Array<UserPart>; blocks: Array<BlockRecord> } {
  const blocks = userBlocks(given);
  return { parts: userParts(blocks), blocks: blockRecords(blocks, stats) };
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
