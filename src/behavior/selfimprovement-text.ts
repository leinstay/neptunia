// The words of the selfimprovement wake's facts (src/behavior/selfimprovement-view.ts) in `<wake>`: every phrase comes
// from `labels.wake.selfimprovement`, the facts are data. The block is left out without its header label. Tool names,
// argument names, codes, counts, ids and the board's own titles and notes are the only content; no line of chat is here.
// `wakeBlockText` (src/behavior/wake.ts) calls it after the heartbeat's lines.

import { fill } from '../format.ts';
import { oneLine } from '../memory/clamp.ts';
import { listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { Landed } from '../selfdev/landed.ts';
import type { SelfimprovementFacts, Shape } from './selfimprovement-view.ts';

/** How the `<wake>` words a moment. */
type When = (ts: unknown) => string;

/** The prefix of a failure cause's reason (src/behavior/inner/selfimprovement.ts). */
const CAUSE_PREFIX = 'failures:';

/** A shape's steps as one text: each tool with its argument names, joined by `join`. */
const stepsText = (shape: Shape, join: string): string =>
  shape.steps.map((step) => `${step.tool}(${step.args.join(', ')})`).join(join);

/** The text of `key` filled with `values`, '' when the label is missing. */
function word(l: Obj, key: string, values: Readonly<Record<string, string>> = {}): string {
  const template = l[key];
  return typeof template === 'string' && template !== '' ? fill(template, values) : '';
}

/** The lines of the chain shapes: none made, or one per frequent shape and the count of the rest. */
function shapeLines(facts: SelfimprovementFacts, l: Obj, when: When): Array<string> {
  const join = typeof l.stepsJoin === 'string' ? l.stepsJoin : ' > ';
  if (facts.shapes.length === 0) return [word(l, 'noShapes')];
  const lines = facts.shapes.map((shape) =>
    word(l, 'shape', {
      count: String(shape.count),
      steps: stepsText(shape, join),
      failures: String(shape.failures),
      retries: String(shape.retries),
      cost: shape.costUsd.toFixed(4),
      when: when(shape.example.at),
      turns: shape.turnIds.join(', '),
    })
  );
  return facts.moreShapes > 0 ? [...lines, word(l, 'moreShapes', { count: String(facts.moreShapes) })] : lines;
}

/** The lines of her skills with their use counts. */
function skillLines(facts: SelfimprovementFacts, l: Obj): Array<string> {
  if (facts.skills.length === 0) return [];
  return [
    word(l, 'skills'),
    ...facts.skills.map((skill) =>
      word(l, 'skill', {
        name: skill.name,
        state: skill.active ? '' : word(l, 'skillOff'),
        discovered: String(skill.counts.discovered),
        read: String(skill.counts.read),
        tried: String(skill.counts.tried),
        succeeded: String(skill.counts.succeeded),
        corrected: String(skill.counts.corrected),
        declined: String(skill.counts.declined),
      })
    ),
  ];
}

/** The lines of the proposals she filed. */
function proposalLines(facts: SelfimprovementFacts, l: Obj): Array<string> {
  if (facts.proposals.length === 0) return [];
  return [
    word(l, 'proposals'),
    ...facts.proposals.map((proposal) =>
      word(l, 'proposal', {
        id: proposal.id,
        kind: proposal.kind ?? '',
        title: oneLine(proposal.title),
        status: proposal.status,
        reason: reasonOf(l, proposal.closeReason),
      })
    ),
  ];
}

/** ` (reason)` through `proposalReason`, or nothing without a reason. */
const reasonOf = (l: Obj, reason: string | null): string =>
  reason === null ? '' : word(l, 'proposalReason', { reason: oneLine(reason) });

/** The lines of what the board holds for her since the last wake: questions, reviews and outbox rows. */
function newsLines(facts: SelfimprovementFacts, l: Obj): Array<string> {
  const { questions, reviews, outbox } = facts.news;
  if (questions.length + reviews.length + outbox.length === 0) return [];
  return [
    word(l, 'news'),
    ...questions.map((question) =>
      word(l, 'question', {
        task: question.taskId,
        text: oneLine(question.text),
        answered: question.answered ? word(l, 'questionAnswered') : '',
      })
    ),
    ...reviews.map((review) =>
      word(l, 'review', {
        task: review.taskId,
        decision: review.decision,
        scope: review.scope ?? '',
        note: review.note === null ? '' : word(l, 'reviewNote', { note: oneLine(review.note) }),
      })
    ),
    ...outbox.map((row) =>
      word(l, 'board', {
        task: row.taskId,
        kind: row.kind,
        status: row.status ?? '',
        reason: reasonOf(l, row.closeReason),
      })
    ),
  ];
}

/** The lines of the facts: the cause, the window, the shapes, the tools never called, the skills, the proposals and the news. */
export function selfimprovementLines(
  facts: SelfimprovementFacts | null | undefined,
  labels: unknown,
  when: When,
  reason: string | null
): Array<string> {
  const l = objOf(labels);
  if (!facts || typeof l.header !== 'string' || l.header === '') return [];
  const cause = reason?.startsWith(CAUSE_PREFIX) ? reason.slice(CAUSE_PREFIX.length) : '';
  return [
    cause === '' ? '' : word(l, 'cause', { shape: oneLine(cause) }),
    fill(l.header, { days: String(facts.days) }),
    ...shapeLines(facts, l, when),
    facts.unusedTools.length > 0 ? word(l, 'unused', { tools: facts.unusedTools.join(', ') }) : '',
    ...skillLines(facts, l),
    ...proposalLines(facts, l),
    ...newsLines(facts, l),
  ].filter((line) => line !== '');
}

/** The reason of the selfimprovement item of a wake's items, or null when there is none. */
export function selfimprovementReason(items: ReadonlyArray<unknown> | undefined): string | null {
  const item = listOf(items)
    .map(objOf)
    .find((one) => one.kind === 'selfimprovement');
  return typeof item?.reason === 'string' ? item.reason : null;
}

/** How many paths of one landed fix the wake lists; the rest is counted. */
const LANDED_FILES_SHOWN = 8;

/**
 * The lines of the fixes of her own code that merged: the header, then one `item` per fix (`{task}`, `{title}`,
 * `{who}`: `ownerMerged` or `autoMerged`, `{files}`: up to eight paths and `filesMore` for the rest). The heartbeat
 * and the selfimprovement wake both carry them; one that both carry is listed once. Nothing without the header label.
 */
export function landedLines(groups: ReadonlyArray<ReadonlyArray<Landed> | undefined>, labels: unknown): Array<string> {
  const l = objOf(labels);
  const bySeq = new Map<number, Landed>();
  for (const one of groups.flatMap((group) => group ?? [])) bySeq.set(one.seq, one);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (all.length === 0 || typeof l.header !== 'string' || l.header === '') return [];
  return [
    l.header,
    ...all.map((one) => {
      const shown = one.files.slice(0, LANDED_FILES_SHOWN).join(', ');
      const more = one.files.length - LANDED_FILES_SHOWN;
      return word(l, 'item', {
        task: one.taskId,
        title: oneLine(one.title),
        who: word(l, one.decidedBy === 'owner' ? 'ownerMerged' : 'autoMerged'),
        files: more > 0 ? `${shown}${word(l, 'filesMore', { count: String(more) })}` : shown,
      });
    }),
  ];
}
