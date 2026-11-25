// The errand results of a `replay.ts --inner --errand-answers <file>` run. The file is a JSON list of results in the
// order the errand calls of a sample take them, each `{ agent, status, text, error? }`: `agent` is `scout`, `server`,
// `code` or `any`, `status` is `done`, `failed` or `cancelled`, `text` is the result's text and `error` the code of a
// failed one. `answeredErrands` is the errand service such a run hands the turn: `submit` files the errand in process
// and starts nothing, and `wait` ends it with the next unused result for its agent, so the call's answer is rendered
// by the errand tool's own code (src/tools/operations/errand.ts, src/errands/blocks.ts#errandResultText). A call that
// finds no result left waits in vain and answers `errand-wait-ended`, as a live wait past its budget answers.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './cli-args.ts';
import type { AddResult, ErrandRecord, WaitResult } from '../../src/errands/types.ts';

/** One result of the file. */
export type ErrandAnswer = {
  agent: 'scout' | 'server' | 'code' | 'any';
  status: 'done' | 'failed' | 'cancelled';
  text: string;
  error: string | null;
};

const AGENTS: ReadonlyArray<string> = ['scout', 'server', 'code', 'any'];
const STATUSES: ReadonlyArray<string> = ['done', 'failed', 'cancelled'];

/** The file's results, checked strictly; throws an Error whose message is one line naming the first fault. */
export function parseErrandAnswers(raw: unknown): Array<ErrandAnswer> {
  if (!Array.isArray(raw)) throw new Error('errand answers: the file must hold a list of results');
  return raw.map((entry: unknown, i): ErrandAnswer => {
    const at = `errand answers: answer ${i + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at}: not an object`);
    const { agent, status, text, error = null, ...rest } = entry as Record<string, unknown>;
    const unknown = Object.keys(rest)[0];
    if (unknown !== undefined) throw new Error(`${at}: unknown field ${unknown}`);
    if (typeof agent !== 'string' || !AGENTS.includes(agent))
      throw new Error(`${at}: agent must be one of ${AGENTS.join(', ')}`);
    if (typeof status !== 'string' || !STATUSES.includes(status))
      throw new Error(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (typeof text !== 'string') throw new Error(`${at}: text must be a string`);
    if (error !== null && (typeof error !== 'string' || status !== 'failed'))
      throw new Error(`${at}: error is a code of a failed result`);
    return { agent: agent as ErrandAnswer['agent'], status: status as ErrandAnswer['status'], text, error };
  });
}

/**
 * The results of `file` (`--errand-answers`, resolved from `root`), null without one; a file that cannot be read or
 * checked stops the run with one line.
 */
export function readErrandAnswers(file: string | null | undefined, root: string): Array<ErrandAnswer> | null {
  if (file === undefined || file === null) return null;
  try {
    return parseErrandAnswers(JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8')));
  } catch (err) {
    // A missing file, broken JSON or a fault parseErrandAnswers names.
    throw new CliError(`replay-cli: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The errand service of one sample over `answers` (see the head of this file). Each sample takes its own, so every
 * sample meets the same results in the same order.
 */
export function answeredErrands(
  answers: ReadonlyArray<ErrandAnswer>,
  now: () => number
): {
  submit: (input: { agent: string; goal: string; requester: unknown; origin: unknown; scope: unknown }) => AddResult;
  wait: (input: { id: string; ms: number }) => Promise<WaitResult>;
} {
  const filed = new Map<string, ErrandRecord>();
  const used = new Set<number>();
  return {
    submit({ agent, goal, requester, origin, scope }) {
      const errand = {
        id: `e-replay-${filed.size + 1}`,
        agent,
        goal,
        requester,
        origin,
        scope,
        state: 'queued',
        createdAt: now(),
        startedAt: null,
        endedAt: null,
        usage: null,
        result: null,
        error: null,
        seen: false,
        readAt: null,
        resolvedAt: null,
        opId: '',
      } as ErrandRecord;
      filed.set(errand.id, errand);
      return { ok: true, errand };
    },
    wait({ id }) {
      // submit filed every id the errand tool waits for.
      const errand = filed.get(id)!;
      const index = answers.findIndex(
        (answer, i) => !used.has(i) && (answer.agent === 'any' || answer.agent === errand.agent)
      );
      if (index < 0) return Promise.resolve({ ended: false, errand });
      used.add(index);
      const answer = answers[index];
      return Promise.resolve({
        ended: true,
        errand: {
          ...errand,
          state: answer.status,
          endedAt: now(),
          result: { text: answer.text, sources: [], files: [] },
          error: answer.status === 'failed' ? (answer.error ?? 'error') : null,
        },
      });
    },
  };
}
