// One route of a model role's chain (src/llm/route-chain.ts): a request on a named key of keys.json with a model, or one
// run of a subscription CLI with a model. The text form is what commands and script flags take and print,
// `<key>/<model>[:<effort>]` and `harness:<claude|codex>/<model>[:<effort>]`; the record form is what
// `models.routes.<role>` of config.json holds. Both read into the same route, and each refusal is a code with a reason
// that holds no key value. A harness carries only the roles that run as a CLI chat step. Every route of every role takes
// an effort on one scale, `disabled`, `low`, `medium` and `high` (the owner, 2026-11-09), which src/llm/chain-client.ts
// translates per route; the older words of a CLI or a provider are refused with `effort-retired`. A role outside
// TEXT_ROLES takes no level, only `disabled` or none (the owner, 2026-11-10). Pure.

import type { EffortLevel } from './roles.ts';

/** The model roles that run on a chain of routes, in display order. */
export const ROUTE_ROLES = [
  'core',
  'memory',
  'analyzer',
  'vision',
  'video',
  'embedding',
  'speech',
  'drawing',
  'search',
] as const;
export type RouteRole = (typeof ROUTE_ROLES)[number];

/** The CLIs a harness route runs: each takes a system prompt of its own, which `opencode run` does not. */
export const HARNESS_BACKENDS = ['claude', 'codex'] as const;
export type HarnessBackend = (typeof HARNESS_BACKENDS)[number];

/**
 * The roles that answer in text from a chat model, the ones a reasoning effort reaches. `embedding`, `speech` and
 * `drawing` call models that take no reasoning parameter.
 */
export const TEXT_ROLES: ReadonlyArray<RouteRole> = ['core', 'memory', 'analyzer', 'search', 'vision', 'video'];

/** The effort of a text role whose route and `llm.routeEffort` name none. */
export const DEFAULT_ROUTE_EFFORT = 'medium';

/** The roles that run as a CLI chat step: her turns and the memory writer. */
export const HARNESS_ROLES: ReadonlyArray<string> = ['core', 'memory'];

/** The one effort scale of a route, for every role and route. */
export const ROUTE_EFFORTS = ['disabled', 'low', 'medium', 'high'] as const;
export type RouteEffort = (typeof ROUTE_EFFORTS)[number];

/** The effort words of a CLI or a provider that the scale left out. */
const RETIRED_EFFORTS: ReadonlyArray<string> = ['minimal', 'xhigh', 'max', 'none'];

export const isRouteEffort = (value: unknown): value is RouteEffort => ROUTE_EFFORTS.some((one) => one === value);

/**
 * The level a harness runs `effort` at: the level itself, and for `disabled` the lowest every CLI takes, `low`, since
 * no CLI takes a `disabled` effort; the memory writer switches claude's thinking off apart. Null leaves
 * the CLI at its own default.
 */
export const harnessEffort = (effort: RouteEffort | null): EffortLevel | null =>
  effort === null ? null : effort === 'disabled' ? 'low' : effort;

export type ApiRoute = { via: 'api'; key: string; model: string; effort: RouteEffort | null };
export type HarnessRoute = { via: 'harness'; backend: HarnessBackend; model: string; effort: RouteEffort | null };
export type Route = ApiRoute | HarnessRoute;

export type RouteRefusal = { code: 'route-malformed' | 'route-unsupported' | 'effort-retired'; reason: string };

/** The key names keys.json accepts. */
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHAPE = 'give <key>/<model>[:<effort>] or harness:<claude|codex>/<model>[:<effort>]';

export const isRouteRole = (role: unknown): role is RouteRole => ROUTE_ROLES.some((one) => one === role);
export const isRefusal = (value: Route | RouteRefusal): value is RouteRefusal => 'code' in value;

const malformed = (reason = SHAPE): RouteRefusal => ({ code: 'route-malformed', reason });
const unsupported = (reason: string): RouteRefusal => ({ code: 'route-unsupported', reason });
const retired = (word: string): RouteRefusal => ({
  code: 'effort-retired',
  reason: `${word} is no effort of the scale; use ${ROUTE_EFFORTS.join(', ')}`,
});

/**
 * The model id and the effort of `rest`: a last `:<level>` of the scale is the effort, a retired word is refused, and
 * any other suffix (a provider variant such as `:free`) stays on the model id.
 */
function modelAndEffort(rest: string): { model: string; effort: RouteEffort | null } | RouteRefusal {
  const colon = rest.lastIndexOf(':');
  const tail = colon === -1 ? '' : rest.slice(colon + 1);
  if (RETIRED_EFFORTS.includes(tail)) return retired(tail);
  return isRouteEffort(tail) ? { model: rest.slice(0, colon), effort: tail } : { model: rest, effort: null };
}

/** The checks every route passes whatever form it came in: the role may take it, and an API effort its requests. */
function checked(role: string, route: Route): Route | RouteRefusal {
  if (route.model.trim() === '') return malformed();
  if (route.via === 'harness') {
    if (!HARNESS_ROLES.includes(role))
      return unsupported(`${role} runs on a key only; a harness carries ${HARNESS_ROLES.join(' and ')}`);
    return route;
  }
  return KEY_NAME.test(route.key) ? route : malformed();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `role` sends `effort`: a level reaches only a role of TEXT_ROLES. */
const takesEffort = (role: string, effort: RouteEffort | null): boolean =>
  effort === null || effort === 'disabled' || TEXT_ROLES.some((one) => one === role);

/**
 * A stored level of a route of `role` that no request of the role sends, or null. The doctor reports it, since
 * `readRoute` reads it as `disabled`.
 */
export function ignoredEffort(role: string, value: unknown): RouteEffort | null {
  const effort = isRecord(value) ? value.effort : null;
  return isRouteEffort(effort) && !takesEffort(role, effort) ? effort : null;
}

/** The route of `text` for `role`, or why it is refused. */
export function parseRouteText(role: string, text: string): Route | RouteRefusal {
  if (text.startsWith('harness:')) {
    const body = text.slice('harness:'.length);
    const slash = body.indexOf('/');
    if (slash === -1) return malformed();
    const name = body.slice(0, slash);
    const backend = HARNESS_BACKENDS.find((one) => one === name);
    if (backend === undefined)
      return unsupported(`${name || 'that'} carries no route; the harnesses are ${HARNESS_BACKENDS.join(' and ')}`);
    const read = modelAndEffort(body.slice(slash + 1));
    if ('code' in read) return read;
    return checked(role, { via: 'harness', backend, ...read });
  }
  const slash = text.indexOf('/');
  if (slash === -1) return malformed();
  const read = modelAndEffort(text.slice(slash + 1));
  if ('code' in read) return read;
  if (!takesEffort(role, read.effort))
    return unsupported(`${role} takes no effort level, since its model has no reasoning; give none or :disabled`);
  return checked(role, { via: 'api', key: text.slice(0, slash), ...read });
}

/** The route of one record of `models.routes.<role>`, or why it is refused. */
export function readRoute(role: string, value: unknown): Route | RouteRefusal {
  if (!isRecord(value) || typeof value.model !== 'string') return malformed('a route is a record with via and model');
  const effort = value.effort ?? null;
  if (typeof effort === 'string' && RETIRED_EFFORTS.includes(effort)) return retired(effort);
  if (effort !== null && !isRouteEffort(effort)) return malformed(`${JSON.stringify(effort)} is no effort level`);
  if (value.via === 'harness') {
    const backend = HARNESS_BACKENDS.find((one) => one === value.backend);
    if (backend === undefined) return unsupported(`the harnesses are ${HARNESS_BACKENDS.join(' and ')}`);
    return checked(role, { via: 'harness', backend, model: value.model, effort });
  }
  if (value.via !== 'api' || typeof value.key !== 'string') return malformed('via is api with a key, or harness');
  // A level stored before the refusal of `parseRouteText` reads as what the role sends, so the route stays.
  const sent = takesEffort(role, effort) ? effort : 'disabled';
  return checked(role, { via: 'api', key: value.key, model: value.model, effort: sent });
}

/** The route in its text form, which `parseRouteText` reads back. */
export function routeText(route: Route): string {
  const effort = route.effort === null ? '' : `:${route.effort}`;
  return route.via === 'api'
    ? `${route.key}/${route.model}${effort}`
    : `harness:${route.backend}/${route.model}${effort}`;
}
