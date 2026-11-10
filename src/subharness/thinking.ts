// The native thinking switch of every harness run of the persona's model roles: her core's turns
// (src/subharness/subscription-client.ts), the memory writer (src/subharness/memory-writer.ts) and the one-reply checks
// and probes (src/subharness/control.ts#replyCheckOptions). While `llm.subscription.thinking` is false (shipped false),
// claude runs with `MAX_THINKING_TOKENS=0` and codex is asked for no reasoning summary; her turns think in her written
// `<think>` block instead. A route's effort flag stays as the route sets it. The memory writer alone thinks when its
// route's effort is a level (`llm.routeEffort` ships `memory` at `medium`): claude gets that `--effort` and a thinking
// budget from `thinkingBudget`. Codex has no switch that turns a reasoning model's thinking off. The errand and
// development agents (src/agent-runner) keep their reasoning and never read this.

import type { EFFORT_LEVELS } from '../llm/roles.ts';

/** A level a route's effort runs at. */
export type ThinkingLevel = (typeof EFFORT_LEVELS)[number];

type Tree = Record<string, unknown>;
const treeOf = (value: unknown): Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Tree) : {};

/** Whether a harness run keeps the model's native thinking: `llm.subscription.thinking` of `config` is `true`. */
export const isNativeThinking = (config: unknown): boolean =>
  treeOf(treeOf(treeOf(config).llm).subscription).thinking === true;

/** The variables that switch claude's native thinking off; none for codex or while thinking is kept. */
export const nativeThinkingEnv = (backend: 'claude' | 'codex', thinking: boolean): Record<string, string> =>
  backend === 'claude' && !thinking ? { MAX_THINKING_TOKENS: '0' } : {};

/** The `-c` pair that asks codex for no reasoning summary; none while thinking is kept. */
export const nativeThinkingCodexArgs = (thinking: boolean): Array<string> =>
  thinking ? [] : ['-c', 'model_reasoning_summary="none"'];

/**
 * The thinking budget of claude's tokens per level. Claude 2.1.317 runs `MAX_THINKING_TOKENS` above 0 as thinking of
 * type `enabled` with that `budgetTokens`, read from its binary on 2026-11-10. The memory session's answers measured on
 * 2026-11-10 average 1,100 visible tokens under a cap of 10,000, so `medium` leaves the answer 6,000.
 */
const THINKING_BUDGET: Readonly<Record<ThinkingLevel, number>> = { low: 2000, medium: 4000, high: 6000 };

/** Claude's thinking budget at `level`, never above half of `maxOutputTokens`, which counts the thinking too. */
export function thinkingBudget(level: ThinkingLevel, maxOutputTokens: number | undefined): number {
  const budget = THINKING_BUDGET[level];
  return maxOutputTokens === undefined ? budget : Math.min(budget, Math.floor(maxOutputTokens / 2));
}
