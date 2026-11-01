// Avatar descriptions, the queue: the persona knows what every profiled
// member's avatar looks like, so a joke about one lands. Each avatar version is described ONCE by
// the vision model (prompts/avatar.md, purpose `avatar`) and stored as the member's current
// `avatar` field (src/memory/avatars.ts; a platform's default avatar is stored without any request).
//
// Who is offered: the served guild's members that already have a profile, never a bot, never the
// persona. When: a scan on the first tick and then once a day (every profiled member whose stored
// hash differs from the current one), plus the gateway's member and user updates and the
// members' own messages, each offering one member on a hash change. The work is a throttled
// background queue: one request at a time, `INTERVAL_MS` apart, never while
// `llm.maxRequestsPerDay` is spent, never while paused. A version that failed waits for the next
// scan (no tight loop). Nothing here ever throws into a gateway handler or blocks a turn.
// Logs carry counts and codes, never the description or a URL.

import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { fillPromptTemplate } from '../behavior/prompt.ts';
import { clampText, oneLine } from './clamp.ts';
import { DAY_MS } from '../time.ts';
import { log as defaultLog } from '../log.ts';
import { hashOrNull, isAvatarDue } from './avatars.ts';
import { VISION_MAX_BYTES } from '../media/fetch-image.ts';
import { propOf } from './types.ts';
import type { Reads } from '../interface/reads.ts';
import type { Hot, Log, Untyped } from './types.ts';
import type { StoreView } from './store.ts';

// The queue's measures. Production values, config cut of 2026-10-31.
/** The wait between two avatar requests, in ms. */
const INTERVAL_MS = 20_000;
/** The length of an avatar description. */
const DESCRIPTION_CHARS = 200;

/** A member whose avatar waits to be described: the version (`hash`, null for the default avatar) and where to fetch it. */
type AvatarItem = { guildId: string; userId: string; hash: string | null; url: string | null };

function buildAvatarQueue({
  hot,
  store,
  llm,
  imageFetcher,
  getGuildId,
  selfId,
  reads,
  paused = () => false,
  now = Date.now,
  log = defaultLog,
}: {
  hot: Hot;
  store: Pick<StoreView, 'getUser' | 'listUserProfiles' | 'setAvatar'>;
  llm: { complete: Untyped; capLeft?: Untyped };
  imageFetcher: { fetchAsDataUrl: Untyped };
  getGuildId: () => string | null;
  selfId: () => string | null;
  reads: Reads;
  paused?: () => boolean;
  now?: () => number;
  log?: Log;
}) {
  /** userId -> { guildId, userId, hash, url }, in offer order. */
  const queue = new Map<string, AvatarItem>();
  /** userId -> the hash whose description failed; offered again only by the next scan. */
  const failed = new Map<string, string | null>();
  let working = false;
  let scanning = false;
  let lastScanAt: number | null = null;
  let scans = 0;
  let lastRequestAt: number | null = null;
  /** The UTC day each refusal was last logged on, by reason: one line a day. */
  const refusalLogged = new Map();

  /** Whether the feature works under the live config and prompts: the switch exactly true and the prompt there. */
  function on() {
    return Boolean(hot.prompts?.avatar);
  }

  /**
   * Offer one member: queued when the guild is the served one, the member has a profile, is not
   * a bot or the persona, and the stored avatar is not this version. Synchronous, never throws.
   * @param view  The member and their avatar.
   */
  function offer(
    guildId: string,
    view: { id: string; bot: boolean; hash: string | null; url: string | null } | null
  ): 'off' | 'other-guild' | 'invalid' | 'self' | 'bot' | 'no-profile' | 'current' | 'failed' | 'queued' | 'error' {
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
      log.warn('avatars: offer failed', { code: propOf(err, 'code') ?? propOf(err, 'name') ?? null });
      return 'error';
    }
  }

  /**
   * Every profiled member of `guildId` offered with their current avatar (`reads.memberInfo`, one at
   * a time). Clears the failed versions first: this is their retry. A member the interface cannot
   * find (left the community, a failed read, no such read) is counted as gone.
   */
  async function scan(guildId: string): Promise<{ profiles: number; queued: number; gone: number }> {
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
  function refusal(reason: string) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (refusalLogged.get(reason) === day) return;
    refusalLogged.set(reason, day);
    log.info('avatars: skipped', { reason, waiting: queue.size });
  }

  /**
   * Store what costs nothing: the default avatars, and drop the items whose profile went or
   * whose stored avatar is current by now. What remains needs a request.
   * @returns How many default avatars were stored.
   */
  function settleFree(): number {
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
    if (lastRequestAt !== null && now() - lastRequestAt < INTERVAL_MS) return 'wait';
    if (typeof llm?.capLeft === 'function' && llm.capLeft() <= 0) return 'daily-cap';
    return null;
  }

  /**
   * One avatar described: the download, the request, the stored line. A failure marks this
   * version failed (retried by the next scan).
   */
  async function describe(item: AvatarItem): Promise<'described' | 'failed'> {
    const config = hot.config ?? {};
    const promptText = hot.prompts?.avatar;
    const descriptionChars = DESCRIPTION_CHARS;
    const fail = (reason: string, extra = {}): 'failed' => {
      failed.set(item.userId, item.hash);
      log.warn('avatars: skipped', { reason, userId: item.userId, ...extra });
      return 'failed';
    };
    if (!item.url) return fail('no-url');
    const visionCfg = config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(item.url, {
      maxBytes: VISION_MAX_BYTES,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) return fail('download');

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(promptText, { maxChars: descriptionChars }) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        {
          model: roleModel(config, 'vision', 'avatar'),
          ...roleRequestOptions(config, {
            role: 'vision',
            maxOutputTokens: config.media?.maxOutputTokens,
            purpose: 'avatar',
          }),
        }
      );
    } catch (err) {
      return fail(railReason(err, 'llm-error'), { status: propOf(err, 'statusCode') ?? null });
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
   */
  async function tick(): Promise<
    'off' | 'paused' | 'no-guild' | 'busy' | 'idle' | 'wait' | 'daily-cap' | 'described' | 'failed' | 'error'
  > {
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
          log.warn('avatars: scan failed', { code: propOf(err, 'code') ?? propOf(err, 'name') ?? null });
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
      log.error('avatars: tick failed', { code: propOf(err, 'code') ?? propOf(err, 'name') ?? null });
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

export type AvatarQueue = ReturnType<typeof buildAvatarQueue>;

/**
 * The avatar queue of the served guild.
 * @param deps.hot  Read at the moment of use.
 * @param deps.imageFetcher  src/media/fetch-image.ts.
 * @param deps.selfId  The persona's user id.
 * @param deps.reads  The core's reads of the interface: `memberInfo` gives a
 *   member of the community with the hash and the address of their avatar, null when they are not a member.
 */
export function createAvatarQueue(deps: Parameters<typeof buildAvatarQueue>[0]): AvatarQueue {
  return buildAvatarQueue(deps);
}
