// The models an agent can run on under each backend, and the one-reply check of a model before it is saved. `codex` and
// `claude` have no list to ask for, so the names their CLIs accept (`codex exec -m`, `claude -p --model`) are fixed here,
// and the owner may type any other name. Nothing here prints a key value.

import type { BackendName } from '../agent-runner/profiles.ts';
import { log } from '../log.ts';
import type { EffortLevel } from '../llm/roles.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';

/**
 * The names the CLIs accept (2026-11-02): the GPT ids a ChatGPT account serves to `codex exec -m`, and for `claude
 * --model` its three aliases and the current Claude ids. Free text stays allowed beside them.
 */
export const FIXED_MODELS: Readonly<Record<'codex' | 'claude', ReadonlyArray<string>>> = {
  codex: [
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6.1-terra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ],
  claude: [
    'opus',
    'sonnet',
    'haiku',
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-4-6',
  ],
};

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const REQUEST_MS = 30_000;
const CHECK_BRIEF = 'Reply with the single word ok.';

/** The URL of an endpoint under the provider's base. */
const endpoint = (deps: Pick<EnableDeps, 'baseUrl'>, path: string): string =>
  `${(deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${path}`;

const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

/**
 * One reply from `model` at `effort` under `backend`: null when it answered, else the refusal. An opencode check with a
 * `provider` asks OpenRouter for that provider alone with no fallback, as the pinned run will.
 */
export async function checkModel(
  deps: EnableDeps,
  backend: BackendName,
  keyValue: string,
  model: string,
  effort?: EffortLevel,
  provider?: string
): Promise<SubharnessResult | null> {
  if (backend !== 'opencode') {
    const outcome = await deps.runBackend(backend, CHECK_BRIEF, model, effort);
    if (outcome.ok && outcome.text.trim() !== '') return null;
    if (outcome.error === 'not-installed') return refused('not-installed', `${backend} is not installed`);
    if (outcome.error === 'backend-missing')
      return refused('binary-missing', `${backend} is not on the PATH of the core`);
    log.warn('subharness: model check failed', { backend, model, error: outcome.error ?? null });
    const why = outcome.detail === undefined ? '' : `: ${outcome.detail}`;
    return refused('model-rejected', `${backend} gave no reply on ${model}${why}`);
  }
  let status: number;
  try {
    const response = await deps.fetch(endpoint(deps, '/chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyValue}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Opencode names a model by its provider, openrouter/<id>; OpenRouter itself knows the id alone.
        model: model.replace(/^openrouter\//, ''),
        messages: [{ role: 'user', content: CHECK_BRIEF }],
        max_tokens: 8,
        ...(effort === undefined ? {} : { reasoning: { effort } }),
        ...(provider === undefined ? {} : { provider: { order: [provider], allow_fallbacks: false } }),
      }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    status = response.status;
  } catch {
    return refused('model-unreachable', 'the provider did not answer the model check');
  }
  if (status >= 200 && status < 300) return null;
  log.warn('subharness: model check rejected', { model, status });
  return refused('model-rejected', `the provider refused ${model} (HTTP ${status})`);
}
