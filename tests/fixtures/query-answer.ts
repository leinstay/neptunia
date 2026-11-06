// The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
// A query-builder answer in the form of its strict schema (src/behavior/query-builder.ts#QUERY_PLAN_FORMAT).
import { QUERY_PLAN_FORMAT, parseQueryPlan } from '../../src/behavior/query-builder.ts';

/** The fields the schema requires. */
const { required: REQUIRED } = QUERY_PLAN_FORMAT.schema;

/** The object text of a query-builder answer: `fields`, and null in every other field. */
export const queryAnswer = (fields: Record<string, string>): string =>
  JSON.stringify({ ...Object.fromEntries(REQUIRED.map((key) => [key, null])), ...fields });

/** The plan of that answer. */
export const planOf = (
  fields: Record<string, string>,
  options: Parameters<typeof parseQueryPlan>[1] = {}
): ReturnType<typeof parseQueryPlan> =>
  parseQueryPlan(queryAnswer(fields), options);
