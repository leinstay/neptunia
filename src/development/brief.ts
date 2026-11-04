// The brief of one agent run of the development worker: `prompts/executor-brief.md` with the task's fields in its
// `{{placeholders}}` (docs/prompt-contract.md), after the agent's own prompt in bin/development.ts. The wording lives in
// the prompt file; this file only lays out the board's own values.

import { fillPromptTemplate } from '../turn/request/text.ts';
import type { DevelopmentBrief } from './worker.ts';

export type FixBrief = {
  id: string;
  title: string;
  evidence: string;
  acceptance: string | null;
  examples: ReadonlyArray<string>;
  counterexamples: ReadonlyArray<string>;
  benefit: string;
  evaluation: string;
  branch?: string;
  generation?: number;
  /** One line per question that was answered, and per comment. */
  answers?: ReadonlyArray<string>;
  /** One line per dev task under this task. */
  children?: ReadonlyArray<string>;
};

const list = (items: ReadonlyArray<string>): string => items.map((one) => `- ${one}`).join('\n');

/** The text of prompts/executor-brief.md with the fields in its `{{placeholders}}`. */
export function briefFrom(template: string, task: FixBrief): string {
  return fillPromptTemplate(template, {
    id: task.id,
    title: task.title,
    evidence: task.evidence,
    acceptance: task.acceptance ?? '',
    examples: list(task.examples),
    counterexamples: list(task.counterexamples),
    benefit: task.benefit,
    evaluation: task.evaluation,
    branch: task.branch ?? '',
    generation: task.generation ?? '',
    answers: list(task.answers ?? []),
    children: list(task.children ?? []),
  });
}

const stringsOf = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The brief's fields from what the worker hands over. */
export function fixBriefOf(brief: DevelopmentBrief): FixBrief {
  const { task, questions, comments } = brief.task;
  const meta = task.metadata ?? {};
  return {
    id: task.id,
    title: task.title,
    evidence: task.description ?? '',
    acceptance: task.acceptance,
    examples: stringsOf(meta.examples),
    counterexamples: stringsOf(meta.counterexamples),
    benefit: textOf(meta.benefit),
    evaluation: textOf(meta.evaluation),
    branch: brief.branch,
    generation: brief.generation,
    answers: [
      ...questions
        .filter((question) => typeof question.answer === 'string')
        .map((question) => `${textOf(question.text)} ${textOf(question.answer)}`),
      ...comments.map((comment) => comment.text),
    ],
    children: brief.children.map((child) =>
      [child.id, child.status, child.title, child.closeReason ?? '', child.report ?? ''].filter(Boolean).join(' · ')
    ),
  };
}
