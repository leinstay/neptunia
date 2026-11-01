// The audience rail (interfaces/discord/collect.ts#audienceOf) leaves a bot's member
// overwrite out of a channel's audience, but it can only tell a bot by the
// member cache, and without the member intent that cache holds only members
// seen since startup. This module fills it: every member named by a
// permission overwrite in the served guild and missing from the cache is
// fetched over REST, one by one, so discord.js caches it and `user.bot` is
// known. The id collection and the fetch loop are pure over their inputs;
// the warmer is the thin part that reads the live guild.
import { OverwriteType } from 'discord.js';
import { errorFields } from './values.ts';
import { log } from '../../src/log.ts';
import type { ChannelLike, GuildLike } from './platform-types.ts';

// Discord's JSON error codes for a member or user that does not exist (left the guild, deleted).
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

/** Whether `err` says the member is not there (HTTP 404, Unknown Member, Unknown User). */
function isUnknownMember(err: unknown): boolean {
  const { status, code } = errorFields(err);
  return status === 404 || code === UNKNOWN_MEMBER || code === UNKNOWN_USER;
}

/**
 * The ids of every member-type permission overwrite across `channels`, each
 * once, in first-seen order, without the ones `isCached` accepts. Role
 * overwrites are skipped; a channel without overwrites (a thread) adds none.
 * @param channels discord.js channels
 */
export function overwriteMemberIds(
  channels: Iterable<ChannelLike> | null | undefined,
  isCached: (id: string) => boolean
): Array<string> {
  const ids = new Set<string>();
  for (const channel of channels ?? []) {
    for (const overwrite of channel?.permissionOverwrites?.cache?.values?.() ?? []) {
      if (overwrite.type !== OverwriteType.Member || ids.has(overwrite.id) || isCached(overwrite.id)) continue;
      ids.add(overwrite.id);
    }
  }
  return [...ids];
}

/**
 * Fetches each id in turn (the next one starts after the previous settled)
 * and never throws. `fetched`: a member came back; `missing`: the member is
 * not there (a 404 / unknown member or user, or an empty result), its id in
 * `gone`; `failed`: any other error (left for a later run).
 */
export async function fetchMembers(
  ids: Array<string>,
  fetchMember: (id: string) => Promise<object | null>
): Promise<{ fetched: number; missing: number; failed: number; gone: Array<string> }> {
  const result: { fetched: number; missing: number; failed: number; gone: Array<string> } = {
    fetched: 0,
    missing: 0,
    failed: 0,
    gone: [],
  };
  for (const id of ids) {
    try {
      const member = await fetchMember(id);
      if (member) {
        result.fetched += 1;
        continue;
      }
      result.missing += 1;
      result.gone.push(id);
    } catch (err) {
      if (isUnknownMember(err)) {
        result.missing += 1;
        result.gone.push(id);
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
}

/**
 * The warmer for the served guild. `warm()` collects the uncached overwrite
 * members of `getGuild()` and fetches them through `guild.members.fetch`
 * (which caches what it finds), then logs `audience: members warmed` with
 * counts. A member found missing is not asked for again by this warmer. A
 * call while a run is going on schedules one more pass after it instead of
 * a second parallel run. `quiet` skips the log when there was nothing to
 * fetch. Never rejects: an error is logged as `audience: members warm failed`.
 */
export function createAudienceWarmer({
  getGuild,
  logger = log,
}: {
  getGuild: () => GuildLike | null;
  logger?: { info: (message: string, fields: object) => void; warn: (message: string, fields: object) => void };
}): { warm: (options?: { quiet?: boolean }) => Promise<void> } {
  const gone = new Set<string>();
  let running: Promise<void> | null = null;
  let again = false;
  let againQuiet = true;

  async function pass(quiet: boolean): Promise<void> {
    const guild = getGuild();
    if (!guild) return;
    try {
      const isCached = (id: string): boolean => gone.has(id) || guild.members?.cache?.has?.(id) === true;
      const ids = overwriteMemberIds(guild.channels?.cache?.values?.(), isCached);
      if (quiet && ids.length === 0) return;
      const {
        fetched,
        missing,
        failed,
        gone: left,
      } = await fetchMembers(ids, (id) => {
        const members = guild.members;
        if (typeof members?.fetch !== 'function')
          return Promise.reject(new TypeError('guild.members.fetch is not a function'));
        return members.fetch(id);
      });
      for (const id of left) gone.add(id);
      logger.info('audience: members warmed', { guildId: guild.id, fetched, missing, failed });
    } catch (err) {
      logger.warn('audience: members warm failed', { guildId: guild.id, error: err });
    }
  }

  function warm({ quiet = false } = {}) {
    if (running) {
      again = true;
      againQuiet = againQuiet && quiet;
      return running;
    }
    running = (async () => {
      let current = quiet;
      for (;;) {
        await pass(current);
        if (!again) break;
        current = againQuiet;
        again = false;
        againQuiet = true;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { warm };
}
