// The mechanics step of `neptunia setup` (src/setup/run.ts, docs/setup.md): her two ticking mechanics, `heartbeat` and
// `diary`, and the humanizer, each switched on or off at the terminal. Each question offers the value in force, so an empty answer
// keeps it. With the diary on, the step then offers the route of the diary's director role `director` from the named keys
// of keys.json and the connected harnesses, and an empty answer keeps its chain, the analyzer's while it has none. The
// answers go into `<private>/config.local/config.json`, every other key kept, and nothing is written when no answer
// changes a value.

import { readConfig } from '../config.ts';
import { readKeys } from '../keys/file.ts';
import { DIARY_DIRECTOR_ROLE } from '../llm/roles.ts';
import { HARNESS_BACKENDS, isRefusal, parseRouteText, readRoute, routeText } from '../llm/route-text.ts';
import type { Route } from '../llm/route-text.ts';
import { availableSources } from '../subharness/sources.ts';
import { updateLocalSettings } from '../service/local-settings.ts';
import { objOf } from '../tools/types.ts';
import { setPath } from '../tools/operations/shared.ts';

/** Asks the owner at the terminal; `offered` is shown as the default and an empty answer takes it. */
export type Ask = (question: string, offered: string | null) => Promise<string>;

export type MechanicsStepDeps = { ask: Ask };
export type MechanicsStepOutcome = { state: 'done' | 'already'; detail: string };

/** How many times one question is asked before the value in force is kept. */
const TRIES = 3;

/**
 * Asks `question` until the answer, trimmed and lowercased, passes `isValid`; '' takes `offered`. After three answers
 * that do not, the value in force (`offered`) is kept.
 */
async function askValid(ask: Ask, question: string, offered: string, isValid: (answer: string) => boolean) {
  for (let tried = 0; tried < TRIES; tried += 1) {
    const raw = (await ask(question, offered)).trim();
    const answer = raw === '' ? offered : raw;
    if (isValid(answer)) return answer;
  }
  return offered;
}

/** An on or off question: true for `on`, false for `off`, `current` after three answers that are neither. */
async function askSwitch(ask: Ask, question: string, current: boolean): Promise<boolean> {
  const answer = await askValid(ask, question, current ? 'on' : 'off', (one) => /^(on|off)$/i.test(one));
  return answer.toLowerCase() === 'on';
}

/** The route of the diary's director role the stored chain starts with, as text; null with no route of its own. */
function sceneRouteInForce(config: unknown): string | null {
  const chain = objOf(objOf(objOf(config).models).routes)[DIARY_DIRECTOR_ROLE];
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const route = readRoute(DIARY_DIRECTOR_ROLE, chain[0]);
  return isRefusal(route) ? null : routeText(route);
}

/**
 * Asks for the route of the diary's director role among the named keys and the connected harnesses. The route read from
 * the answer, or null for an empty answer and after three answers that name no usable route.
 */
async function askSceneRoute(ask: Ask, privateDir: string, inForce: string | null): Promise<Route | null> {
  const keys = Object.keys(readKeys(privateDir).keys);
  const harnesses = (await availableSources(privateDir)).filter((one) => HARNESS_BACKENDS.some((name) => name === one));
  const question = [
    `diary director: the model of the diary's director, which builds its scenes, <key>/<model>[:<effort>] or harness:<claude|codex>/<model>[:<effort>].`,
    `Keys: ${keys.join(', ') || 'none'}. Harnesses: ${harnesses.join(', ') || 'none'}.`,
    `Empty keeps ${inForce ?? "the analyzer's route"}:`,
  ].join(' ');
  for (let tried = 0; tried < TRIES; tried += 1) {
    const answer = (await ask(question, inForce)).trim();
    if (answer === '' || answer === inForce) return null;
    const route = parseRouteText(DIARY_DIRECTOR_ROLE, answer);
    if (isRefusal(route)) continue;
    if (route.via === 'api' ? keys.includes(route.key) : harnesses.includes(route.backend)) return route;
  }
  return null;
}

export async function mechanicsStep(
  options: { rootDir: string; privateDir: string },
  deps: MechanicsStepDeps
): Promise<MechanicsStepOutcome> {
  const config = readConfig(options.rootDir, { privateDir: options.privateDir });
  const inForce = {
    heartbeat: objOf(config.heartbeat).enabled !== false,
    diary: objOf(config.diary).enabled !== false,
    humanizer: objOf(config.humanizer).enabled === true,
  };
  const heartbeat = await askSwitch(
    deps.ask,
    'heartbeat: her own wakes for her wishes and plans (on or off):',
    inForce.heartbeat
  );
  const diary = await askSwitch(deps.ask, 'diary: her diary (on or off):', inForce.diary);
  const humanizer = await askSwitch(
    deps.ask,
    'humanizer: check her longer texts and write them again before they are posted (on or off):',
    inForce.humanizer
  );
  const sceneInForce = sceneRouteInForce(config);
  const scene = diary ? await askSceneRoute(deps.ask, options.privateDir, sceneInForce) : null;
  const answers = { heartbeat, diary, humanizer };
  const changed =
    heartbeat !== inForce.heartbeat || diary !== inForce.diary || humanizer !== inForce.humanizer || scene !== null;
  const sceneText = scene === null ? (sceneInForce ?? "the analyzer's route") : routeText(scene);
  const summary = `heartbeat ${heartbeat ? 'on' : 'off'}, diary ${diary ? 'on' : 'off'}${diary ? `, diary director on ${sceneText}` : ''}, humanizer ${humanizer ? 'on' : 'off'}`;
  if (changed)
    updateLocalSettings(options.privateDir, (saved) => {
      let local = saved;
      for (const [name, value] of Object.entries(answers)) local = setPath(local, [name, 'enabled'], value);
      return scene === null ? local : setPath(local, ['models', 'routes', DIARY_DIRECTOR_ROLE], [scene]);
    });
  return changed ? { state: 'done', detail: summary } : { state: 'already', detail: summary };
}
