// The audience rail (interfaces/discord/collect.js#audienceOf) leaves a bot's member
// overwrite out of a channel's audience, but it can only tell a bot by the
// member cache, and without the member intent that cache holds only members
// seen since startup. This module fills it: every member named by a
// permission overwrite in the served guild and missing from the cache is
// fetched over REST, one by one, so discord.js caches it and `user.bot` is
// known. The id collection and the fetch loop are pure over their inputs;
// the warmer is the thin part that reads the live guild.
import { OverwriteType } from 'discord.js';
import { log } from '../../src/log.js';

// Discord's JSON error codes for a member or user that does not exist (left the guild, deleted).
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

/** Whether `err` says the member is not there (HTTP 404, Unknown Member, Unknown User). */
function isUnknownMember(err) {
  return err?.status === 404 || err?.code === UNKNOWN_MEMBER || err?.code === UNKNOWN_USER;
}

/**
 * The ids of every member-type permission overwrite across `channels`, each
 * once, in first-seen order, without the ones `isCached` accepts. Role
 * overwrites are skipped; a channel without overwrites (a thread) adds none.
 * @param {Iterable<object>|null|undefined} channels  discord.js channels
 * @param {(id: string) => boolean} isCached
 * @returns {string[]}
 */
export function overwriteMemberIds(channels, isCached) {
  const ids = new Set();
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
 * @param {string[]} ids
 * @param {(id: string) => Promise<object|null>} fetchMember
 * @returns {Promise<{ fetched: number, missing: number, failed: number, gone: string[] }>}
 */
export async function fetchMembers(ids, fetchMember) {
  const result = { fetched: 0, missing: 0, failed: 0, gone: [] };
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
 * @param {{ getGuild: () => object|null, logger?: { info: Function, warn: Function } }} deps
 * @returns {{ warm: (options?: { quiet?: boolean }) => Promise<void> }}
 */
export function createAudienceWarmer({ getGuild, logger = log }) {
  const gone = new Set();
  let running = null;
  let again = false;
  let againQuiet = true;

  async function pass(quiet) {
    const guild = getGuild();
    if (!guild) return;
    try {
      const isCached = (id) => gone.has(id) || guild.members?.cache?.has?.(id) === true;
      const ids = overwriteMemberIds(guild.channels?.cache?.values?.(), isCached);
      if (quiet && ids.length === 0) return;
      const { fetched, missing, failed, gone: left } = await fetchMembers(ids, (id) => guild.members.fetch(id));
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
