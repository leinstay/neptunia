// The pure side of one step of a turn that calls tools: how a step's calls are ordered, whether her
// speech may go out after them, the messages the next request appends (the same shape on both
// transports), the note that ends them, the numbers of the lines that came in meanwhile, the room
// that is left, and whether her answer began with her thinking. Nothing here reads a clock, a
// config or the network; the turn (src/behavior/turn.js) passes in what it knows. Not used by a
// turn yet.

import { fill } from '../format.js';
import { clampWithEllipsis } from '../memory/clamp.js';
import { apiNameOf } from '../skills/definitions.js';
import { coversSpeech } from '../skills/tool-calls.js';

/**
 * The calls of a step in the order they run, as segments `{ parallel, calls }`: a run of consecutive
 * reads is one parallel segment, every other call is a segment of its own (a barrier), in her order.
 * @param {object[]} calls
 * @param {(call: object) => boolean} isRead  Whether the call's skill only reads.
 * @returns {{ parallel: boolean, calls: object[] }[]}
 */
export function segments(calls, isRead) {
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
 * its definition's result is an effect or a job (src/skills/tool-calls.js#coversSpeech), so her
 * speech goes out after them; with no calls it is true. `fresh`: some call returned something to
 * read (a `data` result) or did not work (or has no definition), or an inner turn still has an open follow-up, so a request
 * follows when there is room.
 * @param {{ name: string, result: { status?: string } }[]} outcomes  One per call, in order.
 * @param {{ definitionOf: (name: string) => ({ result?: string }|null|undefined), openFollowUp?: boolean }} options
 * @returns {{ speak: boolean, fresh: boolean }}
 */
export function stepVerdict(outcomes, { definitionOf, openFollowUp = false }) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const speak = list.every((outcome) => coversSpeech(definitionOf(outcome.name), outcome.result));
  const fresh =
    openFollowUp === true ||
    list.some(
      (outcome) =>
        outcome.result?.status !== 'ok' || !definitionOf(outcome.name) || definitionOf(outcome.name).result === 'data'
    );
  return { speak, fresh };
}

const textPart = (text) => ({ type: 'text', text });

/**
 * The messages of the next request: `messages` as they were, her answer, one result per call (always,
 * refused and capped ones included, in call order), and the note when there is one. Native: her
 * assistant message with `tool_calls` (null content when she wrote no text), then one `role: 'tool'`
 * message per call, then the note as a user message. Text: her raw text as the assistant message, then
 * one user message whose parts are a `<tool_result id name status>` block per call and the note.
 * A fresh array; the input is not changed, and the first messages are never rebuilt.
 * @param {{ transport: 'native'|'text', messages: object[], rawText?: string, calls: { id: string, name: string, apiName?: string, args?: object }[],
 *   results: { text: string, status?: string }[], note?: string }} input
 * @returns {object[]}
 */
export function appendStep({ transport, messages, rawText = '', calls, results, note = '' }) {
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

/**
 * The trailing note of a step, lines in this order: a notice that her speech was held (it does not
 * repeat her text), the lines that came in meanwhile under their lead, the lines whose media
 * was not ready in the first request and is now (`lateText`) under theirs, one line per message that
 * did not go out, the last-step notice, the open-intentions line of an inner turn, and the parser's
 * diagnostics under their header. Every word from `labels.task`; '' when there is nothing to say.
 * @param {{ labels: object, held?: boolean, deltaText?: string, lateText?: string, deliveries?: { n: number, total: number, code: string }[], last?: boolean, terminal?: boolean,
 *   open?: string, diagnostics?: string[] }} input
 * @returns {string}
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
}) {
  const task = labels?.task ?? {};
  const step = task.step ?? {};
  const lines = [];
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
 * The lines that came in since the last request, numbered on past every number already in use, her
 * own lines left out (she wrote them and has them in her answer). `floor` is the request's highest
 * line number, `taken` the highest number any handle holds (a memory.search's, an earlier delta's),
 * so the new numbers never meet one. Render `lines` with `indexOffset: offset`; `idByIndex` takes the
 * new entries; `next` is the first free number after them.
 * @param {{ lines: { id: string }[], floor?: number, taken?: number, ownIds?: Iterable<string> }} input
 * @returns {{ lines: object[], offset: number, idByIndex: Map<number, string>, next: number }}
 */
export function deltaLines({ lines, floor = 0, taken = 0, ownIds = [] }) {
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
 * @param {{ step: number, maxSteps: number, elapsedMs?: number, timeBudgetMs?: number, tokens?: { used: number, max: number, reserve?: number } }} input
 * @returns {{ run: boolean, capReason: string|null, next: 'normal'|'final'|'none', tokensOver: boolean }}
 */
export function roomLeft({ step, maxSteps, elapsedMs = 0, timeBudgetMs = Infinity, tokens = null }) {
  const tokensOver = Boolean(tokens) && tokens.used > tokens.max - (tokens.reserve ?? 0);
  if (step >= maxSteps) return { run: false, capReason: 'steps', next: 'none', tokensOver };
  const timeSpent = elapsedMs >= timeBudgetMs;
  const finalNext = step >= maxSteps - 1 || timeSpent || tokensOver;
  return { run: !timeSpent, capReason: timeSpent ? 'time' : null, next: finalNext ? 'final' : 'normal', tokensOver };
}

/**
 * `texts` cut so that together they lose about `excess` characters, the longest first, none below
 * `floor` characters (an ellipsis closes a cut one). A fresh array; what cannot be cut stays.
 * @param {string[]} texts
 * @param {number} excess
 * @param {number} [floor]
 * @returns {string[]}
 */
export function cutToFit(texts, excess, floor = 400) {
  const lengths = texts.map((text) => Array.from(text).length);
  const need = Math.max(0, Math.ceil(excess));
  if (need === 0) return [...texts];
  const lost = (level) => lengths.reduce((sum, length) => sum + Math.max(0, length - level), 0);
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
export function thinkMissing(text) {
  return !String(text ?? '')
    .trim()
    .startsWith('<think>');
}
