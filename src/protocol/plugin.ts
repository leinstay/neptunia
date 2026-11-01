// The plugin side of the protocol: the two envelope types a plugin and the core exchange beyond hello, ack and
// action_result, their bodies and checks, the package contract of a plugin (`start(host)`), and `servePlugin`, the
// plugin's end of the link (the core's end is src/plugins/link.ts). A plugin says `hello` under the namespace
// `plugin` with the token of its client, sends one `tool.register` with the tools its `plugin.json` declares, and
// answers each `tool.call` of the core with an `action_result` whose `replyTo` is the call's envelope id. The
// registration is answered by an `ack` that names which tools the core took and which it refused. A plugin imports
// nothing of the core beyond src/protocol/, so everything it needs comes through the host.
//
// `servePlugin` answers a call whose `deadlineAt` (ms since the epoch, by the injected `now`) has passed `failed`
// with `deadline-passed`, a call for a tool it did not register `invalid` with `unknown-tool`, a call with a bad body
// `invalid` with `invalid-call`, and a handler that throws or rejects `failed` with `handler-threw`. It never throws.

import { ackOf, envelope, validateEnvelope } from './envelope.js';
import type { Logger } from './serve.ts';
import type { Envelope, Transport } from './wire.ts';

/** The namespace a plugin principal says hello under. */
export const PLUGIN_IFACE = 'plugin';
export const TOOL_REGISTER = 'tool.register';
export const TOOL_CALL = 'tool.call';

/** Who may run a tool: `kind` is `read` or `write`, `ownerOnly` closes it to everyone but an owner, `member` opens it to every member. */
export type ToolRights = { kind: 'read' | 'write'; ownerOnly?: boolean; member?: boolean };
/** The words the model reads about a tool. */
export type ToolWording = { title: string; whenToUse: string; whenNotToUse: string };

/** The effects a tool may have, as the engine classes them (src/tools/impl/effects.ts). */
export const TOOL_EFFECTS = ['read', 'write', 'destructive', 'administrative', 'paid'] as const;
export const TOOL_COSTS = ['free', 'paid'] as const;

export type ToolDeclaration = {
  /** Dotted, `<plugin>.<verb>`. */
  name: string;
  /** The argument schema of src/tools/schema.ts. */
  schema: Record<string, unknown>;
  wording: ToolWording;
  effect: (typeof TOOL_EFFECTS)[number];
  cost: (typeof TOOL_COSTS)[number];
  rights: ToolRights;
};

/** `plugin.json`. */
export type PluginManifest = {
  /** Kebab-case, equal to the folder name. */
  name: string;
  /** One line. */
  description: string;
  /** Every name starts with `<name>.`, none repeats. */
  tools: Array<ToolDeclaration>;
  /** The environment keys the plugin reads (UPPER_SNAKE), possibly none. */
  env: Array<string>;
  /** The skills it ships (kebab-case), each a folder under `skills/`. */
  skills: Array<string>;
};

/** `tool.register`, plugin to core. Each tool is an object with a string `name`; the registry reads the rest. */
export type ToolRegisterBody = { tools: Array<ToolDeclaration> };
export type RegisterOutcome = { accepted: Array<string>; refused: Array<{ name: string; reason: string }> };
/** The `ack` body that answers a `tool.register`: `ok` for a well-formed body even when some tools are refused, `invalid` for a malformed one. */
export type RegisterAck = { status: 'ok' } & RegisterOutcome;

/** `tool.call`, core to plugin. */
export type ToolCallBody = {
  tool: string;
  args: Record<string, unknown>;
  requester: { id: string | null; roleIds: Array<string> } | null;
  conversationId: string | null;
  /** Ms since the epoch. */
  deadlineAt: number;
  idempotencyKey: string;
};
/** The `action_result` body that answers a `tool.call`: the core's own call result shape. `data.text` is what she reads. */
export type ToolAnswer = { status: string; code?: string; data?: { text?: string } };

type Verdict = { ok: true } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

export function validateToolRegister(body: unknown): Verdict {
  const tools = isObject(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return { ok: false, reason: 'body.tools:type' };
  for (const [index, tool] of tools.entries()) {
    if (!isObject(tool) || !isText(tool.name)) return { ok: false, reason: `body.tools.${index}:type` };
  }
  return { ok: true };
}

function requesterOk(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const idOk = value.id === null || typeof value.id === 'string';
  return idOk && Array.isArray(value.roleIds) && value.roleIds.every((role) => typeof role === 'string');
}

export function validateToolCall(body: unknown): Verdict {
  if (!isObject(body)) return { ok: false, reason: 'body:type' };
  if (!isText(body.tool)) return { ok: false, reason: 'body.tool:type' };
  if (!isObject(body.args)) return { ok: false, reason: 'body.args:type' };
  if (typeof body.deadlineAt !== 'number' || !Number.isFinite(body.deadlineAt))
    return { ok: false, reason: 'body.deadlineAt:type' };
  if (!isText(body.idempotencyKey)) return { ok: false, reason: 'body.idempotencyKey:type' };
  if (!requesterOk(body.requester)) return { ok: false, reason: 'body.requester:type' };
  if (body.conversationId !== null && typeof body.conversationId !== 'string')
    return { ok: false, reason: 'body.conversationId:type' };
  return { ok: true };
}

/** What the core hands a plugin when `neptunia plugin run <name>` starts it. */
export type PluginHost = {
  name: string;
  /** The `plugin.json` the core knows the plugin by. */
  manifest: PluginManifest;
  /** `<data>/plugins/<name>`, the plugin's own folder for what it keeps across restarts. */
  dataDir: string;
  /** The environment keys the manifest lists. */
  env: Readonly<Record<string, string | undefined>>;
  /** The core's settings, read at the moment of use. */
  config(): Readonly<Record<string, unknown>>;
  log: Logger;
  /** Connects (and again after a drop, with backoff), says hello, registers `manifest.tools` and answers calls through `handle`. */
  serve(handle: (call: ToolCallBody) => ToolAnswer | Promise<ToolAnswer>): Promise<ServedPlugin>;
};
export type ServedPlugin = { registered: Promise<RegisterOutcome>; stop(): Promise<void> };
/** What a plugin package's `start(host)` resolves with. */
export type RunningPlugin = { stop(): Promise<void> };

const refusal = (status: string, code: string): ToolAnswer => ({ status, code });

const textsOf = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function refusedOf(value: unknown): RegisterOutcome['refused'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isObject(item) && typeof item.name === 'string' && typeof item.reason === 'string'
      ? [{ name: item.name, reason: item.reason }]
      : []
  );
}

/** The plugin's end of its link: says hello, registers `tools`, answers each `tool.call`. Never throws. */
export function servePlugin(options: {
  transport: Transport;
  name: string;
  token: string;
  tools: ReadonlyArray<ToolDeclaration>;
  handle: (call: ToolCallBody) => ToolAnswer | Promise<ToolAnswer>;
  now?: () => number;
  log: Logger;
}): { registered: Promise<RegisterOutcome>; close(): void } {
  const { transport, name, token, tools, handle, log } = options;
  const now = options.now ?? Date.now;
  const known = new Set(tools.map((tool) => tool.name));
  const helloId = `hello:${PLUGIN_IFACE}:${name}`;
  const registerId = `${TOOL_REGISTER}:${name}`;
  let closed = false;
  let settled = false;
  let accept: (outcome: RegisterOutcome) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const registered = new Promise<RegisterOutcome>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  // A caller that never awaits `registered` must not leave an unhandled rejection.
  registered.catch(() => {});
  const settle = (done: () => void): void => {
    if (settled) return;
    settled = true;
    done();
  };

  function onAck(value: Envelope): void {
    const body = value.body as Record<string, unknown>;
    if (value.replyTo === helloId) {
      if (body.status !== 'ok') {
        settle(() => reject(new Error(`hello refused: ${String(body.reason ?? body.status)}`)));
        return;
      }
      transport.send(envelope(TOOL_REGISTER, { tools: [...tools] }, { id: registerId }));
    } else if (value.replyTo === registerId) {
      if (body.status !== 'ok') {
        settle(() => reject(new Error(`tool.register refused: ${String(body.reason ?? body.status)}`)));
        return;
      }
      settle(() => accept({ accepted: textsOf(body.accepted), refused: refusedOf(body.refused) }));
    }
  }

  async function answerCall(value: Envelope): Promise<ToolAnswer> {
    const verdict = validateToolCall(value.body);
    if (!verdict.ok) {
      log.warn('plugin: invalid call', { reason: verdict.reason });
      return refusal('invalid', 'invalid-call');
    }
    const call = value.body as ToolCallBody;
    if (now() > call.deadlineAt) {
      log.info('plugin: call past its deadline', { tool: call.tool });
      return refusal('failed', 'deadline-passed');
    }
    if (!known.has(call.tool)) return refusal('invalid', 'unknown-tool');
    try {
      return await handle(call);
    } catch (err) {
      log.warn('plugin: handler threw', { tool: call.tool, name: err instanceof Error ? err.name : null });
      return refusal('failed', 'handler-threw');
    }
  }

  async function onCall(value: Envelope): Promise<void> {
    const answer = await answerCall(value);
    if (!closed) transport.send(envelope('action_result', answer, { id: `result:${value.id}`, replyTo: value.id }));
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (value.type === 'ack' && validateEnvelope(value).ok) onAck(value);
    else if (value.type === TOOL_CALL) void onCall(value);
    else if (value.type === 'ping') transport.send(ackOf(value, 'ok'));
  });
  transport.onClose(() => {
    closed = true;
    settle(() => reject(new Error('link closed before the registration was answered')));
  });
  transport.send(
    envelope('hello', { iface: PLUGIN_IFACE, self: { id: name, name }, community: null, token }, { id: helloId })
  );
  return {
    registered,
    close(): void {
      closed = true;
      transport.close();
    },
  };
}
