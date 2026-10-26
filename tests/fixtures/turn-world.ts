// The world of a turn test over the fake interface: one fake adapter per test holding the conversations, the history
// and the members the test seeds, the core's reads over it, and the dependencies a turn runner or a handler takes
// (`port`, `reads`, `selfId`, `memberOf`, `membersOf`, `conversationName`). A test describes a conversation with
// `world.channel({ id, name, history })`, whose history is given as discord.js-shaped message stubs (the same stubs the
// platform's own functions read) and is seeded as the events the Discord interface would report for them. The channel it
// returns reads back what the persona did there: `sent`, `typingCalls` and `reactCalls`, each from the fake's record of
// the calls, in the shape the first tests of the turn asserted (`content`, `reply`, `allowedMentions`, `files`).
//
// `world()` is the current test's world, created on first use and dropped when the test ends.
import { afterEach } from 'node:test';
import { createFakeAdapter } from '../../src/interface/fake.js';
import { createReads } from '../../src/interface/reads.ts';
import type { Reads } from '../../src/interface/reads.ts';
import type { ConversationInfo, MemberInfo, MessageRef, Permissions } from '../../src/protocol/adapter.ts';
import { normalizeOptions, toEvent } from '../../interfaces/discord/index.js';

export type Raw = Record<string, unknown>;
export type Fake = ReturnType<typeof createFakeAdapter>;

const SELF = 'self-id';
const quiet = { info() {}, warn() {}, error() {} };

/** A channel of a test: its info as the fake holds it, and what the persona did in it. */
export type Channel = {
  id: string;
  name: string | null;
  guildId: string | null;
  info: ConversationInfo;
  /** The messages the persona sent here, as the first tests of the turn read them. */
  sent: Array<Record<string, unknown>>;
  /** One entry for each typing indicator she showed here. */
  typingCalls: Array<number>;
  /** The history reads made of this conversation, each as the query it carried. */
  fetches: Array<unknown>;
  /** Changes what the persona may do here, from the next read on. */
  permit(permissions: Partial<Permissions>): void;
  /** Makes every history read of this conversation fail. */
  failHistory(): void;
  /** The conversation is gone: the interface no longer knows it. */
  leave(): void;
  /** Replaces fields of the conversation's info (the audience, the viewers, its last message), from the next read on. */
  update(fields: Partial<ConversationInfo>): void;
  /** Each reaction she put here: the message and the emoji. */
  reactCalls: Array<{ id: string; emoji: string }>;
};

export type ChannelSpec = {
  id?: string;
  name?: string | null;
  /** The community the channel belongs to (g1 by default); `null` for a private chat. */
  guildId?: string | null;
  dm?: boolean;
  partnerId?: string | null;
  /** The history, oldest first, as discord.js-shaped message stubs of this channel. */
  historyMessages?: ReadonlyArray<Raw>;
  permissions?: Partial<Permissions>;
  lastMessageAt?: number | null;
  voice?: boolean;
  public?: boolean;
  kind?: ConversationInfo['kind'];
  parentId?: string | null;
  category?: string | null;
  audience?: ConversationInfo['audience'];
  viewers?: ConversationInfo['viewers'];
  extra?: Partial<ConversationInfo>;
};

export type World = {
  port: Fake;
  reads: Reads;
  selfId: string;
  channel(spec?: ChannelSpec): Channel;
  /** Puts message stubs into a channel's history. */
  seed(channelId: string, messages: ReadonlyArray<Raw>): void;
  member(communityId: string, member: Partial<MemberInfo> & { id: string } & Record<string, unknown>): void;
  /** Makes every read `op` of one conversation answer `failed`. */
  failRead(op: string, conversationId: string): void;
  /** The clock that stamps the messages the persona sends. */
  useClock(now: () => number): void;
  /** Makes the messages seeded so far, and those seeded later, as the interface reports them under `config`. */
  renormalize(config: unknown): void;
  /** Calls `spy` with the arguments of each call of `op`, before the adapter answers it. */
  tap(op: string, spy: (args: Array<unknown>) => void | Promise<void>): void;
  /** Makes each send whose text `matches` (every send by default) fail with `code`, nothing posted. */
  /** Answers each call of `op` with what `answer` returns, when that is not undefined, in place of the adapter. */
  intercept(op: string, answer: (args: Array<unknown>) => unknown): void;
  /** Makes each send whose text `matches` (every send by default) end `failed` (or `unknown`) with `code`, nothing posted. */
  failSends(matches?: (text: string | undefined) => boolean, code?: string, status?: 'failed' | 'unknown'): void;
  /** The reads over another adapter a test brings, which then holds what the world holds. */
  adopt(other: Fake): Reads;
  /** What the runner takes from the world. */
  deps(): {
    port: Fake;
    reads: Reads;
    selfId: () => string;
    memberOf: (communityId: string, memberId: string) => ({ name: string; bot: boolean } & Record<string, unknown>) | null;
    membersOf: (communityId: string) => Array<{ id: string; name: string; bot: boolean } & Record<string, unknown>>;
    conversationName: (conversationId: string) => string | null;
  };
};

let current: World | null = null;
afterEach(() => {
  current = null;
});

const ALL: Permissions = { read: true, send: true, attach: true, react: true };

const EVERYONE = {
  everyone: true,
  groups: [] as Array<string>,
  groupAllow: [] as Array<string>,
  groupDeny: [] as Array<string>,
  memberAllow: [] as Array<string>,
  memberDeny: [] as Array<string>,
  memberGroups: {} as Record<string, Array<string>>,
};

/** The send of the fake as the payload discord.js would have got it. */
function payloadOf(given: unknown): Record<string, unknown> {
  const content = (given ?? {}) as {
    text?: string;
    attachments?: Array<{ name: string; data?: unknown; url?: string }>;
    replyTo?: { messageId?: string };
    mentions?: { users?: Array<string>; repliedUser?: boolean };
  };
  const payload: Record<string, unknown> = {};
  if (typeof content.text === 'string' && content.text !== '') payload.content = content.text;
  if (Array.isArray(content.attachments) && content.attachments.length > 0)
    payload.files = content.attachments.map((file) => ({ attachment: file.data ?? file.url, name: file.name }));
  payload.reply = content.replyTo
    ? { messageReference: content.replyTo.messageId, failIfNotExists: false }
    : undefined;
  payload.allowedMentions = content.mentions
    ? { parse: [], users: content.mentions.users ?? [], repliedUser: content.mentions.repliedUser === true }
    : { parse: [] };
  return payload;
}

function create(): World {
  // The clock the messages she sends are stamped by: the one the runner is given, else the real one.
  let clock: () => number = Date.now;
  const port = createFakeAdapter({
    iface: 'discord',
    selfId: SELF,
    now: () => clock(),
    messageId: (_conversationId, count) => `sent-${count}`,
  });
  // The history of a conversation is what a test seeds, as the arrays it passes were before: her own sends stay out.
  port.showSendsInHistory(false);
  const reads = createReads(port, quiet);
  // What was seeded, replayed into another adapter a test brings (`adopt`) and applied to it from then on.
  const seeded: Array<(one: Fake) => void> = [];
  const adopted = new Map<Fake, Reads>([[port, reads]]);
  const each = (seeding: (one: Fake) => void): void => {
    seeded.push(seeding);
    for (const one of adopted.keys()) seeding(one);
  };
  type Known = { name: string; bot: boolean } & Record<string, unknown>;
  const members = new Map<string, Map<string, Known>>();
  const names = new Map<string, string | null>();
  const failing = new Map<string, Set<string>>();
  const closers = new Map<string, () => void>();
  const deliveries: Array<{ conversationId: string; content: unknown; parts: ReadonlyArray<MessageRef> }> = [];
  const adapter = port as unknown as Record<string, (...args: Array<unknown>) => Promise<unknown>>;

  type Spy = (args: Array<unknown>) => void | Promise<void>;
  type Interceptor = (args: Array<unknown>) => unknown;
  const spies = new Map<string, Array<Spy>>();
  const interceptors = new Map<string, Array<Interceptor>>();
  const wrapped = new Set<string>();

  /** Puts the spies and the failures of `op` in front of the adapter's own method, once. */
  function wrap(op: string): void {
    if (wrapped.has(op)) return;
    wrapped.add(op);
    const original = adapter[op];
    if (original === undefined) throw new Error(`no operation ${op}`);
    adapter[op] = async (...args: Array<unknown>) => {
      for (const spy of spies.get(op) ?? []) await spy(args);
      // An interceptor that answers (anything but undefined) answers in place of the adapter.
      for (const intercept of interceptors.get(op) ?? []) {
        const answered = intercept(args);
        if (answered !== undefined) return answered;
      }
      const ref = args[0] as { conversationId?: string } | undefined;
      if (ref?.conversationId !== undefined && failing.get(op)?.has(ref.conversationId) === true) {
        port.calls.push({ op, args });
        return { status: 'failed', error: { code: 'fixture-failed', retryable: false, retryAfterMs: null } };
      }
      return original.apply(port, args);
    };
  }

  function failRead(op: string, conversationId: string): void {
    const held = failing.get(op) ?? new Set<string>();
    held.add(conversationId);
    failing.set(op, held);
    wrap(op);
  }

  function tap(op: string, spy: Spy): void {
    spies.set(op, [...(spies.get(op) ?? []), spy]);
    wrap(op);
  }

  function intercept(op: string, answer: Interceptor): void {
    interceptors.set(op, [...(interceptors.get(op) ?? []), answer]);
    wrap(op);
  }

  // Every send as it was delivered: the content asked for and the messages it became (a long text is several).
  const send = adapter.send;
  if (send === undefined) throw new Error('no send');
  adapter.send = async (...args: Array<unknown>) => {
    const delivery = (await send.apply(port, args)) as { parts: ReadonlyArray<MessageRef> };
    deliveries.push({
      conversationId: (args[0] as { conversationId: string }).conversationId,
      content: args[1],
      parts: delivery.parts,
    });
    return delivery;
  };

  /** What the persona posted in a conversation, one entry for each message, as the first tests of the turn read them. */
  function sentOf(conversationId: string, from: number, to: number): Array<Record<string, unknown>> {
    const posted: Array<Record<string, unknown>> = [];
    for (const entry of deliveries.slice(from, to).filter((one) => one.conversationId === conversationId)) {
      entry.parts.forEach((ref, index) => {
        const text = port.messages.get(`${ref.conversationId}/${ref.messageId}`)?.text ?? '';
        const whole = payloadOf({ ...(entry.content as object), text });
        posted.push(index === 0 ? whole : { content: text, allowedMentions: whole.allowedMentions });
      });
    }
    return posted;
  }

  // The messages as the interface reports them follow the live config at the time of a read; here they are made
  // from the config the runner is built with (`renormalize`).
  const stubs: Array<[string, Raw]> = [];
  let options = normalizeOptions({});

  const seedOne = (channelId: string, raw: Raw): void => {
    const { raw: dropped, rawPrevious, ...event } = toEvent(raw, SELF, options) as Record<string, unknown>;
    void [dropped, rawPrevious];
    const conversation = { ...(event.conversation as object), id: channelId };
    each((one) => one.seedEvent({ ...event, iface: one.iface, conversation } as never));
  };

  const seed = (channelId: string, messages: ReadonlyArray<Raw>): void => {
    for (const raw of messages) {
      stubs.push([channelId, raw]);
      seedOne(channelId, raw);
    }
  };

  function renormalize(config: unknown): void {
    const next = normalizeOptions(config);
    if (JSON.stringify(next) === JSON.stringify(options)) return;
    options = next;
    for (const [channelId, raw] of stubs) seedOne(channelId, raw);
  }

  function channel(spec: ChannelSpec = {}): Channel {
    const id = spec.id ?? 'c1';
    const guildId = spec.dm === true ? null : spec.guildId === undefined ? 'g1' : spec.guildId;
    const name = spec.dm === true ? null : spec.name === undefined ? 'general' : spec.name;
    const info: ConversationInfo = {
      id,
      kind: spec.kind ?? (guildId === null ? 'dm' : 'channel'),
      communityId: guildId,
      name,
      topic: null,
      category: spec.category ?? null,
      chatType: guildId === null ? 'dm' : (spec.kind ?? 'channel'),
      ...(guildId === null ? { partnerId: spec.partnerId ?? 'u1' } : {}),
      ...(spec.parentId === undefined ? {} : { parentId: spec.parentId }),
      iface: 'discord',
      permissions: { ...ALL, ...spec.permissions },
      owner: null,
      lastMessageAt: spec.lastMessageAt ?? null,
      voice: spec.voice === true,
      public: spec.public ?? true,
      audience: spec.audience === undefined ? (guildId === null ? null : EVERYONE) : spec.audience,
      ...(spec.viewers === undefined ? {} : { viewers: spec.viewers }),
      ...spec.extra,
    };
    // A conversation made again starts over: no message, no id counted, and the calls before now are not its own.
    each((one) => one.clearConversation(id));
    for (let at = stubs.length - 1; at >= 0; at -= 1) if (stubs[at]?.[0] === id) stubs.splice(at, 1);
    const since = port.calls.length;
    const first = deliveries.length;
    // The handle of a conversation made again before this one stops at what it saw.
    let until = Infinity;
    let untilDeliveries = Infinity;
    closers.get(id)?.();
    closers.set(id, () => {
      until = port.calls.length;
      untilDeliveries = deliveries.length;
    });
    each((one) => one.seedConversation({ ...info, iface: one.iface }));
    names.set(id, name);
    seed(id, spec.historyMessages ?? []);
    // A test that adds lines to the array it gave (a message that arrives later) adds them to the history too.
    const live = spec.historyMessages as Array<Raw> | undefined;
    if (Array.isArray(live)) {
      for (const method of ['push', 'unshift'] as const) {
        const original = live[method].bind(live);
        live[method] = (...items: Array<Raw>): number => {
          seed(id, items);
          return original(...items);
        };
      }
    }
    const reseed = (change: Partial<ConversationInfo>): void => {
      Object.assign(info, change);
      each((one) => one.seedConversation({ ...info, iface: one.iface }));
    };
    return {
      id,
      name,
      guildId,
      info,
      get sent() {
        return sentOf(id, first, untilDeliveries);
      },
      get typingCalls() {
        return port.calls
          .slice(since, until)
          .filter((call) => call.op === 'typing' && (call.args[0] as { conversationId: string }).conversationId === id)
          .map((_, index) => index);
      },
      get fetches() {
        return port.calls
          .slice(since, until)
          .filter((call) => call.op === 'history' && (call.args[0] as { conversationId: string }).conversationId === id)
          .map((call) => call.args[1]);
      },
      permit(permissions) {
        reseed({ permissions: { ...info.permissions, ...permissions } });
      },
      failHistory() {
        failRead('history', id);
      },
      update(fields) {
        reseed(fields);
      },
      leave() {
        each((one) => one.removeConversation(id));
      },
      get reactCalls() {
        return port.calls
          .slice(since, until)
          .filter((call) => call.op === 'react' && (call.args[0] as { conversationId: string }).conversationId === id)
          .map((call) => ({ id: (call.args[0] as { messageId: string }).messageId, emoji: String(call.args[1]) }));
      },
    };
  }

  return {
    port,
    reads,
    selfId: SELF,
    channel,
    seed,
    failRead,
    useClock(now) {
      clock = now;
    },
    renormalize,
    tap,
    intercept,
    failSends(matches = () => true, code = 'http-403', status = 'failed') {
      intercept('send', (args) => {
        const content = args[1] as { text?: string } | undefined;
        if (!matches(content?.text)) return undefined;
        return {
          status,
          ref: null,
          parts: [],
          at: null,
          idempotencyKey: 'fixture',
          error: { code, retryable: false, retryAfterMs: null },
        };
      });
    },
    adopt(other) {
      const known = adopted.get(other);
      if (known !== undefined) return known;
      other.showSendsInHistory(false);
      const made = createReads(other, quiet);
      for (const seeding of seeded) seeding(other);
      adopted.set(other, made);
      return made;
    },
    member(communityId, member) {
      const held = members.get(communityId) ?? new Map<string, Known>();
      held.set(member.id, { ...member, name: member.name ?? member.id, bot: member.bot === true });
      members.set(communityId, held);
      each((one) =>
        one.seedMember(communityId, {
          name: member.id,
          bot: false,
          groupIds: [],
          avatar: { hash: null, url: null, largeUrl: null },
          ...member,
        })
      );
    },
    deps: () => ({
      port,
      reads,
      selfId: () => SELF,
      memberOf: (communityId, memberId) => members.get(communityId)?.get(memberId) ?? null,
      membersOf: (communityId) => [...(members.get(communityId) ?? [])].map(([id, member]) => ({ id, ...member })),
      conversationName: (conversationId) => names.get(conversationId) ?? null,
    }),
  };
}

/** A new world in place of the current one, for a test that sets up more than one conversation scene. */
export function freshWorld(): World {
  current = create();
  return current;
}

/** The current test's world. */
export function world(): World {
  current ??= create();
  return current;
}

/**
 * The options of a turn runner as the earlier tests gave them (a discord.js client, the platform's capabilities, a
 * default adapter) turned into what the runner takes now: the world's port, reads and the persona's id, with the
 * name `Bot`. Whatever the test passes of its own wins.
 */
export function runnerOptions(options: Record<string, unknown>): Record<string, unknown> {
  const { discord, createPort, client, ...rest } = options;
  void [discord, createPort, client];
  const own = world();
  own.renormalize((rest.hot as { config?: unknown } | undefined)?.config);
  if (typeof rest.now === 'function') own.useClock(rest.now as () => number);
  // No adapter given, or none (a test that left it open): the world's own.
  if (rest.port === null || rest.port === undefined) delete rest.port;
  const given = rest.port;
  const reads = typeof given === 'object' && given !== null ? own.adopt(given as Fake) : own.reads;
  return { ...own.deps(), reads, getSelfName: () => 'Bot', ...rest };
}

/** The arguments of `runTurn` with a channel of the world given as `channel`: the conversation reference in its place. */
export function turnParams(params: Record<string, unknown>, iface = 'discord'): Record<string, unknown> {
  const { channel, ...rest } = params;
  if (channel === undefined || channel === null) return params;
  return { conversation: { iface, conversationId: (channel as { id: string }).id }, ...rest };
}

type Runner = Record<string, unknown> & { runTurn(params: Record<string, unknown>): Promise<unknown> };

/**
 * `createTurnRunner` over the world: the options turned by `runnerOptions` and `runTurn` taking a channel of the world
 * (`turnParams`). A test file names it `createTurnRunner` and keeps its calls as they were.
 */
export function onWorld(create: (options: Record<string, unknown>) => Runner) {
  return (options: Record<string, unknown> = {}): Runner => {
    const turns = create(runnerOptions(options));
    // The interface the conversations are of: the one of the adapter the test brought, else the world's.
    const given = options.port as Fake | null | undefined;
    const iface = given?.iface ?? world().port.iface;
    return { ...turns, runTurn: (params) => turns.runTurn(turnParams(params, iface)) };
  };
}
