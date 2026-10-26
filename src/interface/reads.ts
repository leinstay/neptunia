// The core's view of an adapter's reads. `createReads(adapter, log)` wraps the adapter so that a caller gets the body of
// an `ok` answer or null. A read the adapter does not declare in `capabilities().reads` is null without a round trip.
// An `unsupported`, `forbidden` or `failed` answer is null as well, logged once per read and code (names and codes, never
// content). A caller leaves out whatever block the read feeds when it gets null: no other channels, no channel view,
// no recall hits, no reactor names, no custom emoji. Nothing here throws.

import type { Adapter } from '../protocol/adapter.ts';
import type { Logger } from '../protocol/serve.ts';

/** The adapter methods that are reads, with the wire action each one runs. */
const WIRE = {
  conversationInfo: 'conversation.info',
  conversations: 'conversations.list',
  fetchMessages: 'messages.fetch',
  history: 'messages.history',
  memberInfo: 'member.info',
  searchMessages: 'messages.search',
  searchMembers: 'members.search',
  emoji: 'emoji.list',
  parseLinks: 'links.parse',
  reactors: 'message.reactors',
} as const;

type ReadName = keyof typeof WIRE;

/** The body of an `ok` answer: everything but its status. */
type OkBody<R> = R extends { status: 'ok' } ? Omit<R, 'status'> : never;

type Wrapped<K extends ReadName> = (
  ...args: Parameters<Adapter[K]>
) => Promise<OkBody<Awaited<ReturnType<Adapter[K]>>> | null>;

export type Reads = { [K in ReadName]: Wrapped<K> } & {
  /** Whether the adapter declares the read (by its wire name), as the next call would find it. */
  offers(wire: string): boolean;
};

type Answer = { status: string; error?: { code?: string } };

export function createReads(adapter: Adapter, log: Logger): Reads {
  const told = new Set<string>();

  const offers = (wire: string): boolean => {
    const declared: unknown = adapter.capabilities().reads;
    return Array.isArray(declared) && declared.includes(wire);
  };

  function untold(name: ReadName, code: string): void {
    const key = `${name}:${code}`;
    if (told.has(key)) return;
    told.add(key);
    log.warn('reads: unavailable', { read: WIRE[name], code });
  }

  function wrap<K extends ReadName>(name: K): Wrapped<K> {
    return (async (...args: Array<unknown>) => {
      if (!offers(WIRE[name])) return null;
      let answer: Answer;
      try {
        const method = (adapter as unknown as Record<string, unknown>)[name];
        if (typeof method !== 'function') return null;
        answer = (await Reflect.apply(method, adapter, args)) as Answer;
      } catch (err) {
        untold(name, err instanceof Error ? err.name : 'threw');
        return null;
      }
      if (answer.status !== 'ok') {
        untold(name, answer.error?.code ?? answer.status);
        return null;
      }
      const { status, ...body } = answer;
      void status;
      return body;
    }) as unknown as Wrapped<K>;
  }

  return {
    conversationInfo: wrap('conversationInfo'),
    conversations: wrap('conversations'),
    fetchMessages: wrap('fetchMessages'),
    history: wrap('history'),
    memberInfo: wrap('memberInfo'),
    searchMessages: wrap('searchMessages'),
    searchMembers: wrap('searchMembers'),
    emoji: wrap('emoji'),
    parseLinks: wrap('parseLinks'),
    reactors: wrap('reactors'),
    offers,
  };
}
