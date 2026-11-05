// The query builder: the step before a search that plans whether to search, where and with which forms
// (prompts/query-builder.md). parseQueryPlan reads its answer, labelled lines `web:`, `history:`, `who:`, `when:`,
// `when-role:`, `recent:` and `skills:`. A live turn has no such step, because the persona's own tools search during her
// reply (`lookup: skipped`, reason `core-tools`, in src/turn/phases/request/lookup.ts). The callers are the replay and the
// two evaluation scripts, and every other caller of the plan takes it from here.

import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { zonedDay } from '../time.ts';
import { lookupClassifierInput } from '../turn/lookup-input.ts';
import { objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import { fillPromptTemplate } from './prompt.ts';
import { parseLookupLines } from './recall.ts';
import type { SkillsLines } from '../tools/discovery.ts';

/** What the plan's `history` part holds: the forms, the names, the range and its qualifiers. */
export type HistoryPlan = NonNullable<ReturnType<typeof parseLookupLines>['server']>;

/** A plan: the web query, the history part, why, and the answer's skills line when it had one. */
export type QueryPlan = {
  web: string | null;
  history: HistoryPlan | null;
  reason: 'ok' | 'none' | 'empty' | 'unparsed' | 'failed' | 'no-prompt';
  skills?: SkillsLines;
};

/** The answer read into a plan. `reason`: `empty` (no text), `none`, `unparsed` (nothing usable) or `ok`. */
export function parseQueryPlan(
  raw: unknown,
  options: { timezone?: string; now?: number; maxForms?: number; skillNames?: Array<string> } = {}
): QueryPlan {
  const { server, ...rest } = parseLookupLines(raw, options);
  return { ...rest, history: server };
}

const NO_PLAN = (reason: QueryPlan['reason']): QueryPlan => ({ web: null, history: null, reason });

/** What one plan is asked about. */
export type QueryInput = {
  selfName: string;
  question: { authorName?: string; content?: string };
  /** The lines around the question, oldest first; a caller with no chat around it, as a heartbeat, gives none. */
  lines?: Array<object>;
  skills?: string;
  skillNames?: Array<string>;
};

/**
 * The builder every caller shares: one request on the analyzer under the purpose `query-builder`, `hot` read at the moment
 * of use, naming no place. A question with no text and a missing prompt cost no request. Resolves the plan, with `reason`
 * `failed` for a failed request, and never rejects.
 */
export function createQueryBuilder({
  hot,
  llm,
  now = Date.now,
}: {
  hot: { config: Record<string, Untyped>; prompts: Record<string, unknown> | null | undefined };
  llm: { complete(messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>): unknown };
  now?: () => number;
}): (input: QueryInput) => Promise<QueryPlan> {
  return async function buildQuery({ selfName, question, lines = [], skills = '', skillNames }) {
    const text = String(question?.content ?? '');
    if (!text.trim()) return NO_PLAN('empty');
    const prompt: unknown = hot.prompts?.['query-builder'];
    if (typeof prompt !== 'string' || !prompt.trim()) {
      log.info('query-builder: skipped', { reason: 'no-prompt' });
      return NO_PLAN('no-prompt');
    }
    const config = hot.config;
    const zone = objOf(config.bot).timezone;
    const timezone = typeof zone === 'string' ? zone : 'UTC';
    const maxForms = objOf(config.recall).maxForms;
    const at = now();
    const { user } = lookupClassifierInput({
      config,
      labels: objOf(hot.prompts).labels,
      selfName,
      history: lines,
      trigger: { id: '', authorName: question.authorName, content: text, ts: at },
    } as unknown as Parameters<typeof lookupClassifierInput>[0]);
    try {
      const completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(prompt, { name: selfName, today: zonedDay(at, timezone), skills }),
          },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'query-builder'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: Number(objOf(objOf(config.web).search).classifierMaxOutputTokens ?? 2000),
            purpose: 'query-builder',
          }),
        }
      );
      return parseQueryPlan(objOf(completion).text, {
        timezone,
        now: at,
        maxForms: typeof maxForms === 'number' ? maxForms : undefined,
        skillNames,
      });
    } catch (err) {
      log.warn('query-builder: failed', { reason: railReason(err), name: objOf(err).name ?? null });
      return NO_PLAN('failed');
    }
  };
}
