// The task of a turn's request: which prompt file frames it, the trigger's label, where a routed call came from, the
// room's question, what else the author waits for, the private chat's and the forced turn's additions, and the
// check of a follow-up's own task. buildRequest (src/behavior/prompt.js) and the request phase's facts
// (src/turn/phases/request/facts.ts) call them.

import { fill, formatDuration } from '../../format.js';
import { currentChannelFallback } from './server.ts';
import { fillPromptTemplate } from './text.ts';
import type { Base } from './head.ts';
import type { PulledView } from './pulled.ts';
import type { Cost, Fit, Labels, RequestInput, TranscriptItem } from './types.ts';

/** What else the trigger's author is waiting for (buildRequest's `input.tasks`). */
export type Tasks = {
  readonly part?: { readonly index: number; readonly total?: number; readonly parts: Array<string> } | null;
  readonly queued?: Array<string>;
  readonly queuedOthers?: Array<{ readonly author?: string; readonly text: string } | null>;
  readonly added?: Array<string>;
  readonly missed?: Array<{ readonly author?: string; readonly text: string } | null>;
  readonly failedEarlier?: Array<{
    readonly author?: string;
    readonly messageId: string;
    readonly link?: string;
    readonly at?: number;
    readonly code?: string;
  } | null>;
};

// How the task labels list several items inline: `{others}` and `{added}` sit inside a sentence.
const TASK_ITEM_JOIN = '; ';

/** `texts` as `<n>. <text>` items, numbered from `first`. */
function numberedItems(texts: Array<string>, first: number): Array<string> {
  return texts.map((text, i) => `${first + i}. ${text}`);
}

/**
 * The task labels for buildRequest's `input.tasks` (see there), joined by a
 * blank line: `labels.task.missed` (a recovery turn's messages, `{missed}`:
 * `<n>. <author>: <text>` joined by `; `), then `labels.task.part` (or,
 * without a usable part, `labels.task.queued`), then
 * `labels.task.queuedOthers`, then `labels.task.added`, then one `labels.task.failedEarlier` line
 * per `failedEarlier` entry (`{ author, messageId, link, at, code }`: `{author}`, `{n}` the
 * message's `#n` in the transcript else its `link`, `{ago}` through `labels.units`, `{code}`).
 * '' when nothing applies.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function renderTasks(
  tasks: Tasks | null | undefined,
  labels: Labels,
  { chatItems = [], now = 0 }: { chatItems?: Array<TranscriptItem>; now?: number } = {}
): string {
  if (!tasks) return '';
  const queued = Array.isArray(tasks.queued) ? tasks.queued : [];
  const added = Array.isArray(tasks.added) ? tasks.added : [];
  const texts: Array<string> = [];
  // A recovery turn's messages left unanswered earlier (src/behavior/missed.js), first.
  const missed = Array.isArray(tasks.missed)
    ? tasks.missed.filter((item): item is NonNullable<typeof item> => Boolean(item && item.text))
    : [];
  if (missed.length > 0 && labels.task?.missed) {
    const items = numberedItems(
      missed.map((item) => `${item.author ?? ''}: ${item.text}`),
      1
    );
    texts.push(fill(labels.task.missed, { missed: items.join(TASK_ITEM_JOIN) }));
  }
  const part = tasks.part;
  const parts = Array.isArray(part?.parts) ? part.parts : [];
  const usablePart =
    Boolean(part) && Number.isInteger(part?.index) && (part?.index ?? 0) >= 1 && (part?.index ?? 0) <= parts.length;
  if (part && usablePart && labels.task?.part) {
    const otherParts = numberedItems(parts, 1).filter((_, i) => i + 1 !== part.index);
    const others = [...otherParts, ...numberedItems(queued, parts.length + 1)].join(TASK_ITEM_JOIN);
    texts.push(
      fill(labels.task.part, {
        index: part.index,
        total: part.total ?? parts.length,
        part: parts[part.index - 1],
        others,
      })
    );
  } else if (!usablePart && queued.length > 0 && labels.task?.queued) {
    texts.push(fill(labels.task.queued, { others: numberedItems(queued, 1).join(TASK_ITEM_JOIN) }));
  }
  const others = Array.isArray(tasks.queuedOthers)
    ? tasks.queuedOthers.filter((call): call is NonNullable<typeof call> => Boolean(call && call.text))
    : [];
  if (others.length > 0 && labels.task?.queuedOthers) {
    const items = numberedItems(
      others.map((call) => `${call.author ?? ''}: ${call.text}`),
      1
    );
    texts.push(fill(labels.task.queuedOthers, { others: items.join(TASK_ITEM_JOIN) }));
  }
  if (added.length > 0 && labels.task?.added)
    texts.push(fill(labels.task.added, { added: added.join(TASK_ITEM_JOIN) }));
  // Earlier requests in this channel that the engine failed to answer: one line each, last.
  const failed = Array.isArray(tasks.failedEarlier)
    ? tasks.failedEarlier.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.messageId))
    : [];
  const failedLabel = labels.task?.failedEarlier;
  if (failed.length > 0 && failedLabel && labels.units) {
    const lines = failed.map((entry) => {
      const shown = chatItems.find((item) => item.id === entry.messageId);
      return fill(failedLabel, {
        author: entry.author ?? '',
        n: shown ? `#${shown.index}` : (entry.link ?? ''),
        ago: formatDuration(Math.max(0, now - (entry.at ?? now)), labels.units),
        code: entry.code ?? '',
      });
    });
    texts.push(lines.join('\n'));
  }
  return texts.join('\n\n');
}

/**
 * Whether a turn's task text is `prompts['follow-up']` instead of `prompts.reply`: a reply-mode
 * turn answering a follow-up (`followUp`: an untagged line the address classifier marked as said
 * to the persona) or an untagged `reply` (a platform reply to the persona's line with no typed tag,
 * `taggedCall` exactly false -- src/behavior/mention.js#isTaggedCall, as decideMention reads it).
 * A mention, a tagged reply (or one whose tagged state is unknown), a name call, an overheard
 * line, a routed call and a private chat keep their usual task. Pure.
 */
export function usesFollowUpTask({
  mode,
  triggerKind,
  taggedCall = null,
  routed = false,
  privateChat = false,
}: {
  mode: string;
  triggerKind: string | null | undefined;
  taggedCall?: boolean | null;
  routed?: boolean;
  privateChat?: boolean;
}): boolean {
  if (mode !== 'reply' || routed || privateChat) return false;
  return triggerKind === 'followUp' || (triggerKind === 'reply' && taggedCall === false);
}

/** A request's task: the routed call's line, whether the trigger was overheard, and the task text either way. */
export type Task = {
  pulledTrigger: TranscriptItem | null;
  overheard: boolean;
  composeTask: (callShown: boolean) => string;
  fittedTask: string;
};

/**
 * The task text of a turn: the mode's prompt file, or the overheard, errand, follow-up or heartbeat file in its place,
 * then the routed call's origin, the room's question, what else the author waits for, the private chat's and the
 * forced turn's additions.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function taskOf(given: RequestInput & Base & PulledView): Task {
  const { prompts, mode, forced, now, selfName, history, trigger, triggerKind, channels, currentChannelId } = given;
  const { labels, privateChat, chatItems, source, routed, offered, chatTrigger, pulledTriggerId, pulledSets } = given;
  // The trigger's line in another channel (a routed call), when a pulled channel holds it.
  const pulledTrigger =
    pulledTriggerId !== null
      ? (pulledSets.flatMap((channel) => channel.items).find((item) => item.id === pulledTriggerId) ?? null)
      : null;
  // A follow-up (triggerKind: 'followUp') falls back to labels.triggers.reply
  // when an older labels.json has no dedicated label yet -- see prompt-contract.md.
  // An overheard line (triggerKind: 'overheard') falls back to the follow-up's label, then reply's.
  const overheard = triggerKind === 'overheard';
  const triggerLabel = overheard
    ? (labels.triggers?.overheard ?? labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
    : triggerKind === 'followUp'
      ? (labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
      : (labels.triggers?.[String(triggerKind)] ?? '');
  // A turn about another channel (routed or noticed) names both channels in its task: the
  // source, and this one, where the words go (its live name first).
  const sourceChannel = source ? (offered.find((channel) => channel.channelId === source.channelId) ?? null) : null;
  const here = sourceChannel
    ? (currentChannelFallback(currentChannelId, history)?.name ??
      (given.elsewhereDestination?.name || null) ??
      channels.find((channel) => channel?.id === currentChannelId)?.name ??
      '')
    : '';
  // An overheard turn has its own task text (prompts.overheard) INSTEAD of the mode's; without
  // it (missing or blank) the mode's text frames the line as said to the persona: degraded.
  const overheardTask =
    overheard && typeof prompts.overheard === 'string' && prompts.overheard.trim() ? prompts.overheard : null;
  // A heartbeat's inner turn has its own task text (prompts.heartbeat) INSTEAD of inner.md; without
  // it (missing or blank) inner.md applies (degraded).
  const heartbeatTask =
    mode === 'inner' &&
    given.wakeKind === 'heartbeat' &&
    typeof prompts.heartbeat === 'string' &&
    prompts.heartbeat.trim()
      ? prompts.heartbeat
      : null;
  // The turn a finished errand opens with no origin message (asked in an inner turn of hers, or
  // the message is gone) has its own task text (prompts['errand-result']) INSTEAD of the mode's:
  // interject.md would frame her own errand's end as a conversation to stay out of. Missing or
  // blank, the mode's text applies (degraded).
  const errandMd = prompts['errand-result'];
  const errandTask =
    triggerKind === 'errand' && !trigger && typeof errandMd === 'string' && errandMd.trim() ? errandMd : null;
  // A follow-up or an untagged reply has its own task text (prompts['follow-up']) INSTEAD of
  // reply.md; without it (missing or blank) reply.md frames it, as before the file existed.
  const followUpPrompt = prompts['follow-up'];
  const followUpTask =
    usesFollowUpTask({ mode, triggerKind, taggedCall: given.taggedCall, routed, privateChat }) &&
    typeof followUpPrompt === 'string' &&
    followUpPrompt.trim()
      ? followUpPrompt
      : null;
  // A line put to everyone present (a room question), found in the chat.
  const focus = privateChat ? null : (given.focus ?? null);
  const focusItem = focus ? chatItems.find((item) => item.id === focus.id) : null;
  const focusText =
    focus && focusItem && labels.room?.focus
      ? fill(labels.room.focus, { author: focus.authorName ?? '', target: `#${focusItem.index}` })
      : '';
  // What else the author waits for: the part answered now and the rest, their queued calls, and
  // their later messages about this call.
  const tasksText = renderTasks(given.tasks, labels, { chatItems, now });
  // The task text. `callShown`: whether the pulled trigger's line made it into
  // `<channel_view>` -- a task never points at a line the request does not show.
  // health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
  const composeTask = (callShown: boolean) => {
    const callItem = chatTrigger ?? (callShown ? pulledTrigger : null);
    const taskValues = {
      name: selfName,
      author: trigger?.authorName ?? '',
      trigger: triggerLabel,
      target: callItem ? `#${callItem.index}` : '',
      ...(sourceChannel ? { channel: sourceChannel.name, destination: here } : {}),
    };
    const baseTask = fillPromptTemplate(
      overheardTask ?? errandTask ?? followUpTask ?? heartbeatTask ?? prompts[mode] ?? '',
      taskValues
    );
    // Owner-forced turn (`/nep interject`/`/nep initiate`): tell the model
    // `<skip/>` is not the expected outcome this time -- optional, missing
    // prompts.forced (an older/undeployed labels layer) leaves the task as-is.
    const forcedText =
      forced && typeof prompts.forced === 'string' && prompts.forced.trim()
        ? fillPromptTemplate(prompts.forced, taskValues)
        : '';
    // Private chat: prompts.private follows the mode prompt; a missing file adds nothing.
    const privateText =
      privateChat && typeof prompts.private === 'string' && prompts.private.trim()
        ? fillPromptTemplate(prompts.private, taskValues)
        : '';
    // A routed call: where it came from and where the words go follow the mode's text, while
    // the call is shown and this channel has a name.
    const calledText =
      routed && sourceChannel && callItem && here && labels.elsewhere?.called
        ? fill(labels.elsewhere.called, { channel: sourceChannel.name, destination: here })
        : '';
    return [baseTask, calledText, focusText, tasksText, privateText, forcedText].filter(Boolean).join('\n\n');
  };
  // Fitted as if the call's line is shown: the pulled block keeps it whenever the request has
  // room for it (see fitPulledChannel); checked once the budget is spent.
  const fittedTask = composeTask(true);
  return { pulledTrigger, overheard, composeTask, fittedTask };
}

/**
 * A call whose line did not make it into the block is not pointed at: the task loses its target and the called text.
 * The request only gets shorter, so the fit holds. Fills `fit`; the task text.
 */
export function finalTask(
  fit: Fit,
  given: Task & { cost: Cost },
  pulledKept: Array<{ ids: Array<string | undefined> }>
): string {
  const { stats } = fit;
  let { used } = fit;
  const { pulledTrigger, composeTask, fittedTask, cost } = given;
  const callShown = pulledKept.some((shown) => shown.ids.includes(pulledTrigger?.id));
  const task = pulledTrigger && !callShown ? composeTask(false) : fittedTask;
  if (task !== fittedTask) {
    const saved = cost(fittedTask) - cost(task);
    stats.fixed.used -= saved;
    used -= saved;
  }
  fit.used = used;
  return task;
}
