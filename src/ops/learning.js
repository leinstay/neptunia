// Operations: `/nep learned add|remove`: the owner's side of the guild's list of things people taught the persona (store.js#applyLearnedOps).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { normalizeTopic } from '../memory/index.js';
import { confirmTarget, learnedLine } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, assertNotPaused, requireGuildId, tokenResolver } = env;

  /**
   * `/nep learned add`: an `add` op with no `from` that confirms the lesson at once, the same way
   * `/nep alias add` confirms an alias: repeated sightings with `confirmGapHours: 0` and ONE
   * `seenAt` (an add of a stored text counts as a sighting of it) until the item's weight reaches
   * `memory.confirmAfter` (default 2). A lesson already at or past that weight gets one ordinary
   * sighting under the live `config.memory` (so `confirmGapHours` applies) -- never more than the
   * analyzer seeing it again would give. Every other limit is the live `config.memory`. Replies
   * with the resulting item's line.
   */
  function cmdLearnedAdd(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const text = String(args?.text ?? '').trim();
    if (!text) throw invalid('text is required');

    const memoryCfg = hot.config?.memory ?? {};
    const target = confirmTarget(memoryCfg);

    const key = normalizeTopic(text);
    const before = store.getGuild(guildId).learned ?? [];
    const beforeIds = new Set(before.map((item) => item.id));
    const seenAt = Date.now();
    const seenIso = new Date(seenAt).toISOString();
    // The item this command added or sighted: a fresh id, else the same text, else the one
    // stamped just now (a text the store clamped no longer matches `key`).
    const locate = (items) =>
      items.find((it) => !beforeIds.has(it.id)) ??
      items.find((it) => normalizeTopic(it.text) === key) ??
      items.find((it) => it.lastSeen === seenIso);

    const existing = before.find((it) => normalizeTopic(it.text) === key);
    let item;
    if (existing && existing.weight >= target) {
      item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, seenAt }));
    } else {
      for (let i = 0; i < target; i += 1) {
        item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, confirmGapHours: 0, seenAt }));
        if (!item || item.weight >= target) break;
      }
    }
    if (!item) throw new Error('the item was not kept (the learned list is full)');
    return learnedLine(item, tokenResolver(guildId).resolve);
  }

  /** `/nep learned remove`: deletes one item by id; an id that is not stored is an error. */
  function cmdLearnedRemove(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const id = args?.id;
    if (!Number.isInteger(id)) throw invalid('an item id is required');
    const existing = (store.getGuild(guildId).learned ?? []).find((item) => item.id === id);
    if (!existing) throw invalid(`no learned item #${id}`, 'not-found');

    store.applyLearnedOps(guildId, { remove: [id] }, { ...(hot.config?.memory ?? {}), seenAt: Date.now() });
    return `Removed learned item #${id}: ${tokenResolver(guildId).resolve(existing.text)}`;
  }

  return { cmdLearnedAdd, cmdLearnedRemove };
});

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
