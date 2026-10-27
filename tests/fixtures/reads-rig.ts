// The pieces the tools-on-the-reads tests share: the fake adapter (src/interface/fake.js) seeded with a community, the
// core's wrapper over its reads (src/interface/reads.ts), and builders for the conversations and the whole
// `message.received` events a read returns. A test seeds what it needs, runs the code under test on `reads`, and
// reads what reached the adapter from `fake.calls` (one entry per read, under the method's name).
import type { ConversationInfo, MemberInfo, MessageEvent, Permissions } from '../../src/protocol/adapter.ts';
import { createReads } from '../../src/interface/reads.ts';
import { createFakeAdapter } from '../../src/interface/fake.js';

export const IFACE = 'fake';
export const SELF_ID = 'self-id';
export const COMMUNITY = 'g1';
export const ALL_PERMISSIONS: Permissions = { read: true, send: true, attach: true, react: true };

type Fake = ReturnType<typeof createFakeAdapter>;

export type Rig = {
  fake: Fake;
  reads: ReturnType<typeof createReads>;
  /** The warnings `createReads` logged, as `read` and `code` pairs. */
  warnings: Array<{ read: string; code: string }>;
  /** The reads that reached the adapter, in order, as `[method, first argument]`. */
  asked: (method: string) => Array<unknown>;
};

/** A fake adapter and the core's reads over it. `reads` limits the wire names the fake offers. */
export function rig(options: { reads?: ReadonlyArray<string>; selfId?: string } = {}): Rig {
  const warnings: Array<{ read: string; code: string }> = [];
  const fake = createFakeAdapter({
    iface: IFACE,
    selfId: options.selfId ?? SELF_ID,
    ...(options.reads === undefined ? {} : { reads: options.reads }),
  });
  const reads = createReads(fake, {
    info() {},
    error() {},
    warn(_message: string, fields?: unknown) {
      warnings.push(fields as { read: string; code: string });
    },
  });
  return {
    fake,
    reads,
    warnings,
    asked: (method) => fake.calls.filter((call) => call.op === method).map((call) => call.args[0]),
  };
}

/** A channel of the community the persona can read, write in, attach to and react in; everyone can view it. */
export function channel(id: string, extra: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    kind: 'channel',
    communityId: COMMUNITY,
    name: `room-${id}`,
    topic: null,
    category: null,
    iface: IFACE,
    permissions: ALL_PERMISSIONS,
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: {
      everyone: true,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      memberGroups: {},
    },
    ...extra,
  };
}

/** A channel only the named members can view, nobody else of the community. */
export function privateChannel(id: string, memberIds: Array<string>): ConversationInfo {
  return channel(id, {
    public: false,
    audience: {
      everyone: false,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: memberIds,
      memberDeny: [],
      memberGroups: {},
    },
  });
}

/** One member of the community, as `memberInfo` answers it. */
export function member(id: string, name: string, extra: Partial<MemberInfo> = {}): MemberInfo {
  return { id, name, bot: false, groupIds: [], avatar: { hash: null, url: null, largeUrl: null }, ...extra };
}

/**
 * The `message.received` event of a message in `conversation`. `text` is what the chat shows (`content`),
 * `sourceText` the text as written in the core's grammar, which defaults to `text`.
 */
export function message(
  conversation: ConversationInfo,
  id: string,
  at: number,
  text: string,
  options: { authorId?: string; authorName?: string; bot?: boolean; sourceText?: string; replyToId?: string | null } = {}
): MessageEvent {
  const authorId = options.authorId ?? 'u1';
  return {
    kind: 'message.received',
    iface: IFACE,
    at,
    id: `${IFACE}:message:${id}`,
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      communityId: conversation.communityId,
      name: conversation.name,
    },
    message: {
      id,
      author: { id: authorId, name: options.authorName ?? 'Eleni', self: authorId === SELF_ID, bot: options.bot ?? false },
      content: text,
      sourceText: options.sourceText ?? text,
      system: false,
      at,
      replyToId: options.replyToId ?? null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
}
