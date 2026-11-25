// Direct OpenRouter accounting: one read of `/key` on the key in use, no completion. The account is the key's name in the
// store, because the label OpenRouter returns is the key's own masked text. A limit it does not report stays unknown.
// src/subharness/usage.ts reads through this.

import { apiUrl, openRouterHeaders } from '../../llm/openrouter.ts';
import type { BackendUsage, Observation, UsageMetric } from '../usage.ts';

export type OpenRouterUsageDeps = {
  fetch: typeof fetch;
  baseUrl: string;
  key: { name: string; value: string } | null;
  now(): number;
};

/** How long the provider may take (ms), the same wait as the model listing (src/keys/models.ts). */
const READ_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function usd(name: string, value: unknown): UsageMetric {
  return typeof value === 'number'
    ? { name, scope: 'account', unit: 'usd', value, state: 'observed' }
    : { name, scope: 'account', unit: 'usd', value: null, state: 'unknown' };
}

/** The key's account now. */
export async function readOpenRouterUsage(deps: OpenRouterUsageDeps): Promise<BackendUsage> {
  const answer = (over: Partial<Observation>): BackendUsage => ({
    variant: 'api',
    source: 'openrouter',
    account: { label: deps.key?.name ?? null },
    observedAt: deps.now(),
    availability: 'unavailable',
    metrics: [],
    errors: [],
    handoff: null,
    ...over,
  });
  if (deps.key === null) return answer({ errors: [{ code: 'no-key' }] });
  let body: unknown;
  try {
    const response = await deps.fetch(apiUrl(deps.baseUrl, 'key'), {
      headers: openRouterHeaders(deps.key.value),
      signal: AbortSignal.timeout(READ_MS),
    });
    if (!response.ok) return answer({ errors: [{ code: 'provider-rejected' }] });
    body = await response.json();
  } catch {
    return answer({ errors: [{ code: 'read-failed' }] });
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  return answer({
    availability: 'available',
    metrics: [usd('usage', data.usage), usd('limit', data.limit), usd('limitRemaining', data.limit_remaining)],
  });
}
