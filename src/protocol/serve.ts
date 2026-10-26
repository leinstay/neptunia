// The serving side of the link: what an interface runs to talk to the core over a Transport. It says `hello`
// with who the persona is on it, the community it serves, its capabilities and the token it was started with, sends each inbound event as an `event` envelope
// and resolves with the status of the `ack` that answers it, and runs each `action` envelope of the core on its
// adapter, answering with an `action_result`. It holds no core state and no platform object: a value that
// cannot cross the wire (a platform error in `error.cause`, the `raw` handles of an event) never leaves it.
// The core's end is src/interface/link.ts.

import type { Adapter, Capabilities } from './adapter.ts';
import { ackOf, envelope } from './envelope.js';
import { MESSAGES_FETCH } from './actions.js';
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

/** How many idempotency keys the serving side remembers. */
const KEPT_KEYS = 1000;

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

export function serveAdapter(options: {
  transport: Transport;
  hello: Hello;
  token: string;
  adapter: Adapter;
  log: Logger;
}): { emit(event: unknown): Promise<AckStatus>; close(): void } {
  const { transport, hello, token, adapter, log } = options;
  const waiting = new Map<string, Array<(status: AckStatus) => void>>();
  // Insertion order is the age: the oldest key is the first one.
  const keys = new Map<string, Promise<Result>>();
  let closed = false;

  function finish(): void {
    closed = true;
    for (const resolvers of waiting.values()) for (const resolve of resolvers) resolve('failed');
    waiting.clear();
  }

  async function run(body: Record<string, unknown>): Promise<Result> {
    const conversation = body.conversation as Parameters<Adapter['send']>[0];
    const message = body.message as Parameters<Adapter['edit']>[0];
    const content = body.content as Parameters<Adapter['send']>[1];
    switch (body.action) {
      case 'message.send':
        return await adapter.send(conversation, content);
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
      case MESSAGES_FETCH:
        return await adapter.fetchMessages(conversation, body.messageIds as Array<string>);
      default:
        return refusal('unsupported', 'unsupported');
    }
  }

  async function runSafely(body: Record<string, unknown>): Promise<Result> {
    try {
      return crossable(await run(body));
    } catch (err) {
      log.warn('link: adapter threw', { action: body.action, name: err instanceof Error ? err.name : null });
      return refusal(body.action === MESSAGES_FETCH ? 'failed' : 'unknown', 'adapter-threw');
    }
  }

  function answerOf(body: Record<string, unknown>): Promise<Result> {
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
    if (key === null) return runSafely(body);
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

  async function onAction(value: Envelope): Promise<void> {
    const body: unknown = value.body;
    const verdict = validateAction(body);
    const result = verdict.ok ? await answerOf(body as Record<string, unknown>) : refusal('failed', 'invalid-action');
    if (!verdict.ok) log.warn('link: invalid action', { reason: verdict.reason });
    transport.send(envelope('action_result', result, { id: `result:${value.id}`, replyTo: value.id }));
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (value.type === 'ack') {
      const resolvers = waiting.get(value.replyTo ?? '');
      if (resolvers === undefined) return;
      waiting.delete(value.replyTo ?? '');
      const status = (value.body as { status: AckStatus }).status;
      for (const resolve of resolvers) resolve(status);
    } else if (value.type === 'action') {
      void onAction(value);
    } else if (value.type === 'ping') {
      transport.send(ackOf(value, 'ok'));
    }
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
      { id: `hello:${hello.iface}` }
    )
  );

  return {
    emit(event: unknown): Promise<AckStatus> {
      if (closed || !isObject(event)) return Promise.resolve(closed ? 'failed' : 'invalid');
      // The platform handles stay on this side: the event crosses without them.
      const clean = { ...event };
      delete clean.raw;
      delete clean.rawPrevious;
      const verdict = validateEvent(clean);
      if (!verdict.ok) {
        log.warn('link: invalid event', { kind: clean.kind, reason: verdict.reason });
        return Promise.resolve('invalid');
      }
      const id = clean.id as string;
      return new Promise<AckStatus>((resolve) => {
        const list = waiting.get(id) ?? [];
        list.push(resolve);
        waiting.set(id, list);
        transport.send(envelope('event', clean, { id }));
      });
    },
    close(): void {
      finish();
      transport.close();
    },
  };
}
