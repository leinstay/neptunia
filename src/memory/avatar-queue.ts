// Avatar descriptions, the queue: the persona knows what every profiled
// member's avatar looks like, so a joke about one lands. Each avatar version is described ONCE by
// the vision model (prompts/avatar.md, purpose `avatar`) and stored as the member's current
// `avatar` field (src/memory/avatars.ts; a platform's default avatar is stored without any request).
//
// Who is offered: the served place's members that already have a profile, never the
// persona. When: a scan on the first tick and then once a day (every profiled member whose stored
// hash differs from the current one), plus the gateway's member and user updates and the
// members' own messages, each offering one member on a hash change. The work is a throttled
// background queue: one request at a time, `INTERVAL_MS` apart, never while
// `llm.maxRequestsPerDay` is spent, never while paused. A version that failed waits for the next
// scan (no tight loop). Nothing here ever throws into a gateway handler or blocks a turn.
// Logs carry counts and codes, never the description or a URL.

import { accountOf } from './addresses.ts';
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
type AvatarItem = { placeId: string; accountId: string; hash: string | null; url: string | null };

function buildAvatarQueue({
  hot,
  store,
  llm,
  imageFetcher,
  servedPlaces,
  isServedRoot,
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
  /** The places to read members from: every root the connected interfaces serve. */
  servedPlaces: () => ReadonlyArray<string>;
  /** A root some connected interface serves. */
  isServedRoot: (placeId: string | null | undefined) => boolean;
  selfId: () => string | null;
  reads: Reads;
  paused?: () => boolean;
  now?: () => number;
  log?: Log;
}) {
  /** accountId -> { placeId, accountId, hash, url }, in offer order. */
  const queue = new Map<string, AvatarItem>();
  /** accountId -> the hash whose description failed; offered again only by the next scan. */
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
   * Offer one member: queued when the place is the served one, the member has a profile, is not
   * the persona, and the stored avatar is not this version. Synchronous, never throws.
   * @param view  The member and their avatar.
   */
  function offer(
    placeId: string,
    view: { id: string; bot: boolean; hash: string | null; url: string | null } | null
  ): 'off' | 'other-place' | 'invalid' | 'self' | 'no-profile' | 'current' | 'failed' | 'queued' | 'error' {
    try {
      if (!on()) return 'off';
      if (!placeId || !isServedRoot(placeId)) return 'other-place';
      if (!view || typeof view.id !== 'string' || !view.id) return 'invalid';
      if (view.id === selfId()) return 'self';
      const profile = store.getUser(accountOf(store, view.id));
      if (!profile) return 'no-profile';
      const hash = hashOrNull(view.hash);
      if (!isAvatarDue(profile.avatar, hash)) {
        queue.delete(view.id);
        return 'current';
      }
      if (failed.has(view.id) && failed.get(view.id) === hash) return 'failed';
      queue.set(view.id, { placeId, accountId: view.id, hash, url: hashOrNull(view.url) });
      return 'queued';
    } catch (err) {
      log.warn('avatars: offer failed', { code: propOf(err, 'code') ?? propOf(err, 'name') ?? null });
      return 'error';
    }
  }

  /**
   * Every profiled member of `placeId` offered with their current avatar (`reads.memberInfo`, one at
   * a time). Clears the failed versions first: this is their retry. A member the interface cannot
   * find (left the root, a failed read, no such read) is counted as gone.
   */
  async function scan(placeId: string): Promise<{ profiles: number; queued: number; gone: number }> {
    failed.clear();
    const started = now();
    const counts = { profiles: 0, queued: 0, gone: 0 };
    const self = selfId();
    for (const profile of store.listUserProfiles()) {
      counts.profiles += 1;
      const id = typeof profile?.id === 'string' ? String(profile.id) : null;
      if (!id || id === self) continue;
      const found = await reads.memberInfo({ placeId: placeId, accountId: id });
      const member = found?.member ?? null;
      if (!member) {
        counts.gone += 1;
        continue;
      }
      const view = { id: member.id, bot: member.bot, hash: member.avatar.hash, url: member.avatar.url };
      if (offer(placeId, view) === 'queued') counts.queued += 1;
    }
    log.info('avatars: scanned', { placeId, ...counts, waiting: queue.size, ms: now() - started });
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
    for (const [accountId, item] of [...queue]) {
      const profile = store.getUser(accountOf(store, accountId));
      if (!profile || !isAvatarDue(profile.avatar, item.hash)) {
        queue.delete(accountId);
        continue;
      }
      if (item.hash !== null) continue;
      queue.delete(accountId);
      if (store.setAvatar(accountOf(store, accountId), { hash: null, default: true })) {
        stored += 1;
        log.info('avatars: described', { accountId, default: true });
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
      failed.set(item.accountId, item.hash);
      log.warn('avatars: skipped', { reason, accountId: item.accountId, ...extra });
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
    const written = store.setAvatar(accountOf(store, item.accountId), {
      hash: item.hash,
      text,
      describedAt: new Date(now()).toISOString(),
    });
    if (!written) return fail('no-profile');
    log.info('avatars: described', { accountId: item.accountId, chars: Array.from(text).length });
    return 'described';
  }

  /**
   * One step of the queue, for a timer: the scan when one is due (the first tick, then once a
   * day), the free items, then at most one request. Never throws.
   */
  async function tick(): Promise<
    'off' | 'paused' | 'no-place' | 'busy' | 'idle' | 'wait' | 'daily-cap' | 'described' | 'failed' | 'error'
  > {
    try {
      if (!on()) return 'off';
      if (paused()) return 'paused';
      const places = servedPlaces();
      if (places.length === 0) return 'no-place';
      if (!scanning && (lastScanAt === null || now() - lastScanAt >= DAY_MS)) {
        scanning = true;
        lastScanAt = now();
        scans += 1;
        try {
          for (const placeId of places) await scan(placeId);
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
        queue.delete(item.accountId);
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
 * The avatar queue of the served place.
 * @param deps.hot  Read at the moment of use.
 * @param deps.imageFetcher  src/media/fetch-image.ts.
 * @param deps.selfId  The persona's user id.
 * @param deps.reads  The core's reads of the interface: `memberInfo` gives a
 *   member of the root with the hash and the address of their avatar, null when they are not a member.
 */
export function createAvatarQueue(deps: Parameters<typeof buildAvatarQueue>[0]): AvatarQueue {
  return buildAvatarQueue(deps);
}
