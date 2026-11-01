// The core's end of one plugin's connection (the plugin's end is `servePlugin`, src/protocol/plugin.ts), with no door
// and no adapter. The first envelope must be `hello` under the namespace `plugin` with a token that stands for a
// `plugin` principal (src/interface/principals.ts), otherwise the link closes and `hello` rejects with the reason.
// `admit` may refuse a principal of a good hello (the core refuses a plugin the owner has not enabled with
// `plugin-disabled`). The token is resolved again for every envelope, so a rotated or revoked token closes the link.
//
// After hello the link answers a second `hello`, a malformed body and any `event` with an `ack` `invalid` and goes on:
// a plugin sends no event, so an event reaches no one. A good `tool.register` goes to `register` (the registry) and is
// answered with what it took and refused. `callTool` sends one `tool.call` with a deadline `deadlineMs()` from `now()`
// and resolves with the plugin's `action_result`; past the deadline it resolves `unknown` with `plugin-no-answer` and
// forgets the call, so a late answer is dropped. A link that closes resolves each waiting call `unknown` with
// `plugin-not-connected`, and a call on a closed link `failed` with the same code. `onClosed` is told once when a link
// that had said hello closes.
//
// `routeConnection` picks the link a new socket connection becomes by its first envelope: a `hello` under `plugin`
// goes to the plugin link, anything else to the adapter link (src/interface/link.ts).

import { randomUUID } from 'node:crypto';
import { ackOf, envelope, validateEnvelope } from '../protocol/envelope.js';
import { PLUGIN_IFACE, TOOL_CALL } from '../protocol/plugin.ts';
import type { RegisterOutcome, ToolAnswer, ToolCallBody } from '../protocol/plugin.ts';
import type { Logger } from '../protocol/serve.ts';
import type { Envelope, Transport } from '../protocol/wire.ts';
import type { Principal } from '../interface/principals.ts';
import { CODE } from '../tools/codes.ts';

export type PluginLink = {
  /** Rejects when the hello is refused or the link closes first. */
  hello: Promise<{ plugin: string }>;
  principal(): Principal | null;
  isClosed(): boolean;
  close(): void;
  /** One tool.call with the deadline `deadlineMs()` from `now()`. Never rejects. */
  callTool(request: Omit<ToolCallBody, 'deadlineAt'>): Promise<ToolAnswer>;
};

type Waiting = { resolve: (answer: ToolAnswer) => void; timer: ReturnType<typeof setTimeout> };

const samePrincipal = (now: Principal | null, first: Principal): boolean =>
  now !== null && now.name === first.name && now.kind === first.kind;

export function openPluginLink(options: {
  transport: Transport;
  principalOf: (token: string) => Principal | null;
  admit?: (principal: Principal) => string | null;
  register: (plugin: string, tools: ReadonlyArray<unknown>) => RegisterOutcome;
  onClosed?: (plugin: string) => void;
  deadlineMs: () => number;
  now: () => number;
  log: Logger;
}): PluginLink {
  const { transport, log } = options;
  const waiting = new Map<string, Waiting>();
  let principal: Principal | null = null;
  let helloToken = '';
  let closed = false;
  let accept: (said: { plugin: string }) => void = () => {};
  let refuse: (error: Error) => void = () => {};
  const hello = new Promise<{ plugin: string }>((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  // A caller that never awaits hello (it closed the link first) must not leave an unhandled rejection.
  hello.catch(() => {});

  function shut(reason: string): void {
    if (closed) return;
    closed = true;
    refuse(new Error(`link closed before hello: ${reason}`));
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ status: 'unknown', code: CODE.PLUGIN_NOT_CONNECTED });
    }
    waiting.clear();
    transport.close();
    if (principal !== null) options.onClosed?.(principal.name);
  }

  /** Why the hello `value` is refused, or null; logged and the link closed by the caller. */
  function helloRefusal(value: Envelope, found: Principal | null): string | null {
    if (!validateEnvelope(value).ok) return 'hello-invalid';
    if ((value.body as Record<string, unknown>).iface !== PLUGIN_IFACE) return 'iface';
    if (found === null) return 'token';
    if (found.kind !== 'plugin') return 'iface';
    return options.admit?.(found) ?? null;
  }

  function onHello(value: Envelope): void {
    const body = value.body as Record<string, unknown>;
    const given = typeof body.token === 'string' ? body.token : '';
    const found = options.principalOf(given);
    const reason = helloRefusal(value, found);
    if (reason !== null || found === null) {
      log.warn('link: hello refused', { reason, ...(found === null ? {} : { principal: found.name }) });
      shut(reason ?? 'token');
      return;
    }
    principal = found;
    helloToken = given;
    log.info('link: hello', { iface: PLUGIN_IFACE, principal: found.name, kind: 'plugin' });
    transport.send(ackOf(value, 'ok'));
    accept({ plugin: found.name });
  }

  function onRegister(value: Envelope, who: Principal): void {
    const tools = (value.body as { tools: ReadonlyArray<unknown> }).tools;
    let outcome: RegisterOutcome;
    try {
      outcome = options.register(who.name, tools);
    } catch (err) {
      log.warn('plugins: registration failed', { plugin: who.name, name: err instanceof Error ? err.name : null });
      transport.send(ackOf(value, 'failed', 'handler-threw'));
      return;
    }
    transport.send(
      envelope(
        'ack',
        { status: 'ok', accepted: outcome.accepted, refused: outcome.refused },
        { id: `ack:${value.id}`, replyTo: value.id }
      )
    );
    log.info('plugins: tools registered', {
      plugin: who.name,
      accepted: outcome.accepted.length,
      refused: outcome.refused.length,
    });
  }

  function onAuthenticated(value: Envelope, who: Principal): void {
    if (value.type === 'event') {
      log.warn('link: event refused', { reason: 'body.kind:not-allowed', principal: who.name });
      transport.send(ackOf(value, 'invalid', 'body.kind:not-allowed'));
      return;
    }
    if (value.type === 'hello') {
      transport.send(ackOf(value, 'invalid', 'hello:repeated'));
      return;
    }
    const verdict = validateEnvelope(value);
    if (!verdict.ok) {
      if (value.type === 'tool.register') transport.send(ackOf(value, 'invalid', verdict.reason));
      return;
    }
    if (value.type === 'tool.register') onRegister(value, who);
    else if (value.type === 'action_result') {
      const entry = waiting.get(value.replyTo ?? '');
      if (entry === undefined) return;
      waiting.delete(value.replyTo ?? '');
      clearTimeout(entry.timer);
      entry.resolve(value.body as ToolAnswer);
    } else if (value.type === 'ping') transport.send(ackOf(value, 'ok'));
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (principal === null) {
      if (value.type === 'hello') onHello(value);
      else {
        log.warn('link: first envelope is not hello', { type: value.type });
        shut('no-hello');
      }
      return;
    }
    if (!samePrincipal(options.principalOf(helloToken), principal)) {
      log.warn('link: token no longer stands for the client', { principal: principal.name });
      shut('revoked');
      return;
    }
    onAuthenticated(value, principal);
  });
  transport.onClose((reason) => shut(reason));

  return {
    hello,
    principal: () => principal,
    isClosed: () => closed,
    close: () => shut('closed'),
    callTool(request) {
      if (closed || principal === null) return Promise.resolve({ status: 'failed', code: CODE.PLUGIN_NOT_CONNECTED });
      const id = randomUUID();
      const wait = options.deadlineMs();
      const body: ToolCallBody = { ...request, deadlineAt: options.now() + wait };
      return new Promise<ToolAnswer>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          log.warn('plugins: call past its deadline', { plugin: principal?.name ?? null, tool: request.tool });
          resolve({ status: 'unknown', code: CODE.PLUGIN_NO_ANSWER });
        }, wait);
        waiting.set(id, { resolve, timer });
        transport.send(envelope(TOOL_CALL, body, { id }));
      });
    },
  };
}

/**
 * Hands a new connection to `plugin` when its first envelope is a `hello` under the namespace `plugin`, else to
 * `adapter`, which gets the transport with that first envelope still to come. Either gets every later envelope in order.
 */
export function routeConnection(
  transport: Transport,
  route: { adapter: (transport: Transport) => void; plugin: (transport: Transport) => void }
): void {
  const handlers = new Set<(value: Envelope) => void>();
  let routed = false;
  const view: Transport = {
    send: (value) => transport.send(value),
    onEnvelope(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: (handler) => transport.onClose(handler),
    close: () => transport.close(),
  };
  transport.onEnvelope((value) => {
    if (!routed) {
      routed = true;
      const body = value.body as Record<string, unknown>;
      const toPlugin = value.type === 'hello' && body.iface === PLUGIN_IFACE;
      (toPlugin ? route.plugin : route.adapter)(view);
    }
    for (const handler of [...handlers]) handler(value);
  });
}
