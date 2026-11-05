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
// next connection to send, marked `replayed`, so the core keeps it as history and starts no turn. A full outbox evicts
// nothing: the event is refused and lost, counted in a warning, and the interface reports `outbox-full` on `status()`.
// Nothing reads a missed stretch back from the platform on its own (the owner's no-catch-up policy, 2026-11-02).
//
// An action carrying `deadlineAt` (ms since the epoch, by the injected `now`) that arrives after it is refused
// `failed` with `deadline-passed` and never reaches the adapter; one that started in time keeps its result. A
// `cancel` envelope naming an action that has not started ends it `cancelled`; once started, its result stands.
//
// A `command.result` action goes to `onCommandResult` with the `replyRef` of its command (for the owner's command line,
// also of a line whose turn ended), `text` and `status`, and is answered `ok`; without it the action is `unsupported`. A `command.requested` event never enters the outbox: it goes
// out at once, and on a closed link it is answered `failed`.

import type { Adapter, Capabilities } from './adapter.ts';
import { ackOf, envelope, validateEnvelope } from './envelope.ts';
import { MESSAGES_FETCH } from './actions.ts';
import type { Outbox } from './outbox.ts';
import { isReadAction } from './reads.ts';
import { validateAction, validateEvent } from './validate.ts';
import type { Envelope, Transport } from './wire.ts';

/** The statuses of an `ack` (envelope.ts#ACK_STATUSES). */
export type AckStatus = 'ok' | 'duplicate' | 'invalid' | 'unhandled' | 'failed';

/** Who an interface says it is: an id and the name people see. */
export type Named = { id: string; name: string };

/** `self` is the persona's account on the interface, `community` the community it serves (null when it serves none). */
export type Hello = {
  iface: string;
  self: Named;
  community: Named | null;
  /** Every community an interface serving several serves, `community` among them. */
  communities?: ReadonlyArray<Named>;
  capabilities: Capabilities;
  resume: string | null;
};

export type Logger = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

/** What `status()` reports: whether the outbox refuses events. */
export type ServeStatus = { outbox: 'ok' | 'outbox-full' };

/** How many idempotency keys the serving side remembers. */
const KEPT_KEYS = 1000;

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
  'dm.conversation': 'dmConversationOf',
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
  const community = pick(body, ['placeId']);
  switch (body.action) {
    case 'conversation.info':
      return [body.conversation, pick(body, ['audience', 'viewers'])];
    case 'conversations.list':
      return [pick(body, ['placeId', 'audience', 'viewers'])];
    case MESSAGES_FETCH:
      return [body.conversation, body.messageIds, pick(body, ['idempotencyKey'])];
    case 'messages.history':
      return [body.conversation, pick(body, ['limit', 'before', 'after', 'around', 'since'])];
    case 'member.info':
      return [pick(body, ['placeId', 'accountId'])];
    case 'dm.conversation':
      return [pick(body, ['iface', 'accountId'])];
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

/** The question a `command.result` of status `ask` carries, null for any other result. */
function askOf(body: Record<string, unknown>): CommandResult['ask'] {
  if (body.status !== 'ask' || typeof body.dialogId !== 'string') return null;
  const choices = Array.isArray(body.choices)
    ? body.choices.filter((one): one is string => typeof one === 'string')
    : null;
  return {
    dialogId: body.dialogId,
    prompt: typeof body.prompt === 'string' ? body.prompt : String(body.text),
    secret: body.secret === true,
    choices,
  };
}

/** The `command.result` action as the serving side hands it on: the command it answers, its text and its outcome. */
export type CommandResult = {
  replyRef: string;
  text: string;
  status: string | null;
  /** Why a refused command was refused, when the command names it. */
  code?: string | null;
  /** The question of a status `ask`: its dialog, prompt, whether the answer is secret and its choices. */
  ask?: { dialogId: string; prompt: string; secret: boolean; choices: Array<string> | null } | null;
};

/** The action runner of one adapter: reads, effects under their idempotency key, deadlines and cancels. */
function createActions(
  adapter: Adapter,
  log: Logger,
  now: () => number,
  onCommandResult: ((result: CommandResult) => unknown) | null
) {
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
      case 'command.result':
        if (onCommandResult === null) return refusal('unsupported', 'unsupported');
        await onCommandResult({
          replyRef: body.replyRef as string,
          text: body.text as string,
          status: typeof body.status === 'string' ? body.status : null,
          code: typeof body.code === 'string' ? body.code : null,
          ask: askOf(body),
        });
        return { status: 'ok' };
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

export function serveAdapter(options: {
  transport: Transport;
  hello: Hello;
  token: string;
  adapter: Adapter;
  log: Logger;
  outbox?: Outbox;
  now?: () => number;
  onCommandResult?: (result: CommandResult) => unknown;
}): { emit(event: unknown): Promise<AckStatus>; status(): ServeStatus; close(): void } {
  const { transport, hello, token, adapter, log } = options;
  const outbox = options.outbox ?? null;
  const actions = createActions(adapter, log, options.now ?? Date.now, options.onCommandResult ?? null);
  const waiting = new Map<string, Array<(status: AckStatus) => void>>();
  const helloId = `hello:${hello.iface}`;
  let closed = false;
  // Without an outbox an event goes out at once; with one, only once the core has answered hello.
  let welcomed = outbox === null;
  let lostKinds = 0;
  const backlog = new Set((outbox?.pending() ?? []).map((entry) => entry.seq));

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

  function onAck(value: Envelope): void {
    if (!validateEnvelope(value).ok) return;
    const body = value.body as { status: AckStatus; ackedSeq?: number };
    if (outbox !== null && typeof body.ackedSeq === 'number') outbox.ack(body.ackedSeq);
    if (value.replyTo === helloId && !welcomed) {
      welcomed = true;
      // Everything the core has not taken goes again, in order, before anything new.
      // What an earlier connection left is a backlog: the core keeps it as history and starts no turn. An event of
      // this connection that merely waited for the answer to hello goes as it is.
      for (const entry of outbox?.pending() ?? [])
        sendEvent(backlog.has(entry.seq) ? { ...entry.event, replayed: true } : entry.event, entry.seq);
    }
    const resolvers = waiting.get(value.replyTo ?? '');
    if (resolvers !== undefined) {
      waiting.delete(value.replyTo ?? '');
      for (const resolve of resolvers) resolve(body.status);
    }
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
        ...(hello.communities === undefined ? {} : { communities: hello.communities }),
        capabilities: hello.capabilities,
        resume: hello.resume,
        token,
      },
      { id: helloId }
    )
  );

  /** One event into the outbox and, when the core has answered hello, onto the link. */
  function emitDurable(event: Record<string, unknown>, box: Outbox): Promise<AckStatus> {
    const seq = box.push(event);
    if (seq === null) {
      lostKinds += 1;
      log.warn('link: event lost while the outbox is full', { kind: event.kind, lost: lostKinds });
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
      // A command is answered while its asker waits: it is never kept for a later connection to run again.
      if (outbox !== null && clean.kind !== 'command.requested') return emitDurable(clean, outbox);
      if (closed) return Promise.resolve('failed');
      const acked = awaitAck(clean.id as string);
      sendEvent(clean, null);
      return acked;
    },
    status: (): ServeStatus => ({
      outbox: outbox?.full() === true ? 'outbox-full' : 'ok',
    }),
    close(): void {
      finish();
      transport.close();
    },
  };
}
