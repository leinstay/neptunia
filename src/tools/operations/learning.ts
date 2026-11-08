// Operations: `/nep learned add|remove`, and the owner's console read `/memory lessons list` (no operation, so no
// tool of hers): the owner's side of the place's list of things people taught the persona (store.js#applyLearnedOps).
// The handler bodies moved here from src/admin.ts unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { normalizeTopic } from '../../memory/index.ts';
import { NONE, confirmTarget, learnedLine } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { callMethod, listOf, objOf, textOf } from '../types.ts';
import type { Env } from './env.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';
import { MEMORY_LIMITS } from '../../memory/text-limits.ts';

const handlers = perEnv((env) => {
  const { hot, store, assertNotPaused, requirePlaceId, tokenResolver } = env;

  /**
   * `/nep learned add`: an `add` op with no `from` that confirms the lesson at once, the same way
   * `/nep alias add` confirms an alias: repeated sightings with `confirmGapHours: 0` and ONE
   * `seenAt` (an add of a stored text counts as a sighting of it) until the item's weight reaches
   * `memory.confirmAfter` (default 2). A lesson already at or past that weight gets one ordinary
   * sighting under the live `config.memory` (so `confirmGapHours` applies) -- never more than the
   * analyzer seeing it again would give. Every other limit is the live `config.memory`. Replies
   * with the resulting item's line.
   */
  function cmdLearnedAdd(args: Obj, context: OpContext): string {
    assertNotPaused();
    const placeId = requirePlaceId(context);

    const text = textOf(args.text).trim();
    if (!text) throw invalid('text is required');

    const memoryCfg = { ...hot.config?.memory, ...MEMORY_LIMITS };
    const target = confirmTarget(memoryCfg);

    const key = normalizeTopic(text);
    const before = store.getPlace(placeId).learned ?? [];
    const beforeIds = new Set((before as Array<Untyped>).map((item) => item.id as number));
    const seenAt = Date.now();
    const seenIso = new Date(seenAt).toISOString();
    // The item this command added or sighted: a fresh id, else the same text, else the one
    // stamped just now (a text the store clamped no longer matches `key`).
    const locate = (items: Array<Untyped>): Untyped =>
      items.find((it: Untyped) => !beforeIds.has(it.id)) ??
      items.find((it: Untyped) => normalizeTopic(it.text) === key) ??
      items.find((it: Untyped) => it.lastSeen === seenIso);

    const existing = (before as Array<Untyped>).find((it: Untyped) => normalizeTopic(it.text) === key);
    let item: Untyped;
    if (existing && existing.weight >= target) {
      item = locate(store.applyLearnedOps(placeId, { add: [{ text }] }, { ...memoryCfg, seenAt }));
    } else {
      for (let i = 0; i < target; i += 1) {
        item = locate(
          store.applyLearnedOps(placeId, { add: [{ text }] }, { ...memoryCfg, confirmGapHours: 0, seenAt })
        );
        if (!item || item.weight >= target) break;
      }
    }
    if (!item) throw new Error('the item was not kept (the learned list is full)');
    return learnedLine(item, tokenResolver().resolve);
  }

  /** `/nep learned remove`: deletes one item by id; an id that is not stored is an error. */
  function cmdLearnedRemove(args: Obj, context: OpContext): string {
    assertNotPaused();
    const placeId = requirePlaceId(context);

    const id = args.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw invalid('an item id is required');
    const existing = (store.getPlace(placeId).learned ?? []).find((item: Untyped) => item.id === id);
    if (!existing) throw invalid(`no learned item #${id}`, CODE.NOT_FOUND);

    store.applyLearnedOps(placeId, { remove: [id] }, { ...hot.config?.memory, ...MEMORY_LIMITS, seenAt: Date.now() });
    return `Removed learned item #${id}: ${tokenResolver().resolve(existing.text)}`;
  }

  /** `/memory lessons list`: every lesson of the place, one line each, as `add` answers one. */
  function cmdLearnedList(context: OpContext): string {
    const placeId = requirePlaceId(context);
    const items = listOf(objOf(callMethod(store, 'getPlace', placeId)).learned);
    if (items.length === 0) return NONE;
    const { resolve } = tokenResolver();
    return items.map((item) => learnedLine(item, resolve)).join('\n');
  }

  return { cmdLearnedAdd, cmdLearnedRemove, cmdLearnedList };
});

/** `/memory lessons list` of the owner's console (src/interface/commands/console.ts), over the ops env `env`. */
export function listLessons(env: Env, context: OpContext): string {
  return handlers(env).cmdLearnedList(context);
}

defineOp({
  name: 'learning.add',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdLearnedAdd(args, ctx),
});
defineOp({
  name: 'learning.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdLearnedRemove(args, ctx),
});
