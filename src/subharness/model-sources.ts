// The source-qualified choices of a model role: what `/model set` can offer from OpenRouter and from the installed,
// logged-in backends, one choice per source even when two sources expose one name. A backend's fixed names are labelled
// suggestions, because a CLI has no list to ask (src/subharness/models.ts), and OpenRouter's and opencode's are read from
// the provider. What keeps a source out is its own notice. Only an agent role or the memory writer can run through a CLI;
// opencode cannot carry the writer. Reading the choices sends no model request and returns no key value.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { opencodeKey, SUBHARNESS_AGENTS } from './routing.ts';
import { roleModelListing } from '../keys/models.ts';
import { MEMORY_ROLE } from '../llm/roles.ts';
import { FIXED_MODELS } from './models.ts';
import { sourceState } from './sources.ts';

export type ModelChoice = { id: string; source: 'openrouter' | BackendName; model: string; suggestion: boolean };
export type SourceNotice = { source: 'openrouter' | BackendName; code: string };
export type ModelChoices = { choices: Array<ModelChoice>; notices: Array<SourceNotice> };

export type ChoicesDeps = {
  privateDir: string;
  fetch: typeof fetch;
  baseUrl: string;
  /** the key the OpenRouter listing goes out on; null while there is none */
  openRouterKey: string | null;
};

const DEFAULT_LISTING_ROLE = 'core';

/** The role whose fit the listing is filtered by: an agent takes and gives text, as her core does. */
const listingRole = (role: string): string =>
  SUBHARNESS_AGENTS.some((agent) => agent === role) ? DEFAULT_LISTING_ROLE : role;

/** The backends `role` can run through. */
function backendsOf(role: string): ReadonlyArray<BackendName> {
  if (role === MEMORY_ROLE) return BACKEND_NAMES.filter((name) => name !== 'opencode');
  return SUBHARNESS_AGENTS.some((agent) => agent === role) ? BACKEND_NAMES : [];
}

const choice = (source: ModelChoice['source'], model: string, suggestion: boolean): ModelChoice => ({
  id: `${source}:${model}`,
  source,
  model,
  suggestion,
});

/** One source's listing on `value`: its choices, or the notice of why there are none. */
async function listed(
  deps: ChoicesDeps,
  source: ModelChoice['source'],
  value: string,
  role: string
): Promise<ModelChoices> {
  const reading = await roleModelListing({ fetch: deps.fetch, baseUrl: deps.baseUrl, value }, listingRole(role));
  return reading.ok
    ? { choices: reading.models.map((model) => choice(source, model, false)), notices: [] }
    : { choices: [], notices: [{ source, code: 'provider-rejected' }] };
}

/** What one backend adds for `role`. */
async function ofBackend(deps: ChoicesDeps, backend: BackendName, role: string): Promise<ModelChoices> {
  const state = await sourceState(deps.privateDir, backend);
  if (!state.available) return { choices: [], notices: [{ source: backend, code: state.code }] };
  if (backend !== 'opencode')
    return { choices: FIXED_MODELS[backend].map((model) => choice(backend, model, true)), notices: [] };
  return listed(deps, backend, opencodeKey(deps.privateDir)?.value ?? '', role);
}

/** The choices of `role` now, OpenRouter's first. */
export async function modelChoices(deps: ChoicesDeps, role: string): Promise<ModelChoices> {
  const parts = await Promise.all([
    deps.openRouterKey === null
      ? Promise.resolve<ModelChoices>({ choices: [], notices: [{ source: 'openrouter', code: 'no-key' }] })
      : listed(deps, 'openrouter', deps.openRouterKey, role),
    ...backendsOf(role).map((backend) => ofBackend(deps, backend, role)),
  ]);
  return { choices: parts.flatMap((one) => one.choices), notices: parts.flatMap((one) => one.notices) };
}
