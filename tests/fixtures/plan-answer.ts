// The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
// A planner fake's answer in the form the strict schema of the plan request lets through
// (src/behavior/selfreflection.ts#selfreflectionPlanFormat).

/** The one kind the plan request offers by its schema, or null when it offers several or none. */
export function offeredKind(options: unknown): string | null {
  const format = (options as { responseFormat?: { schema?: { properties?: { kind?: { enum?: unknown } } } } } | null)
    ?.responseFormat;
  const kinds = format?.schema?.properties?.kind?.enum;
  return Array.isArray(kinds) && kinds.length === 1 && typeof kinds[0] === 'string' ? kinds[0] : null;
}

/**
 * The text of a plan answer `plan` for the request with `options`. A plan object gets the fields a lenient reader took
 * as empty (`brief` and `search` '', `picture` false, `seed` 0), and the request's one offered kind, which the plan
 * keeps over the answer's. Text, and anything that is not an object, goes out as it is.
 */
export function planAnswerText(plan: unknown, options: unknown): string {
  if (typeof plan === 'string') return plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return JSON.stringify(plan);
  const kind = offeredKind(options);
  return JSON.stringify({ brief: '', search: '', picture: false, seed: 0, ...plan, ...(kind ? { kind } : {}) });
}
