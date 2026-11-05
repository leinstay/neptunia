// What a model chooser may read about a role: the registry of the roles under their display groups, and each source of a
// role with its state, the evidence behind its models and effort, and the commands that repair it. A row says how it is
// known: `observed` came from the provider or the installed binary now, `suggestion` is a fixed name nobody checked
// against this account. Effort levels are `observed` only when the binary's help lists them
// (src/subharness/place.ts#effortLevelsOfHelp); the global constants in src/llm/roles.ts never stand in for them. Reading
// sends no model request, starts no model run and returns no key value, only a key's name. An agent cannot run on a direct
// `openrouter:` path, so OpenRouter's models reach it through opencode alone. The console answers `/model sources` with
// this, and cli/model-picker.ts draws it.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { readKeys, SUBHARNESS_AGENTS } from '../keys/file.ts';
import { roleModelListing } from '../keys/models.ts';
import { BASE_ROLES, DEVELOPMENT_ROLES, ERRAND_ROLES, MEMORY_ROLE } from '../llm/roles.ts';
import { FIXED_MODELS } from './models.ts';
import { effortLevelsOfHelp } from './place.ts';
import { sourceState } from './sources.ts';

export type ModelRoleRow = {
  group: 'main' | 'errand' | 'development';
  role: string;
  label: string;
  /** a report's model, not one more agent of the group: it has no `models.development` key */
  utility: boolean;
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
  effort: { evidence: 'observed' | 'unknown' | 'unsupported'; levels: Array<string> };
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
  /** the installed binary's `--help`; without it no level is observed and none is asked of a binary */
  helpOf?(name: BackendName): Promise<string>;
};

/** Main's display order and names. `Voice` is the display name of the role `speech`, whose key is `models.base.speech`. */
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

const isAgent = (role: string): boolean => SUBHARNESS_AGENTS.some((agent) => agent === role);

/** Every role the chooser offers, Main first, each agent under the group the role table gives it. */
export function modelRoleRegistry(): Array<ModelRoleRow> {
  const row = (group: ModelRoleRow['group'], role: string, utility = false): ModelRoleRow => ({
    group,
    role,
    label: labelOf(role),
    utility,
  });
  const grouped: ReadonlyArray<string> = [...ERRAND_ROLES, ...DEVELOPMENT_ROLES];
  return [
    ...MAIN_ROLES.map((role) => row('main', role)),
    ...ERRAND_ROLES.map((role) => row('errand', role)),
    ...DEVELOPMENT_ROLES.map((role) => row('development', role)),
    ...SUBHARNESS_AGENTS.filter((agent) => !grouped.includes(agent)).map((agent) => row('development', agent, true)),
  ];
}

/** The backends `role` can run through: an agent all of them, the memory writer those that carry a system prompt. */
function backendsOf(role: string): ReadonlyArray<BackendName> {
  if (role === MEMORY_ROLE) return BACKEND_NAMES.filter((name) => name !== 'opencode');
  return isAgent(role) ? BACKEND_NAMES : [];
}

const noEffort = (): SourceDescriptor['effort'] => ({ evidence: 'unsupported', levels: [] });

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

/** The levels this binary's help lists, or `unknown`: a flag with no list proves no level. */
async function effortOf(deps: CapabilityDeps, backend: BackendName): Promise<SourceDescriptor['effort']> {
  if (deps.helpOf === undefined) return { evidence: 'unknown', levels: [] };
  try {
    const levels = effortLevelsOfHelp(await deps.helpOf(backend));
    return levels.length > 0 ? { evidence: 'observed', levels } : { evidence: 'unknown', levels: [] };
  } catch {
    // A help that cannot be read proves nothing about the levels.
    return { evidence: 'unknown', levels: [] };
  }
}

/** opencode's source when it can run: OpenRouter's listing on the extra key it logged in with. */
async function opencodeReady(deps: CapabilityDeps, role: string): Promise<SourceDescriptor> {
  const store = readKeys(deps.privateDir);
  const { key } = store.subharness;
  const reading = await roleModelListing(
    { fetch: deps.fetch, baseUrl: deps.baseUrl, value: key === null ? '' : (store.extra[key] ?? '') },
    isAgent(role) ? LISTING_ROLE_OF_AGENT : role
  );
  const shape = { ...backendShape('opencode'), account: key, setup: [], effort: await effortOf(deps, 'opencode') };
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
      effort: noEffort(),
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
      effort: { evidence: 'unknown', levels: [] },
    };
  }
  if (backend === 'opencode') return opencodeReady(deps, role);
  return {
    ...backendShape(backend),
    code: 'ok',
    setup: [],
    listing: 'suggestion',
    models: FIXED_MODELS[backend].map((id) => ({ id, evidence: 'suggestion' })),
    effort: await effortOf(deps, backend),
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
    effort: noEffort(),
    manualModel: true,
  };
  if (deps.openRouterKey === null)
    return {
      ...shape,
      code: 'no-key',
      listing: 'none',
      models: [],
      setup: [
        { command: '/keys core add <name>', masked: true },
        { command: '/keys extra add <name>', masked: true },
        { command: `/keys bind ${role} <name>`, masked: false },
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
  const stored = readKeys(privateDir).subharness;
  if (role === MEMORY_ROLE) {
    const { memory } = stored;
    return memory === null ? null : { via: memory.backend, model: memory.model, effort: memory.effort };
  }
  if (!isAgent(role)) return null;
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
