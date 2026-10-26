// Who reacted to the persona's own messages, as a member sees it by hovering a reaction: the feedback on what she
// says. A small in-process store, never persisted: message id -> emoji -> the reactors' member ids in the order they
// reacted. It is fed by the interface's `reaction.changed` events of the served community, and for her messages a
// transcript shows with reactions it has no reactors for (after a restart, say) by a best-effort `reactors` read
// bounded by a time budget. Only her messages are kept, at most `context.reactions.maxMessages`, the oldest message
// evicted first. Her own reaction is the `mine` flag of the reaction already, so she is never listed as a reactor;
// other bots count like anyone. Pure but for the timer of `runBackfill`.

import { reactionKey } from '../protocol/reaction-key.ts';
import type { ReactionChanged } from '../protocol/events.js';

export { reactionKey };

/** Snowflakes oldest first: shorter digit strings first, then text order. */
function olderFirst(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export type ReactorStore = {
  markOwn(messageId: string): void;
  isOwn(messageId: string): boolean;
  add(messageId: string, emoji: string, userId: string): boolean;
  remove(messageId: string, emoji: string, userId: string): boolean;
  removeAll(messageId: string): boolean;
  removeEmoji(messageId: string, emoji: string): boolean;
  set(messageId: string, emoji: string, userIds: ReadonlyArray<string>): boolean;
  reactors(messageId: string, emoji: string): Array<string> | null;
  attempted(messageId: string, emoji: string): boolean;
  markAttempted(messageId: string, emoji: string): void;
  counts(): { messages: number; reactors: number };
};

type Entry = { emojis: Map<string, Array<string>>; attempted: Set<string> };

/**
 * The reactor store. `maxMessages` is read at each insertion (the live `context.reactions.maxMessages`; 500 when it is
 * not a positive integer). A message enters through `markOwn` (it is hers); reactions on any other message are ignored.
 */
export function createReactorStore({ maxMessages = () => 500 }: { maxMessages?: () => number } = {}): ReactorStore {
  const messages = new Map<string, Entry>();
  const limit = (): number => {
    const value = Number(maxMessages());
    return Number.isInteger(value) && value > 0 ? value : 500;
  };
  const evict = (): void => {
    while (messages.size > limit()) {
      const oldest = [...messages.keys()].sort(olderFirst)[0];
      if (oldest === undefined) return;
      messages.delete(oldest);
    }
  };
  const entryOf = (messageId: string): Entry | null => messages.get(String(messageId)) ?? null;

  return {
    /** Marks `messageId` as one of the persona's messages (kept from now on); evicts past the bound. */
    markOwn(messageId: string): void {
      if (String(messageId) === '') return;
      const id = String(messageId);
      if (messages.has(id)) return;
      messages.set(id, { emojis: new Map(), attempted: new Set() });
      evict();
    },
    /** Whether `messageId` is a message of the persona the store keeps. */
    isOwn(messageId: string): boolean {
      return messages.has(String(messageId));
    },
    /** `userId` reacted `emoji` on her message `messageId` (appended once, in order). */
    add(messageId: string, emoji: string, userId: string): boolean {
      const entry = entryOf(messageId);
      if (!entry || !emoji || !userId) return false;
      const list = entry.emojis.get(emoji) ?? [];
      if (list.includes(String(userId))) return false;
      list.push(String(userId));
      entry.emojis.set(emoji, list);
      return true;
    },
    /** `userId` took back `emoji` on `messageId`. */
    remove(messageId: string, emoji: string, userId: string): boolean {
      const list = entryOf(messageId)?.emojis.get(emoji);
      if (!list) return false;
      const at = list.indexOf(String(userId));
      if (at < 0) return false;
      list.splice(at, 1);
      return true;
    },
    /** Every reaction of `messageId` removed (the message stays hers). */
    removeAll(messageId: string): boolean {
      const entry = entryOf(messageId);
      if (!entry) return false;
      entry.emojis.clear();
      return true;
    },
    /** One emoji's reactions of `messageId` removed. */
    removeEmoji(messageId: string, emoji: string): boolean {
      return entryOf(messageId)?.emojis.delete(emoji) ?? false;
    },
    /**
     * The reactors a read found for `emoji` on `messageId`: their order first, then the ones the store knew and the
     * read did not return (a live event that came meanwhile).
     */
    set(messageId: string, emoji: string, userIds: ReadonlyArray<string>): boolean {
      const entry = entryOf(messageId);
      if (!entry || !emoji) return false;
      const fetched = [...new Set(userIds.map(String))];
      const known = entry.emojis.get(emoji) ?? [];
      entry.emojis.set(emoji, [...fetched, ...known.filter((id) => !fetched.includes(id))]);
      return true;
    },
    /** The reactors of `emoji` on `messageId` (a copy), or null when the store has none. */
    reactors(messageId: string, emoji: string): Array<string> | null {
      const list = entryOf(messageId)?.emojis.get(emoji);
      return list && list.length > 0 ? [...list] : null;
    },
    /** Whether a backfill of `emoji` on `messageId` was already tried (once per message and emoji). */
    attempted(messageId: string, emoji: string): boolean {
      return entryOf(messageId)?.attempted.has(emoji) ?? false;
    },
    /** Notes a backfill of `emoji` on `messageId` as tried. */
    markAttempted(messageId: string, emoji: string): void {
      entryOf(messageId)?.attempted.add(emoji);
    },
    /** Counts for a log line: messages kept, reactors known. */
    counts(): { messages: number; reactors: number } {
      let reactors = 0;
      for (const entry of messages.values()) for (const list of entry.emojis.values()) reactors += list.length;
      return { messages: messages.size, reactors };
    },
  };
}

/**
 * Applies one `reaction.changed` event to `store`. An event of another community, one with no message, the persona's own
 * reaction and an event on a message that is not hers are ignored. A message whose author is known to be the persona
 * becomes hers in the store. `cleared` 'all' empties the message, 'emoji' one emoji of it.
 */
export function applyReactionChanged(
  store: ReactorStore,
  event: ReactionChanged,
  { communityId, selfId }: { communityId: string | null; selfId: string | null }
): 'applied' | 'ignored' {
  const messageId = event.messageId;
  if (!messageId || !communityId || event.conversation.communityId !== communityId) return 'ignored';
  const userId = event.userId ?? null;
  const emoji = event.emoji ? reactionKey(event.emoji) : null;
  if (selfId && userId === selfId && event.cleared === undefined) return 'ignored';
  if (selfId && event.authorId === selfId) store.markOwn(messageId);
  if (!store.isOwn(messageId)) return 'ignored';
  if (event.cleared === 'all') return applied(store.removeAll(messageId));
  if (event.cleared === 'emoji') return applied(emoji !== null && store.removeEmoji(messageId, emoji));
  if (!emoji || !userId) return 'ignored';
  return applied(event.added ? store.add(messageId, emoji, userId) : store.remove(messageId, emoji, userId));
}

const applied = (changed: boolean): 'applied' | 'ignored' => (changed ? 'applied' : 'ignored');

type Reaction = { emoji?: string; count?: number; mine?: boolean };
type Line = { id?: string; self?: boolean; reactions?: ReadonlyArray<Reaction> };
export type ReactorName = { id: string; name: string; bot: boolean };

/** How many members other than the persona put `reaction` (its count less her own). */
function othersOf(reaction: Reaction): number {
  const count = Number(reaction.count);
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.max(0, count - (reaction.mine ? 1 : 0));
}

/**
 * Which reactions a backfill should fetch the reactors of: on each of the persona's lines of `messages`, every
 * reaction put by someone other than her whose reactors the store knows fewer of than its count says, and that was
 * not tried before. Marks every one of her lines as hers in the store (later live events on it are kept).
 */
export function backfillPlan(
  messages: ReadonlyArray<Line>,
  store: ReactorStore
): Array<{ messageId: string; emoji: string }> {
  const plan: Array<{ messageId: string; emoji: string }> = [];
  for (const message of messages) {
    if (!message.self || message.id === undefined) continue;
    const id = message.id;
    store.markOwn(id);
    for (const reaction of message.reactions ?? []) {
      if (!reaction.emoji) continue;
      const others = othersOf(reaction);
      if (others === 0) continue;
      const known = store.reactors(id, reaction.emoji)?.length ?? 0;
      if (known >= others || store.attempted(id, reaction.emoji)) continue;
      plan.push({ messageId: id, emoji: reaction.emoji });
    }
  }
  return plan;
}

/** The real wait of `runBackfill`: resolves after `ms`, never holding the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Fetches the reactors of each `plan` item, one at a time, through `fetchReactors(item)` (resolves member ids; a throw
 * or a non-array is a failure) and puts them into `store`, each item marked tried first so it is never fetched twice.
 * Waits at most `budgetMs` (0 or less: does not wait); what is still running past that goes on in the background and
 * lands in the store for a later transcript. Never throws. `wait` is injected for tests.
 */
export async function runBackfill(
  plan: ReadonlyArray<{ messageId: string; emoji: string }>,
  store: ReactorStore,
  fetchReactors: (item: { messageId: string; emoji: string }) => Promise<ReadonlyArray<string> | null>,
  {
    budgetMs = 2000,
    selfId = null,
    wait = sleep,
  }: { budgetMs?: number; selfId?: string | null; wait?: (ms: number) => Promise<void> } = {}
): Promise<{ planned: number; fetched: number; failed: number; timedOut: boolean }> {
  const stats = { planned: plan.length, fetched: 0, failed: 0, timedOut: false };
  if (plan.length === 0) return stats;
  for (const item of plan) store.markAttempted(item.messageId, item.emoji);
  const all = (async () => {
    for (const item of plan) {
      try {
        const ids = await fetchReactors(item);
        if (!Array.isArray(ids)) throw new TypeError('not a list');
        store.set(
          item.messageId,
          item.emoji,
          ids.map(String).filter((id) => !selfId || id !== String(selfId))
        );
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
  await Promise.race([
    all,
    wait(budget).then(() => {
      timedOut = true;
    }),
  ]);
  return { ...stats, timedOut };
}

/** A line with the names of the reactors added to its reactions. */
type WithNames<L extends { reactions: ReadonlyArray<Reaction> }> = Omit<L, 'reactions'> & {
  reactions: Array<L['reactions'][number] & { users?: Array<ReactorName> }>;
};

/**
 * `messages` with each reaction on the persona's lines carrying its known reactors as `users` (`{ id, name, bot }`, in
 * the store's order), each resolved by `resolveUser(id)` (null: not known, left out, the line keeps counting them).
 * Other lines and reactions without known reactors are returned as they are. Never mutates the input.
 */
export function withReactors<L extends { id: string; self?: boolean; reactions: ReadonlyArray<Reaction> }>(
  messages: ReadonlyArray<L>,
  store: ReactorStore,
  resolveUser: (id: string) => { name: string; bot?: boolean } | null
): Array<WithNames<L>> {
  return messages.map((message) => {
    if (!message.self || message.reactions.length === 0) return message as unknown as WithNames<L>;
    let changed = false;
    const reactions = message.reactions.map((reaction) => {
      const ids = reaction.emoji ? store.reactors(message.id, reaction.emoji) : null;
      if (!ids) return reaction;
      const users: Array<ReactorName> = [];
      for (const id of ids) {
        const user = resolveUser(id);
        if (user && user.name !== '') users.push({ id, name: user.name, bot: Boolean(user.bot) });
      }
      if (users.length === 0) return reaction;
      changed = true;
      return { ...reaction, users };
    });
    return (changed ? { ...message, reactions } : message) as unknown as WithNames<L>;
  });
}
