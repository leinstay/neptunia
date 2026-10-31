// The route of her tool abilities inside one turn (src/behavior/turn.js): `draw.create` on the drawing role and
// `media.look` on the vision or video role go through src/tools/gateway.ts#callOnRoute over the core's one role
// health (src/llm/role-health.ts); `voice.say` routes inside its operation (src/tools/impl/voice.ts) and its result
// carries the same mark. The first result of a turn that went to the core model or did not happen gets one route
// line as its note, naming every tool role that is down in the order vision, video, drawing, speech
// (`labels.tools.route.fallback` or `.unavailable` per role, `.separator` between them, the ability and the reason in
// the words of `labels.tools.result.params.ability` and `.why`). Later calls of the turn get none.

import { fill } from '../format.js';
import { TOOL_ROLES, abilityRoute, abilityUnavailable, callOnRoute } from '../tools/gateway.ts';
import type { RoleHealth } from '../llm/role-health.ts';

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});
const textAt = (table: Loose, key: string): string => {
  const value = Object.hasOwn(table, key) ? table[key] : null;
  return typeof value === 'string' ? value : '';
};

/**
 * One in-turn tool call of `role` on its route: `call` runs with the core model's id when the role is down and the
 * core declares its ability, with null on the role's own model, and not at all when neither can: then the result is
 * `ability-unavailable`. A result that came from the core model is marked `route: 'core'`.
 */
export async function toolOnRoute({
  config,
  role,
  health,
  call,
}: {
  config: unknown;
  role: string;
  health: RoleHealth | null;
  call: (model: string | null) => Promise<unknown>;
}): Promise<unknown> {
  const { route, value } = await callOnRoute({ config, role, health, call });
  if (route.kind === 'unavailable') return abilityUnavailable(route);
  return route.kind === 'core' ? { ...looseOf(value), route: 'core' } : value;
}

/**
 * What the request of `role` on `model` (null: the role's own) tells `health`, then `made` as it settled: a success
 * clears the role, a failure counts as `health` judges it. A request on the core model tells nothing about the role.
 */
export async function reportRole<TValue>(
  health: RoleHealth | null,
  role: string,
  model: string | null,
  made: Promise<TValue>
): Promise<TValue> {
  if (health === null || model !== null) return made;
  try {
    const value = await made;
    health.succeeded(role);
    return value;
  } catch (err) {
    health.failed(role, err);
    throw err;
  }
}

/** The route line: one phrase for each tool role that is down, '' when none is or the labels lack a phrase. */
export function routeLine({
  config,
  labels,
  health,
}: {
  config: unknown;
  labels: unknown;
  health: RoleHealth | null;
}): string {
  const tools = looseOf(looseOf(labels).tools);
  const words = looseOf(tools.route);
  const params = looseOf(looseOf(tools.result).params);
  const phrases: Array<string> = [];
  for (const role of TOOL_ROLES) {
    const route = abilityRoute({ config, role, health });
    if (route.kind === 'role') continue;
    const template = textAt(words, route.kind === 'core' ? 'fallback' : 'unavailable');
    if (template === '') return '';
    const ability = textAt(looseOf(params.ability), route.ability) || route.ability;
    const why = textAt(looseOf(params.why), route.reason) || route.reason;
    phrases.push(fill(template, { ability, why }));
  }
  return phrases.join(textAt(words, 'separator'));
}

/**
 * The results of one step, the first routed one of the turn given the route line as its note (after a note it holds
 * already). `draft.routeTold` remembers that the turn was told; without a draft every step may tell it.
 */
export function tellRoute<TResult>(
  results: Array<TResult>,
  { draft, config, labels, health }: { draft: unknown; config: unknown; labels: unknown; health: RoleHealth | null }
): Array<TResult> {
  const turn = looseOf(draft);
  if (turn.routeTold === true) return results;
  const at = results.findIndex((result) => {
    const route = looseOf(result).route;
    return route === 'core' || route === 'unavailable';
  });
  if (at === -1) return results;
  const line = routeLine({ config, labels, health });
  if (line === '') return results;
  if (draft !== null && typeof draft === 'object') Reflect.set(draft, 'routeTold', true);
  const held = textAt(looseOf(results[at]), 'note');
  return results.map((result, i) =>
    i === at ? { ...looseOf(result), note: held === '' ? line : `${held}\n${line}` } : result
  ) as Array<TResult>;
}

/** The routes of one turn runner over its hot config and labels (read at each call) and the core's role health. */
export type TurnRoutes = {
  /** An in-turn tool call of `role` on its route (toolOnRoute). */
  tool: (role: string, call: (model: string | null) => Promise<unknown>) => Promise<unknown>;
  /** A call of `role` on its route with the route it took (src/tools/gateway.ts#callOnRoute), for `media.look`. */
  look: (role: string, call: (model: string | null) => Promise<unknown>) => ReturnType<typeof callOnRoute<unknown>>;
  /** reportRole for this runner's health. */
  report: <TValue>(role: string, model: string | null, made: Promise<TValue>) => Promise<TValue>;
  /** tellRoute over a step's results, in the call context that holds the turn's `draft`. */
  tell: <TResult>(results: Array<TResult>, context: unknown) => Array<TResult>;
};

/** The routes of a turn runner: `hot` is its `{ config, prompts }`, `health` the core's tracker or null. */
export function turnRoutes(hot: unknown, health: RoleHealth | null): TurnRoutes {
  const config = (): unknown => looseOf(hot).config;
  return {
    tool: (role, call) => toolOnRoute({ config: config(), role, health, call }),
    look: (role, call) => callOnRoute({ config: config(), role, health, call }),
    report: (role, model, made) => reportRole(health, role, model, made),
    tell: (results, context) =>
      tellRoute(results, {
        draft: looseOf(context).draft ?? null,
        config: config(),
        labels: looseOf(looseOf(hot).prompts).labels,
        health,
      }),
  };
}
