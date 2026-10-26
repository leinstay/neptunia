// The core's end of the link to one interface (the serving end is src/protocol/serve.ts). The first envelope on a
// connection must be `hello` with the token the core made at boot, otherwise the link closes and nothing reaches
// the event door. After it, each `event` envelope goes through the door and its ack goes back, concurrently, and
// the core speaks to the interface through `adapter`: every method is one `action` envelope answered by the
// `action_result` with the same `replyTo`. The adapter never rejects. A link that closes answers every pending
// effect `unknown` (it may have happened) and every pending read `failed`, and so does a call made afterwards.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ackOf, declaredHooks, envelope, portAction } from '../protocol/index.js';
import type { Adapter, Capabilities, Delivery, FetchedMessages } from '../protocol/adapter.ts';
import type { Hello, Logger } from '../protocol/serve.ts';
import type { Envelope, Transport } from '../protocol/wire.ts';

/** How many actions may wait for an answer at once. */
const MAX_PENDING = 256;

type Result = Record<string, unknown>;
type Kind = 'effect' | 'read';
type Waiting = { kind: Kind; resolve(result: Result): void };

const NO_CAPABILITIES: Capabilities = {
  operations: [],
  maxChars: 0,
  maxFiles: 0,
  maxFileBytes: 0,
  edit: { ownOnly: true, windowMs: null },
  history: false,
  threads: false,
  reactions: false,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
};

// An effect that may have happened is `unknown`; a refusal before anything was sent, and a read, is `failed`.
function refusal(kind: Kind, code: string, retryable: boolean): Result {
  const error = { code, retryable, retryAfterMs: null };
  const status = kind === 'effect' && code === 'link-closed' ? 'unknown' : 'failed';
  return { status, ref: null, parts: [], at: null, idempotencyKey: '', error };
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

export function openAdapterLink(options: {
  transport: Transport;
  door: { receive(value: unknown): Promise<Envelope> };
  token: string;
  log: Logger;
}): { hello: Promise<Hello>; adapter: Adapter; close(): void } {
  const { transport, door, token, log } = options;
  const waiting = new Map<string, Waiting>();
  let greeting: Hello | null = null;
  let closed = false;
  let acceptHello: (hello: Hello) => void = () => {};
  let refuseHello: (error: Error) => void = () => {};
  const hello = new Promise<Hello>((resolve, reject) => {
    acceptHello = resolve;
    refuseHello = reject;
  });
  // A caller that never awaits hello (it closed the link first) must not leave an unhandled rejection.
  hello.catch(() => {});

  function shut(reason: string): void {
    if (closed) return;
    closed = true;
    refuseHello(new Error(`link closed before hello: ${reason}`));
    for (const entry of waiting.values()) entry.resolve(refusal(entry.kind, 'link-closed', false));
    waiting.clear();
    transport.close();
  }

  function onHello(value: Envelope): void {
    const body = value.body as Record<string, unknown>;
    const given = typeof body.token === 'string' ? body.token : '';
    if (!timingSafeEqual(digest(given), digest(token))) {
      log.warn('link: hello refused', { reason: 'token' });
      shut('token');
      return;
    }
    greeting = {
      iface: body.iface as string,
      capabilities: (body.capabilities ?? NO_CAPABILITIES) as Capabilities,
      resume: typeof body.resume === 'string' ? body.resume : null,
    };
    log.info('link: hello', { iface: greeting.iface });
    acceptHello(greeting);
  }

  function onEvent(value: Envelope): void {
    door.receive(value).then(
      (answer) => transport.send(answer),
      (err: unknown) => {
        log.warn('link: door failed', { name: err instanceof Error ? err.name : null });
        transport.send(ackOf(value, 'failed', 'handler-threw'));
      }
    );
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (greeting === null) {
      if (value.type === 'hello') onHello(value);
      else {
        log.warn('link: first envelope is not hello', { type: value.type });
        shut('no-hello');
      }
      return;
    }
    if (value.type === 'event') onEvent(value);
    else if (value.type === 'action_result') {
      const entry = waiting.get(value.replyTo ?? '');
      if (entry === undefined) return;
      waiting.delete(value.replyTo ?? '');
      entry.resolve(value.body as Result);
    } else if (value.type === 'ping') transport.send(ackOf(value, 'ok'));
  });
  transport.onClose((reason) => shut(reason));

  function call(action: Record<string, unknown>, kind: Kind): Promise<Result> {
    if (closed || greeting === null) return Promise.resolve(refusal(kind, 'link-closed', false));
    if (waiting.size >= MAX_PENDING) return Promise.resolve(refusal(kind, 'link-busy', true));
    const id = randomUUID();
    return new Promise<Result>((resolve) => {
      waiting.set(id, { kind, resolve });
      try {
        transport.send(envelope('action', action, { id }));
      } catch (err) {
        log.warn('link: action not sent', { name: err instanceof Error ? err.name : null });
        waiting.delete(id);
        // Nothing was sent, so even an effect is known not to have happened.
        resolve(refusal('read', 'invalid-action', false));
      }
    });
  }

  const effect = (operation: string, args: Array<unknown>, extra: Record<string, unknown> = {}): Promise<Result> =>
    call({ ...portAction(operation, args), ...extra }, 'effect');

  // The declared hooks give the adapter the shape of today's port; nothing delivers events through them.
  const adapter = {
    ...declaredHooks(),
    get iface(): string {
      return greeting?.iface ?? '';
    },
    capabilities: () => greeting?.capabilities ?? NO_CAPABILITIES,
    send: (conversation: Parameters<Adapter['send']>[0], content: Parameters<Adapter['send']>[1]) =>
      effect('send', [conversation, content], { idempotencyKey: randomUUID() }) as unknown as Promise<Delivery>,
    edit: (message: Parameters<Adapter['edit']>[0], content: Parameters<Adapter['edit']>[1]) =>
      effect('edit', [message, content]) as ReturnType<Adapter['edit']>,
    delete: (message: Parameters<Adapter['delete']>[0]) => effect('delete', [message]) as ReturnType<Adapter['delete']>,
    react: (message: Parameters<Adapter['react']>[0], emoji: string) =>
      effect('react', [message, emoji]) as ReturnType<Adapter['react']>,
    unreact: (message: Parameters<Adapter['unreact']>[0], emoji: string) =>
      effect('unreact', [message, emoji]) as ReturnType<Adapter['unreact']>,
    typing: (conversation: Parameters<Adapter['typing']>[0]) =>
      effect('typing', [conversation]) as ReturnType<Adapter['typing']>,
    fetchMessages: (conversation: Parameters<Adapter['fetchMessages']>[0], messageIds: ReadonlyArray<string>) =>
      call(portAction('fetchMessages', [conversation, messageIds]), 'read') as unknown as Promise<FetchedMessages>,
  };
  return { hello, adapter, close: () => shut('closed') };
}
