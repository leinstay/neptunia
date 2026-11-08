// The `routes` check of `neptunia doctor`: every part of Neptunia checked for real on what it runs on now, and every
// connection that is set up but used by nothing. A role on the API (`core`, `memory`, `analyzer`, `vision`, `video`,
// `embedding`, `speech`, the simulation and quick search on `openrouter`) gets one minimal request of `checkRole`
// (src/keys/check.ts) on its own key, the extra key `llm.boundKeys` binds it to or else the first core key, with its own
// model. One model on one key is asked once. `drawing` is named and never asked, since one request bills a picture. A
// role or an agent on a harness gets the vendor's own status command (`sourceState`, src/subharness/sources.ts). An extra
// key bound to nothing gets the free read of its record (`checkKey`), and a harness no role or agent uses gets its status
// command. A failure under the core, the memory writer or the analyzer fails the check, any other failure warns. Lines
// carry names and models, never a key value. The owner's word of 2026-11-08: the doctor is a diagnosis he asked for,
// while a chat launch checks nothing (src/setup/readiness.ts).

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { checkKey, checkRole } from '../keys/check.ts';
import type { CheckResult } from '../keys/check.ts';
import { createKeyStore } from '../keys/store.ts';
import { roleModel } from '../llm/roles.ts';
import { routeName } from '../subharness/route-names.ts';
import { readRouting, SUBHARNESS_AGENTS } from '../subharness/routing.ts';
import { sourceProblem, sourceState } from '../subharness/sources.ts';
import type { SourceState } from '../subharness/sources.ts';

export type RouteHealth = { status: 'ok' | 'warn' | 'fail'; detail: string };

export type RouteHealthDeps = { privateDir: string; config: unknown; fetch: typeof fetch };

/** The parts she cannot work without: a failure of one fails the check. */
const MANDATORY: ReadonlySet<string> = new Set(['core', 'memory', 'analyzer']);

/** The model roles on the API, in the order the check names them. */
const API_ROLES = ['core', 'memory', 'analyzer', 'vision', 'video', 'embedding', 'speech', 'drawing'] as const;

type Line = { text: string; bad: 'fail' | 'warn' | null };

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function routeHealth(deps: RouteHealthDeps): Promise<RouteHealth> {
  const { privateDir, config } = deps;
  const routing = readRouting(privateDir);
  const store = createKeyStore({ privateDir });
  const baseUrl = text(rec(rec(config).llm).baseUrl);
  const voice = text(rec(rec(config).speech).voice);
  const sources = new Map<BackendName, Promise<SourceState>>();
  const source = (backend: BackendName): Promise<SourceState> => {
    const known = sources.get(backend) ?? sourceState(privateDir, backend);
    sources.set(backend, known);
    return known;
  };
  const probes = new Map<string, Promise<CheckResult>>();
  const used = new Set<string>();
  const badOf = (part: string): 'fail' | 'warn' => (MANDATORY.has(part) ? 'fail' : 'warn');

  async function onHarness(part: string, backend: BackendName, model: string | null): Promise<Line> {
    const state = await source(backend);
    const head = `${part}: ${routeName(backend)}${model === null ? '' : ` ${model}`}`;
    return state.available
      ? { text: `${head} · logged in`, bad: null }
      : { text: `${head} · ${sourceProblem(state)}`, bad: badOf(part) };
  }

  async function onKey(part: string, role: string, model: string, keyName: string | null): Promise<Line> {
    const value = keyName === null ? null : store.valueOf(keyName);
    if (keyName === null || value === null) return { text: `${part}: ${model} · no key carries it`, bad: badOf(part) };
    used.add(keyName);
    const head = `${part}: ${model} on key ${keyName}`;
    const kind = role === 'embedding' || role === 'speech' ? role : 'chat';
    const id = `${kind}|${model}|${keyName}`;
    const probe =
      probes.get(id) ??
      checkRole({ fetch: deps.fetch, baseUrl, role, model, keyName, value, voice: voice || undefined });
    probes.set(id, probe);
    const result = await probe;
    if (result.capability === 'unsupported')
      return { text: `${head} · not asked: no cheap request proves it`, bad: null };
    if (result.ok) return { text: `${head} · answers`, bad: null };
    const why =
      result.status === null ? (result.error ?? 'no answer') : `${result.status} ${result.error ?? ''}`.trim();
    return { text: `${head} · refused: ${why}`, bad: badOf(part) };
  }

  const keyOf = (role: string): string | null => store.boundTo(role) ?? store.coreNames()[0] ?? null;

  async function partLine(role: (typeof API_ROLES)[number]): Promise<Line> {
    const record = role === 'core' || role === 'memory' ? routing.subharness[role] : null;
    if (record !== null) return onHarness(role, record.backend, record.model);
    const model = roleModel(config, role);
    if (model === undefined || model === '') return { text: `${role}: off`, bad: null };
    if (role === 'drawing') return { text: `drawing: ${model} · not asked: one request bills a picture`, bad: null };
    return onKey(role, role, model, keyOf(role));
  }

  const lines: Array<Line> = [];
  for (const role of API_ROLES) lines.push(await partLine(role));

  const simulation = routing.subharness.simulation;
  if (simulation !== null) lines.push(await onHarness('simulation', simulation.backend, simulation.model));
  else if (routing.simulation.key !== null)
    lines.push(await onKey('simulation', 'core', roleModel(config, 'core') ?? '', routing.simulation.key));
  else lines.push({ text: 'simulation: off', bad: null });

  const search = rec(rec(rec(config).web).quickSearch);
  const engine = text(search.engine);
  if (engine === 'openrouter') lines.push(await onKey('search', 'search', text(search.model), keyOf('search')));
  else
    lines.push({
      text: `search: ${engine === '' ? 'off' : `${engine} · not asked: its service key is its own`}`,
      bad: null,
    });

  for (const agent of SUBHARNESS_AGENTS) {
    const backend = routing.subharness.uses[agent];
    if (backend === undefined) continue;
    lines.push(await onHarness(agent, backend, routing.subharness.models[agent] ?? null));
    if (backend === 'opencode' && routing.subharness.key !== null) used.add(routing.subharness.key);
  }

  for (const row of store.list().extra) {
    if (used.has(row.name) || row.roles.length > 0) continue;
    const value = store.valueOf(row.name) ?? '';
    const info = await checkKey({ fetch: deps.fetch, baseUrl, value });
    lines.push({
      text: `${row.name}: bound to nothing · ${info.ok ? 'answers' : `refused: ${info.error ?? 'no answer'}`}`,
      bad: info.ok ? null : 'warn',
    });
  }
  const usedBackends = new Set<string>([...sources.keys()]);
  for (const backend of BACKEND_NAMES) {
    if (usedBackends.has(backend)) continue;
    const state = await sourceState(privateDir, backend);
    if (!state.installed) continue;
    lines.push({
      text: `${routeName(backend)}: used by nothing · ${state.available ? 'logged in' : sourceProblem(state)}`,
      bad: null,
    });
  }

  const status = lines.some((one) => one.bad === 'fail')
    ? 'fail'
    : lines.some((one) => one.bad === 'warn')
      ? 'warn'
      : 'ok';
  return { status, detail: lines.map((one) => one.text).join('\n') };
}
