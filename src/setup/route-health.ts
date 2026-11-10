// The `routes` check of `neptunia doctor`: every part of Neptunia checked for real on every route of its chain
// (src/llm/route-chain.ts), and every connection that is set up but used by nothing. A route on a key (`core`,
// `memory`, `analyzer`, `vision`, `video`, `embedding`, `speech` and quick search on `openrouter`) gets one minimal
// request of `checkRole` (src/keys/check.ts) on that key with that model. One model on one key is asked once. `drawing`
// is named and never asked, since one request bills a picture. A route or an agent on a harness gets the vendor's own
// status command (`sourceState`, src/subharness/sources.ts). A key no route uses gets the free read of its record
// (`checkKey`), and a harness no role or agent uses gets its status command. A role of the core, the memory writer or the
// analyzer whose every route failed fails the check, a failed route with another that answers warns, and so does an
// effort level stored on a role whose model takes none (`ignoredEffort`). Lines
// carry names and models, never a key value. With no harness logged in at all, a warning names the command that logs one
// in, since her agents have no runtime. The owner's word of 2026-11-08: the doctor is a diagnosis he asked for,
// while a chat launch checks nothing (src/setup/readiness.ts).

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { checkKey, checkRole } from '../keys/check.ts';
import type { CheckResult } from '../keys/check.ts';
import { createKeyStore } from '../keys/store.ts';
import { routesOf } from '../llm/route-chain.ts';
import { ignoredEffort } from '../llm/route-text.ts';
import type { RouteRole } from '../llm/route-text.ts';
import { roleModel, searchModel } from '../llm/roles.ts';
import { routeName } from '../subharness/route-names.ts';
import { readRouting, SUBHARNESS_AGENTS } from '../subharness/routing.ts';
import { availableSources, sourceProblem, sourceState } from '../subharness/sources.ts';
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
  /** the keys some line used */
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

/** One line per route of the chain of `role`; a role whose every route failed keeps its badness, else it warns. */
async function chainLines(run: Run, role: RouteRole): Promise<Array<Line>> {
  const chain = routesOf(run.deps.config, role);
  const model = role === 'search' ? searchModel(run.deps.config) : roleModel(run.deps.config, role);
  if (chain.length === 0)
    return [
      model === undefined || model === ''
        ? { text: `${role}: off`, bad: null }
        : { text: `${role}: ${model} · no key carries it`, bad: badOf(role) },
    ];
  const lines: Array<Line> = [];
  for (const [index, route] of chain.entries()) {
    const part = chain.length === 1 ? role : `${role} ${index + 1}`;
    if (route.via === 'harness') lines.push(await onHarness(run, part, route.backend, route.model));
    else if (role === 'drawing')
      lines.push({
        text: `${part}: ${route.model} on key ${route.key} · not asked: one request bills a picture`,
        bad: null,
      });
    else lines.push(await onKey(run, part, role, route.model, route.key));
  }
  const allBad = lines.every((line) => line.bad !== null);
  const checked = allBad ? lines : lines.map((line): Line => (line.bad === 'fail' ? { ...line, bad: 'warn' } : line));
  return [...checked, ...ignoredLines(run, role)];
}

/** A warning for each stored effort level of `role` that its model takes none of (`ignoredEffort`). */
function ignoredLines(run: Run, role: RouteRole): Array<Line> {
  const stored = rec(rec(rec(run.deps.config).models).routes)[role];
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value, index): Array<Line> => {
    const effort = ignoredEffort(role, value);
    const part = stored.length === 1 ? role : `${role} ${index + 1}`;
    return effort === null
      ? []
      : [{ text: `${part}: effort ${effort} is stored but its model takes none; it runs at disabled`, bad: 'warn' }];
  });
}

function searchLines(run: Run): Promise<Array<Line>> {
  const engine = text(rec(rec(rec(run.deps.config).web).quickSearch).engine);
  if (engine === 'openrouter') return chainLines(run, 'search');
  const said = engine === '' ? 'off' : `${engine} · not asked: its service key is its own`;
  return Promise.resolve([{ text: `search: ${said}`, bad: null }]);
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

/** The keys no route named and the installed harnesses no line asked: used by nothing. */
async function unusedLines(run: Run): Promise<Array<Line>> {
  const lines: Array<Line> = [];
  for (const row of run.store.list()) {
    if (run.used.has(row.name)) continue;
    const info = await checkKey({
      fetch: run.deps.fetch,
      baseUrl: run.baseUrl,
      value: run.store.valueOf(row.name) ?? '',
    });
    const said = info.ok ? 'answers' : `refused: ${info.error ?? 'no answer'}`;
    lines.push({ text: `${row.name}: used by no route · ${said}`, bad: info.ok ? null : 'warn' });
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
  for (const role of API_ROLES) lines.push(...(await chainLines(run, role)));
  lines.push(...(await searchLines(run)), ...(await agentLines(run)), ...(await unusedLines(run)));
  if ((await availableSources(deps.privateDir)).length === 0)
    lines.push({ text: 'subharness: off · neptunia subharness codex|claude|opencode login', bad: 'warn' });
  const worst = lines.some((one) => one.bad === 'fail')
    ? 'fail'
    : lines.some((one) => one.bad === 'warn')
      ? 'warn'
      : 'ok';
  return { status: worst, detail: lines.map((one) => one.text).join('\n') };
}
