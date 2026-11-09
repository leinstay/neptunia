// One route of a model role's chain (src/llm/route-chain.ts): a request on a named key of keys.json with a model, or one
// run of a subscription CLI with a model. The text form is what commands and script flags take and print,
// `<key>/<model>[:<effort>]` and `harness:<claude|codex>/<model>[:<effort>]`; the record form is what
// `models.routes.<role>` of config.json holds. Both read into the same route, and each refusal is a code with a reason
// that holds no key value. A harness carries only the roles that run as a CLI chat step, and an effort on an API route
// only the roles of REASONING_ROLES, so the core never gets provider reasoning (the owner's rule, 2026-10-19). Pure.

import { isEffortLevel, isListedEffort, REASONING_ROLES } from './roles.ts';
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

/** The roles that run as a CLI chat step: her turns and the memory writer. */
export const HARNESS_ROLES: ReadonlyArray<string> = ['core', 'memory'];

export type ApiRoute = { via: 'api'; key: string; model: string; effort: EffortLevel | null };
export type HarnessRoute = { via: 'harness'; backend: HarnessBackend; model: string; effort: EffortLevel | null };
export type Route = ApiRoute | HarnessRoute;

export type RouteRefusal = { code: 'route-malformed' | 'route-unsupported'; reason: string };

/** The key names keys.json accepts. */
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHAPE = 'give <key>/<model>[:<effort>] or harness:<claude|codex>/<model>[:<effort>]';

export const isRouteRole = (role: unknown): role is RouteRole => ROUTE_ROLES.some((one) => one === role);
export const isRefusal = (value: Route | RouteRefusal): value is RouteRefusal => 'code' in value;

const malformed = (reason = SHAPE): RouteRefusal => ({ code: 'route-malformed', reason });
const unsupported = (reason: string): RouteRefusal => ({ code: 'route-unsupported', reason });

/** The model id and the effort of `rest`: a last `:<level>` is the effort when `isLevel` accepts it. */
function modelAndEffort(rest: string, isLevel: (value: unknown) => value is EffortLevel) {
  const colon = rest.lastIndexOf(':');
  const tail = colon === -1 ? '' : rest.slice(colon + 1);
  return isLevel(tail) ? { model: rest.slice(0, colon), effort: tail } : { model: rest, effort: null };
}

/** The checks every route passes whatever form it came in: the role may take it, and an API effort its requests. */
function checked(role: string, route: Route): Route | RouteRefusal {
  if (route.model.trim() === '') return malformed();
  if (route.via === 'harness') {
    if (!HARNESS_ROLES.includes(role))
      return unsupported(`${role} runs on a key only; a harness carries ${HARNESS_ROLES.join(' and ')}`);
    return route;
  }
  if (!KEY_NAME.test(route.key)) return malformed();
  if (route.effort !== null && !REASONING_ROLES.includes(role))
    return unsupported(`${role} takes no effort on the API; the roles that do are ${REASONING_ROLES.join(', ')}`);
  return route;
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
    const { model, effort } = modelAndEffort(body.slice(slash + 1), isListedEffort);
    return checked(role, { via: 'harness', backend, model, effort });
  }
  const slash = text.indexOf('/');
  if (slash === -1) return malformed();
  const { model, effort } = modelAndEffort(text.slice(slash + 1), isEffortLevel);
  return checked(role, { via: 'api', key: text.slice(0, slash), model, effort });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The route of one record of `models.routes.<role>`, or why it is refused. */
export function readRoute(role: string, value: unknown): Route | RouteRefusal {
  if (!isRecord(value) || typeof value.model !== 'string') return malformed('a route is a record with via and model');
  const effort = value.effort ?? null;
  if (effort !== null && !isListedEffort(effort)) return malformed(`${JSON.stringify(effort)} is no effort level`);
  if (value.via === 'harness') {
    const backend = HARNESS_BACKENDS.find((one) => one === value.backend);
    if (backend === undefined) return unsupported(`the harnesses are ${HARNESS_BACKENDS.join(' and ')}`);
    return checked(role, { via: 'harness', backend, model: value.model, effort });
  }
  if (value.via !== 'api' || typeof value.key !== 'string') return malformed('via is api with a key, or harness');
  if (effort !== null && !isEffortLevel(effort)) return unsupported(`${effort} is an effort of a CLI only`);
  return checked(role, { via: 'api', key: value.key, model: value.model, effort });
}

/** The route in its text form, which `parseRouteText` reads back. */
export function routeText(route: Route): string {
  const effort = route.effort === null ? '' : `:${route.effort}`;
  return route.via === 'api'
    ? `${route.key}/${route.model}${effort}`
    : `harness:${route.backend}/${route.model}${effort}`;
}
