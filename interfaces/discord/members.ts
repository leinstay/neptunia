// A discord.js member as the core sees it: the avatar the queue describes (`memberView`, from `avatarHashOf`) and
// the `membership.changed` event that carries the same view. A message's author carries the view's hash and url
// as `author.avatar` (collect.js#toEvent).

import { DISCORD_IFACE } from './port.js';

/** The avatar picture asked for: a static 256 px PNG (an animated one's first frame). */
const AVATAR_URL_OPTIONS = Object.freeze({ extension: 'png', size: 256, forceStatic: true });

/** A member as the avatar queue reads it: `hash` and `url` are null for Discord's default avatar. */
export type MemberView = { id: string; bot: boolean; hash: string | null; url: string | null };

type Member = {
  id?: unknown;
  avatar?: unknown;
  displayName?: unknown;
  guild?: { id?: unknown } | null;
  user?: { id?: unknown; bot?: unknown; avatar?: unknown } | null;
  displayAvatarURL?: (options: { extension: string; size: number; forceStatic: boolean }) => unknown;
};

const hashOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The hash of the avatar a member shows: the server avatar when set, else the account avatar, else null. */
export function avatarHashOf(hashes: { memberAvatar?: unknown; userAvatar?: unknown } = {}): string | null {
  return hashOrNull(hashes.memberAvatar) ?? hashOrNull(hashes.userAvatar);
}

/**
 * A guild member as the queue sees it: its id, whether it is a bot, the current avatar hash and, with a hash, the
 * url of a static 256 px PNG of it (`displayAvatarURL` prefers the server avatar as the hash does). Null for
 * anything that is not a member with a user id. A failing url builder gives a null url.
 */
export function memberView(value: unknown): MemberView | null {
  const member = (value ?? {}) as Member;
  const user = member.user;
  if (user === null || user === undefined || typeof user.id !== 'string' || user.id === '') return null;
  const hash = avatarHashOf({ memberAvatar: member.avatar, userAvatar: user.avatar });
  let url: string | null = null;
  if (hash !== null) {
    try {
      url = hashOrNull(member.displayAvatarURL?.({ ...AVATAR_URL_OPTIONS }));
    } catch {
      url = null;
    }
  }
  return { id: user.id, bot: user.bot === true, hash, url };
}

/**
 * The `membership.changed` event of a changed member (`GuildMemberUpdate`, or the member behind a `UserUpdate`).
 * Throws for a member without a guild or a user id, which the caller logs as an event that could not be built.
 */
export function membershipUpdatedEvent(value: unknown, at: number): Record<string, unknown> {
  const member = (value ?? {}) as Member;
  const view = memberView(member);
  const guildId = member.guild?.id;
  if (view === null || typeof guildId !== 'string') throw new TypeError('member without a guild or a user id');
  return {
    kind: 'membership.changed',
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:membership:${guildId}:${view.id}:updated:${at}`,
    guildId,
    userId: view.id,
    change: 'updated',
    member: {
      id: view.id,
      name: typeof member.displayName === 'string' ? member.displayName : null,
      bot: view.bot,
      avatar: { hash: view.hash, url: view.url },
    },
  };
}
