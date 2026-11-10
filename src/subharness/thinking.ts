// The native thinking switch of every harness run of the persona's model roles: her core's turns
// (src/subharness/subscription-client.ts), the memory writer (src/subharness/memory-writer.ts) and the one-reply checks
// and probes (src/subharness/control.ts#replyCheckOptions). While `llm.subscription.thinking` is false (shipped false),
// claude runs with `MAX_THINKING_TOKENS=0` and codex is asked for no reasoning summary; she thinks in her written
// `<think>` block instead. A route's effort flag stays as the route sets it. Codex has no switch that turns a reasoning
// model's thinking off. The errand and development agents (src/agent-runner) keep their reasoning and never read this.

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
