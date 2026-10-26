// The pull rails over discord.js objects, for the one reader that still takes them: the recall runner
// (src/behavior/recall-run.js, converted with the tools). A turn pulls through src/behavior/pull-fetch.ts over the
// interface's listing; this module keeps the audience rule (`audienceAllows`) and the rails of a pull (`checkPull`)
// for a discord.js guild, channel and member until the runner reads through the core's reads.

import { PermissionFlagsBits } from 'discord.js';
import { isTooOld, pullSettings } from '../../src/behavior/pull.js';
import { audienceCovers } from '../../src/behavior/elsewhere.ts';
import { audienceOf, isReadableChannel, lastActivity } from './collect.js';

/** A refusal: nothing of the channel. */
function refused(skip) {
  return { channel: null, skip };
}

/**
 * Whether `partner` (a discord.js GuildMember) has View Channel on `source`,
 * a channel of the partner's guild. No partner, a source without a guild or
 * of another guild -> false.
 */
function partnerViews(partner, source) {
  if (!partner || !source?.guild || typeof source.permissionsFor !== 'function') return false;
  if (partner.guild?.id && partner.guild.id !== source.guild.id) return false;
  return source.permissionsFor(partner)?.has(PermissionFlagsBits.ViewChannel) === true;
}

/**
 * Whether content of `source` may enter a turn in `destination`. A private
 * chat (a destination without a guild) has one reader: the source must be a
 * channel its `partner` (the guild member the persona talks to) has View
 * Channel on, whatever `context.pull.sameAudience` says; no partner never
 * qualifies. Elsewhere, with `context.pull.sameAudience` (read from `config`,
 * the live config; only `false` turns it off) everyone who can view the
 * destination must be able to view the source, checked role by role on both
 * channels' audiences (interfaces/discord/collect.js#audienceOf,
 * src/behavior/elsewhere.ts#audienceCovers; no shortcut for a source
 * @everyone can view). A missing destination or a thread never qualifies
 * while the rail is on.
 * @param {object|null} destination  The discord.js channel the turn speaks in.
 * @param {object|null} source       The discord.js channel whose content would enter it.
 * @param {object} config            The live config.
 * @param {{ partner?: object|null }} [options]  A private chat's partner (a discord.js GuildMember).
 * @returns {boolean}
 */
export function audienceAllows(destination, source, config, { partner = null } = {}) {
  if (destination && !destination.guild) return partnerViews(partner, source);
  if (!pullSettings(config).sameAudience) return true;
  return audienceCovers(audienceOf(destination), audienceOf(source));
}

/**
 * Why `channel` is not one the persona may read, or null when it is. The
 * decision is isReadableChannel's (interfaces/discord/collect.js: the one rule every
 * reader of the bot obeys, neighbours included); the checks after it only
 * name the refusal, and a refusal none of them names (a rule
 * isReadableChannel gains later) is `not-readable`. A channel without
 * `isTextBased` is `not-text` before the rule is asked.
 */
function readableRefusal(channel, bot) {
  if (typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return 'not-text';
  if (isReadableChannel(channel, bot)) return null;
  if (channel.isThread?.()) return 'thread';
  const mirrorId = bot.dryRunChannelId;
  if (mirrorId && channel.id === mirrorId) return 'dry-run-channel';
  return 'not-readable';
}

/**
 * The rails a pull must pass before anything is fetched, in this order, each
 * with its kebab-case skip code: a `destination` that is given is a guild
 * channel, or a private chat with its `partner` (`private-chat` without one,
 * whatever the audience rail says); the id is a channel of `guild` (`not-found`); the channel is one the
 * persona may read (interfaces/discord/collect.js#isReadableChannel, the rule
 * neighbours obey too), the refusal named `not-text` (not a text channel),
 * `thread`, `dry-run-channel` (`bot.dryRunChannelId`) or else `not-readable`
 * (the bot cannot read its history);
 * the audience rail toward `destination` (`audience`, see audienceAllows: in
 * a private chat, the partner's View Channel on it);
 * and its newest message not older than a positive `context.pull.maxAgeDays`
 * (`too-old`; 0, the default, never refuses). No request is made: a route
 * hook or a mention scan can ask it for every candidate id (`pullTargets`'
 * `isPullable`).
 * @param {{ guild: object, channelId: string, destination?: object|null, partner?: object|null,
 *   config: object, now?: number }} args  `partner`: a private chat's partner, the discord.js
 *   GuildMember of `guild` the persona talks to there.
 * @returns {{ channel: object|null, skip: string|null }}  The discord.js channel when it passes, else its code.
 */
export function checkPull({ guild, channelId, destination = null, partner = null, config, now = Date.now() } = {}) {
  if (destination && !destination.guild && !partner) return refused('private-chat');
  const channel =
    typeof channelId === 'string' && channelId ? (guild?.channels?.cache?.get?.(channelId) ?? null) : null;
  if (!channel) return refused('not-found');
  const unreadable = readableRefusal(channel, config?.bot ?? {});
  if (unreadable) return refused(unreadable);
  if (!audienceAllows(destination, channel, config, { partner })) return refused('audience');
  const last = lastActivity(channel);
  if (last > 0 && isTooOld(last, { maxAgeDays: pullSettings(config).maxAgeDays, now })) return refused('too-old');
  return { channel, skip: null };
}
