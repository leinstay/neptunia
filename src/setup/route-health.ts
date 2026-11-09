// The `routes` check of `neptunia doctor`: every part of Neptunia checked for real on what it runs on now, and every
// connection that is set up but used by nothing. A role on the API (`core`, `memory`, `analyzer`, `vision`, `video`,
// `embedding`, `speech` and quick search on `openrouter`) gets one minimal request of `checkRole`
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

/** What the lines of one doctor run share: the routing, the key store, and the answers asked once. */
type Run = {
  deps: RouteHealthDeps;
  routing: ReturnType<typeof readRouting>;
  sub: ReturnType<typeof readRouting>['subharness'];
  store: ReturnType<typeof createKeyStore>;
  baseUrl: string;
  voice: string;
  sources: Map<BackendName, Promise<SourceState>>;
  probes: Map<string, Promise<CheckResult>>;
  /** the extra keys some line used */
  used: Set<string>;
};

const badOf = (part: string): 'fail' | 'warn' => (MANDATORY.has(part) ? 'fail' : 'warn');

function source(run: Run, backend: BackendName): Promise<SourceState> {
  const known = run.sources.get(backend) ?? sourceState(run.deps.privateDir, backend);
  run.sources.set(backend, known);
  return known;
}

async function onHarness(run: Run, part: string, backend: BackendName, model: string | null): Promise<Line> {
  const state = await source(run, backend);
  const head = `${part}: ${routeName(backend)}${model === null ? '' : ` ${model}`}`;
  return state.available
    ? { text: `${head} · logged in`, bad: null }
    : { text: `${head} · ${sourceProblem(state)}`, bad: badOf(part) };
}

/** `checkRole` of `role` on `keyName`, one request per kind of endpoint, model and key. */
function probe(run: Run, role: string, model: string, keyName: string, value: string): Promise<CheckResult> {
  const kind = role === 'embedding' || role === 'speech' ? role : 'chat';
  const id = `${kind}|${model}|${keyName}`;
  const voice = run.voice === '' ? undefined : run.voice;
  const asked =
    run.probes.get(id) ??
    checkRole({ fetch: run.deps.fetch, baseUrl: run.baseUrl, role, model, keyName, value, voice });
  run.probes.set(id, asked);
  return asked;
}

async function onKey(run: Run, part: string, role: string, model: string, keyName: string | null): Promise<Line> {
  const value = keyName === null ? null : run.store.valueOf(keyName);
  if (keyName === null || value === null) return { text: `${part}: ${model} · no key carries it`, bad: badOf(part) };
  run.used.add(keyName);
  const head = `${part}: ${model} on key ${keyName}`;
  const result = await probe(run, role, model, keyName, value);
  if (result.capability === 'unsupported')
    return { text: `${head} · not asked: no cheap request proves it`, bad: null };
  if (result.ok) return { text: `${head} · answers`, bad: null };
  const why = result.status === null ? (result.error ?? 'no answer') : `${result.status} ${result.error ?? ''}`.trim();
  return { text: `${head} · refused: ${why}`, bad: badOf(part) };
}

const keyOf = (run: Run, role: string): string | null => run.store.boundTo(role) ?? run.store.coreNames()[0] ?? null;

function partLine(run: Run, role: (typeof API_ROLES)[number]): Promise<Line> {
  const record = role === 'core' || role === 'memory' ? run.sub[role] : null;
  if (record !== null) return onHarness(run, role, record.backend, record.model);
  const model = roleModel(run.deps.config, role);
  if (model === undefined || model === '') return Promise.resolve({ text: `${role}: off`, bad: null });
  if (role === 'drawing')
    return Promise.resolve({ text: `drawing: ${model} · not asked: one request bills a picture`, bad: null });
  return onKey(run, role, role, model, keyOf(run, role));
}

function searchLine(run: Run): Promise<Line> {
  const search = rec(rec(rec(run.deps.config).web).quickSearch);
  const engine = text(search.engine);
  if (engine === 'openrouter') return onKey(run, 'search', 'search', text(search.model), keyOf(run, 'search'));
  const said = engine === '' ? 'off' : `${engine} · not asked: its service key is its own`;
  return Promise.resolve({ text: `search: ${said}`, bad: null });
}

async function agentLines(run: Run): Promise<Array<Line>> {
  const lines: Array<Line> = [];
  const { uses, models } = run.sub;
  for (const agent of SUBHARNESS_AGENTS) {
    const backend = uses[agent];
    if (backend === undefined) continue;
    lines.push(await onHarness(run, agent, backend, models[agent] ?? null));
    if (backend === 'opencode' && run.sub.key !== null) run.used.add(run.sub.key);
  }
  return lines;
}

/** The extra keys bound to nothing and the installed harnesses no line asked: used by nothing. */
async function unusedLines(run: Run): Promise<Array<Line>> {
  const lines: Array<Line> = [];
  for (const row of run.store.list().extra) {
    if (run.used.has(row.name) || row.roles.length > 0) continue;
    const info = await checkKey({
      fetch: run.deps.fetch,
      baseUrl: run.baseUrl,
      value: run.store.valueOf(row.name) ?? '',
    });
    const said = info.ok ? 'answers' : `refused: ${info.error ?? 'no answer'}`;
    lines.push({ text: `${row.name}: bound to nothing · ${said}`, bad: info.ok ? null : 'warn' });
  }
  for (const backend of BACKEND_NAMES) {
    if (run.sources.has(backend)) continue;
    const state = await sourceState(run.deps.privateDir, backend);
    if (!state.installed) continue;
    const said = state.available ? 'logged in' : sourceProblem(state);
    lines.push({ text: `${routeName(backend)}: used by nothing · ${said}`, bad: null });
  }
  return lines;
}

export async function routeHealth(deps: RouteHealthDeps): Promise<RouteHealth> {
  const routing = readRouting(deps.privateDir);
  const run: Run = {
    deps,
    routing,
    sub: routing.subharness,
    store: createKeyStore({ privateDir: deps.privateDir }),
    baseUrl: text(rec(rec(deps.config).llm).baseUrl),
    voice: text(rec(rec(deps.config).speech).voice),
    sources: new Map(),
    probes: new Map(),
    used: new Set(),
  };
  const lines: Array<Line> = [];
  for (const role of API_ROLES) lines.push(await partLine(run, role));
  lines.push(await searchLine(run), ...(await agentLines(run)), ...(await unusedLines(run)));
  const worst = lines.some((one) => one.bad === 'fail')
    ? 'fail'
    : lines.some((one) => one.bad === 'warn')
      ? 'warn'
      : 'ok';
  return { status: worst, detail: lines.map((one) => one.text).join('\n') };
}
