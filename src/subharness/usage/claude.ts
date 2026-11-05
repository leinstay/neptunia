// Claude's native usage. Its `/usage` is an interactive screen, and `claude -p "/usage"` would be a model turn, so no
// unattended read is proven for the installed version (2.1.317, checked 2026-11-05 from its `--help`). The adapter says so
// and hands off to that screen under the persona's home. It runs the vendor's status command and nothing else.
// src/subharness/usage.ts reads through this.

import { subharnessPlace } from '../place.ts';
import { sourceState } from '../sources.ts';
import type { BackendUsage, UsageSpawn } from '../usage.ts';

export type ClaudeUsageDeps = { privateDir: string; now(): number; spawn: UsageSpawn };

/** Claude's account now: whether its screen can open, and how to open it. */
export async function readClaudeUsage(deps: ClaudeUsageDeps): Promise<BackendUsage> {
  const shape = {
    variant: 'subscription',
    source: 'claude',
    account: { label: null },
    observedAt: deps.now(),
    metrics: [],
  } as const;
  const state = await sourceState(deps.privateDir, 'claude');
  if (state.code !== 'ok')
    return { ...shape, availability: 'unavailable', errors: [{ code: state.code }], handoff: null };
  const { binary, env } = subharnessPlace(deps.privateDir, 'claude');
  return {
    ...shape,
    availability: 'unsupported',
    errors: [],
    handoff: `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR ?? ''} ${binary}, then /usage in its own screen (claude)`,
  };
}
