// The pure side of one step of a turn that calls tools: how a step's calls are ordered, whether her
// speech may go out after them, the messages the next request appends (the same shape on both
// transports), the note that ends them, the rescue request of a turn left with no answer, the numbers of the lines that came in meanwhile, the room
// that is left, and whether her answer began with her thinking. Nothing here reads a clock, a
// config or the network; the turn (src/behavior/turn.ts) and the replay sandbox (src/behavior/sandbox.ts)
// pass in what they know.

import { fill } from '../format.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { apiNameOf } from '../tools/definitions.ts';
import { coversSpeech } from '../tools/tool-calls.ts';
import type { Definition } from '../tools/definitions.ts';
import type { Untyped } from '../tools/types.ts';

/**
 * The calls of a step in the order they run, as segments `{ parallel, calls }`: a run of consecutive
 * reads is one parallel segment, every other call is a segment of its own (a barrier), in her order.
 * @param isRead  Whether the call's skill only reads.
 */
export function segments(
  calls: Array<Record<string, Untyped>>,
  isRead: (call: Record<string, Untyped>) => boolean
): Array<{ parallel: boolean; calls: Array<Record<string, Untyped>> }> {
  const out = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const read = isRead(call) === true;
    const last = out.at(-1);
    if (read && last?.parallel) last.calls.push(call);
    else out.push({ parallel: read, calls: [call] });
  }
  return out;
}

/**
 * What a step's calls mean for her speech and for the next request. `speak`: every call worked and
 * its definition's result is an effect or a job (src/tools/tool-calls.ts#coversSpeech), so her
 * speech goes out after them; with no calls it is true. `fresh`: some call returned something to
 * read (a `data` result) or did not work (or has no definition), or an inner turn still has an open follow-up, so a request
 * follows when there is room.
 * @param outcomes  One per call, in order.
 */
export function stepVerdict(
  outcomes: Array<{ name: string; result: { status?: string } }>,
  {
    definitionOf,
    openFollowUp = false,
  }: { definitionOf: (name: string) => { result?: Definition['result'] } | null | undefined; openFollowUp?: boolean }
): { speak: boolean; fresh: boolean } {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const speak = list.every((outcome) => coversSpeech(definitionOf(outcome.name), outcome.result));
  const fresh =
    openFollowUp === true ||
    list.some(
      (outcome) =>
        outcome.result?.status !== 'ok' || !definitionOf(outcome.name) || definitionOf(outcome.name)?.result === 'data'
    );
  return { speak, fresh };
}

const textPart = (text: string) => ({ type: 'text', text });

/**
 * The messages of the next request: `messages` as they were, her answer, one result per call (always,
 * refused and capped ones included, in call order), and the note when there is one. Native: her
 * assistant message with `tool_calls` (null content when she wrote no text), then one `role: 'tool'`
 * message per call, then the note as a user message. Text: her raw text as the assistant message, then
 * one user message whose parts are a `<tool_result id name status>` block per call and the note.
 * A fresh array; the input is not changed, and the first messages are never rebuilt.
 */
export function appendStep({
  transport,
  messages,
  rawText = '',
  calls,
  results,
  note = '',
}: {
  transport: 'native' | 'text';
  messages: Array<Record<string, Untyped>>;
  rawText?: string;
  calls: Array<{ id: string; name: string; apiName?: string; args?: Untyped }>;
  results: Array<{ text: string; status?: string }>;
  note?: string;
}): Array<Record<string, Untyped>> {
  const out = [...(Array.isArray(messages) ? messages : [])];
  const list = Array.isArray(calls) ? calls : [];
  const answers = Array.isArray(results) ? results : [];
  if (transport === 'text') {
    out.push({ role: 'assistant', content: rawText });
    const parts = list.map((call, i) =>
      textPart(
        `<tool_result id="${call.id}" name="${call.name}" status="${answers[i]?.status ?? 'failed'}">\n${answers[i]?.text ?? ''}\n</tool_result>`
      )
    );
    if (note) parts.push(textPart(note));
    if (parts.length > 0) out.push({ role: 'user', content: parts });
    return out;
  }
  out.push({
    role: 'assistant',
    content: rawText === '' ? null : rawText,
    ...(list.length > 0
      ? {
          tool_calls: list.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.apiName ?? apiNameOf(call.name) ?? call.name,
              arguments: JSON.stringify(call.args ?? {}),
            },
          })),
        }
      : {}),
  });
  list.forEach((call, i) => out.push({ role: 'tool', tool_call_id: call.id, content: answers[i]?.text ?? '' }));
  if (note) out.push({ role: 'user', content: [textPart(note)] });
  return out;
}

/** One earlier result `giveWay` may replace: where it sits, and the name of the tool that made it. */
type ResultSlot = { at: number; part: number | null; tool: string };

/** The opening tag of a text-transport result, its tool's name in the second group. */
const RESULT_OPEN = /^(<tool_result id="[^"]*" name="([^"]*)" status="[^"]*">)\n/;

/** A call of an assistant message and a part of a user message, as far as `giveWay` reads them. */
type AskedCall = { id?: unknown; function?: { name?: string } };
type Part = Record<string, unknown> & { text?: unknown };

/** The parts of a message whose content is a list, else none. */
const partsOf = (message: Record<string, Untyped>): Array<Part> =>
  Array.isArray(message.content) ? (message.content as Array<Part>) : [];

/**
 * The earlier results of `messages` after the first `keep`, oldest first. Native: every `role: 'tool'` message, named
 * by the call of the assistant message that asked for it. Text: every `<tool_result>` part of a user message.
 */
function resultSlots(messages: Array<Record<string, Untyped>>, keep: number): Array<ResultSlot> {
  const names = new Map<string, string>();
  const slots: Array<ResultSlot> = [];
  messages.forEach((message, at) => {
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []) as Array<AskedCall>;
    for (const call of calls) names.set(String(call.id), call.function?.name ?? '');
    if (at < keep) return;
    if (message.role === 'tool') slots.push({ at, part: null, tool: names.get(String(message.tool_call_id)) ?? '' });
    else if (message.role === 'user')
      partsOf(message).forEach((part, index) => {
        const open = RESULT_OPEN.exec(typeof part?.text === 'string' ? part.text : '');
        if (open) slots.push({ at, part: index, tool: open[2] });
      });
  });
  return slots;
}

/** `messages` with the result at `slot` replaced by `line`; a fresh array, the input unchanged. */
function replaceSlot(
  messages: Array<Record<string, Untyped>>,
  slot: ResultSlot,
  line: string
): Array<Record<string, Untyped>> {
  const out = [...messages];
  const message = out[slot.at];
  if (slot.part === null) out[slot.at] = { ...message, content: line };
  else {
    const parts = [...partsOf(message)];
    const { text } = parts[slot.part];
    const open = RESULT_OPEN.exec(typeof text === 'string' ? text : '')?.[1] ?? '';
    parts[slot.part] = { ...parts[slot.part], text: `${open}\n${line}\n</tool_result>` };
    out[slot.at] = { ...message, content: parts };
  }
  return out;
}

/**
 * Room for the next request when it would pass the cap: the results of earlier steps in `messages` replaced, oldest
 * first, by `line` with `{tool}` filled with the tool's name, as few as it takes for `fits` to hold. The first `keep`
 * messages (the turn's first request) are never touched, and neither is anything the caller appends after `messages`.
 * Returns the messages and whether they fit; when nothing older is left they come back with every earlier result
 * replaced and `fits` false. A fresh array; the input is not changed.
 * @param fits  Whether the request built on the given messages fits under the cap.
 */
export function giveWay({
  messages,
  keep,
  line,
  fits,
}: {
  messages: Array<Record<string, Untyped>>;
  keep: number;
  line: string;
  fits: (messages: Array<Record<string, Untyped>>) => boolean;
}): { messages: Array<Record<string, Untyped>>; fits: boolean } {
  let out = [...messages];
  for (const slot of resultSlots(messages, keep)) {
    const text = fill(line, { tool: slot.tool });
    const before = out;
    out = replaceSlot(out, slot, text);
    // A result replaced in an earlier step is the same line already: replacing it again makes no room.
    if (JSON.stringify(before[slot.at]) === JSON.stringify(out[slot.at])) continue;
    if (fits(out)) return { messages: out, fits: true };
  }
  return { messages: out, fits: false };
}

/** The words of `labels.task` a step's trailing note reads. */
export type StepLabels =
  | {
      task?: {
        step?: {
          held?: string;
          delta?: string;
          late?: string;
          delivery?: string;
          last?: string;
          lastInner?: string;
          rescue?: string;
          cut?: string;
          dropped?: string;
        };
        diagnostics?: string;
      };
    }
  | null
  | undefined;

/**
 * The trailing note of a step, lines in this order: a notice that her speech was held (it does not
 * repeat her text), the lines that came in meanwhile under their lead, the lines whose media
 * was not ready in the first request and is now (`lateText`) under theirs, one line per message that
 * did not go out, the last-step notice, the open-intentions line of an inner turn, and the parser's
 * diagnostics under their header. Every word from `labels.task`; '' when there is nothing to say.
 */
export function stepNote({
  labels,
  held = false,
  deltaText = '',
  lateText = '',
  deliveries = [],
  last = false,
  terminal = false,
  open = '',
  diagnostics = [],
}: {
  labels: StepLabels;
  held?: boolean;
  deltaText?: string;
  lateText?: string;
  deliveries?: Array<{ n: number; total: number; code: string }>;
  last?: boolean;
  terminal?: boolean;
  open?: string;
  diagnostics?: Array<string>;
}): string {
  const task = labels?.task ?? {};
  const step = task.step ?? {};
  const lines: Array<string> = [];
  if (held && step.held) lines.push(step.held);
  if (deltaText) lines.push([step.delta, deltaText].filter(Boolean).join('\n'));
  if (lateText) lines.push([step.late, lateText].filter(Boolean).join('\n'));
  for (const item of Array.isArray(deliveries) ? deliveries : [])
    if (step.delivery) lines.push(fill(step.delivery, item));
  // An inner turn's last step still allows one terminal call: its own notice, else the ordinary one.
  if (last) {
    const notice = terminal && step.lastInner ? step.lastInner : step.last;
    if (notice) lines.push(notice);
  }
  if (open) lines.push(open);
  const found = (Array.isArray(diagnostics) ? diagnostics : []).filter(Boolean);
  if (found.length > 0) lines.push([task.diagnostics, ...found].filter(Boolean).join('\n'));
  return lines.join('\n\n');
}

/**
 * The rescue request of a turn whose steps ended with no final answer: the turn's first messages as they
 * were, then one user message with `labels.task.step.rescue`. The same shape on both transports; a fresh
 * array. With the label missing the request is the first messages alone.
 */
export function rescueRequest({
  messages,
  labels,
}: {
  messages: Array<Record<string, Untyped>>;
  labels: StepLabels;
}): Array<Record<string, Untyped>> {
  const out = [...(Array.isArray(messages) ? messages : [])];
  const step = labels?.task?.step ?? {};
  const note = step.rescue;
  if (note) out.push({ role: 'user', content: [textPart(note)] });
  return out;
}

/**
 * The lines that came in since the last request, numbered on past every number already in use, her
 * own lines left out (she wrote them and has them in her answer). `floor` is the request's highest
 * line number, `taken` the highest number any handle holds (a memory.search's, an earlier delta's),
 * so the new numbers never meet one. Render `lines` with `indexOffset: offset`; `idByIndex` takes the
 * new entries; `next` is the first free number after them.
 */
export function deltaLines({
  lines,
  floor = 0,
  taken = 0,
  ownIds = [],
}: {
  lines: Array<{ id: string }>;
  floor?: number;
  taken?: number;
  ownIds?: Iterable<string>;
}): { lines: Array<Record<string, Untyped>>; offset: number; idByIndex: Map<number, string>; next: number } {
  const own = new Set(ownIds);
  const offset = Math.max(Number(floor) || 0, Number(taken) || 0);
  const kept = (Array.isArray(lines) ? lines : []).filter((line) => line && !own.has(line.id));
  const idByIndex = new Map(kept.map((line, i) => [offset + i + 1, line.id]));
  return { lines: kept, offset, idByIndex, next: offset + kept.length + 1 };
}

/**
 * The room a step leaves. `step` counts the continuation requests made so far (0 is the answer to
 * the reply request), `maxSteps` the continuation requests allowed, the last of which is always the
 * final no-action request. Returns `{ run, capReason, next, tokensOver }`: whether this answer's calls
 * run (`false` with `capReason` `steps` for the final answer's calls, `time` when the budget is
 * spent), and what follows: `normal` (a request that may call again), `final` (a request that
 * cannot), or `none` (nothing follows the final answer). `tokensOver`: the request about to be sent
 * (`tokens.used` = the messages plus the tools) is over `tokens.max` less the output reserve; the
 * next request is then final too, once the results are cut to fit (see {@link cutToFit}).
 */
export function roomLeft({
  step,
  maxSteps,
  elapsedMs = 0,
  timeBudgetMs = Infinity,
  tokens = null,
}: {
  step: number;
  maxSteps: number;
  elapsedMs?: number;
  timeBudgetMs?: number;
  tokens?: { used: number; max: number; reserve?: number } | null;
}): { run: boolean; capReason: string | null; next: 'normal' | 'final' | 'none'; tokensOver: boolean } {
  const tokensOver = tokens !== null && tokens.used > tokens.max - (tokens.reserve ?? 0);
  if (step >= maxSteps) return { run: false, capReason: 'steps', next: 'none', tokensOver };
  const timeSpent = elapsedMs >= timeBudgetMs;
  const finalNext = step >= maxSteps - 1 || timeSpent || tokensOver;
  return { run: !timeSpent, capReason: timeSpent ? 'time' : null, next: finalNext ? 'final' : 'normal', tokensOver };
}

/**
 * `texts` cut so that together they lose about `excess` characters, the longest first, none below
 * `floor` characters (an ellipsis closes a cut one). A fresh array; what cannot be cut stays.
 */
export function cutToFit(texts: Array<string>, excess: number, floor: number = 400): Array<string> {
  const lengths = texts.map((text) => Array.from(text).length);
  const need = Math.max(0, Math.ceil(excess));
  if (need === 0) return [...texts];
  const lost = (level: Untyped) => lengths.reduce((sum, length) => sum + Math.max(0, length - level), 0);
  // The highest common length that sheds what is asked, never below the floor: the longest texts come down to it together.
  let low = floor;
  let high = Math.max(floor, ...lengths);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lost(middle) >= need) low = middle;
    else high = middle - 1;
  }
  return texts.map((text, i) => (lengths[i] > low ? clampWithEllipsis(text, low) : text));
}

/** Whether her answer did not begin with her thinking: the trimmed text does not start with `<think>`. */
export function thinkMissing(text: string): boolean {
  return !String(text ?? '')
    .trim()
    .startsWith('<think>');
}
