// What each operation does to the world, by its actual effect, in one table: `read` (changes
// nothing), `write` (adds or changes something that can be changed back), `destructive` (deletes
// or overwrites what cannot simply be put back), `administrative` (changes how the bot is run or
// who may do what), `paid` (spends balance). The persona's skills read it (src/tools/definitions.ts):
// a paid skill needs its budget, a destructive one has a cooldown per channel
// (src/tools/gateway.ts), and it will decide which calls need the owner's confirmation later.
// Pure; every registered operation must have its row (a test holds it).

/** The effect classes, from the mildest. */
export const EFFECT_CLASSES = Object.freeze(['read', 'write', 'destructive', 'administrative', 'paid'] as const);

/** One of the effect classes. */
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** Operation name -> effect class. */
export const OP_EFFECTS: Readonly<Record<string, EffectClass>> = Object.freeze({
  'status.show': 'read',
  'config.set': 'administrative',
  'config.unset': 'administrative',
  'bot.pause': 'administrative',
  'bot.resume': 'administrative',
  'draw.create': 'paid',
  'voice.say': 'paid',
  'pings.get': 'read',
  'pings.set': 'write',
  'media.status': 'read',
  'media.rescan': 'write',
  'media.recache': 'write',
  'model.show': 'read',
  'model.set': 'administrative',
  'route.list': 'read',
  'route.set': 'administrative',
  'route.remove': 'administrative',
  'rule.add': 'write',
  'rule.list': 'read',
  'rule.remove': 'destructive',
  'access.grant': 'administrative',
  'access.revoke': 'administrative',
  'access.list': 'read',
  'alias.add': 'write',
  'alias.remove': 'destructive',
  'learning.add': 'write',
  'learning.remove': 'destructive',
  'lore.add': 'write',
  'lore.list': 'read',
  'lore.show': 'read',
  'lore.remove': 'destructive',
  'memory.profile.read': 'read',
  'memory.channel.read': 'read',
  'memory.server.read': 'read',
  'memory.recent.read': 'read',
  'memory.affinity.read': 'read',
  'memory.journal.read': 'read',
  'memory.archive.read': 'read',
  'memory.restore': 'destructive',
  'memory.snapshot': 'write',
  'memory.private.read': 'read',
  'message.create': 'write',
  'message.edit': 'write',
  'message.delete': 'destructive',
  'message.react.add': 'write',
  'message.react.remove': 'write',
  'task.run': 'paid',
  'task.status': 'read',
  'task.cancel': 'write',
  'task.list': 'read',
  'task.read': 'read',
  'task.resolve': 'write',
  'web.search': 'read',
  'web.read': 'read',
  'media.look': 'read',
  'media.find': 'read',
  'memory.search': 'read',
  'conversation.read': 'read',
  'intent.set': 'write',
  'intent.update': 'write',
  'intent.cancel': 'write',
  'intent.list': 'read',
  'places.list': 'read',
  'skills.describe': 'read',
  'inner.stop': 'administrative',
  'inner.start': 'administrative',
  'inner.status': 'read',
});

/**
 * The persona's own expressive operations -- her messages, reactions, drawings -- and her
 * own intentions: run for her on her own grant alone, whoever asked (the owner's decision: "messages and drawings are
 * hers"); every other operation also needs the right of the person who asked
 * (src/tools/gateway.ts). Their own rules still hold (edit and delete only her own messages, a
 * post only where she may write), and so do the rules on who asked: no write when a turn answers
 * several people, only a read when nobody asked.
 */
export const SELF_OWNED_OPS: ReadonlyArray<string> = Object.freeze([
  'message.create',
  'message.edit',
  'message.delete',
  'message.react.add',
  'message.react.remove',
  'draw.create',
  'voice.say',
  // Her intentions are her own state (src/tools/impl/intent.ts).
  'intent.set',
  'intent.update',
  'intent.cancel',
  'intent.list',
]);
