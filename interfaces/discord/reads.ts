// The conversation reads of the Discord adapter (src/protocol/adapter.ts), each a thin answer over the functions of this
// package: what a conversation allows and holds, its newest messages and the messages around one, a member and his
// groups, the server's search, its custom emoji, the messages a text links to and who reacted. `createDiscordReads`
// builds the methods `port.js#createDiscordAdapter` spreads into the adapter. Every read answers `{ status: 'ok', ... }` or
// a failure and never throws. The messages of a read are events (`toEvent`) without the discord.js handles, so they
// cross the link as plain data. The config is read at each call (`normalizeOptions(config())`), so no read takes media
// options from its caller.

import { PermissionFlagsBits } from 'discord.js';
import type {
  Adapter,
  Audience,
  ConversationInfo,
  FetchedMessage,
  HistoryQuery,
  MemberInfo,
  MessageEvent,
  MessageRef,
  PortError,
} from '../../src/protocol/adapter.ts';
import { emojiUrl } from '../../src/media/classify.js';
import {
  PAGE,
  audienceOf,
  canAttach,
  canReact,
  canRead,
  canSend,
  conversationOfChannel,
  fetchReactorIds,
  lastActivity,
  normalizeOptions,
  toEvent,
} from './collect.js';
import { memberView } from './members.ts';
import { searchMembers, searchMessages } from './search.js';

type Obj = Record<string, unknown>;
type Failure = { status: 'failed' | 'unsupported' | 'forbidden'; error: PortError };

/** The first millisecond of Discord's snowflakes (2015-01-01). */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** A message link as a whole text: the optional hosts, `@me` for a private chat; groups: the conversation, the message. */
const MESSAGE_LINK_RE =
  /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)\/?$/i;

const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const idList = (cache: unknown): Array<string> =>
  [...((obj(cache).keys as undefined | (() => Iterable<string>))?.call(cache) ?? [])].map(String);

/** The snowflake of the first message possible at `ms`, '0' before the epoch or for a time that is not finite. */
function snowflakeAt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH_MS) return '0';
  return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH_MS)) << 22n).toString();
}

/** A discord.js error as the failure of a read: a 404 (message or member gone) is the caller's to tell apart first. */
type FailureOf = (err: unknown) => Failure;

/** The groups of an audience as ids; the rail's sets become arrays on the wire and its roles become groups. */
function audienceOnTheWire(channel: Obj): Audience | null {
  const raw = audienceOf(channel);
  if (raw === null) return null;
  return {
    everyone: raw.everyone,
    groups: [...raw.roles],
    groupAllow: [...raw.roleAllow],
    groupDeny: [...raw.roleDeny],
    memberAllow: [...raw.memberAllow],
    memberDeny: [...raw.memberDeny],
    memberGroups: Object.fromEntries([...raw.memberRoles].map(([id, held]) => [id, [...held]])),
  };
}

/** The large static avatar address of a user or a member, null when the platform gives none. */
function largeAvatarOf(source: unknown): string | null {
  const make = obj(source).displayAvatarURL;
  if (typeof make !== 'function') return null;
  try {
    return text((make as (options: Obj) => unknown).call(source, { extension: 'png', size: 1024, forceStatic: true }));
  } catch {
    return null;
  }
}

/** One guild member: from the cache, else one fetch; undefined for a member who is gone. */
async function guildMember(guild: Obj, memberId: string, failure: FailureOf): Promise<{ member?: Obj } | Failure> {
  const members = obj(guild.members);
  const cached = (obj(members.cache).get as (id: string) => unknown)?.call(members.cache, memberId);
  if (cached) return { member: obj(cached) };
  if (typeof members.fetch !== 'function') return {};
  try {
    return { member: obj(await (members.fetch as (id: string) => Promise<unknown>).call(members, memberId)) };
  } catch (err) {
    const gone = obj(err);
    return gone.status !== 404 && gone.code !== 10007 ? failure(err) : {};
  }
}

/** A user the platform knows outside any guild, as the member of a private chat. */
async function directUser(client: Obj, memberId: string): Promise<Obj | undefined> {
  const users = obj(client.users);
  try {
    const user =
      (obj(users.cache).get as (id: string) => unknown)?.call(users.cache, memberId) ??
      (await (users.fetch as (id: string) => Promise<unknown>)?.call(users, memberId));
    return user ? { id: memberId, user, displayName: obj(user).globalName ?? obj(user).username } : undefined;
  } catch {
    return undefined;
  }
}

/** The member `who` names as the platform holds him, or a failure. */
async function findMember(
  client: Obj,
  guild: Obj | null,
  who: { communityId: string | null; memberId: string },
  failure: FailureOf
): Promise<{ member?: Obj } | Failure> {
  if (guild !== null) return guildMember(guild, who.memberId, failure);
  if (who.communityId === null) return { member: await directUser(client, who.memberId) };
  return {};
}

/** The member as a read answers it: his names, his groups and his avatar, the large one for her own and for a member who has one. */
function memberInfoOf(member: Obj, memberId: string, selfId: string, client: Obj): MemberInfo {
  const view = memberView(member);
  const user = obj(member.user);
  const own = memberId === selfId;
  return {
    id: view?.id ?? memberId,
    name: typeof member.displayName === 'string' ? member.displayName : null,
    bot: view?.bot ?? user.bot === true,
    groupIds: idList(obj(member.roles).cache),
    avatar: {
      hash: view?.hash ?? null,
      url: view?.url ?? null,
      largeUrl: own ? largeAvatarOf(client.user) : view?.hash ? largeAvatarOf(member) : null,
    },
  };
}

/** The searches, the emoji list and the link parse of a read: answers over the client and the guild of a community. */
function createLookupReads(deps: { client: Obj; iface: string; guildOf: (communityId: string | null) => Obj | null }) {
  const { client, iface, guildOf } = deps;
  const failed = (code: string): Failure => ({
    status: 'failed',
    error: { code, retryable: false, retryAfterMs: null },
  });
  return {
    async searchMessages(
      scope: { communityId: string },
      query: { text?: string; authorId?: string; after?: number; before?: number; offset?: number }
    ) {
      const page = (await searchMessages(
        { id: scope.communityId, client },
        {
          ...(query.text === undefined ? {} : { content: query.text }),
          ...(query.authorId === undefined ? {} : { authorId: query.authorId }),
          ...(query.after === undefined ? {} : { minId: snowflakeAt(query.after) }),
          ...(query.before === undefined ? {} : { maxId: snowflakeAt(query.before) }),
          ...(query.offset === undefined ? {} : { offset: query.offset }),
        }
      )) as { total: number; hits: Array<Obj> } | null;
      if (page === null) return failed('error');
      return {
        status: 'ok' as const,
        total: page.total,
        hits: page.hits.map((hit) => {
          const author = obj(hit.author);
          return {
            ref: { iface, conversationId: String(hit.channel_id), messageId: String(hit.id) },
            at: Date.parse(String(hit.timestamp)),
            text: typeof hit.content === 'string' ? hit.content : '',
            author: {
              id: text(author.id),
              handle: text(author.username),
              displayName: text(author.global_name),
              bot: author.bot === true,
            },
          };
        }),
      };
    },

    async searchMembers(scope: { communityId: string }, query: { prefix: string; limit: number }) {
      const found = (await searchMembers(
        { id: scope.communityId, client },
        query.prefix,
        query.limit
      )) as Array<Obj> | null;
      if (found === null) return failed('error');
      return {
        status: 'ok' as const,
        members: found.map((member) => ({
          id: String(member.id),
          handle: text(member.username),
          displayName: text(member.globalName),
          nickname: text(member.nick),
          bot: member.bot === true,
        })),
      };
    },

    emoji(scope: { communityId: string }) {
      const guild = guildOf(scope.communityId);
      const cache = obj(guild?.emojis).cache as Map<string, Obj> | undefined;
      const listed = [...(cache?.values() ?? [])]
        .filter((e) => text(e.id) !== null && text(e.name) !== null && e.available !== false)
        .map((e) => ({
          id: String(e.id),
          name: String(e.name),
          animated: e.animated === true,
          url: emojiUrl(String(e.id)),
        }));
      return Promise.resolve({ status: 'ok' as const, emoji: listed });
    },

    parseLinks(texts: ReadonlyArray<string>) {
      const refs = texts.map((value): MessageRef | null => {
        const match = MESSAGE_LINK_RE.exec(value);
        return match?.[1] !== undefined && match[2] !== undefined
          ? { iface, conversationId: match[1], messageId: match[2] }
          : null;
      });
      return Promise.resolve({ status: 'ok' as const, refs });
    },
  };
}

/** One attachment of a message read by id, as the contract lists it. */
function fetchedFile(file: Obj): NonNullable<FetchedMessage['attachments']>[number] {
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const duration = finite(file.duration);
  return {
    url: text(file.url) ?? undefined,
    name: text(file.name) ?? undefined,
    contentType: text(file.contentType) ?? undefined,
    size: finite(file.size),
    ...(duration === undefined ? {} : { durationSec: duration }),
    ...(typeof file.waveform === 'string' ? { waveform: file.waveform } : {}),
  };
}

/**
 * @param deps `client` the discord.js client, `config` the live config, `resolveChannel` the adapter's lookup of a
 *   channel by reference, `failure` its mapping of a thrown error, `refusal` its check of a reference.
 */
export type DiscordReads = Pick<
  Adapter,
  | 'conversationInfo'
  | 'conversations'
  | 'fetchMessages'
  | 'history'
  | 'memberInfo'
  | 'searchMessages'
  | 'searchMembers'
  | 'emoji'
  | 'parseLinks'
  | 'reactors'
>;

export function createDiscordReads(deps: {
  client: Obj;
  config: () => unknown;
  iface: string;
  resolveChannel: (ref: unknown) => Promise<{ channel?: Obj; result?: Failure }>;
  resolveMessage: (ref: unknown) => Promise<{ channel?: Obj; message?: Obj; result?: Failure }>;
  failure: FailureOf;
  refusal: (ref: unknown, needMessage?: boolean) => Failure | null;
}): DiscordReads {
  const { client, iface, resolveChannel, resolveMessage, failure, refusal } = deps;
  const selfId = (): string => text(obj(client.user).id) ?? '';
  const options = (): Obj => normalizeOptions(deps.config() as Parameters<typeof normalizeOptions>[0]);
  const failed = (code: string): Failure => ({
    status: 'failed',
    error: { code, retryable: false, retryAfterMs: null },
  });
  const guildOf = (communityId: string | null): Obj | null =>
    communityId === null
      ? null
      : ((obj(obj(client.guilds).cache).get as (id: string) => Obj | undefined)?.call(
          obj(client.guilds).cache,
          communityId
        ) ?? null);

  /** The event of a discord.js message without its handles. */
  function eventOf(message: unknown, extra: Obj = {}): MessageEvent {
    const { raw, rawPrevious, ...event } = toEvent(message as object, selfId(), { ...options(), ...extra }) as Obj;
    void [raw, rawPrevious];
    return event as unknown as MessageEvent;
  }

  /** The members of `guild` named by `ids`, from the cache first and one fetch each otherwise; those it cannot find are left out. */
  async function membersOf(guild: Obj, ids: ReadonlyArray<string>): Promise<Map<string, Obj>> {
    const found = new Map<string, Obj>();
    const members = obj(guild.members);
    for (const id of ids) {
      const cached = (obj(members.cache).get as (id: string) => unknown).call(members.cache, id);
      if (cached) {
        found.set(id, obj(cached));
        continue;
      }
      try {
        const fetched = await (members.fetch as (id: string) => Promise<unknown>).call(members, id);
        if (fetched) found.set(id, obj(fetched));
      } catch {
        // Not a member of this guild (or not reachable): the viewer is left out and reads as unable to view.
      }
    }
    return found;
  }

  const canView = (channel: Obj, member: Obj | undefined): boolean => {
    if (member === undefined || obj(channel.guild).id === undefined) return false;
    if (obj(member.guild).id !== undefined && obj(member.guild).id !== obj(channel.guild).id) return false;
    const permissions = (channel.permissionsFor as (who: unknown) => unknown)?.call(channel, member);
    return (permissions as { has?: (flag: bigint) => boolean } | null)?.has?.(PermissionFlagsBits.ViewChannel) === true;
  };

  /** The conversation of `channel` as a read answers it: the booleans, the time, the flags and, when asked, the audience and viewers. */
  function infoOf(
    channel: Obj,
    asked: { audience?: boolean; viewers?: ReadonlyArray<string> },
    viewerMembers: Map<string, Obj>
  ): ConversationInfo {
    const guild = obj(channel.guild);
    const everyone = obj(guild.roles).everyone;
    const permissionsFor = channel.permissionsFor as ((who: unknown) => unknown) | undefined;
    const isPublic =
      guild.id !== undefined &&
      (permissionsFor?.call(channel, everyone) as { has?: (flag: string) => boolean } | null | undefined)?.has?.(
        'ViewChannel'
      ) === true;
    const last = lastActivity(channel);
    const info: ConversationInfo = {
      ...(conversationOfChannel(channel) as Obj as ConversationInfo),
      iface,
      permissions: {
        read: canRead(channel),
        send: canSend(channel),
        attach: canAttach(channel),
        react: canReact(channel),
      },
      owner: null,
      lastMessageAt: last > 0 ? last : null,
      voice: (channel.isVoiceBased as (() => boolean) | undefined)?.call(channel) === true,
      public: isPublic,
    };
    if (asked.audience === true) info.audience = audienceOnTheWire(channel);
    if ((asked.viewers?.length ?? 0) > 0)
      info.viewers = Object.fromEntries(
        (asked.viewers ?? []).map((id) => [id, canView(channel, viewerMembers.get(id))])
      );
    return info;
  }

  /** The viewers asked for as guild members of `guild` (none when the conversation has no guild). */
  const viewersOf = (guild: Obj | null, ids: ReadonlyArray<string> | undefined): Promise<Map<string, Obj>> =>
    guild === null || (ids?.length ?? 0) === 0 ? Promise.resolve(new Map<string, Obj>()) : membersOf(guild, ids ?? []);

  /** The messages of one page of `channel`, oldest first (`fetch` answers a Map newest first). */
  async function pageOf(channel: Obj, query: Obj): Promise<Array<Obj>> {
    const messages = obj(channel.messages);
    const fetch = messages.fetch as (query: Obj) => Promise<Map<string, Obj>>;
    const page = await fetch.call(messages, query);
    return [...page.values()].sort((a, b) => Number(a.createdTimestamp) - Number(b.createdTimestamp));
  }

  /** The lines of `limit` newest messages before `before` (or the newest), paged back until `since` or the start of the channel. */
  async function windowOf(
    channel: Obj,
    { limit, before, since }: { limit: number; before?: string; since?: number }
  ): Promise<{ messages: Array<Obj>; complete: boolean } | Failure> {
    const collected: Array<Obj> = [];
    let cursor = before;
    let complete = false;
    while (collected.length < limit) {
      let batch: Array<Obj>;
      try {
        batch = (
          await pageOf(channel, cursor === undefined ? { limit: PAGE } : { limit: PAGE, before: cursor })
        ).reverse();
      } catch (err) {
        if (collected.length === 0) return failure(err);
        break;
      }
      if (batch.length === 0) {
        complete = true;
        break;
      }
      let hitFloor = false;
      for (const message of batch) {
        if (since !== undefined && since > 0 && Number(message.createdTimestamp) < since) {
          hitFloor = true;
          break;
        }
        collected.push(message);
        if (collected.length >= limit) break;
      }
      cursor = String(batch[batch.length - 1]?.id);
      if (hitFloor || batch.length < PAGE) {
        complete = true;
        break;
      }
    }
    return { messages: collected.reverse(), complete };
  }

  const methods = {
    async conversationInfo(
      ref: { conversationId: string },
      asked: { audience?: boolean; viewers?: ReadonlyArray<string> } = {}
    ) {
      const refused = refusal(ref);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(ref);
      if (result || channel === undefined) return result ?? failed('error');
      const viewers = await viewersOf(obj(channel.guild).id === undefined ? null : obj(channel.guild), asked.viewers);
      return { status: 'ok' as const, conversation: infoOf(channel, asked, viewers) };
    },

    async conversations(scope: { communityId: string; audience?: boolean; viewers?: ReadonlyArray<string> }) {
      const guild = guildOf(scope.communityId);
      if (guild === null) return failed('no-guild');
      const viewers = await viewersOf(guild, scope.viewers);
      const channels = [...((obj(guild.channels).cache as Map<string, Obj> | undefined)?.values() ?? [])].filter(
        (channel) =>
          typeof channel.isTextBased === 'function' &&
          typeof channel.isThread === 'function' &&
          typeof channel.permissionsFor === 'function' &&
          (channel.isTextBased as () => boolean).call(channel)
      );
      const groups = [...((obj(guild.roles).cache as Map<string, Obj> | undefined)?.values() ?? [])]
        .filter((role) => text(role.id) !== null && typeof role.name === 'string')
        .map((role) => ({ id: String(role.id), name: String(role.name) }));
      return {
        status: 'ok' as const,
        conversations: channels.map((channel) => infoOf(channel, scope, viewers)),
        groups,
      };
    },

    async fetchMessages(conversation: { conversationId: string }, messageIds: ReadonlyArray<string>) {
      const refused = refusal(conversation);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(conversation);
      if (result || channel === undefined) return result ?? failed('error');
      const messages = obj(channel.messages);
      if (typeof messages.fetch !== 'function')
        return { status: 'unsupported' as const, error: { code: 'unsupported', retryable: false, retryAfterMs: null } };
      const out: Array<FetchedMessage> = [];
      for (const id of Array.isArray(messageIds) ? messageIds : []) {
        try {
          const found = obj(await (messages.fetch as (id: string) => Promise<unknown>).call(messages, String(id)));
          if (Object.keys(found).length === 0) {
            out.push({ messageId: String(id), missing: true });
            continue;
          }
          const files =
            typeof obj(found.attachments).values === 'function'
              ? [...(found.attachments as Map<string, Obj>).values()]
              : [];
          out.push({
            messageId: String(id),
            text: typeof found.content === 'string' ? found.content : '',
            attachments: files.map(fetchedFile),
            event: eventOf(found),
          });
        } catch (err) {
          const gone = obj(err);
          if (gone.status === 404 || gone.code === 10008) {
            out.push({ messageId: String(id), missing: true });
            continue;
          }
          return failure(err);
        }
      }
      return { status: 'ok' as const, messages: out };
    },

    async history(conversation: { conversationId: string }, query: HistoryQuery) {
      const refused = refusal(conversation);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(conversation);
      if (result || channel === undefined) return result ?? failed('error');
      const { limit, before, after, around, since } = query;
      const size = Math.min(PAGE, limit);
      let messages: Array<Obj>;
      let complete: boolean;
      try {
        if (after !== undefined || around !== undefined) {
          messages = await pageOf(channel, after !== undefined ? { after, limit: size } : { around, limit: size });
          complete = messages.length < size;
        } else if (since === undefined && limit <= PAGE) {
          messages = await pageOf(channel, before === undefined ? { limit: size } : { before, limit: size });
          complete = messages.length < size;
        } else {
          const window = await windowOf(channel, {
            limit,
            ...(before === undefined ? {} : { before }),
            ...(since === undefined ? {} : { since }),
          });
          if ('status' in window) return window;
          ({ messages, complete } = window);
        }
      } catch (err) {
        return failure(err);
      }
      return { status: 'ok' as const, events: messages.map((message) => eventOf(message)), complete };
    },

    async memberInfo(who: { communityId: string | null; memberId: string }) {
      const found = await findMember(client, guildOf(who.communityId), who, failure);
      if ('status' in found) return found;
      if (found.member === undefined || Object.keys(found.member).length === 0)
        return { status: 'ok' as const, member: null };
      return { status: 'ok' as const, member: memberInfoOf(found.member, who.memberId, selfId(), client) };
    },

    ...createLookupReads({ client, iface, guildOf }),

    async reactors(ref: MessageRef, emoji: string, limit: number) {
      const refused = refusal(ref, true);
      if (refused) return refused;
      const { message, result } = await resolveMessage(ref);
      if (result || message === undefined) return result ?? failed('error');
      try {
        return { status: 'ok' as const, memberIds: (await fetchReactorIds(message, emoji, limit)) as Array<string> };
      } catch (err) {
        return failure(err);
      }
    },
  };

  return methods;
}
