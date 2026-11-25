// What a model chooser may read about a role: the registry of the roles under their display groups, and each source of a
// role with its state, the evidence behind its models, the effort levels it takes and the commands that repair it. A
// model row says how it is known: `observed` came from the provider or the installed binary now, `suggestion` is a fixed
// name nobody checked against this account. A source's effort levels are what its backend takes by the survey in
// src/subharness/models.ts, and a direct-path source has none, because `/model set --effort` sets its effort. Reading
// sends no model request, starts no model run and returns no key value, only a key's name. An agent cannot run on a direct
// `openrouter:` path, so OpenRouter's models reach it through opencode alone. The console answers `/model sources` with
// this, and interfaces/cli/model-picker.ts draws it.

import { BACKEND_NAMES, agentNames, isAgentName } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { opencodeKey, readRouting } from './routing.ts';
import { harnessPathOf } from './memory-path.ts';
import { roleModelListing } from '../keys/models.ts';
import { BASE_ROLES, MEMORY_ROLE } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { BACKEND_EFFORTS, FIXED_MODELS } from './models.ts';
import { sourceState } from './sources.ts';

export type ModelRoleRow = {
  group: 'main' | 'errand';
  role: string;
  label: string;
};

export type SourceDescriptor = {
  id: string;
  providerType: 'api' | 'subharness';
  /** the backend a commit names with `--via`; null on the direct path */
  via: BackendName | null;
  label: string;
  /** the name of the key or account behind the source, never its value */
  account: string | null;
  code: 'ok' | 'not-installed' | 'not-logged-in' | 'no-key' | 'provider-rejected' | 'role-unsupported';
  setup: Array<{ command: string; masked: boolean }>;
  listing: 'observed' | 'suggestion' | 'none' | 'failed';
  models: Array<{
    id: string;
    evidence: 'observed' | 'suggestion';
    /** what a commit stores when the backend names the model differently from the listing */
    saveAs?: string;
  }>;
  /** the levels a commit may name; empty when the source takes none from the chooser */
  effort: ReadonlyArray<EffortLevel>;
  /** the setter takes a name the listing lacks */
  manualModel: boolean;
};

export type RoleSources = {
  role: string;
  /** what the role stores as its CLI path now; null for a role on the direct path */
  current: { via: BackendName | null; model: string | null; effort: string | null } | null;
  sources: ReadonlyArray<SourceDescriptor>;
};

export type CapabilityDeps = {
  privateDir: string;
  fetch: typeof fetch;
  baseUrl: string;
  /** the key the OpenRouter listing goes out on; null while the role has none */
  openRouterKey: string | null;
  /** the name of that key, for the source's account */
  openRouterKeyName?: string | null;
};

/** Main's display order and names. `Voice` is the display name of the role `speech`, whose chain is `models.routes.speech`. */
const MAIN_ROLES = ['core', 'drawing', 'speech', 'memory', 'analyzer', 'vision', 'video', 'embedding'] as const;
const LABELS: Readonly<Record<string, string>> = { speech: 'Voice' };

const labelOf = (role: string): string => LABELS[role] ?? `${role.charAt(0).toUpperCase()}${role.slice(1)}`;

const BACKEND_LABELS: Readonly<Record<BackendName, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** The role a listing is filtered by: an agent takes and gives text, as the core does. */
const LISTING_ROLE_OF_AGENT = 'core';

/** Every role the chooser offers, Main first, each agent under the group the role table gives it. */
export function modelRoleRegistry(): Array<ModelRoleRow> {
  const row = (group: ModelRoleRow['group'], role: string): ModelRoleRow => ({ group, role, label: labelOf(role) });
  return [...MAIN_ROLES.map((role) => row('main', role)), ...agentNames().map((agent) => row('errand', agent))];
}

/** The backends `role` can run through: an agent all of them, the memory writer those that carry a system prompt. */
function backendsOf(role: string): ReadonlyArray<BackendName> {
  if (role === MEMORY_ROLE) return BACKEND_NAMES.filter((name) => name !== 'opencode');
  return isAgentName(role) ? BACKEND_NAMES : [];
}

function backendShape(
  backend: BackendName
): Omit<SourceDescriptor, 'code' | 'listing' | 'models' | 'setup' | 'effort'> {
  return {
    id: `backend:${backend}`,
    providerType: 'subharness',
    via: backend,
    label: BACKEND_LABELS[backend],
    account: null,
    manualModel: true,
  };
}

/** opencode's source when it can run: OpenRouter's listing on the named key it logged in with. */
async function opencodeReady(deps: CapabilityDeps, role: string): Promise<SourceDescriptor> {
  const { key } = readRouting(deps.privateDir).subharness;
  const reading = await roleModelListing(
    { fetch: deps.fetch, baseUrl: deps.baseUrl, value: opencodeKey(deps.privateDir)?.value ?? '' },
    isAgentName(role) ? LISTING_ROLE_OF_AGENT : role
  );
  const shape = { ...backendShape('opencode'), account: key, setup: [], effort: BACKEND_EFFORTS.opencode };
  if (!reading.ok) return { ...shape, code: 'provider-rejected', listing: 'failed', models: [] };
  return {
    ...shape,
    code: 'ok',
    listing: 'observed',
    // opencode names a model by its provider; the reply check strips the prefix again for OpenRouter.
    models: reading.models.map((id) => ({ id, evidence: 'observed', saveAs: `openrouter/${id}` })),
  };
}

async function backendSource(deps: CapabilityDeps, backend: BackendName, role: string): Promise<SourceDescriptor> {
  if (!backendsOf(role).includes(backend))
    return {
      ...backendShape(backend),
      code: 'role-unsupported',
      setup: [],
      listing: 'none',
      models: [],
      effort: [],
    };
  const state = await sourceState(deps.privateDir, backend);
  if (!state.available) {
    const key = backend === 'opencode' ? ' --key <name>' : '';
    return {
      ...backendShape(backend),
      code: state.code === 'ok' ? 'not-logged-in' : state.code,
      setup: [{ command: `/subharness ${backend} login${key}`, masked: false }],
      listing: 'none',
      models: [],
      effort: BACKEND_EFFORTS[backend],
    };
  }
  if (backend === 'opencode') return opencodeReady(deps, role);
  return {
    ...backendShape(backend),
    code: 'ok',
    setup: [],
    listing: 'suggestion',
    models: FIXED_MODELS[backend].map((id) => ({ id, evidence: 'suggestion' })),
    effort: BACKEND_EFFORTS[backend],
  };
}

/** The direct path, for a base role or the memory writer. Effort stays with `/model set --effort`, which checks it on the key. */
async function apiSource(deps: CapabilityDeps, role: string): Promise<SourceDescriptor> {
  const shape: Omit<SourceDescriptor, 'code' | 'listing' | 'models' | 'setup'> = {
    id: 'api:openrouter',
    providerType: 'api',
    via: null,
    label: 'OpenRouter',
    account: deps.openRouterKeyName ?? null,
    effort: [],
    manualModel: true,
  };
  if (deps.openRouterKey === null)
    return {
      ...shape,
      code: 'no-key',
      listing: 'none',
      models: [],
      setup: [
        { command: '/keys add <name>', masked: true },
        { command: `/model set ${role} <name>/<model>`, masked: false },
      ],
    };
  const reading = await roleModelListing({ fetch: deps.fetch, baseUrl: deps.baseUrl, value: deps.openRouterKey }, role);
  return reading.ok
    ? {
        ...shape,
        code: 'ok',
        listing: 'observed',
        setup: [],
        models: reading.models.map((id) => ({ id, evidence: 'observed' })),
      }
    : { ...shape, code: 'provider-rejected', listing: 'failed', setup: [], models: [] };
}

function currentOf(privateDir: string, role: string): RoleSources['current'] {
  const stored = readRouting(privateDir).subharness;
  if (role === MEMORY_ROLE) {
    const memory = harnessPathOf(privateDir, 'memory');
    return memory.kind === 'direct' ? null : { via: memory.backend, model: memory.model, effort: memory.effort };
  }
  if (!isAgentName(role)) return null;
  return {
    via: Object.hasOwn(stored.uses, role) ? (stored.uses[role] ?? null) : null,
    model: Object.hasOwn(stored.models, role) ? (stored.models[role] ?? null) : null,
    effort: Object.hasOwn(stored.efforts, role) ? (stored.efforts[role] ?? null) : null,
  };
}

const isApiRole = (role: string): boolean => role === MEMORY_ROLE || BASE_ROLES.includes(role);

/** The sources of `role` as they stand now: the direct path first where the role has one, then every backend. */
export async function roleSources(deps: CapabilityDeps, role: string): Promise<RoleSources> {
  const sources = await Promise.all([
    ...(isApiRole(role) ? [apiSource(deps, role)] : []),
    ...BACKEND_NAMES.map((backend) => backendSource(deps, backend, role)),
  ]);
  return { role, current: currentOf(deps.privateDir, role), sources };
}
