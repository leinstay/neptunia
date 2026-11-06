// The core's end of the MCP server her subscription turns use (src/subharness/mcp-server.ts). The subscription client
// (src/subharness/subscription-client.ts) opens one session per turn with the turn's tool definitions and a handler of
// its calls, and gets a token that stands for that session alone. The MCP process the CLI starts reads the token from
// a file and reaches the session through the core socket: `bridgePeer` says `hello` as the interface `turn` with the
// token and sends one `action` per list or call, and `serveBridge` answers each with an `action_result`. A token that
// is unknown or whose session closed is refused with `turn-unknown`, so no process without the turn's token reaches her
// tools. `routeTurnLink` sits in front of the core's interface links and hands a connection whose first envelope is a
// `turn` hello to `serveBridge`, so the socket carries the bridge with no entry in `clients.json`.

import { ackOf, envelope } from '../protocol/envelope.ts';
import type { Envelope, Transport } from '../protocol/wire.ts';
import { bareToolName } from '../tools/gateway.ts';
import type { BridgeAnswer, BridgeCall, McpPeer } from './mcp-server.ts';

/** The interface name the MCP process says hello under. */
export const TURN_IFACE = 'turn';

/** One turn's tools and the handler of their calls. */
export type BridgeSession = {
  tools: ReadonlyArray<object>;
  call(call: BridgeCall): Promise<BridgeAnswer>;
};

export type ToolBridge = {
  open(session: BridgeSession): { token: string; close(): void };
  list(token: string): Promise<ReadonlyArray<object>>;
  call(token: string, call: BridgeCall): Promise<BridgeAnswer>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const unknownTurn = (): Error => coded('turn-unknown', 'no open turn has this token');

/** The bridge; `deps.token` makes each session's token (the core passes 32 random bytes in hex). */
export function createToolBridge(deps: { token: () => string }): ToolBridge {
  const sessions = new Map<string, BridgeSession>();
  const sessionOf = (token: string): BridgeSession => {
    const session = sessions.get(token);
    if (session === undefined) throw unknownTurn();
    return session;
  };
  return {
    open(session) {
      const token = deps.token();
      sessions.set(token, session);
      return { token, close: () => void sessions.delete(token) };
    },
    list: (token) => Promise.resolve().then(() => sessionOf(token).tools),
    call: (token, call) =>
      Promise.resolve().then(() => sessionOf(token).call({ ...call, name: bareToolName(call.name) })),
  };
}

/** The `action_result` body of one request of the MCP process. */
async function answerOf(bridge: ToolBridge, token: string, body: Record<string, unknown>): Promise<object> {
  try {
    if (body.operation === 'tools.list') return { ok: true, tools: await bridge.list(token) };
    if (body.operation !== 'tools.call' || !isRecord(body.call)) return { ok: false, code: 'bad-request' };
    const { name, arguments: args, meta } = body.call;
    const answer = await bridge.call(token, {
      name: typeof name === 'string' ? name : '',
      arguments: isRecord(args) ? args : {},
      meta: isRecord(meta) ? meta : null,
    });
    return { ok: true, text: answer.text, isError: answer.isError };
  } catch (error) {
    return { ok: false, code: isRecord(error) && typeof error.code === 'string' ? error.code : 'failed' };
  }
}

/** Answers the MCP process on `transport`: its `hello` names the token, and each `action` is one list or call. */
export function serveBridge(transport: Transport, bridge: ToolBridge): void {
  let token = '';
  transport.onEnvelope((value) => {
    const body = isRecord(value.body) ? value.body : {};
    if (value.type === 'hello') {
      token = typeof body.token === 'string' ? body.token : '';
      transport.send(ackOf(value, 'ok'));
      return;
    }
    if (value.type === 'ping') {
      transport.send(ackOf(value, 'ok'));
      return;
    }
    if (value.type !== 'action') return;
    void answerOf(bridge, token, body).then((answer) =>
      transport.send(envelope('action_result', answer, { id: `result:${value.id}`, replyTo: value.id }))
    );
  });
}

/** The MCP process's peer over the core socket: it says hello with `token`, then asks one request per list or call. */
export function bridgePeer(transport: Transport, token: string): McpPeer {
  const waiting = new Map<string, { resolve(body: Record<string, unknown>): void; reject(error: Error): void }>();
  let count = 0;
  transport.onEnvelope((value) => {
    const entry = value.type === 'action_result' && value.replyTo !== null ? waiting.get(value.replyTo) : undefined;
    if (entry === undefined || value.replyTo === null) return;
    waiting.delete(value.replyTo);
    const body = isRecord(value.body) ? value.body : {};
    if (body.ok === true) entry.resolve(body);
    else entry.reject(coded(typeof body.code === 'string' ? body.code : 'failed', 'the core refused the request'));
  });
  transport.onClose(() => {
    for (const entry of waiting.values()) entry.reject(coded('bridge-closed', 'the core socket closed'));
    waiting.clear();
  });
  const self = { id: TURN_IFACE, name: TURN_IFACE };
  transport.send(envelope('hello', { iface: TURN_IFACE, self, community: null, token }, { id: 'turn-hello' }));
  const ask = (body: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      count += 1;
      const id = `turn-${count}`;
      waiting.set(id, { resolve, reject });
      transport.send(envelope('action', body, { id }));
    });
  return {
    list: async () => {
      const { tools } = await ask({ operation: 'tools.list' });
      return Array.isArray(tools) ? tools.filter(isRecord) : [];
    },
    call: async (call) => {
      const { text, isError } = await ask({ operation: 'tools.call', call });
      return { text: typeof text === 'string' ? text : '', isError: isError === true };
    },
  };
}

/** `transport` with `first` handed to the first handler again, in the same tick it subscribes, before anything later. */
function replaying(transport: Transport, first: Envelope): Transport {
  let replayed = false;
  return {
    ...transport,
    onEnvelope(handler) {
      const off = transport.onEnvelope(handler);
      if (!replayed) {
        replayed = true;
        handler(first);
      }
      return off;
    },
  };
}

/**
 * Routes one connection of the core socket by its first envelope: a `hello` of the interface `turn` goes to the
 * bridge, everything else to `other`, the interface link, which sees that first envelope as its own.
 */
export function routeTurnLink(transport: Transport, bridge: ToolBridge, other: (transport: Transport) => void): void {
  const stop = transport.onEnvelope((first) => {
    stop();
    const isTurn = first.type === 'hello' && isRecord(first.body) && first.body.iface === TURN_IFACE;
    if (isTurn) serveBridge(replaying(transport, first), bridge);
    else other(replaying(transport, first));
  });
}
