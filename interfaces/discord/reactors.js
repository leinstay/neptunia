// Who reacted to the persona's own messages, as a member sees it by hovering a reaction: the
// feedback on what she says. A small in-process store, never persisted: message id -> emoji ->
// the reactors' user ids in the order they reacted. It is fed by the gateway's reaction events
// (messageReactionAdd / Remove / RemoveAll / RemoveEmoji) of the served guild, and for her
// messages a transcript shows with reactions it has no reactors for (after a restart, say) by a
// best-effort REST backfill bounded by a time budget. Only her messages are kept, at most
// `context.reactions.maxMessages`, the oldest message evicted first. Her own reaction is the
// `mine` flag of the normalized reaction already, so she is never listed as a reactor; other
// bots count like anyone (Discord shows them). Pure but for the timer of runBackfill.

/**
 * The key one reaction is shown under: a custom emoji as `:name:`, a unicode one as itself --
 * the same string interfaces/discord/collect.js#normalizeReactions gives a reaction's `emoji`, so the
 * store and the transcript meet on it. null without a name.
 * @param {{ id?: string|null, name?: string|null }|null|undefined} emoji
 * @returns {string|null}
 */
export function reactionKey(emoji) {
  if (!emoji?.name) return null;
  return emoji.id ? `:${emoji.name}:` : emoji.name;
}

/** Snowflakes oldest first: shorter digit strings first, then text order. */
function olderFirst(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The reactor store. `maxMessages` is read at each insertion (the live
 * `context.reactions.maxMessages`; 500 when it is not a positive integer). A message enters
 * through markOwn (it is hers); reactions on any other message are ignored.
 * @param {{ maxMessages?: () => number }} [options]
 */
export function createReactorStore({ maxMessages = () => 500 } = {}) {
  /** @type {Map<string, { emojis: Map<string, string[]>, attempted: Set<string> }>} */
  const messages = new Map();
  const limit = () => {
    const value = Number(maxMessages());
    return Number.isInteger(value) && value > 0 ? value : 500;
  };
  const evict = () => {
    while (messages.size > limit()) {
      const oldest = [...messages.keys()].sort(olderFirst)[0];
      messages.delete(oldest);
    }
  };
  const entryOf = (messageId) => messages.get(String(messageId)) ?? null;

  return {
    /** Mark `messageId` as one of the persona's messages (kept from now on); evicts past the bound. */
    markOwn(messageId) {
      if (messageId === undefined || messageId === null || String(messageId) === '') return;
      const id = String(messageId);
      if (messages.has(id)) return;
      messages.set(id, { emojis: new Map(), attempted: new Set() });
      evict();
    },
    /** Whether `messageId` is a message of the persona the store keeps. */
    isOwn(messageId) {
      return messages.has(String(messageId));
    },
    /** `userId` reacted `emoji` on her message `messageId` (appended once, in order). */
    add(messageId, emoji, userId) {
      const entry = entryOf(messageId);
      if (!entry || !emoji || !userId) return false;
      const list = entry.emojis.get(emoji) ?? [];
      if (list.includes(String(userId))) return false;
      list.push(String(userId));
      entry.emojis.set(emoji, list);
      return true;
    },
    /** `userId` took back `emoji` on `messageId`. */
    remove(messageId, emoji, userId) {
      const list = entryOf(messageId)?.emojis.get(emoji);
      if (!list) return false;
      const at = list.indexOf(String(userId));
      if (at < 0) return false;
      list.splice(at, 1);
      return true;
    },
    /** Every reaction of `messageId` removed (the message stays hers). */
    removeAll(messageId) {
      const entry = entryOf(messageId);
      if (!entry) return false;
      entry.emojis.clear();
      return true;
    },
    /** One emoji's reactions of `messageId` removed. */
    removeEmoji(messageId, emoji) {
      return entryOf(messageId)?.emojis.delete(emoji) ?? false;
    },
    /**
     * The reactors a REST fetch found for `emoji` on `messageId`: their order first, then the
     * ones the store knew and the fetch did not return (a live event that came meanwhile).
     */
    set(messageId, emoji, userIds) {
      const entry = entryOf(messageId);
      if (!entry || !emoji) return false;
      const fetched = [...new Set((userIds ?? []).map(String))];
      const known = entry.emojis.get(emoji) ?? [];
      entry.emojis.set(emoji, [...fetched, ...known.filter((id) => !fetched.includes(id))]);
      return true;
    },
    /** The reactors of `emoji` on `messageId` (a copy), or null when the store has none. */
    reactors(messageId, emoji) {
      const list = entryOf(messageId)?.emojis.get(emoji);
      return list && list.length > 0 ? [...list] : null;
    },
    /** Whether a backfill of `emoji` on `messageId` was already tried (once per message and emoji). */
    attempted(messageId, emoji) {
      return entryOf(messageId)?.attempted.has(emoji) ?? false;
    },
    /** Note a backfill of `emoji` on `messageId` as tried. */
    markAttempted(messageId, emoji) {
      entryOf(messageId)?.attempted.add(emoji);
    },
    /** Counts for a log line: messages kept, reactors known. */
    counts() {
      let reactors = 0;
      for (const entry of messages.values()) for (const list of entry.emojis.values()) reactors += list.length;
      return { messages: messages.size, reactors };
    },
  };
}

/**
 * A discord.js reaction's emoji, or null: discord.js resolves it through the client's emoji
 * cache, and on a REST-only client (the tools) the getter throws.
 * @param {object|null|undefined} reaction
 * @returns {{ id?: string|null, name?: string|null }|null}
 */
export function emojiOf(reaction) {
  try {
    return reaction?.emoji ?? null;
  } catch {
    return null;
  }
}

/**
 * One gateway reaction event as plain data. `kind`: `add` / `remove` (`reaction`, `user`),
 * `removeAll` (`message`), `removeEmoji` (`reaction`). The message's author is known only on a
 * whole (cached) message; a partial one gives null.
 * @param {'add'|'remove'|'removeAll'|'removeEmoji'} kind
 * @param {{ reaction?: object|null, user?: object|null, message?: object|null }} parts  discord.js objects.
 * @returns {{ kind: string, guildId: string|null, messageId: string|null, authorId: string|null,
 *   emoji: string|null, userId: string|null }}
 */
export function reactionEventOf(kind, { reaction = null, user = null, message = null } = {}) {
  const msg = message ?? reaction?.message ?? null;
  const guildId = msg?.guildId ?? msg?.guild?.id ?? null;
  const authorId = msg && !msg.partial ? (msg.author?.id ?? null) : null;
  return {
    kind,
    guildId: guildId === null ? null : String(guildId),
    messageId: msg?.id === undefined || msg?.id === null ? null : String(msg.id),
    authorId: authorId === null ? null : String(authorId),
    emoji: reaction ? reactionKey(emojiOf(reaction)) : null,
    userId: user?.id === undefined || user?.id === null ? null : String(user.id),
  };
}

/**
 * The store's event shape (reactionEventOf's) of a `reaction.changed` protocol event, from its
 * plain fields only: `cleared` 'all' is `removeAll`, 'emoji' `removeEmoji`, otherwise `added`
 * tells `add` from `remove`. The emoji goes through reactionKey, so it matches the transcript's
 * and the backfill's. Never throws.
 * @param {{ conversation?: { guildId?: string|null }, messageId?: string, authorId?: string|null,
 *   emoji?: { id?: string|null, name?: string|null }|null, userId?: string|null, added?: boolean,
 *   cleared?: 'emoji'|'all' }} event  A `reaction.changed` event.
 * @returns {ReturnType<typeof reactionEventOf>}
 */
export function reactionStoreEventOf(event) {
  const text = (value) => (value === undefined || value === null ? null : String(value));
  const kind = event?.cleared === 'all' ? 'removeAll' : event?.cleared === 'emoji' ? 'removeEmoji' : event?.added === true ? 'add' : 'remove';
  return {
    kind,
    guildId: text(event?.conversation?.guildId),
    messageId: text(event?.messageId),
    authorId: text(event?.authorId),
    emoji: event?.emoji ? reactionKey(event.emoji) : null,
    userId: text(event?.userId),
  };
}

/**
 * Apply one reaction event (reactionEventOf's) to `store`. Another guild's event, an event on a
 * message that is not hers, the persona's own reaction and an incomplete event are ignored. A
 * message whose author is known to be the persona becomes hers in the store.
 * @param {ReturnType<typeof createReactorStore>} store
 * @param {ReturnType<typeof reactionEventOf>} event
 * @param {{ guildId: string|null, selfId: string|null }} served
 * @returns {'applied'|'ignored'}
 */
export function applyReactionEvent(store, event, { guildId, selfId }) {
  if (!event?.messageId || !guildId || event.guildId !== String(guildId)) return 'ignored';
  if (selfId && event.authorId === String(selfId)) store.markOwn(event.messageId);
  if (!store.isOwn(event.messageId)) return 'ignored';
  switch (event.kind) {
    case 'add':
    case 'remove':
      if (!event.emoji || !event.userId || (selfId && event.userId === String(selfId))) return 'ignored';
      return (event.kind === 'add' ? store.add(event.messageId, event.emoji, event.userId) : store.remove(event.messageId, event.emoji, event.userId)) ? 'applied' : 'ignored';
    case 'removeAll':
      return store.removeAll(event.messageId) ? 'applied' : 'ignored';
    case 'removeEmoji':
      return event.emoji && store.removeEmoji(event.messageId, event.emoji) ? 'applied' : 'ignored';
    default:
      return 'ignored';
  }
}

/** How many members other than the persona put `reaction` (its count less her own). */
function othersOf(reaction) {
  const count = Number(reaction?.count);
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.max(0, count - (reaction.mine ? 1 : 0));
}

/**
 * Which reactions a backfill should fetch the reactors of: on each of the persona's lines of
 * `messages` (normalized, `self`), every reaction put by someone other than her whose reactors
 * the store knows fewer of than its count says, and that was not tried before. Marks every one
 * of her lines as hers in the store (later live events on it are kept). Pure but for the store.
 * @param {object[]} messages  Normalized lines.
 * @param {ReturnType<typeof createReactorStore>} store
 * @returns {{ messageId: string, emoji: string }[]}
 */
export function backfillPlan(messages, store) {
  const plan = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.self || message.id === undefined || message.id === null) continue;
    const id = String(message.id);
    store.markOwn(id);
    for (const reaction of Array.isArray(message.reactions) ? message.reactions : []) {
      if (!reaction?.emoji) continue;
      const others = othersOf(reaction);
      if (others === 0) continue;
      const known = store.reactors(id, reaction.emoji)?.length ?? 0;
      if (known >= others || store.attempted(id, reaction.emoji)) continue;
      plan.push({ messageId: id, emoji: reaction.emoji });
    }
  }
  return plan;
}

/** The real wait of runBackfill: resolves after `ms`, never holding the process open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Fetch the reactors of each `plan` item, one at a time, through `fetchReactors(item)` (resolves
 * user ids; a throw or a non-array is a failure) and put them into `store`, each item marked tried
 * first so it is never fetched twice. Waits at most `budgetMs` (0 or less: does not wait); what is
 * still running past that goes on in the background and lands in the store for a later transcript.
 * Never throws. `wait` is injected for tests.
 * @param {{ messageId: string, emoji: string }[]} plan
 * @param {ReturnType<typeof createReactorStore>} store
 * @param {(item: { messageId: string, emoji: string }) => Promise<string[]>} fetchReactors
 * @param {{ budgetMs?: number, selfId?: string|null, wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ planned: number, fetched: number, failed: number, timedOut: boolean }>}
 */
export async function runBackfill(plan, store, fetchReactors, { budgetMs = 2000, selfId = null, wait = sleep } = {}) {
  const stats = { planned: plan.length, fetched: 0, failed: 0, timedOut: false };
  if (plan.length === 0) return stats;
  for (const item of plan) store.markAttempted(item.messageId, item.emoji);
  const all = (async () => {
    for (const item of plan) {
      try {
        const ids = await fetchReactors(item);
        if (!Array.isArray(ids)) throw new TypeError('not a list');
        store.set(item.messageId, item.emoji, ids.map(String).filter((id) => !selfId || id !== String(selfId)));
        stats.fetched += 1;
      } catch {
        stats.failed += 1;
      }
    }
  })();
  const budget = Number(budgetMs);
  if (!(budget > 0)) {
    stats.timedOut = true;
    return { ...stats };
  }
  let timedOut = false;
  await Promise.race([all, wait(budget).then(() => (timedOut = true))]);
  return { ...stats, timedOut };
}

/**
 * `messages` with each reaction on the persona's lines carrying its known reactors as `users`
 * (`{ id, name, bot }`, in the store's order), each resolved by `resolveUser(id)` (null: not
 * known, left out -- the line keeps counting them). Other lines and reactions without known
 * reactors are returned as they are. Never mutates the input.
 * @param {object[]} messages  Normalized lines.
 * @param {ReturnType<typeof createReactorStore>} store
 * @param {(id: string) => ({ name: string, bot?: boolean }|null)} resolveUser
 * @returns {object[]}
 */
export function withReactors(messages, store, resolveUser) {
  return messages.map((message) => {
    if (!message?.self || !Array.isArray(message.reactions) || message.reactions.length === 0) return message;
    let changed = false;
    const reactions = message.reactions.map((reaction) => {
      const ids = reaction?.emoji ? store.reactors(message.id, reaction.emoji) : null;
      if (!ids) return reaction;
      const users = [];
      for (const id of ids) {
        const user = resolveUser(id);
        if (user && typeof user.name === 'string' && user.name !== '') users.push({ id, name: user.name, bot: Boolean(user.bot) });
      }
      if (users.length === 0) return reaction;
      changed = true;
      return { ...reaction, users };
    });
    return changed ? { ...message, reactions } : message;
  });
}

// The member ids that react on the persona's lines (withReactors' `users`) are read by the core
// (src/format.js#reactorIdsOf, normalized lines only); re-exported here for the package's importers.
export { reactorIdsOf } from '../../src/format.js';
