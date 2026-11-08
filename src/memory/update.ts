// The code-only memory of the live message path: every place message the persona sees moves the counters of its
// author's profile and of its channel's map entry (`touchMemory`), feeds the GIF library, the custom emoji ranking
// and the names members are called by (`recordAddressing`). No model is asked here: what she remembers of a
// chat is written by her memory session over the memory database (src/memory/db/session.ts), which reads
// the observed lines from the database. `slimMessage` is the one shape a normalized message is kept in by the
// record (src/memory/record.ts#toRecordLine) and by the late-embed fold of src/behavior/pipeline.js.

import { accountOf, placeOfChat } from './addresses.ts';
import { log } from '../log.ts';
import { DEFAULT_ADDRESS_HALF_LIFE_DAYS, addressCandidates, countAddressUses } from './addressed.ts';
import { emojiUsageOpts } from './emoji-usage.ts';
import { gifOpts } from './gifs.ts';
import { recordLinks } from './record.ts';
import { selfreflectionChatIds } from './db/mirrors.ts';
import { MEMORY_LIMITS } from './text-limits.ts';
import type { StoreView } from './store.ts';
import { propOf } from './types.ts';
import type { StoredRecord, Hot, Untyped } from './types.ts';

/**
 * The log `error` field of a failure: the error's name only (`SyntaxError`, `TypeError`, `Error`), never its message.
 */
export function errorNameOf(err: unknown): string {
  const name = propOf(err, 'name');
  return typeof name === 'string' && name ? name : 'Error';
}

/**
 * Count which names observed place lines call members by (src/memory/addressed.ts) and fold
 * the uses into each member's `addressedAs` (`store.recordAddressUses`, `cfg.addressHalfLifeDays`,
 * 30 when missing). The candidates are every stored profile of the place; other bots' lines are
 * skipped, the persona's own count. A store without `listUserProfiles` / `recordAddressUses` (a
 * test fake) counts nothing.
 * @param messages  The observed slim messages.
 * @param [cfg]  `config.memory`, read at the moment of use.
 * @returns The uses recorded.
 */
export function recordAddressing(
  store: StoreView,
  placeId: string,
  messages: Array<StoredRecord>,
  cfg: StoredRecord = {}
): number {
  if (typeof store?.listUserProfiles !== 'function' || typeof store?.recordAddressUses !== 'function') return 0;
  const lines = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.bot);
  if (lines.length === 0) return 0;
  const uses = countAddressUses(lines, addressCandidates(store.listUserProfiles()));
  let recorded = 0;
  for (const [accountId, list] of uses) {
    if (
      store.recordAddressUses(accountOf(store, accountId), list, {
        halfLifeDays: cfg?.addressHalfLifeDays ?? DEFAULT_ADDRESS_HALF_LIFE_DAYS,
      })
    )
      recorded += list.length;
  }
  return recorded;
}

/**
 * Record that a normalized message happened, for the counters kept on a
 * user's profile and a channel's map entry: `touchUser` (skipped for the
 * persona's own messages) and `touchChannel`, whose `topWriters` tally also
 * skips the persona's own messages and other bots. Used by `observe()`, the
 * live pipeline.
 * @param normalized  A normalized message (src/protocol/events.ts#Message);
 *   callers are expected to have already dropped other bots' messages.
 * @param [memoryCfg]  The live `config.memory`, for the tally's settings
 *   (`channelWritersStored`, `channelWritersHalfLifeDays`); omitted -> the store's fallbacks.
 *   `selfreflectionChannelIds` (the caller adds the places of her selfreflection, src/memory/db/mirrors.ts#selfreflectionChatIds) names
 *   the channels where the persona's own messages count as a writer.
 */
export function touchMemory(
  store: StoreView,
  placeId: string,
  normalized: NormalizedMessage,
  memoryCfg?: StoredRecord
): void {
  if (!normalized.self) {
    store.touchUser(accountOf(store, normalized.authorId), normalized.authorName, normalized.ts);
  }
  // The persona's own messages and other bots never count toward a channel's
  // top writers -- see src/memory/store.ts#touchChannel.
  // The one exception is a place of her selfreflection (`memoryCfg.selfreflectionChannelIds`): the persona is its writer, so the map
  // does not show it as dead.
  const selfreflectionIds: Set<string> | undefined = memoryCfg?.selfreflectionChannelIds;
  const inSelfreflection = selfreflectionIds?.has(String(normalized.placeId)) === true;
  const writerId = !normalized.bot && (!normalized.self || inSelfreflection) ? normalized.authorId : null;
  store.touchChannel(
    placeOfChat(store, { id: normalized.placeId }),
    { name: normalized.channelName, topic: normalized.channelTopic },
    normalized.ts,
    writerId,
    memoryCfg
  );
}

/**
 * The media of one normalized message part (the message itself or one
 * forwarded snapshot) as a slim message keeps it. No URL ever survives
 * into it -- but the item `id` does. A sticker keeps `id`/`name`/`format` and its `url` (a fixed picture address,
 * null for a sticker with no picture); a custom emoji keeps only `id`/`name` (its URL is rebuilt via emojiUrl).
 */
/** The media of a normalized message, or of one of its forwarded snapshots, as the interface describes them. */
type MediaPart = {
  attachments?: Array<Untyped>;
  links?: Array<Untyped>;
  stickers?: Array<Untyped>;
  emojis?: Array<Untyped>;
};

/** A normalized message (src/protocol/events.ts#Message) as the observer reads it. */
export type NormalizedMessage = MediaPart & {
  id: string;
  placeId: string;
  channelName?: string;
  channelTopic?: string | null;
  authorId: string;
  authorName: string;
  self?: boolean;
  bot?: boolean;
  content?: string;
  ts: number;
  replyToId?: string | null;
  mentionedAccountIds?: Array<string>;
  forwarded?: Array<MediaPart & { content?: string }>;
  forwardedFrom?: Untyped;
};

/**
 * A sticker as a slim message keeps it: `id`, `name`, `format` and the `url` of its picture (null for a sticker with none).
 */
function slimSticker(sticker: { id?: unknown; name?: unknown; format?: unknown; url?: unknown }) {
  return { id: sticker.id, name: sticker.name, format: sticker.format, url: sticker.url ?? null };
}

function slimMedia(part: MediaPart) {
  return {
    attachments: (part.attachments ?? []).map((a: Untyped) => ({
      kind: a.kind,
      name: a.name,
      id: a.id,
      durationSec: a.durationSec ?? null,
    })),
    links: (part.links ?? []).map((l: Untyped) => ({
      kind: l.kind,
      name: l.title || l.site || '',
      id: l.id,
      durationSec: null,
    })),
    stickers: (part.stickers ?? []).map(slimSticker),
    emojis: (part.emojis ?? []).map((e: Untyped) => ({ id: e.id, name: e.name })),
  };
}

/**
 * One normalized message as the record keeps it: ids, author, content, `ts`, the
 * reply target and its media without any URL (slimMedia), the forwarded snapshots stripped
 * the same way, and `direct`; a message whose links carry a preview title or description also
 * keeps them as `linkCards` (src/memory/record.ts#recordLinks: URL, title, description, site),
 * which only the record reads.
 * @param normalized  A normalized message (src/protocol/events.ts#Message).
 * @param [direct]   Whether the message was addressed to the persona.
 */
export function slimMessage(normalized: Partial<NormalizedMessage>, direct: boolean = false): object {
  const linkCards = recordLinks(normalized.links);
  const forwarded = (normalized.forwarded ?? []).map((snapshot: Untyped) => ({
    content: snapshot.content ?? '',
    ...slimMedia(snapshot),
  }));
  return {
    id: normalized.id,
    placeId: normalized.placeId,
    channelName: normalized.channelName,
    authorId: normalized.authorId,
    authorName: normalized.authorName,
    self: normalized.self,
    bot: normalized.bot,
    content: normalized.content,
    ts: normalized.ts,
    replyToId: normalized.replyToId,
    // The members the message mentions (the record's `mentions`); absent when none.
    ...(Array.isArray(normalized.mentionedAccountIds) && normalized.mentionedAccountIds.length > 0
      ? { mentionedAccountIds: [...normalized.mentionedAccountIds] }
      : {}),
    ...slimMedia(normalized),
    // The link previews the record keeps (toRecordLine's `links`); absent when none.
    ...(linkCards.length > 0 ? { linkCards } : {}),
    // A forwarded message's snapshots (`forwarded`,
    // src/protocol/events.ts#Message), stripped the same way. Absent for a message
    // with no forward.
    ...(forwarded.length > 0 ? { forwardedFrom: normalized.forwardedFrom ?? null, forwarded } : {}),
    direct: Boolean(direct),
  };
}

function buildMemoryUpdater({
  hot,
  store,
  gifKeeper = null,
}: {
  hot: Pick<Hot, 'config'>;
  store: StoreView;
  /** The keeper of the GIF library (src/memory/gif-keeper.ts), absent in a run without one. */
  gifKeeper?: { keep: (placeId: string, message: StoredRecord) => unknown } | null;
}) {
  /**
   * One observed message: the counters (`touchMemory`), the GIF library, the emoji usage and the address counts.
   * `direct` marks a message addressed to the persona. Never throws on a store that cannot be read: the count is
   * left out with a warning.
   */
  function observe(
    placeId: string,
    normalized: NormalizedMessage,
    { direct = false, private: privateAccountId = null } = {}
  ) {
    // /nep pause: nothing may make the store dirty while paused.
    const stateData = store.state.data;
    if (stateData.paused) return;
    if (normalized.bot) return;
    if (privateAccountId) return;
    touchMemory(store, placeId, normalized, {
      ...hot.config.memory,
      ...MEMORY_LIMITS,
      selfreflectionChannelIds: selfreflectionChatIds(store),
    });
    // The GIF library (src/memory/gifs.ts) is fed here: it needs the GIF's URL, which no slim message keeps.
    const gifs = store.recordGifs(placeId, [normalized], gifOpts());
    if (gifs > 0) {
      log.info('memory: gifs recorded', { placeId, gifs });
      void gifKeeper?.keep(placeId, normalized);
    }
    const slim = slimMessage(normalized, direct);
    try {
      store.recordEmojiUsage(placeId, [slim], emojiUsageOpts());
    } catch (err) {
      log.warn('memory: emoji count left out', { placeId, reason: 'store-error', error: errorNameOf(err) });
    }
    try {
      recordAddressing(store, placeId, [slim], MEMORY_LIMITS);
    } catch (err) {
      log.warn('memory: address count left out', { placeId, reason: 'store-error', error: errorNameOf(err) });
    }
  }

  return { observe };
}

export type MemoryUpdater = ReturnType<typeof buildMemoryUpdater>;

/**
 * The live observer (src/behavior/pipeline.js calls `observe` for every place message the persona sees, her own
 * included). A private chat's line (`private`: the partner's id) moves no public counter, feeds no GIF library and
 * counts no names. Nothing while `/nep pause` holds.
 */
export function createMemoryUpdater(deps: Parameters<typeof buildMemoryUpdater>[0]): MemoryUpdater {
  return buildMemoryUpdater(deps);
}
