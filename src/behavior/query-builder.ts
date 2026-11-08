// The query builder: the step before a search that plans whether to search, where and with which forms
// (prompts/query-builder.md). parseQueryPlan reads its answer, the JSON object of QUERY_PLAN_FORMAT with the fields `web`,
// `history`, `who`, `when`, `when_role`, `recent` and `skills`. A live turn has no such step, because the persona's own tools search during her
// reply (`lookup: skipped`, reason `core-tools`, in src/turn/phases/request/lookup.ts). The callers are the replay and the
// two evaluation scripts, and every other caller of the plan takes it from here.

import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { strictJsonObject } from '../llm/parse.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { oneLine } from '../memory/clamp.ts';
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

const nullableText = { type: ['string', 'null'] };

/**
 * The schema of the builder's answer, handed to the client as `responseFormat`: one field per label of the plan, each
 * null when unused. `web`, `history`, `who`, `when` and `skills` are texts, `when_role` is `scope` or `locator`, and
 * `recent` is `yes` or `no`.
 */
export const QUERY_PLAN_FORMAT = {
  name: 'query-plan',
  schema: {
    type: 'object',
    properties: {
      web: nullableText,
      history: nullableText,
      who: nullableText,
      when: nullableText,
      // A nullable choice is an enum holding null: Anthropic refuses a type array with an enum.
      when_role: { enum: ['scope', 'locator', null] },
      recent: { enum: ['yes', 'no', null] },
      skills: nullableText,
    },
    required: ['web', 'history', 'who', 'when', 'when_role', 'recent', 'skills'],
    additionalProperties: false,
  },
};

/** Each field of QUERY_PLAN_FORMAT with the label parseLookupLines reads its value under, and the values it allows. */
const PLAN_FIELDS: ReadonlyArray<{ field: string; label: string; values?: ReadonlyArray<string> }> = [
  { field: 'web', label: 'web' },
  { field: 'history', label: 'history' },
  { field: 'who', label: 'who' },
  { field: 'when', label: 'when' },
  { field: 'when_role', label: 'when-role', values: ['scope', 'locator'] },
  { field: 'recent', label: 'recent', values: ['yes', 'no'] },
  { field: 'skills', label: 'skills' },
];

const NO_PLAN = (reason: QueryPlan['reason']): QueryPlan => ({ web: null, history: null, reason });

/**
 * The answer read into a plan: the JSON object of QUERY_PLAN_FORMAT, each field present and either null or a text of
 * its form, read as parseLookupLines reads the line of its label. `reason`: `empty` (no text), `none` (every field
 * null, or nothing asked), `unparsed` (text that is not that object, or values none of which is usable) or `ok`.
 */
export function parseQueryPlan(
  raw: unknown,
  options: { timezone?: string; now?: number; maxForms?: number; skillNames?: Array<string> } = {}
): QueryPlan {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return NO_PLAN('empty');
  const answer = strictJsonObject(raw);
  if (!answer) return NO_PLAN('unparsed');
  const lines: Array<string> = [];
  for (const { field, label, values } of PLAN_FIELDS) {
    const value = answer[field];
    if (value === null) continue;
    if (typeof value !== 'string' || (values && !values.includes(value))) return NO_PLAN('unparsed');
    if (value.trim()) lines.push(`${label}: ${oneLine(value)}`);
  }
  if (lines.length === 0) return NO_PLAN('none');
  const { server, ...rest } = parseLookupLines(lines.join('\n'), options);
  return { ...rest, history: server };
}

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
            maxOutputTokens: Number(objOf(objOf(config.web).quickSearch).classifierMaxOutputTokens ?? 2000),
            purpose: 'query-builder',
          }),
          responseFormat: QUERY_PLAN_FORMAT,
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
