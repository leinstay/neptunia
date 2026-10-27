// Operations: `/nep lore`: the owner's side of the server lorebook (src/memory/lore.js).
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { NONE, loreLine } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { textOf } from '../types.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

const handlers = perEnv((env) => {
  const { hot, store, assertNotPaused, freshenIfPaused, requireGuildId } = env;

  function cmdLoreAdd(args: Obj, context: OpContext): string {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const title = textOf(args.title).trim();
    if (!title) throw invalid('a title is required');
    const keys = textOf(args.keys)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const text = textOf(args.text).trim();
    if (!text) throw invalid('text is required');

    const maxEntries = hot.config?.lore?.maxEntries ?? Infinity;
    const upserted = store.setLore(guildId, [{ title, keys, text, always: Boolean(args.always) }], {
      source: 'owner',
      by: 'owner',
      now: Date.now(),
      maxEntries,
      textChars: hot.config?.lore?.textChars,
      clampTolerance: hot.config?.memory?.clampTolerance,
    });
    if (upserted === 0) {
      throw invalid('invalid lore entry: needs a title, at least one key of 2+ characters, and non-empty text');
    }
    return `Lore entry saved: ${title}`;
  }

  function cmdLoreList(args: Obj, context: OpContext): string {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const query = textOf(args.query).trim().toLowerCase();
    let entries = store.getLore(guildId);
    if (query) {
      entries = entries.filter(
        (entry: Untyped) =>
          (entry.title as string).toLowerCase().includes(query) ||
          (entry.keys as Array<string>).some((key) => key.includes(query))
      );
    }
    if (entries.length === 0) return NONE;
    return (entries as Array<Untyped>).map((entry) => loreLine(entry)).join('\n');
  }

  function cmdLoreShow(args: Obj, context: OpContext): string {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const id = textOf(args.id).trim();
    const entry = store.getLore(guildId).find((e: Untyped) => e.id === id);
    if (!entry) throw invalid(`no lore entry ${id}`, CODE.NOT_FOUND);
    return JSON.stringify(entry, null, 2);
  }

  function cmdLoreRemove(args: Obj, context: OpContext): string {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const id = textOf(args.id).trim();
    const entry = store.getLore(guildId).find((e: Untyped) => e.id === id);
    if (!entry) throw invalid(`no lore entry ${id}`, CODE.NOT_FOUND);
    store.removeLore(guildId, id);
    return `Removed lore entry ${id}: ${entry.title}`;
  }

  return { cmdLoreAdd, cmdLoreList, cmdLoreShow, cmdLoreRemove };
});

defineOp({
  name: 'lore.add',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdLoreAdd(args, ctx),
});
defineOp({
  name: 'lore.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdLoreList(args, ctx),
});
defineOp({
  name: 'lore.show',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdLoreShow(args, ctx),
});
defineOp({
  name: 'lore.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdLoreRemove(args, ctx),
});
