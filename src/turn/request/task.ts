// The task of a turn's request: which prompt file frames it, the trigger's label, what else the author waits for and
// the private chat's addition, and the
// check of a follow-up's own task. buildRequest (src/behavior/prompt.ts) and the request phase's facts
// (src/turn/phases/request/facts.ts) call them.

import { kindOfRequest } from './frame.ts';
import { fill, formatDuration } from '../../format.ts';
import { fillPromptTemplate } from './text.ts';
import type { Base } from './head.ts';
import type { Labels, RequestInput, TranscriptItem } from './types.ts';

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
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.ts in stage 5d, a pure move
export function renderTasks(
  tasks: Tasks | null | undefined,
  labels: Labels,
  { chatItems = [], now = 0 }: { chatItems?: Array<TranscriptItem>; now?: number } = {}
): string {
  if (!tasks) return '';
  const queued = Array.isArray(tasks.queued) ? tasks.queued : [];
  const added = Array.isArray(tasks.added) ? tasks.added : [];
  const texts: Array<string> = [];
  // A recovery turn's messages left unanswered earlier (src/behavior/missed.ts), first.
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
 * `taggedCall` exactly false -- src/behavior/mention.ts#isTaggedCall, as decideMention reads it).
 * A mention, a tagged reply (or one whose tagged state is unknown), a name call, an overheard
 * line and a private chat keep their usual task. Pure.
 */
export function usesFollowUpTask({
  mode,
  triggerKind,
  taggedCall = null,
  dmChat = false,
}: {
  mode: string;
  triggerKind: string | null | undefined;
  taggedCall?: boolean | null;
  dmChat?: boolean;
}): boolean {
  if (mode !== 'reply' || dmChat) return false;
  return triggerKind === 'followUp' || (triggerKind === 'reply' && taggedCall === false);
}

/** A request's task: whether the trigger was overheard, and the task text. */
export type Task = {
  overheard: boolean;
  fittedTask: string;
};

/**
 * The task text of a turn: the mode's prompt file, or the overheard, errand, follow-up, heartbeat or selfimprovement file in its place,
 * then what else the author waits for and the private chat's addition.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function taskOf(given: RequestInput & Base): Task {
  const { prompts, mode, now, selfName, trigger, triggerKind } = given;
  const { labels, dmChat, chatItems } = given;
  const chatTrigger = trigger ? (chatItems.find((item) => item.id === trigger.id) ?? null) : null;
  // A follow-up (triggerKind: 'followUp') falls back to labels.triggers.reply
  // when an older labels.json has no dedicated label yet -- see prompt-contract.md.
  // An overheard line (triggerKind: 'overheard') falls back to the follow-up's label, then reply's.
  const overheard = triggerKind === 'overheard';
  const triggerLabel = overheard
    ? (labels.triggers?.overheard ?? labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
    : triggerKind === 'followUp'
      ? (labels.triggers?.followUp ?? labels.triggers?.reply ?? '')
      : (labels.triggers?.[String(triggerKind)] ?? '');
  // An overheard turn has its own task text (prompts.overheard) INSTEAD of the mode's; without
  // it (missing or blank) the mode's text frames the line as said to the persona: degraded.
  const overheardTask =
    overheard && typeof prompts.overheard === 'string' && prompts.overheard.trim() ? prompts.overheard : null;
  // A heartbeat's and a selfimprovement wake's inner turn have their own task text (prompts.heartbeat,
  // prompts.selfimprovement) INSTEAD of inner.md; without it (missing or blank) inner.md applies (degraded).
  const turnKind = kindOfRequest(given);
  const ownWakeMd =
    turnKind === 'heartbeat' ? prompts.heartbeat : turnKind === 'selfimprovement' ? prompts.selfimprovement : null;
  const ownWakeTask = typeof ownWakeMd === 'string' && ownWakeMd.trim() ? ownWakeMd : null;
  // The turn a finished errand opens with no origin message (asked in an inner turn of hers, or
  // the message is gone) has its own task text (prompts['errand-result']) instead of the mode's. Missing or blank, the
  // mode's text applies.
  const errandMd = prompts['errand-result'];
  const errandTask =
    turnKind === 'errand_result' && !trigger && typeof errandMd === 'string' && errandMd.trim() ? errandMd : null;
  // A follow-up or an untagged reply has its own task text (prompts['follow-up']) INSTEAD of
  // reply.md; without it (missing or blank) reply.md frames it, as before the file existed.
  const followUpPrompt = prompts['follow-up'];
  const followUpTask =
    usesFollowUpTask({ mode, triggerKind, taggedCall: given.taggedCall, dmChat }) &&
    typeof followUpPrompt === 'string' &&
    followUpPrompt.trim()
      ? followUpPrompt
      : null;
  // What else the author waits for: the part answered now and the rest, their queued calls, and
  // their later messages about this call.
  const tasksText = renderTasks(given.tasks, labels, { chatItems, now });
  const taskValues = {
    name: selfName,
    author: trigger?.authorName ?? '',
    trigger: triggerLabel,
    target: chatTrigger ? `#${chatTrigger.index}` : '',
  };
  const baseTask = fillPromptTemplate(
    overheardTask ?? errandTask ?? followUpTask ?? ownWakeTask ?? prompts[mode] ?? '',
    taskValues
  );
  // Private chat: prompts.private follows the mode prompt; a missing file adds nothing.
  const privateText =
    dmChat && typeof prompts.private === 'string' && prompts.private.trim()
      ? fillPromptTemplate(prompts.private, taskValues)
      : '';
  return { overheard, fittedTask: [baseTask, tasksText, privateText].filter(Boolean).join('\n\n') };
}
