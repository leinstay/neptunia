// Avatar descriptions (features.avatars), the queue: the persona knows what every profiled
// member's avatar looks like, so a joke about one lands. Each avatar version is described ONCE by
// the vision model (prompts/avatar.md, purpose `avatar`) and stored as the member's current
// `avatar` field (src/memory/avatars.js; a platform's default avatar is stored without any request).
//
// Who is offered: the served guild's members that already have a profile, never a bot, never the
// persona. When: a scan on the first tick and then once a day (every profiled member whose stored
// hash differs from the current one), plus the gateway's member and user updates and the
// members' own messages, each offering one member on a hash change. The work is a throttled
// background queue: one request at a time, `avatars.intervalMs` apart, at most
// `avatars.maxPerDay` a UTC day (state.json's `avatarDay` / `avatarCount`), never while
// `llm.maxRequestsPerDay` is spent, never while paused. A version that failed waits for the next
// scan (no tight loop). Nothing here ever throws into a gateway handler or blocks a turn.
// Logs carry counts and codes, never the description or a URL.

import { dailyCapOf, helperRequestOptions, railReason } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { clampText, oneLine } from './clamp.js';
import { bumpDaily, countToday, DAY_MS } from '../time.js';
import { log as defaultLog } from '../log.js';
import { hashOrNull, isAvatarDue } from './avatars.js';

/** The state.json fields of the daily avatar counter (every request, sent or refused by the provider). */
export const AVATAR_DAILY = Object.freeze({ dayKey: 'avatarDay', countKey: 'avatarCount' });

// Only when the key is missing or invalid (config.json always has it, the same value).
const INTERVAL_MS_FALLBACK = 20_000;
const DESCRIPTION_CHARS_FALLBACK = 200;

/** A positive finite number as it is, else `fallback`. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A finite number >= 0 as it is, else `fallback`. */
function nonNegativeOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The avatar queue of the served guild.
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot  Read at the moment of use.
 * @param {{ getUser: Function, listUserProfiles: Function, setAvatar: Function }} deps.store
 * @param {{ complete: Function, capLeft?: Function }} deps.llm
 * @param {{ fetchAsDataUrl: Function }} deps.imageFetcher  src/media/fetch-image.js.
 * @param {{ data: object, markDirty: Function }} deps.state  Where the daily counter lives.
 * @param {() => string|null} deps.getGuildId
 * @param {() => string|null} deps.selfId  The persona's user id.
 * @param {import('../interface/reads.ts').Reads} deps.reads  The core's reads of the interface: `memberInfo` gives a
 *   member of the community with the hash and the address of their avatar, null when they are not a member.
 * @param {() => boolean} [deps.paused]
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
export function createAvatarQueue({
  hot,
  store,
  llm,
  imageFetcher,
  state,
  getGuildId,
  selfId,
  reads,
  paused = () => false,
  now = Date.now,
  log = defaultLog,
}) {
  /** userId -> { guildId, userId, hash, url }, in offer order. */
  const queue = new Map();
  /** userId -> the hash whose description failed; offered again only by the next scan. */
  const failed = new Map();
  let working = false;
  let scanning = false;
  let lastScanAt = null;
  let scans = 0;
  let lastRequestAt = null;
  /** The UTC day each refusal was last logged on, by reason: one line a day. */
  const refusalLogged = new Map();

  /** Whether the feature works under the live config and prompts: the switch exactly true and the prompt there. */
  function on() {
    return hot.config?.features?.avatars === true && Boolean(hot.prompts?.avatar);
  }

  /**
   * Offer one member: queued when the guild is the served one, the member has a profile, is not
   * a bot or the persona, and the stored avatar is not this version. Synchronous, never throws.
   * @param {string} guildId
   * @param {{ id: string, bot: boolean, hash: string|null, url: string|null }|null} view  The member and their avatar.
   * @returns {'off'|'other-guild'|'invalid'|'self'|'bot'|'no-profile'|'current'|'failed'|'queued'|'error'}
   */
  function offer(guildId, view) {
    try {
      if (!on()) return 'off';
      if (!guildId || guildId !== getGuildId()) return 'other-guild';
      if (!view || typeof view.id !== 'string' || !view.id) return 'invalid';
      if (view.id === selfId()) return 'self';
      if (view.bot) return 'bot';
      const profile = store.getUser(guildId, view.id);
      if (!profile) return 'no-profile';
      const hash = hashOrNull(view.hash);
      if (!isAvatarDue(profile.avatar, hash)) {
        queue.delete(view.id);
        return 'current';
      }
      if (failed.has(view.id) && failed.get(view.id) === hash) return 'failed';
      queue.set(view.id, { guildId, userId: view.id, hash, url: hashOrNull(view.url) });
      return 'queued';
    } catch (err) {
      log.warn('avatars: offer failed', { code: err?.code ?? err?.name ?? null });
      return 'error';
    }
  }

  /**
   * Every profiled member of `guildId` offered with their current avatar (`reads.memberInfo`, one at
   * a time). Clears the failed versions first: this is their retry. A member the interface cannot
   * find (left the community, a failed read, no such read) is counted as gone.
   * @param {string} guildId
   * @returns {Promise<{ profiles: number, queued: number, gone: number }>}
   */
  async function scan(guildId) {
    failed.clear();
    const started = now();
    const counts = { profiles: 0, queued: 0, gone: 0 };
    const self = selfId();
    for (const profile of store.listUserProfiles(guildId)) {
      counts.profiles += 1;
      const id = typeof profile?.id === 'string' ? String(profile.id) : null;
      if (!id || id === self) continue;
      const found = await reads.memberInfo({ communityId: guildId, memberId: id });
      const member = found?.member ?? null;
      if (!member) {
        counts.gone += 1;
        continue;
      }
      const view = { id: member.id, bot: member.bot, hash: member.avatar.hash, url: member.avatar.url };
      if (offer(guildId, view) === 'queued') counts.queued += 1;
    }
    log.info('avatars: scanned', { guildId, ...counts, waiting: queue.size, ms: now() - started });
    return counts;
  }

  /** Log a refusal that holds the queue once per UTC day and reason. */
  function refusal(reason) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (refusalLogged.get(reason) === day) return;
    refusalLogged.set(reason, day);
    log.info('avatars: skipped', { reason, waiting: queue.size });
  }

  /**
   * Store what costs nothing: the default avatars, and drop the items whose profile went or
   * whose stored avatar is current by now. What remains needs a request.
   * @returns {number}  How many default avatars were stored.
   */
  function settleFree() {
    let stored = 0;
    for (const [userId, item] of [...queue]) {
      const profile = store.getUser(item.guildId, userId);
      if (!profile || !isAvatarDue(profile.avatar, item.hash)) {
        queue.delete(userId);
        continue;
      }
      if (item.hash !== null) continue;
      queue.delete(userId);
      if (store.setAvatar(item.guildId, userId, { hash: null, default: true })) {
        stored += 1;
        log.info('avatars: described', { userId, default: true });
      }
    }
    return stored;
  }

  /** The first item that needs a request, or null. */
  function nextPaid() {
    for (const item of queue.values()) if (item.hash !== null) return item;
    return null;
  }

  /** Why the next request may not go out now, or null when it may. */
  function blocker() {
    const config = hot.config ?? {};
    const interval = nonNegativeOr(config.avatars?.intervalMs, INTERVAL_MS_FALLBACK);
    if (lastRequestAt !== null && now() - lastRequestAt < interval) return 'wait';
    const cap = dailyCapOf(config.avatars?.maxPerDay, 'avatars.maxPerDay');
    if (countToday(state.data, AVATAR_DAILY, now()) >= cap) return 'avatar-cap';
    if (typeof llm?.capLeft === 'function' && llm.capLeft() <= 0) return 'daily-cap';
    return null;
  }

  /**
   * One avatar described: the download, the request, the stored line. A failure marks this
   * version failed (retried by the next scan).
   * @returns {Promise<'described'|'failed'>}
   */
  async function describe(item) {
    const config = hot.config ?? {};
    const promptText = hot.prompts?.avatar;
    const descriptionChars = positiveOr(config.avatars?.descriptionChars, DESCRIPTION_CHARS_FALLBACK);
    const fail = (reason, extra = {}) => {
      failed.set(item.userId, item.hash);
      log.warn('avatars: skipped', { reason, userId: item.userId, ...extra });
      return 'failed';
    };
    if (!item.url) return fail('no-url');
    const visionCfg = config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(item.url, {
      maxBytes: visionCfg.maxBytes,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) return fail('download');

    bumpDaily(state.data, AVATAR_DAILY, now());
    state.markDirty();
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(promptText, { maxChars: descriptionChars }) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        {
          model: roleModel(config, 'vision', 'avatar'),
          ...helperRequestOptions(config, {
            role: 'vision',
            maxOutputTokens: config.media?.maxOutputTokens,
            purpose: 'avatar',
          }),
        }
      );
    } catch (err) {
      return fail(railReason(err, 'llm-error'), { status: err?.statusCode ?? null });
    }
    const firstLine = String(completion?.text ?? '')
      .trim()
      .split('\n')[0];
    const text = clampText(oneLine(firstLine), descriptionChars, { tolerance: 1 });
    if (!text) return fail('empty');
    const written = store.setAvatar(item.guildId, item.userId, {
      hash: item.hash,
      text,
      describedAt: new Date(now()).toISOString(),
    });
    if (!written) return fail('no-profile');
    log.info('avatars: described', { userId: item.userId, chars: Array.from(text).length });
    return 'described';
  }

  /**
   * One step of the queue, for a timer: the scan when one is due (the first tick, then once a
   * day), the free items, then at most one request. Never throws.
   * @returns {Promise<'off'|'paused'|'no-guild'|'busy'|'idle'|'wait'|'avatar-cap'|'daily-cap'|'described'|'failed'|'error'>}
   */
  async function tick() {
    try {
      if (!on()) return 'off';
      if (paused()) return 'paused';
      const guildId = getGuildId();
      if (!guildId) return 'no-guild';
      if (!scanning && (lastScanAt === null || now() - lastScanAt >= DAY_MS)) {
        scanning = true;
        lastScanAt = now();
        scans += 1;
        try {
          await scan(guildId);
        } catch (err) {
          log.warn('avatars: scan failed', { code: err?.code ?? err?.name ?? null });
        } finally {
          scanning = false;
        }
      }
      if (working) return 'busy';
      working = true;
      try {
        settleFree();
        const item = nextPaid();
        if (!item) return 'idle';
        const blocked = blocker();
        if (blocked) {
          if (blocked !== 'wait') refusal(blocked);
          return blocked;
        }
        queue.delete(item.userId);
        try {
          return await describe(item);
        } finally {
          lastRequestAt = now();
        }
      } finally {
        working = false;
      }
    } catch (err) {
      log.error('avatars: tick failed', { code: err?.code ?? err?.name ?? null });
      return 'error';
    }
  }

  return {
    offer,
    scan,
    tick,
    /** The user ids waiting, in order. */
    pending: () => [...queue.keys()],
    /** How many scans the tick has started in this process. */
    scansStarted: () => scans,
  };
}
