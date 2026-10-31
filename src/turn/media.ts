// The media of a turn's history that its preparation works on: the protocol tokens of the re-watch classifier, the
// links the web lookup may read, the pictures and GIFs a second look may be offered for, the describable pictures
// newest first, and whether a direct call brought something to look at. src/behavior/turn.js calls them while it
// prepares a turn.

import { collectEmojiItems, collectPictures, collectReadableLinks, isDescribable } from '../media/classify.js';

export const REWATCH_SUMMARY_CHARS = 200;
// Protocol tokens of the re-watch classifier (docs/prompt-contract.md), not wording:
// the kind and status columns of a `<media>` line. The answer's parser
// (parseRewatchPickDetailed) lives in src/behavior/planner.js, which reads the
// planner's re-watch block with it; it is re-exported from src/behavior/turn.js.
export const REWATCH_KIND_VIDEO = 'video';
export const REWATCH_KIND_PICTURE = 'picture';
// A watched GIF: listed to the classifier as a video (REWATCH_KIND_VIDEO); `gif` is the internal
// candidate kind and the log's code, never written into `<media>`.
export const REWATCH_KIND_GIF = 'gif';
export const REWATCH_STATUS_WATCHED = 'watched';
export const REWATCH_STATUS_NOT_LOADED = 'not loaded';
export const REWATCH_STATUS_DESCRIBED = 'described';

/** A normalized message (src/protocol/events.js#Message), as the media collectors read it. */
type MediaMessage = object;

type ReadableLink = ReturnType<typeof collectReadableLinks>[number];
type Picture = ReturnType<typeof collectPictures>[number];
/** A custom emoji of a message's text as a describable item (src/media/classify.js#collectEmojiItems). */
type EmojiItem = { source: 'emoji'; messageId: unknown; itemId: string; kind?: unknown } & Record<string, unknown>;

// collectEmojiItems is JavaScript whose return type TypeScript cannot infer; this is its shape.
const emojiItemsOf: (message: MediaMessage) => Array<EmojiItem> = collectEmojiItems;

/**
 * The link items of `history` the web lookup may read (src/media/classify.js#collectReadableLinks:
 * no video-site link, no gif embed), newest message first.
 */
export function readableLinkCandidates(
  history: ReadonlyArray<MediaMessage>,
  sites: Array<string> | null | undefined
): Array<ReadableLink> {
  const out: Array<ReadableLink> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    out.push(...collectReadableLinks(history[i], { videoSites: sites ?? [] }));
  }
  return out;
}

/**
 * The pictures of `history` a second look on a question may be offered for
 * (features.imageRelook): every `image` item of collectPictures -- an attached
 * picture, the persona's own posted drawings included -- newest message first.
 */
export function relookCandidates(history: ReadonlyArray<MediaMessage>): Array<Picture> {
  const out: Array<Picture> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of collectPictures(history[i])) if (item.kind === 'image') out.push(item);
  }
  return out;
}

/**
 * The GIFs of `history` a second look on a question may be offered for
 * (features.videoRewatch): every `gif` item of collectPictures -- an
 * attached .gif, a tenor/giphy embed -- newest message first. Which of them
 * were watched is the describer's to say (describer.watchedGifs).
 */
export function gifRewatchItems(history: ReadonlyArray<MediaMessage>): Array<Picture> {
  const out: Array<Picture> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of collectPictures(history[i])) if (item.kind === 'gif') out.push(item);
  }
  return out;
}

/**
 * Describable pictures (image/gif/video/sticker/link-thumbnail, plus custom
 * emoji — see src/media/classify.js#isDescribable) of `history`, newest
 * message first — so a per-turn cap spends its budget on what the persona
 * just saw. Pictures (collectPictures) come before that message's emoji.
 */
export function describableCandidates(history: ReadonlyArray<MediaMessage>): Array<Picture | EmojiItem> {
  const out: Array<Picture | EmojiItem> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of [...collectPictures(history[i]), ...emojiItemsOf(history[i])]) {
      if (!isDescribable(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/** The picture kinds (src/media/classify.js) that make a direct call's own media something to look at. */
const LOOKED_AT_KINDS: ReadonlySet<unknown> = new Set(['image', 'gif', 'video']);

/**
 * Whether `trigger` (a direct call) brought something to look at that this turn's stages work
 * on: an item of `captionItems` (the caption stage's candidates) that is a picture, a GIF or a
 * video -- attached or embedded; never a sticker, an emoji or a link's thumbnail -- or any item
 * of `videoItems` (the video stage's candidates: an attached video, a video-site link), on the
 * trigger's own message or on the message it replies to. Media of any other line does not count.
 */
export function triggerBringsMedia(
  trigger: { id: string; replyToId?: string | null },
  captionItems: ReadonlyArray<{ messageId?: unknown; kind?: unknown }>,
  videoItems: ReadonlyArray<{ messageId?: unknown }>
): boolean {
  const ids = new Set<unknown>([trigger.id, trigger.replyToId].filter(Boolean));
  const own = (item: { messageId?: unknown }) => ids.has(item.messageId);
  return videoItems.some(own) || captionItems.some((item) => own(item) && LOOKED_AT_KINDS.has(item.kind));
}
