// The core's end of the link to one interface (the serving end is src/protocol/serve.ts). The first envelope on a
// connection must be `hello` with a token that stands for a principal (`principalOf`, src/interface/principals.ts;
// a link opened with one `token` gives that token the boot principal), otherwise the link closes and nothing reaches
// the event door. The principal, never what `hello` claims, decides what the connection may do: its events must
// carry its own `iface` (a principal with no `iface` takes the one its `hello` names), and commands come only from a
// `cli` principal or an interface principal with the permission `commands`. The token is resolved again for every envelope, so a rotated or revoked token closes the link.
// `hello` is answered by an `ack` with the principal's watermark (`ackedSeq`, from `ingest.cursor`). After it, every
// envelope is checked by its type: a malformed body, a second `hello`, an event of another `iface` and a command of a
// principal that may not send one are answered `invalid`, and the link stays open.
//
// Each `event` goes through the door with the principal and its `seq`, and its ack goes back. Un-numbered events run
// concurrently. Numbered ones (an interface with an outbox) run one at a time per conversation in `seq` order, the
// conversations side by side, and their acks carry the contiguous watermark of the events taken, which is written
// with `ingest.ack` before the ack goes out. An event that `failed` holds the watermark back, so it goes again.
//
// A link opened with `admit` asks it about the principal of a good `hello`: a reason it answers refuses the hello with
// that reason (the core refuses a disabled interface with `interface-disabled`). Every refused `hello` is logged as
// `link: hello refused` with its reason.
//
// The core speaks to the interface through `adapter`: every method is one `action` envelope answered by the
// `action_result` with the same `replyTo`. A send carries the idempotency key its caller gives (one is made when it
// gives none), its `deadlineAt`, and a `signal`: aborted before the call, the send is `cancelled` and never leaves;
// aborted later, a `cancel` envelope names the action and the result that arrives stands. The adapter never rejects.
// A link that closes answers every pending effect `unknown` (it may have happened) and every pending read `failed`,
// and so does a call made afterwards. `drain(ms)` stops the link taking new actions (each answers `failed` with
// `interface-disabled`), gives the effects in flight `ms` to finish, then closes the link, so the ones left end
// `unknown`; it answers how many finished and how many did not.
//
// `answerCommand` sends the `command.result` of a command the principal asked for over this link, with its `status`.
// A command reaches the link only from a `cli` principal, an interface principal granted `commands`, or an `agent`
// principal; any other is refused and logged as `link: event refused`. Only a `cli` principal says hello as
// `iface: 'cli'`, only an `agent` principal says hello as `iface: 'agent'`, and neither says hello under another
// namespace. An agent (a development agent of the task board) sends nothing but `command.requested` events whose
// `name` starts with `task.`: any other event and any other command of it is answered `invalid` and never reaches the
// door.
//
// `createInterfaceLinks` keeps every link of the core's socket, answers which interfaces are connected and runs the
// disable of one: the owner's switch is written first, then each of its links drains. `createIfaceRouter` puts the
// served interface and the owner's command line behind one adapter, routed by the `iface` of each reference.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ackOf, declaredHooks, envelope, portAction, validateEnvelope } from '../protocol/index.js';
import type { Adapter, Capabilities, Delivery, SendOptions } from '../protocol/adapter.ts';
import type { AckStatus, Hello, Logger, Named } from '../protocol/serve.ts';
import type { Envelope, Transport } from '../protocol/wire.ts';
import type { Principal } from './principals.ts';

/** How many actions may wait for an answer at once. */
const MAX_PENDING = 256;

/** The principal of a link opened with one token: the core's one in-process interface, bound to its `hello`. */
const TOKEN_PRINCIPAL: Principal = { name: 'boot', kind: 'interface', iface: null, permissions: [] };

/** Who sent an envelope through the door: the principal's name and the envelope's `seq`. */
export type From = { principal: string | null; seq?: number | null };

/** The door as the link uses it. */
export type LinkDoor = { receive(value: unknown, from?: From): Promise<Envelope> };

/** The ingestion record of the watermarks (src/memory/db/ingest.ts through the memory database). */
export type LinkIngest = { cursor(principal: string): number; ack(principal: string, seq: number): Promise<unknown> };

type Result = Record<string, unknown>;
type Kind = 'effect' | 'read';
type Waiting = { kind: Kind; resolve(result: Result): void };

/** The answer to one `command.requested`: the token it named, the text the owner reads and the command's outcome. */
export type CommandAnswer = { replyRef: string; text: string; status: string };

/** What a drain answers: the effects in flight that finished within its time, and those it ended `unknown`. */
export type Drained = { drained: number; unknown: number };

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
  reads: [],
};

// An effect that may have happened is `unknown`; a refusal before anything was sent, and a read, is `failed`.
function refusal(kind: Kind, code: string, retryable: boolean): Result {
  const error = { code, retryable, retryAfterMs: null };
  const status = kind === 'effect' && code === 'link-closed' ? 'unknown' : 'failed';
  return { status, ref: null, parts: [], at: null, idempotencyKey: '', error };
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/** The statuses after which the core never wants the event again: everything but a failure. */
const TAKEN: ReadonlySet<string> = new Set<AckStatus>(['ok', 'duplicate', 'invalid', 'unhandled']);

/**
 * The contiguous watermark of the numbered events of one link: the highest `seq` below which every event was taken.
 * It starts at the principal's stored watermark, or just below the first `seq` the link sees when that is higher (an
 * interface never resends what it already saw acknowledged).
 */
function createWatermark(start: number) {
  let mark = start;
  let started = false;
  const done = new Set<number>();
  return {
    see(seq: number): void {
      if (!started) mark = Math.max(mark, seq - 1);
      started = true;
    },
    /** Marks `seq` taken and answers whether the watermark moved. */
    take(seq: number): boolean {
      if (seq <= mark) return false;
      done.add(seq);
      const before = mark;
      while (done.delete(mark + 1)) mark += 1;
      return mark !== before;
    },
    value: (): number => mark,
  };
}

/** The principal of `token` while it keeps standing for the same client, else null. */
function samePrincipal(now: Principal | null, first: Principal): boolean {
  return now !== null && now.name === first.name && now.kind === first.kind && now.iface === first.iface;
}

/** The namespace of the owner's command line: only a `cli` principal says hello under it, and it says hello under no other. */
export const CLI_IFACE = 'cli';

/** The permission that lets an interface principal send commands (a unit's slash commands, `/nep`). */
export const COMMANDS_PERMISSION = 'commands';

/** The namespace of the board's agents: only an `agent` principal says hello under it, and it says hello under no other. */
export const AGENT_IFACE = 'agent';

/** The prefix of the only commands an agent principal sends: the board's (src/board/commands.ts). */
const TASK_PREFIX = 'task.';

/** Whether `principal` may send `command.requested`: the owner's command line, an agent, or an interface granted `commands`. */
export const mayCommand = (principal: Principal): boolean =>
  principal.kind === 'cli' || principal.kind === 'agent' || principal.permissions.includes(COMMANDS_PERMISSION);

/** Why the authenticated sender of `body` may not send it, or null. */
function eventRefusal(body: Record<string, unknown>, iface: string, principal: Principal): string | null {
  if (body.iface !== iface) return 'body.iface:foreign';
  if (principal.kind === 'agent') {
    if (body.kind !== 'command.requested') return 'body.kind:not-allowed';
    if (typeof body.name !== 'string' || !body.name.startsWith(TASK_PREFIX)) return 'body.name:not-allowed';
    return null;
  }
  if (body.kind === 'command.requested' && !mayCommand(principal)) return 'body.kind:not-allowed';
  return null;
}

/**
 * Why a principal may not say hello under `iface`, or null: the `cli` namespace belongs to the `cli` principals alone,
 * the `agent` namespace to the `agent` principals alone.
 */
function ifaceRefusal(found: Principal, iface: unknown): string | null {
  if (found.iface !== null && found.iface !== iface) return 'iface';
  if ((found.kind === 'cli') !== (iface === CLI_IFACE)) return 'iface';
  if ((found.kind === 'agent') !== (iface === AGENT_IFACE)) return 'iface';
  return null;
}

export function openAdapterLink(options: {
  transport: Transport;
  door: LinkDoor;
  log: Logger;
  principalOf?: (token: string) => Principal | null;
  token?: string;
  ingest?: LinkIngest | null;
  admit?: (principal: Principal) => string | null;
}): {
  hello: Promise<Hello>;
  principal(): Principal | null;
  adapter: Adapter;
  isClosed(): boolean;
  drain(ms: number): Promise<Drained>;
  answerCommand(answer: CommandAnswer): Promise<Result>;
  close(): void;
} {
  const { transport, door, log } = options;
  const ingest = options.ingest ?? null;
  const principalOf =
    options.principalOf ??
    ((given: string): Principal | null =>
      options.token !== undefined && timingSafeEqual(digest(given), digest(options.token)) ? TOKEN_PRINCIPAL : null);
  const waiting = new Map<string, Waiting>();
  const lanes = new Map<string, Promise<void>>();
  let greeting: Hello | null = null;
  let principal: Principal | null = null;
  let helloToken = '';
  let watermark = createWatermark(0);
  let closed = false;
  let draining = false;
  // Told each time a waiting action is answered, so a drain sees its effects finish.
  const onSettled = new Set<() => void>();
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
    for (const listener of [...onSettled]) listener();
    transport.close();
  }

  function onHello(value: Envelope): void {
    const verdict = validateEnvelope(value);
    const body = value.body as Record<string, unknown>;
    const given = typeof body.token === 'string' ? body.token : '';
    const found = verdict.ok ? principalOf(given) : null;
    const reason = !verdict.ok ? 'hello-invalid' : found === null ? 'token' : null;
    if (reason !== null || found === null) {
      log.warn('link: hello refused', { reason });
      shut(reason ?? 'token');
      return;
    }
    const wrongIface = ifaceRefusal(found, body.iface);
    if (wrongIface !== null) {
      log.warn('link: hello refused', { reason: wrongIface, principal: found.name });
      shut(wrongIface);
      return;
    }
    const refusedBy = options.admit?.(found) ?? null;
    if (refusedBy !== null) {
      log.warn('link: hello refused', { reason: refusedBy, principal: found.name });
      shut(refusedBy);
      return;
    }
    principal = found;
    helloToken = given;
    greeting = {
      iface: body.iface as string,
      self: body.self as Named,
      community: (body.community ?? null) as Named | null,
      capabilities: (body.capabilities ?? NO_CAPABILITIES) as Capabilities,
      resume: typeof body.resume === 'string' ? body.resume : null,
    };
    const ackedSeq = ingest?.cursor(found.name) ?? 0;
    watermark = createWatermark(ackedSeq);
    log.info('link: hello', { iface: greeting.iface, principal: found.name, kind: found.kind });
    transport.send(envelope('ack', { status: 'ok', ackedSeq }, { id: `ack:${value.id}`, replyTo: value.id }));
    acceptHello(greeting);
  }

  const answerWith = (value: Envelope, status: string, reason?: string): void =>
    transport.send(ackOf(value, status, reason));

  /** One event through the door; a numbered one's ack carries the watermark, written first. */
  async function take(value: Envelope, who: Principal): Promise<void> {
    const seq = typeof value.seq === 'number' ? value.seq : null;
    let answer: Envelope;
    try {
      answer = await door.receive(value, { principal: who.name, seq });
    } catch (err) {
      log.warn('link: door failed', { name: err instanceof Error ? err.name : null });
      answer = ackOf(value, 'failed', 'handler-threw');
    }
    if (seq === null) {
      transport.send(answer);
      return;
    }
    const status = String((answer.body as Record<string, unknown>).status);
    if (TAKEN.has(status) && watermark.take(seq) && ingest !== null) {
      await ingest.ack(who.name, watermark.value()).catch((err: unknown) => {
        log.warn('link: watermark not written', { name: err instanceof Error ? err.name : null });
      });
    }
    transport.send({ ...answer, body: { ...(answer.body as Record<string, unknown>), ackedSeq: watermark.value() } });
  }

  function onEvent(value: Envelope, who: Principal): void {
    const body = value.body as Record<string, unknown>;
    const refused = eventRefusal(body, greeting?.iface ?? '', who);
    if (refused !== null) {
      log.warn('link: event refused', { reason: refused, principal: who.name });
      answerWith(value, 'invalid', refused);
      return;
    }
    if (typeof value.seq !== 'number') {
      void take(value, who);
      return;
    }
    watermark.see(value.seq);
    // One conversation's numbered events wait for each other; other conversations go on.
    const conversation = body.conversation as { id?: unknown } | undefined;
    const lane = typeof conversation?.id === 'string' ? conversation.id : '';
    const next = (lanes.get(lane) ?? Promise.resolve()).then(() => take(value, who));
    lanes.set(lane, next);
    void next.finally(() => {
      if (lanes.get(lane) === next) lanes.delete(lane);
    });
  }

  function onAuthenticated(value: Envelope, who: Principal): void {
    const verdict = validateEnvelope(value);
    if (!verdict.ok) {
      if (value.type === 'event' || value.type === 'hello') answerWith(value, 'invalid', verdict.reason);
      return;
    }
    if (value.type === 'hello') answerWith(value, 'invalid', 'hello:repeated');
    else if (value.type === 'event') onEvent(value, who);
    else if (value.type === 'action_result') {
      const entry = waiting.get(value.replyTo ?? '');
      if (entry === undefined) return;
      waiting.delete(value.replyTo ?? '');
      entry.resolve(value.body as Result);
      for (const listener of [...onSettled]) listener();
    } else if (value.type === 'ping') answerWith(value, 'ok');
  }

  transport.onEnvelope((value) => {
    if (closed) return;
    if (greeting === null || principal === null) {
      if (value.type === 'hello') onHello(value);
      else {
        log.warn('link: first envelope is not hello', { type: value.type });
        shut('no-hello');
      }
      return;
    }
    if (!samePrincipal(principalOf(helloToken), principal)) {
      log.warn('link: token no longer stands for the client', { principal: principal.name });
      shut('revoked');
      return;
    }
    onAuthenticated(value, principal);
  });
  transport.onClose((reason) => shut(reason));

  function call(action: Record<string, unknown>, kind: Kind, signal?: AbortSignal): Promise<Result> {
    if (closed || greeting === null) return Promise.resolve(refusal(kind, 'link-closed', false));
    if (draining) return Promise.resolve(refusal(kind, 'interface-disabled', false));
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
        return;
      }
      // The action is out: a cancel names it, and whatever result comes back stands.
      signal?.addEventListener(
        'abort',
        () => {
          if (!closed && waiting.has(id)) transport.send(envelope('cancel', {}, { id: `cancel:${id}`, replyTo: id }));
        },
        { once: true }
      );
    });
  }

  const effect = (operation: string, args: Array<unknown>, extra: Record<string, unknown> = {}): Promise<Result> =>
    call({ ...portAction(operation, args), ...extra }, 'effect');
  // A read changes nothing: a closed link answers it `failed`, never `unknown`.
  const read = (operation: string, args: ReadonlyArray<unknown>): Promise<Result> =>
    call(portAction(operation, [...args]), 'read');

  function send(
    conversation: Parameters<Adapter['send']>[0],
    content: Parameters<Adapter['send']>[1],
    given: SendOptions = {}
  ): Promise<Delivery> {
    const idempotencyKey = given.idempotencyKey ?? randomUUID();
    if (given.signal?.aborted === true) {
      const error = { code: 'cancelled', retryable: false, retryAfterMs: null };
      return Promise.resolve({ status: 'cancelled', ref: null, parts: [], at: null, idempotencyKey, error });
    }
    const extra =
      given.deadlineAt === undefined ? { idempotencyKey } : { idempotencyKey, deadlineAt: given.deadlineAt };
    // The result is the interface's Delivery, as it crossed the wire.
    return call(
      { ...portAction('send', [conversation, content]), ...extra },
      'effect',
      given.signal
    ) as unknown as Promise<Delivery>;
  }

  // The declared hooks give the adapter the shape of today's port; nothing delivers events through them.
  const adapter = {
    ...declaredHooks(),
    get iface(): string {
      return greeting?.iface ?? '';
    },
    capabilities: () => greeting?.capabilities ?? NO_CAPABILITIES,
    send,
    edit: (message: Parameters<Adapter['edit']>[0], content: Parameters<Adapter['edit']>[1]) =>
      effect('edit', [message, content]) as ReturnType<Adapter['edit']>,
    delete: (message: Parameters<Adapter['delete']>[0]) => effect('delete', [message]) as ReturnType<Adapter['delete']>,
    react: (message: Parameters<Adapter['react']>[0], emoji: string) =>
      effect('react', [message, emoji]) as ReturnType<Adapter['react']>,
    unreact: (message: Parameters<Adapter['unreact']>[0], emoji: string) =>
      effect('unreact', [message, emoji]) as ReturnType<Adapter['unreact']>,
    typing: (conversation: Parameters<Adapter['typing']>[0]) =>
      effect('typing', [conversation]) as ReturnType<Adapter['typing']>,
    fetchMessages: (...args: Parameters<Adapter['fetchMessages']>) =>
      read('fetchMessages', args) as ReturnType<Adapter['fetchMessages']>,
    conversationInfo: (...args: Parameters<Adapter['conversationInfo']>) =>
      read('conversationInfo', args) as ReturnType<Adapter['conversationInfo']>,
    conversations: (...args: Parameters<Adapter['conversations']>) =>
      read('conversations', args) as ReturnType<Adapter['conversations']>,
    history: (...args: Parameters<Adapter['history']>) => read('history', args) as ReturnType<Adapter['history']>,
    memberInfo: (...args: Parameters<Adapter['memberInfo']>) =>
      read('memberInfo', args) as ReturnType<Adapter['memberInfo']>,
    searchMessages: (...args: Parameters<Adapter['searchMessages']>) =>
      read('searchMessages', args) as ReturnType<Adapter['searchMessages']>,
    searchMembers: (...args: Parameters<Adapter['searchMembers']>) =>
      read('searchMembers', args) as ReturnType<Adapter['searchMembers']>,
    emoji: (...args: Parameters<Adapter['emoji']>) => read('emoji', args) as ReturnType<Adapter['emoji']>,
    parseLinks: (...args: Parameters<Adapter['parseLinks']>) =>
      read('parseLinks', args) as ReturnType<Adapter['parseLinks']>,
    reactors: (...args: Parameters<Adapter['reactors']>) => read('reactors', args) as ReturnType<Adapter['reactors']>,
  };
  /** The effects waiting now, given `ms` to finish; then the link closes and the rest end `unknown`. */
  async function drain(ms: number): Promise<Drained> {
    draining = true;
    const ids = [...waiting].filter(([, entry]) => entry.kind === 'effect').map(([id]) => id);
    const left = (): number => ids.filter((id) => waiting.has(id)).length;
    if (left() > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          onSettled.delete(check);
          resolve();
        };
        const check = (): void => {
          if (left() === 0) done();
        };
        const timer = setTimeout(done, ms);
        onSettled.add(check);
      });
    }
    const unknown = left();
    shut('drained');
    return { drained: ids.length - unknown, unknown };
  }

  return {
    hello,
    principal: () => principal,
    adapter,
    isClosed: () => closed,
    drain,
    // A command's answer may have reached the owner, so a link that closed meanwhile answers it `unknown`.
    answerCommand: (answer) => call({ action: 'command.result', ...answer }, 'effect'),
    close: () => shut('closed'),
  };
}

/** One link as `openAdapterLink` answers it. */
export type AdapterLink = ReturnType<typeof openAdapterLink>;

/** A link that is closed from the start: it answers every call as a link that dropped does (`link-closed`). */
function closedLink(): AdapterLink {
  const transport: Transport = { send() {}, onEnvelope: () => () => {}, onClose: () => () => {}, close() {} };
  const quiet: Logger = { info() {}, warn() {}, error() {} };
  const link = openAdapterLink({ transport, door: { receive: () => Promise.reject(new Error('closed')) }, log: quiet });
  link.close();
  return link;
}

/**
 * One adapter over the links of one interface, one after another: every call goes to the link attached last, so an
 * interface that reconnects is reached through the same adapter the core's modules were built with. A call while the
 * attached link is closed is answered as that link answers it (`link-closed`), and so is a call before the first link
 * when the switch starts with none (a core whose interface runs as a unit). The core attaches a new link once its
 * `hello` names the principal of the first one.
 */
export function createLinkSwitch(first: AdapterLink | null): {
  adapter: Adapter;
  current(): AdapterLink;
  attach(link: AdapterLink): void;
  close(): void;
} {
  let live = first ?? closedLink();
  const now = (): Adapter => live.adapter;
  const adapter = {
    ...declaredHooks(),
    get iface(): string {
      return now().iface;
    },
    capabilities: () => now().capabilities(),
    send: (...args: Parameters<Adapter['send']>) => now().send(...args),
    edit: (...args: Parameters<Adapter['edit']>) => now().edit(...args),
    delete: (...args: Parameters<Adapter['delete']>) => now().delete(...args),
    react: (...args: Parameters<Adapter['react']>) => now().react(...args),
    unreact: (...args: Parameters<Adapter['unreact']>) => now().unreact(...args),
    typing: (...args: Parameters<Adapter['typing']>) => now().typing(...args),
    fetchMessages: (...args: Parameters<Adapter['fetchMessages']>) => now().fetchMessages(...args),
    conversationInfo: (...args: Parameters<Adapter['conversationInfo']>) => now().conversationInfo(...args),
    conversations: (...args: Parameters<Adapter['conversations']>) => now().conversations(...args),
    history: (...args: Parameters<Adapter['history']>) => now().history(...args),
    memberInfo: (...args: Parameters<Adapter['memberInfo']>) => now().memberInfo(...args),
    searchMessages: (...args: Parameters<Adapter['searchMessages']>) => now().searchMessages(...args),
    searchMembers: (...args: Parameters<Adapter['searchMembers']>) => now().searchMembers(...args),
    emoji: (...args: Parameters<Adapter['emoji']>) => now().emoji(...args),
    parseLinks: (...args: Parameters<Adapter['parseLinks']>) => now().parseLinks(...args),
    reactors: (...args: Parameters<Adapter['reactors']>) => now().reactors(...args),
  };
  return {
    adapter,
    current: () => live,
    attach(link: AdapterLink): void {
      if (link === live) return;
      live.close();
      live = link;
    },
    close: () => live.close(),
  };
}

/** An adapter that answers every call as a link that dropped (`link-closed`): where a call goes when its link is gone. */
export const closedAdapter = (): Adapter => closedLink().adapter;

/**
 * One adapter over the served interface and the interfaces of other namespaces: a call whose reference names an
 * `iface` that `routeOf` answers goes to that adapter, every other call to `served`. The core sends the persona's
 * reply in the owner's command line (`iface: 'cli'`) this way, while its modules hold one port. Its capabilities are
 * the served interface's, with the reads of every adapter `routed()` lists added, so a read of a routed conversation
 * is asked at all (src/interface/reads.ts asks only a declared read).
 */
export function createIfaceRouter(
  served: Adapter,
  routeOf: (iface: string) => Adapter | null,
  routed: () => ReadonlyArray<Adapter>
): Adapter {
  const by = (ref: { iface?: unknown } | null | undefined): Adapter => {
    const iface = ref?.iface;
    if (typeof iface !== 'string' || iface === '' || iface === served.iface) return served;
    return routeOf(iface) ?? served;
  };
  return {
    ...declaredHooks(),
    get iface(): string {
      return served.iface;
    },
    capabilities(): Capabilities {
      const own = served.capabilities();
      const extra = routed().flatMap((adapter) => adapter.capabilities().reads ?? []);
      return extra.length === 0 ? own : { ...own, reads: [...new Set([...(own.reads ?? []), ...extra])] };
    },
    send: (...args: Parameters<Adapter['send']>) => by(args[0]).send(...args),
    edit: (...args: Parameters<Adapter['edit']>) => by(args[0]).edit(...args),
    delete: (...args: Parameters<Adapter['delete']>) => by(args[0]).delete(...args),
    react: (...args: Parameters<Adapter['react']>) => by(args[0]).react(...args),
    unreact: (...args: Parameters<Adapter['unreact']>) => by(args[0]).unreact(...args),
    typing: (...args: Parameters<Adapter['typing']>) => by(args[0]).typing(...args),
    fetchMessages: (...args: Parameters<Adapter['fetchMessages']>) => by(args[0]).fetchMessages(...args),
    conversationInfo: (...args: Parameters<Adapter['conversationInfo']>) => by(args[0]).conversationInfo(...args),
    conversations: (...args: Parameters<Adapter['conversations']>) => served.conversations(...args),
    history: (...args: Parameters<Adapter['history']>) => by(args[0]).history(...args),
    memberInfo: (...args: Parameters<Adapter['memberInfo']>) => served.memberInfo(...args),
    searchMessages: (...args: Parameters<Adapter['searchMessages']>) => served.searchMessages(...args),
    searchMembers: (...args: Parameters<Adapter['searchMembers']>) => served.searchMembers(...args),
    emoji: (...args: Parameters<Adapter['emoji']>) => served.emoji(...args),
    parseLinks: (...args: Parameters<Adapter['parseLinks']>) => served.parseLinks(...args),
    reactors: (...args: Parameters<Adapter['reactors']>) => by(args[0]).reactors(...args),
  };
}

/** One interface as the owner sees it: whether the settings let it connect and whether a link of it is up. */
export type InterfaceState = { name: string; enabled: boolean; connected: boolean };

/**
 * The links of the core's socket, by the principal each `hello` named. `names()` lists the interfaces the core knows
 * (those it runs, the interface clients of `clients.json`, the ones the settings name), `isEnabled` and `setEnabled`
 * read and write the owner's switch, `drainMs()` is read at each disable.
 */
export function createInterfaceLinks(options: {
  names(): ReadonlyArray<string>;
  isEnabled(name: string): boolean;
  setEnabled(name: string, enabled: boolean): void;
  drainMs(): number;
}): {
  add(link: AdapterLink): void;
  list(): Array<InterfaceState>;
  disable(name: string): Promise<Drained>;
  enable(name: string): void;
} {
  const links = new Set<AdapterLink>();
  /** The open links of interface `name` whose `hello` was taken. */
  function openOf(name: string): Array<AdapterLink> {
    for (const link of links) if (link.isClosed()) links.delete(link);
    return [...links].filter((link) => link.principal()?.kind === 'interface' && link.principal()?.name === name);
  }
  return {
    add: (link) => void links.add(link),
    list: () =>
      [...new Set(options.names())]
        .sort()
        .map((name) => ({ name, enabled: options.isEnabled(name), connected: openOf(name).length > 0 })),
    async disable(name) {
      options.setEnabled(name, false);
      const ms = options.drainMs();
      const outcomes = await Promise.all(openOf(name).map((link) => link.drain(ms)));
      return outcomes.reduce(
        (sum, outcome) => ({ drained: sum.drained + outcome.drained, unknown: sum.unknown + outcome.unknown }),
        { drained: 0, unknown: 0 }
      );
    },
    enable: (name) => options.setEnabled(name, true),
  };
}
