// The owner's console read `/memory lessons list` (no operation, so no tool of the persona's): the place's list of things
// people taught the persona, as the store keeps it. The memory session writes the lessons.

import { NONE, learnedLine } from './shared.ts';
import { perEnv } from './registry.ts';
import { callMethod, listOf, objOf } from '../types.ts';
import type { Env } from './env.ts';
import type { OpContext } from '../types.ts';

const handlers = perEnv((env) => {
  const { store, requirePlaceId, tokenResolver } = env;

  /** `/memory lessons list`: every lesson of the place, one line each. */
  function cmdLearnedList(context: OpContext): string {
    const placeId = requirePlaceId(context);
    const items = listOf(objOf(callMethod(store, 'getPlace', placeId)).learned);
    if (items.length === 0) return NONE;
    const { resolve } = tokenResolver();
    return items.map((item) => learnedLine(item, resolve)).join('\n');
  }

  return { cmdLearnedList };
});

/** `/memory lessons list` of the owner's console (src/interface/commands/console.ts), over the ops env `env`. */
export function listLessons(env: Env, context: OpContext): string {
  return handlers(env).cmdLearnedList(context);
}
