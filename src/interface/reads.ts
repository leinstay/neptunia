// The core's view of an adapter's reads. `createReads(adapter, log)` wraps the adapter so that a caller gets the body of
// an `ok` answer or null. A read the adapter does not declare in `capabilities().reads` is null without a round trip.
// An `unsupported`, `forbidden` or `failed` answer is null as well, logged once per read and code (names and codes, never
// content). A caller leaves out whatever block the read feeds when it gets null: no other channels, no channel view,
// no recall hits, no reactor names, no custom emoji. A read that names the persona's own place or a direct chat with none
// to belong to is null without a round trip; a place of any depth reaches the adapter as the native id of its tree's top,
// and `placeId` null goes through as it is. Nothing here throws. `answer` runs the same read for a caller that acts on why a read
// came to nothing: it keeps the status, the code and whether the failure is worth another try.

import { PERSONA_ID } from '../memory/db/ids.ts';
import type { Adapter } from '../protocol/adapter.ts';
import type { Logger } from '../protocol/serve.ts';

/** The adapter methods that are reads, with the wire action each one runs. */
const WIRE = {
  chatInfo: 'chat.info',
  chats: 'chats.list',
  fetchMessages: 'messages.fetch',
  history: 'messages.history',
  memberInfo: 'member.info',
  dmChatOf: 'dm.chat',
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

/** A read that came to nothing, with its code. `retryable` is absent when the adapter did not say. */
export type ReadRefusal = { status: 'failed' | 'unsupported' | 'forbidden'; code: string; retryable?: boolean };

/** What `answer` gives: the `ok` answer whole, or why there is none. */
export type ReadAnswer<K extends ReadName> = ({ status: 'ok' } & OkBody<Awaited<ReturnType<Adapter[K]>>>) | ReadRefusal;

export type Reads = { [K in ReadName]: Wrapped<K> } & {
  /** Whether the adapter declares the read (by its wire name), as the next call would find it. */
  offers(wire: string): boolean;
  /** The read named, its failure kept. */
  answer<K extends ReadName>(name: K, ...args: Parameters<Adapter[K]>): Promise<ReadAnswer<K>>;
};

type Answer = { status: string; error?: { code?: string; retryable?: boolean } };

const NO_PLACE: ReadRefusal = { status: 'unsupported', code: 'no-place' };

export function createReads(adapter: Adapter, log: Logger, nativeRootOf?: (placeId: string) => string | null): Reads {
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

  /** One read to its end: the `ok` answer, or a refusal with its code. */
  async function attempt(name: ReadName, given: ReadonlyArray<unknown>): Promise<Answer | ReadRefusal> {
    const args = [...given];
    if (!offers(WIRE[name])) return { status: 'unsupported', code: 'not-offered' };
    const scope: unknown = args[0];
    const named = (scope as { placeId?: unknown } | null)?.placeId;
    if (scope === PERSONA_ID || named === PERSONA_ID) return NO_PLACE;
    if (typeof named === 'string' && nativeRootOf) {
      const native = nativeRootOf(named);
      if (native === null) return NO_PLACE;
      args[0] = { ...(scope as object), placeId: native };
    } else if (typeof scope === 'string' && nativeRootOf) {
      const native = nativeRootOf(scope);
      if (native === null) return NO_PLACE;
      args[0] = native;
    }
    let answer: Answer;
    try {
      const method = (adapter as unknown as Record<string, unknown>)[name];
      if (typeof method !== 'function') return { status: 'unsupported', code: 'not-offered' };
      answer = (await Reflect.apply(method, adapter, args)) as Answer;
    } catch (err) {
      const code = err instanceof Error ? err.name : 'threw';
      untold(name, code);
      return { status: 'failed', code };
    }
    if (answer.status === 'ok') return answer;
    const code = answer.error?.code ?? answer.status;
    untold(name, code);
    const { retryable } = answer.error ?? {};
    return { status: answer.status as ReadRefusal['status'], code, ...(retryable === undefined ? {} : { retryable }) };
  }

  function wrap<K extends ReadName>(name: K): Wrapped<K> {
    return (async (...args: Array<unknown>) => {
      const answer = await attempt(name, args);
      if (answer.status !== 'ok') return null;
      const { status, ...body } = answer;
      void status;
      return body;
    }) as unknown as Wrapped<K>;
  }

  return {
    chatInfo: wrap('chatInfo'),
    chats: wrap('chats'),
    fetchMessages: wrap('fetchMessages'),
    history: wrap('history'),
    memberInfo: wrap('memberInfo'),
    dmChatOf: wrap('dmChatOf'),
    searchMessages: wrap('searchMessages'),
    searchMembers: wrap('searchMembers'),
    emoji: wrap('emoji'),
    parseLinks: wrap('parseLinks'),
    reactors: wrap('reactors'),
    offers,
    answer: ((name: ReadName, ...args: Array<unknown>) => attempt(name, args)) as unknown as Reads['answer'],
  };
}
