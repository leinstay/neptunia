// The words of the selfimprovement wake's facts (src/behavior/selfimprovement-view.ts) in `<wake>`: every phrase comes
// from `labels.wake.selfimprovement`, the facts are data. The block is left out without its header label. Tool names,
// argument names, codes, counts, ids and the board's own titles and notes are the only content; no line of chat is here.
// `wakeBlockText` (src/behavior/wake.ts) calls it after the heartbeat's lines.

import { fill } from '../format.js';
import { oneLine } from '../memory/clamp.js';
import { listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
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

/** The lines of the facts: the window, the shapes, the tools never called, the skills, the proposals and the news. */
export function selfimprovementLines(
  facts: SelfimprovementFacts | null | undefined,
  labels: unknown,
  when: When,
  reason: string | null
): Array<string> {
  const l = objOf(labels);
  if (!facts || typeof l.header !== 'string' || l.header === '') return [];
  const out: Array<string> = [];
  const cause = reason?.startsWith(CAUSE_PREFIX) ? reason.slice(CAUSE_PREFIX.length) : '';
  if (cause !== '') out.push(word(l, 'cause', { shape: oneLine(cause) }));
  out.push(fill(l.header, { days: String(facts.days) }));
  const join = typeof l.stepsJoin === 'string' ? l.stepsJoin : ' > ';
  if (facts.shapes.length === 0) out.push(word(l, 'noShapes'));
  for (const shape of facts.shapes) {
    out.push(
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
  }
  if (facts.moreShapes > 0) out.push(word(l, 'moreShapes', { count: String(facts.moreShapes) }));
  if (facts.unusedTools.length > 0) out.push(word(l, 'unused', { tools: facts.unusedTools.join(', ') }));
  if (facts.skills.length > 0) {
    out.push(word(l, 'skills'));
    for (const skill of facts.skills) {
      out.push(
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
      );
    }
  }
  if (facts.proposals.length > 0) {
    out.push(word(l, 'proposals'));
    for (const proposal of facts.proposals) {
      out.push(
        word(l, 'proposal', {
          id: proposal.id,
          kind: proposal.kind ?? '',
          title: oneLine(proposal.title),
          status: proposal.status,
          reason:
            proposal.closeReason === null ? '' : word(l, 'proposalReason', { reason: oneLine(proposal.closeReason) }),
        })
      );
    }
  }
  const { questions, reviews, outbox } = facts.news;
  if (questions.length + reviews.length + outbox.length > 0) {
    out.push(word(l, 'news'));
    for (const question of questions) {
      out.push(
        word(l, 'question', {
          task: question.taskId,
          text: oneLine(question.text),
          answered: question.answered ? word(l, 'questionAnswered') : '',
        })
      );
    }
    for (const review of reviews) {
      out.push(
        word(l, 'review', {
          task: review.taskId,
          decision: review.decision,
          scope: review.scope ?? '',
          note: review.note === null ? '' : word(l, 'reviewNote', { note: oneLine(review.note) }),
        })
      );
    }
    for (const row of outbox) {
      out.push(
        word(l, 'board', {
          task: row.taskId,
          kind: row.kind,
          status: row.status ?? '',
          reason: row.closeReason === null ? '' : word(l, 'proposalReason', { reason: oneLine(row.closeReason) }),
        })
      );
    }
  }
  return out.filter((line) => line !== '');
}

/** The reason of the selfimprovement item of a wake's items, or null when there is none. */
export function selfimprovementReason(items: ReadonlyArray<unknown> | undefined): string | null {
  const item = listOf(items)
    .map(objOf)
    .find((one) => one.kind === 'selfimprovement');
  return typeof item?.reason === 'string' ? item.reason : null;
}
