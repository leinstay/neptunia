// The serving side of the link: what an interface runs to talk to the core over a Transport. It says `hello`
// with who the persona is on it, the community it serves, its capabilities and the token it was started with, sends
// each inbound event as an `event` envelope and resolves with the status of the `ack` that answers it, and runs each
// `action` envelope of the core on its adapter, answering with an `action_result`. It holds no core state and no
// platform object: a value that cannot cross the wire (a platform error in `error.cause`, the `raw` handles of an
// event) never leaves it. The core's end is src/interface/link.ts.
//
// With an `outbox` (outbox.ts) every event is numbered and kept until the core acknowledges it. Nothing is sent
// before the core answers `hello`; its answer carries the watermark of what the core has, and every waiting event
// after it goes again, in order, before any new one. An emit on a closed link still goes into the outbox, for the
// next connection to send. A full outbox evicts nothing: the event is refused, the interface reports `outbox-full`
// on `status()`, and once acknowledgements make room the messages of the gap are read back from the platform's
// history (`adapter.history` from the time of the first refused message of each conversation), under the ids live
// ingestion gives them, before anything new is queued. A refused event of another kind is lost, counted in a warning.
//
// An action carrying `deadlineAt` (ms since the epoch, by the injected `now`) that arrives after it is refused
// `failed` with `deadline-passed` and never reaches the adapter; one that started in time keeps its result. A
// `cancel` envelope naming an action that has not started ends it `cancelled`; once started, its result stands.

import type { Adapter, Capabilities } from './adapter.ts';
import { ackOf, envelope, validateEnvelope } from './envelope.js';
import { MESSAGES_FETCH } from './actions.js';
import type { Outbox } from './outbox.ts';
import { isReadAction } from './reads.ts';
import { validateAction, validateEvent } from './validate.js';
import type { Envelope, Transport } from './wire.ts';

/** The statuses of an `ack` (envelope.js#ACK_STATUSES). */
export type AckStatus = 'ok' | 'duplicate' | 'invalid' | 'unhandled' | 'failed';

/** Who an interface says it is: an id and the name people see. */
export type Named = { id: string; name: string };

/** `self` is the persona's account on the interface, `community` the community it serves (null when it serves none). */
export type Hello = {
  iface: string;
  self: Named;
  community: Named | null;
  capabilities: Capabilities;
  resume: string | null;
};

export type Logger = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

/** What `status()` reports: whether the outbox refuses events and a gap waits for the platform's history. */
export type ServeStatus = { outbox: 'ok' | 'outbox-full' };

/** How many idempotency keys the serving side remembers. */
const KEPT_KEYS = 1000;

/** How many messages of one conversation a gap is read back with: the most one history read answers on the platform. */
const GAP_HISTORY_LIMIT = 100;

/** How many cancels of actions not seen yet are remembered. */
const KEPT_CANCELS = 256;

type Result = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The result of an action as it may cross the wire: the platform's own error stays behind.
function crossable(result: unknown): Result {
  if (!isObject(result)) return { status: 'failed', error: { code: 'invalid-result', retryable: false } };
  const { error, ...rest } = result;
  if (!isObject(error)) return rest;
  const kept = { ...error };
  delete kept.cause;
  return { ...rest, error: kept };
}

const refusal = (status: string, code: string, retryable = false): Result => ({
  status,
  error: { code, retryable },
});

// The adapter method each read action runs, by the method's name; an adapter without it answers `unsupported`.
const READ_METHODS: Record<string, string> = {
  'conversation.info': 'conversationInfo',
  'conversations.list': 'conversations',
  [MESSAGES_FETCH]: 'fetchMessages',
  'messages.history': 'history',
  'member.info': 'memberInfo',
  'messages.search': 'searchMessages',
  'members.search': 'searchMembers',
  'emoji.list': 'emoji',
  'links.parse': 'parseLinks',
  'message.reactors': 'reactors',
};

// The fields of `body` named by `keys` that it carries, as the options object of an adapter method.
const pick = (body: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

// The arguments a read action carries, in the argument order of the adapter's method.
function readArguments(body: Record<string, unknown>): Array<unknown> {
  const community = pick(body, ['communityId']);
  switch (body.action) {
    case 'conversation.info':
      return [body.conversation, pick(body, ['audience', 'viewers'])];
    case 'conversations.list':
      return [pick(body, ['communityId', 'audience', 'viewers'])];
    case MESSAGES_FETCH:
      return [body.conversation, body.messageIds, pick(body, ['idempotencyKey'])];
    case 'messages.history':
      return [body.conversation, pick(body, ['limit', 'before', 'after', 'around', 'since'])];
    case 'member.info':
      return [pick(body, ['communityId', 'memberId'])];
    case 'messages.search':
      return [community, pick(body, ['text', 'authorId', 'after', 'before', 'offset'])];
    case 'members.search':
      return [community, pick(body, ['prefix', 'limit'])];
    case 'emoji.list':
      return [community];
    case 'links.parse':
      return [body.texts];
    default:
      return [body.message, body.emoji, body.limit];
  }
}

/** The event as it may cross: the platform handles stay on this side. */
function cleaned(event: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...event };
  delete clean.raw;
  delete clean.rawPrevious;
  return clean;
}

/** The action runner of one adapter: reads, effects under their idempotency key, deadlines and cancels. */
function createActions(adapter: Adapter, log: Logger, now: () => number) {
  // Insertion order is the age: the oldest key is the first one.
  const keys = new Map<string, Promise<Result>>();
  const cancelled = new Set<string>();

  async function runRead(body: Record<string, unknown>): Promise<Result> {
    const method = READ_METHODS[body.action as string];
    const target: unknown = method === undefined ? undefined : (adapter as unknown as Record<string, unknown>)[method];
    if (typeof target !== 'function') return refusal('unsupported', 'unsupported');
    return (await Reflect.apply(target, adapter, readArguments(body))) as Result;
  }

  async function run(body: Record<string, unknown>): Promise<Result> {
    const conversation = body.conversation as Parameters<Adapter['send']>[0];
    const message = body.message as Parameters<Adapter['edit']>[0];
    const content = body.content as Parameters<Adapter['send']>[1];
    if (isReadAction(body.action)) return await runRead(body);
    switch (body.action) {
      case 'message.send':
        return await adapter.send(conversation, content, pick(body, ['idempotencyKey', 'deadlineAt']));
      case 'message.edit':
        return await adapter.edit(message, content);
      case 'message.delete':
        return await adapter.delete(message);
      case 'message.react.add':
        return await adapter.react(message, body.emoji as string);
      case 'message.react.remove':
        return await adapter.unreact(message, body.emoji as string);
      // The action carries no lease: the platform's typing indicator ends by itself.
      case 'conversation.typing':
        return await adapter.typing(conversation, { untilMs: 0 });
      default:
        return refusal('unsupported', 'unsupported');
    }
  }

  async function runSafely(body: Record<string, unknown>): Promise<Result> {
    try {
      return crossable(await run(body));
    } catch (err) {
      log.warn('link: adapter threw', { action: body.action, name: err instanceof Error ? err.name : null });
      // A read changed nothing, so a throw is a plain failure; an effect that threw may have happened.
      return refusal(isReadAction(body.action) ? 'failed' : 'unknown', 'adapter-threw');
    }
  }

  // A read is asked again freely; only an effect is answered from its key.
  function answerOf(body: Record<string, unknown>): Promise<Result> {
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
    if (key === null || isReadAction(body.action)) return runSafely(body);
    const known = keys.get(key);
    if (known !== undefined) return known;
    const started = runSafely(body);
    keys.set(key, started);
    while (keys.size > KEPT_KEYS) {
      const oldest = keys.keys().next();
      if (oldest.done === true) break;
      keys.delete(oldest.value);
    }
    return started;
  }

  return {
    /** The result of the action envelope `value`. */
    async answer(value: Envelope): Promise<Result> {
      const body: unknown = value.body;
      const verdict = validateAction(body);
      if (!verdict.ok) {
        log.warn('link: invalid action', { reason: verdict.reason });
        return refusal('failed', 'invalid-action');
      }
      const fields = body as Record<string, unknown>;
      if (cancelled.delete(value.id)) return refusal('cancelled', 'cancelled');
      if (typeof fields.deadlineAt === 'number' && now() > fields.deadlineAt) {
        log.info('link: action past its deadline', { action: fields.action });
        return refusal('failed', 'deadline-passed');
      }
      return await answerOf(fields);
    },
    /** A cancel of an action not seen yet; an action that started keeps its result. */
    cancel(actionId: string): void {
      cancelled.add(actionId);
      while (cancelled.size > KEPT_CANCELS) {
        const oldest = cancelled.values().next();
        if (oldest.done === true) break;
        cancelled.delete(oldest.value);
      }
    },
  };
}

/** The gap of a full outbox: by conversation, the time of its first message that was refused. */
type Gap = Map<string, { iface: string; conversationId: string; since: number }>;

/** The conversation of a message event, as a gap reads it back; null for another kind. */
function gapEntryOf(event: Record<string, unknown>): { iface: string; conversationId: string; at: number } | null {
  const conversation = isObject(event.conversation) ? event.conversation : null;
  if (event.kind !== 'message.received' || typeof conversation?.id !== 'string') return null;
  if (typeof event.iface !== 'string' || typeof event.at !== 'number') return null;
  return { iface: event.iface, conversationId: conversation.id, at: event.at };
}

export function serveAdapter(options: {
  transport: Transport;
  hello: Hello;
  token: string;
  adapter: Adapter;
  log: Logger;
  outbox?: Outbox;
  now?: () => number;
}): { emit(event: unknown): Promise<AckStatus>; status(): ServeStatus; close(): void } {
  const { transport, hello, token, adapter, log } = options;
  const outbox = options.outbox ?? null;
  const actions = createActions(adapter, log, options.now ?? Date.now);
  const waiting = new Map<string, Array<(status: AckStatus) => void>>();
  const helloId = `hello:${hello.iface}`;
  const gap: Gap = new Map();
  let closed = false;
  // Without an outbox an event goes out at once; with one, only once the core has answered hello.
  let welcomed = outbox === null;
  let recovering = false;
  let lostKinds = 0;

  function finish(): void {
    closed = true;
    for (const resolvers of waiting.values()) for (const resolve of resolvers) resolve('failed');
    waiting.clear();
  }

  function sendEvent(event: Record<string, unknown>, seq: number | null): void {
    const id = event.id as string;
    transport.send(envelope('event', event, seq === null ? { id } : { id, seq }));
  }

  /** Resolves when the ack of `id` comes; the event is sent by the caller. */
  function awaitAck(id: string): Promise<AckStatus> {
    return new Promise<AckStatus>((resolve) => {
      const list = waiting.get(id) ?? [];
      list.push(resolve);
      waiting.set(id, list);
    });
  }

  function extendGap(event: Record<string, unknown>): void {
    const entry = gapEntryOf(event);
    if (entry === null) {
      lostKinds += 1;
      log.warn('link: event lost while the outbox is full', { kind: event.kind, lost: lostKinds });
      return;
    }
    const known = gap.get(entry.conversationId);
    if (known === undefined || entry.at < known.since)
      gap.set(entry.conversationId, { iface: entry.iface, conversationId: entry.conversationId, since: entry.at });
  }

  // The messages of the gap read back from the platform, oldest first, queued as they come. A conversation whose
  // read fails or that fills the outbox again stays in the gap for the next round.
  async function recoverGap(): Promise<void> {
    if (outbox === null || recovering) return;
    recovering = true;
    try {
      while (gap.size > 0 && !outbox.full() && !closed) {
        const [conversationId, wanted] = gap.entries().next().value as [
          string,
          { iface: string; conversationId: string; since: number },
        ];
        gap.delete(conversationId);
        const ref = { iface: wanted.iface, conversationId };
        const read = await adapter.history(ref, { limit: GAP_HISTORY_LIMIT, since: wanted.since });
        if (read.status !== 'ok') {
          log.warn('link: gap history failed', { code: read.error.code });
          gap.set(conversationId, wanted);
          return;
        }
        if (!read.complete) log.warn('link: gap longer than one history read', { limit: GAP_HISTORY_LIMIT });
        for (const found of [...read.events].sort((a, b) => a.at - b.at)) {
          const event = cleaned(found);
          const seq = validateEvent(event).ok ? outbox.push(event) : null;
          if (seq === null) {
            extendGap(event);
            continue;
          }
          if (welcomed && !closed) sendEvent(event, seq);
        }
      }
    } finally {
      recovering = false;
    }
  }

  function onAck(value: Envelope): void {
    if (!validateEnvelope(value).ok) return;
    const body = value.body as { status: AckStatus; ackedSeq?: number };
    if (outbox !== null && typeof body.ackedSeq === 'number') outbox.ack(body.ackedSeq);
    if (value.replyTo === helloId && !welcomed) {
      welcomed = true;
      // Everything the core has not taken goes again, in order, before anything new.
      for (const entry of outbox?.pending() ?? []) sendEvent(entry.event, entry.seq);
    }
    const resolvers = waiting.get(value.replyTo ?? '');
    if (resolvers !== undefined) {
      waiting.delete(value.replyTo ?? '');
      for (const resolve of resolvers) resolve(body.status);
    }
    if (gap.size > 0) void recoverGap();
  }

  async function onAction(value: Envelope): Promise<void> {
    const result = await actions.answer(value);
    transport.send(envelope('action_result', result, { id: `result:${value.id}`, replyTo: value.id }));
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (value.type === 'ack') onAck(value);
    else if (value.type === 'action') void onAction(value);
    else if (value.type === 'cancel' && value.replyTo !== null) actions.cancel(value.replyTo);
    else if (value.type === 'ping') transport.send(ackOf(value, 'ok'));
  });
  transport.onClose(finish);

  transport.send(
    envelope(
      'hello',
      {
        iface: hello.iface,
        self: hello.self,
        community: hello.community,
        capabilities: hello.capabilities,
        resume: hello.resume,
        token,
      },
      { id: helloId }
    )
  );

  /** One event into the outbox and, when the core has answered hello, onto the link. */
  function emitDurable(event: Record<string, unknown>, box: Outbox): Promise<AckStatus> {
    if (gap.size > 0 || recovering) {
      extendGap(event);
      return Promise.resolve('failed');
    }
    const seq = box.push(event);
    if (seq === null) {
      log.warn('link: outbox full', { kind: event.kind });
      extendGap(event);
      return Promise.resolve('failed');
    }
    if (closed) return Promise.resolve('failed');
    const acked = awaitAck(event.id as string);
    if (welcomed) sendEvent(event, seq);
    return acked;
  }

  return {
    emit(event: unknown): Promise<AckStatus> {
      if (!isObject(event)) return Promise.resolve(closed ? 'failed' : 'invalid');
      if (closed && outbox === null) return Promise.resolve('failed');
      const clean = cleaned(event);
      const verdict = validateEvent(clean);
      if (!verdict.ok) {
        log.warn('link: invalid event', { kind: clean.kind, reason: verdict.reason });
        return Promise.resolve('invalid');
      }
      if (outbox !== null) return emitDurable(clean, outbox);
      const acked = awaitAck(clean.id as string);
      sendEvent(clean, null);
      return acked;
    },
    status: (): ServeStatus => ({
      outbox: gap.size > 0 || recovering || outbox?.full() === true ? 'outbox-full' : 'ok',
    }),
    close(): void {
      finish();
      transport.close();
    },
  };
}
