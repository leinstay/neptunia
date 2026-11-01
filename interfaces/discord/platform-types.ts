// The shapes of the discord.js objects this package reads: a message, a channel, a guild, a member, a reaction. Each is
// the part of the object a function of the package touches, every field optional where a partial object or a fixture
// may lack it, so the functions take what discord.js hands them and what a test builds alike. Types only.

import type { OverwriteType } from 'discord.js';
import type { EmbedInput } from './embed.ts';

/** A discord.js Collection or a Map, as far as the package calls it: each method optional. */
export type Collection<V> = {
  values?: () => Iterable<V>;
  keys?: () => Iterable<string>;
  get?: (key: string) => V | undefined;
  has?: (key: string) => boolean;
};

export type UserLike = { id: string; bot: boolean; username?: string | null; globalName?: string | null };

export type MemberLike = {
  id?: string;
  displayName?: string | null;
  user?: UserLike | null;
  roles?: { cache?: Collection<unknown> };
};

export type RoleLike = { id: string };

export type PermissionsLike = { has?: (flag: bigint) => boolean };

export type OverwriteLike = { id: string; type: OverwriteType; allow?: PermissionsLike; deny?: PermissionsLike };

export type GuildLike = {
  id?: string;
  channels?: { cache?: Collection<ChannelLike> };
  members?: {
    me?: { id?: string } | null;
    cache?: Collection<MemberLike>;
    fetch?: (id: string) => Promise<MemberLike | null>;
  };
  roles?: { everyone?: RoleLike | null; cache?: Collection<RoleLike> };
};

export type ChannelLike = {
  id?: string;
  name?: string | null;
  topic?: string | null;
  type?: number;
  parent?: { name?: string | null } | null;
  parentId?: string | null;
  recipientId?: string | null;
  recipient?: { id?: string } | null;
  guild?: GuildLike | null;
  guildId?: string | null;
  viewable?: boolean;
  lastMessageId?: string | null;
  client?: { user?: { id?: string } | null };
  isTextBased?: () => boolean;
  isThread?: () => boolean;
  permissionsFor?: (target: unknown) => PermissionsLike | null | undefined;
  permissionOverwrites?: { cache?: Collection<OverwriteLike> };
  messages?: { cache?: Collection<MessageLike> };
};

export type AttachmentLike = {
  id: string;
  name: string;
  url: string;
  contentType?: string | null;
  size?: number | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
};

export type StickerLike = { id: string; name: string; format: number };

export type ReactionLike = {
  count?: number;
  me?: boolean;
  emoji?: { id?: string | null; name?: string | null } | null;
  message?: MessageLike | null;
};

/** A forwarded message (a snapshot) or the body of a message: the parts that carry content. */
export type SnapshotLike = {
  id?: string;
  content?: string | null;
  cleanContent?: string | null;
  attachments?: Collection<AttachmentLike>;
  embeds?: Array<EmbedInput>;
  stickers?: Collection<StickerLike>;
  flags?: { has?: (flag: string) => boolean };
};

export type MessageLike = SnapshotLike & {
  id: string;
  channelId?: string;
  guildId?: string | null;
  guild?: GuildLike | null;
  channel?: ChannelLike | null;
  author: UserLike;
  member?: MemberLike | null;
  createdTimestamp: number;
  editedTimestamp?: number | null;
  reference?: { type?: number; messageId?: string | null; channelId?: string | null } | null;
  mentions?: {
    users?: Collection<UserLike>;
    members?: Collection<MemberLike>;
    repliedUser?: { id?: string } | null;
  };
  messageSnapshots?: Collection<SnapshotLike>;
  reactions?: { cache?: Collection<ReactionLike> };
  system?: boolean;
  webhookId?: string | null;
  partial?: boolean;
};
