// Pure media semantics shared by the interface packages (normalization),
// src/format.ts (transcript rendering) and src/behavior/prompt.ts
// (vision selection): classifying an attachment/embed into a kind, choosing
// which label form a media item takes in a transcript line, picking which
// pictures of a channel a live turn may see, and listing the video
// candidates of a message (attached videos, video-site links) for the video
// describer. The addresses of a platform's media (its CDN, its resizing proxy,
// its stickers) are the interface's: an item arrives with its `previewUrl` and
// an `expiring` flag. No network I/O, no platform SDK
// import: callers hand in plain data already read off a platform's
// message (node:crypto is used only for a deterministic, synchronous
// hash, not for any I/O).

import { createHash } from 'node:crypto';
import { objOf, scalarText } from '../tools/types.ts';
import { videoSiteFor } from './video-sites.ts';

// The GIF sites a chat's GIF picker posts pages of (and their media hosts).
const GIF_HOST_RE = /(^|\.)((tenor|giphy|klipy)\.com)$/i;

// Extensions a platform may leave without a contentType (or none at all, for
// bots that strip it): a conservative, deliberately small map — anything
// unmatched falls back to the generic 'file' kind.
const EXT_KIND: Record<string, string> = {
  gif: 'gif',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  txt: 'text',
  md: 'text',
  log: 'text',
  csv: 'text',
  json: 'text',
  js: 'text',
};

// Media "picture" kinds: the ones collectPictures (below) lists for the
// describer.
const PICTURE_ATTACHMENT_KINDS = new Set(['image', 'gif', 'video']);
// Media kinds the describer (src/memory/describe.ts) can produce a caption
// for. 'sticker'/'emoji' are added here for the same reason a picture-format
// sticker or a custom emoji is describable, even though neither is a platform's
// attachment or embed kind. 'link' (a video-site embed such as YouTube) is
// describable through its thumbnail alone -- collectPictures only ever
// offers a 'link' item that actually carries one (see below), so the kind
// alone is a safe signal here.
// 'voice' and 'audio' (collectAudio) are told by the `video` model role, which hears them; a 'text' file by its own words.
const DESCRIBABLE_KINDS = new Set<unknown>([
  'image',
  'gif',
  'video',
  'sticker',
  'emoji',
  'link',
  'voice',
  'audio',
  'text',
]);
/** The kinds of attachment a model hears. */
const AUDIO_KINDS = new Set<unknown>(['voice', 'audio']);

/** One attachment of a normalized message, as the media collectors read it. */
type MediaAttachment = {
  id: string;
  kind: string;
  url: string;
  name: string;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  size?: number;
  previewUrl?: string;
};

/** One link or embed of a normalized message. */
type MediaLink = {
  id: string;
  kind: string;
  url?: string;
  site?: string;
  title?: string;
  text?: string;
  thumbnailUrl?: string;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  animationUrl?: string;
  previewUrl?: string;
};

type MediaSticker = { id: string; name: string; url: string | null };
type MediaEmoji = { id: string; name: string; url: string };

/** The parts of a message (or of one forwarded snapshot of it) that carry media. */
export type MediaPart = {
  attachments?: Array<MediaAttachment>;
  links?: Array<MediaLink>;
  stickers?: Array<MediaSticker>;
  emojis?: Array<MediaEmoji>;
};

/** A normalized message as the collectors read it: its own media parts and its forwarded snapshots'. */
type MediaMessage = MediaPart & { id: string; forwarded?: Array<MediaPart> };

/**
 * A normalized message (src/protocol/events.ts#Message, or a slim buffered one) read as the collectors read it. The
 * callers hold messages in their own shapes, so the collectors take `object` and name the fields they read here.
 */
function asMediaMessage(message: object): MediaMessage {
  return message as MediaMessage;
}

/** One media item of a transcript line, as `mediaLabelFor` reads it. */
export type MediaItem = {
  kind: string;
  name?: string;
  site?: string;
  title?: string;
  text?: string;
  durationSec?: number | null;
  previewText?: string;
};

/** A second look on a question: `{ question, text }`. */
type Answer = { question?: string; text?: string };

/** The state of a video that was or was not watched. */
type VideoState = {
  state: 'watched' | 'limit' | 'error' | 'pending';
  text?: string;
  reason?: string;
  watchedSeconds?: number;
  totalSeconds?: number;
  answer?: Answer;
};

/** One label key with the values that fill it. */
type LabelTag = { key: string; values: Record<string, string> };

/** The label of a media item: its key and values, and the extra tags that follow it. */
type Label = LabelTag & { extra?: LabelTag | Array<LabelTag> };

function extOf(name: unknown): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(scalarText(name ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * `text` cut to its first `maxChars` code points with `…` appended (the
 * ellipsis is outside the budget), or unchanged when it fits. Never splits a
 * surrogate pair, never trims. A missing, non-finite or non-positive
 * `maxChars` means no limit.
 */
export function clipWithEllipsis(text: string, maxChars?: number): string {
  const value = String(text ?? '');
  const limit = Math.floor(Number(maxChars));
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points.slice(0, limit).join('')}…`;
}

/** The longest file name shown or kept, in characters: the owner's standard of 2026-11-05. */
const FILE_NAME_CHARS = 120;

/** A file name as data: one line, nothing that opens a tag, cut to the standard's length. Pure. */
export function safeFileName(name: unknown): string {
  return scalarText(name ?? '')
    .replace(/[<>\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_NAME_CHARS);
}

/** The hostname of `url` without a leading `www.`, or '' for an unparsable URL. */
export function siteOf(url: string): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Classify one attachment into `image | gif | video | audio | voice |
 * text | file`. `isVoice` reflects the MESSAGE's voice-message flag (a platform
 * flags the whole message, not the attachment); a voice message's attachment
 * always classifies as `voice`, ahead of its content type.
 */
export function classifyAttachment({
  contentType,
  name,
  isVoice = false,
}: { contentType?: string | null; name?: string | null; isVoice?: boolean } = {}): string {
  if (isVoice) return 'voice';
  const type = String(contentType ?? '').toLowerCase();
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  const ext = extOf(name);
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  return 'file';
}

/**
 * Whether `url` is on a GIF site (tenor, giphy, klipy -- a page or one of
 * their media hosts). False for an unparsable URL.
 */
export function isGifHostUrl(url: string): boolean {
  return GIF_HOST_RE.test(siteOf(url ?? ''));
}

/**
 * A stable cache key for a link/embed thumbnail: `link:<sha1 prefix of the
 * URL without its query string>`. A signed media-proxy URL (or any
 * re-fetched embed) carries a query string that changes between fetches of
 * the very same picture; the origin+path does not, so it is dropped before
 * hashing. Deterministic and pure (no I/O) -- see emojiUrl for the
 * same "rebuild an id from stable inputs" idea.
 */
export function linkThumbnailCacheKey(url: string): string {
  let base = String(url ?? '');
  try {
    const parsed = new URL(base);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // An unparsable URL still hashes to something stable -- best effort.
  }
  return `link:${createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

/** `m:ss`, floored/rounded to the nearest second, never negative. */
export function formatDurationShort(seconds: unknown): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** A pixel dimension as a positive finite number, else null. */
export function positiveDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The media-proxy `width`/`height` pair for a picture of known size: the
 * proxy FILLS the box it is given and centre-crops to it, and ignores a lone
 * `width` or `height`, so the only way to resize without cropping is a box of
 * the picture's own aspect. Scales so that the longer side is at most `max`
 * (rounded to integers, each side at least 1), never upscales (a picture
 * already within `max` keeps its size). Null when either dimension is
 * unknown or not positive, or `max` is not positive: the caller then sends
 * no size at all and the original is served. Pure.
 */
export function fitBox(
  width: number | null | undefined,
  height: number | null | undefined,
  max: number | undefined
): { width: number; height: number } | null {
  const w = positiveDimension(width);
  const h = positiveDimension(height);
  const limit = positiveDimension(max);
  if (w === null || h === null || limit === null) return null;
  const scale = Math.min(1, limit / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * `m:ss` for a known duration, or `unknownDuration` when `durationSec` is
 * null/undefined -- a platform's own duration is usually present on a
 * video/voice/audio attachment but can be missing; this must never silently
 * render as "0:00" for an unknown length.
 */
function durationOrUnknown(durationSec: number | null | undefined, unknownDuration: string): string {
  return durationSec == null ? unknownDuration : formatDurationShort(durationSec);
}

/**
 * The reason CODE of a not-watched video state: `'length' | 'size' | 'daily'`
 * for a `limit` state, `'error'` for an `error` state, `'pending'` for a
 * `pending` one (its watch had not finished when the request was built).
 * Label-free on purpose: src/format.ts swaps it for
 * `labels.transcript.videoReason[code]`.
 */
function videoReasonCode(video: VideoState): string {
  if (video.state === 'error' || video.state === 'pending') return video.state;
  return String(video.reason ?? '');
}

/**
 * The watched lengths a cached video summary (a media cache entry
 * `video:<item id>`) carries, for its video state: `watchedSeconds` (the
 * downloaded clip's length) and `totalSeconds` (a link's probed total
 * length), each only when it is a finite number -- an entry from before
 * either was stored gives `{}`. Pure.
 */
export function watchedLengths(entry: object | undefined): { watchedSeconds?: number; totalSeconds?: number } {
  const out: { watchedSeconds?: number; totalSeconds?: number } = {};
  for (const key of ['watchedSeconds', 'totalSeconds'] as const) {
    const value = (entry as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Whether a watched video was seen only in part: its total length
 * `durationSec` and the watched clip's `watchedSeconds` are both known and
 * the total is longer by at least a whole second (both rounded as m:ss shows them).
 */
function watchedPart(durationSec: unknown, watchedSeconds: unknown): boolean {
  const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return known(durationSec) && known(watchedSeconds) && Math.round(durationSec) > Math.round(watchedSeconds);
}

/**
 * The ONE video extra tag of a `link` item with a video state: `linkWatched`
 * when the video was watched -- `linkWatchedPart` when the state's
 * `watchedSeconds` is shorter than its total (`video.totalSeconds`, else the
 * item's `durationSec`), with `{ duration, watched }` as m:ss and the reason
 * code `'clip'` --, else `linkNotWatchedFrame` when a thumbnail caption
 * exists, else `linkNotWatched`.
 */
function linkVideoExtra(video: VideoState, description: string | null, item: MediaItem): LabelTag {
  if (video.state === 'watched') {
    const total = video.totalSeconds ?? item?.durationSec;
    if (watchedPart(total, video.watchedSeconds)) {
      return {
        key: 'linkWatchedPart',
        values: {
          duration: formatDurationShort(total),
          watched: formatDurationShort(video.watchedSeconds),
          reason: 'clip',
          text: video.text ?? '',
        },
      };
    }
    return { key: 'linkWatched', values: { text: video.text ?? '' } };
  }
  const reason = videoReasonCode(video);
  return description
    ? { key: 'linkNotWatchedFrame', values: { reason, text: description } }
    : { key: 'linkNotWatched', values: { reason } };
}

/**
 * The `videoAnswered` extra of a watched video that got a second look on a
 * question (`video.answer = { question, text }`), else null.
 */
function answeredExtra(video: VideoState | null): LabelTag | null {
  if (video?.state !== 'watched' || !video.answer) return null;
  return { key: 'videoAnswered', values: { question: video.answer.question ?? '', text: video.answer.text ?? '' } };
}

/**
 * The `imageAnswered` extra of a picture that got a second look on a
 * question (`answer = { question, text }`, src/memory/describe.ts#relookImage), else null.
 */
function imageAnsweredExtra(answer: Answer | null): LabelTag | null {
  if (!answer) return null;
  return { key: 'imageAnswered', values: { question: answer.question ?? '', text: answer.text ?? '' } };
}

/**
 * The `videoAnswered` extra of a GIF that got a second look on a question
 * (`answer = { question, text }`, src/memory/describe.ts#rewatchGif: its clip
 * watched again, as a video's), else null.
 */
function gifAnsweredExtra(answer: Answer | null): LabelTag | null {
  if (!answer) return null;
  return { key: 'videoAnswered', values: { question: answer.question ?? '', text: answer.text ?? '' } };
}

/** `base` with `extra` (an extraOf result) added when there is one. */
function withExtra(base: LabelTag, extra: LabelTag | Array<LabelTag> | undefined): Label {
  return extra ? { ...base, extra } : base;
}

/** `extras` without the nulls: none -> undefined, one -> that tag, more -> the array. */
function extraOf(...extras: Array<LabelTag | Array<LabelTag> | null>): LabelTag | Array<LabelTag> | undefined {
  const kept = extras.flatMap((extra) => (Array.isArray(extra) ? extra : extra ? [extra] : []));
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : kept;
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one media
 * item, in priority order: described (the `vision` caption, the only way a
 * picture reaches the persona) > blind. `item` is a normalized attachment or
 * link/embed item (src/protocol/events.ts#Message): `{ kind, name?, site?,
 * title?, text?, durationSec?, previewText? }`.
 *
 * A plain image renders as `imageDescribed` when a caption exists, else the
 * blind `image`; a video or gif as `video`/`videoDescribed`/`gif`/`gifDescribed`
 * (so the persona still knows it WAS a video, its name, its duration). A `link`
 * (a video-site embed, e.g. YouTube) never swaps its own tag: the plain
 * `link`/`linkText` form always stays, and ONE extra tag follows it —
 * `thumbnailDescribed` when a caption exists, else nothing.
 *
 * `context.video` is the item's video state (see collectVideos and the video
 * describer): `{ state: 'watched', text }`, `{ state: 'limit', reason:
 * 'length'|'size'|'daily' }`, `{ state: 'error' }` or `{ state: 'pending' }`
 * (the turn's watch missed its deadline, see lateVideoStates); null keeps the
 * still-frame behaviour above. A `video` item that was watched renders
 * `videoWatched`, or `videoWatchedPart` when the state's `watchedSeconds` (the
 * downloaded clip's length) is shorter than the item's known `durationSec`
 * (`values.watched` its m:ss, `values.reason` the code `'clip'`, swapped by
 * src/format.ts for `transcript.videoPartReason.clip`); one not watched renders `videoNotWatchedFrame` (a still
 * frame caption exists) or `videoNotWatched`, `values.reason` carrying the
 * reason CODE (`'length'|'size'|'daily'|'error'|'pending'`, never a label -- see
 * src/format.ts). A `link` with a video state swaps its one extra for
 * `linkWatched` / `linkNotWatchedFrame` / `linkNotWatched`. A watched video (attachment or link) whose state
 * carries `answer: { question, text }` (a second look on a question, see
 * src/memory/describe.ts#rewatchVideo) appends `videoAnswered` after every
 * other tag of the item. Every other kind ignores `context.video`.
 *
 * `context.read` is the excerpt of a `link` page read by the web lookup
 * (src/web/lookup.ts#readLinks): it appends `linkRead` after every other extra
 * of the link (the video extra, videoAnswered or thumbnailDescribed). Every
 * other kind ignores it.
 *
 * `context.gifHandle` is the library handle (`g12`, see
 * src/memory/gifs.ts#gifHandleOf) of a `gif` item the persona can post
 * back: it renders `gifKnown` (`{ id, text }`) when a caption exists, else
 * `gifKnownNoText` (`{ id, name }`), in place of `gifDescribed`/`gif` (with
 * those keys blanked in prompts.local/labels.json, src/format.ts
 * falls back to them). Every other kind ignores it.
 *
 * `context.gifFields` is that GIF's three caption fields (`{ reaction,
 * action, screen }`, already cut for display, see
 * src/behavior/prompt.ts#gifFieldsMap): a `gif` item with a handle and a
 * caption whose `reaction` or `screen` is non-empty renders `gifKnownFields`
 * (`{ id, text, reaction, action, screen }`, `text` being the caption
 * gifKnown would show) in place of `gifKnown`; with that key blanked
 * src/format.ts falls back to `gifKnown`. A GIF without a handle
 * ignores it (`gifDescribed` keeps the caption alone).
 *
 * `context.answer` is a picture's second look on a question (`{ question,
 * text }`, src/memory/describe.ts#relookImage): an `image` item appends
 * `imageAnswered` after its own tag. A `gif` item takes a GIF's
 * second look the same way (src/memory/describe.ts#rewatchGif) and appends
 * `videoAnswered` instead: its clip was watched again, as a video's. Every
 * other kind ignores it (a video's answer lives in its state, `context.video.answer`).
 */
export function mediaLabelFor(
  item: MediaItem,
  {
    description = null,
    unknownDuration = '?',
    video = null,
    read = null,
    gifHandle = null,
    gifFields = null,
    answer = null,
  }: {
    description?: string | null;
    unknownDuration?: string;
    video?: VideoState | null;
    read?: string | null;
    gifHandle?: string | null;
    gifFields?: { reaction?: string; action?: string; screen?: string } | null;
    answer?: Answer | null;
  } = {}
): Label {
  switch (item.kind) {
    case 'image': {
      const base: LabelTag = description
        ? { key: 'imageDescribed', values: { text: description } }
        : { key: 'image', values: {} };
      return withExtra(base, extraOf(imageAnsweredExtra(answer)));
    }
    case 'gif': {
      const name = item.name || item.title || item.site || '';
      const answered = extraOf(gifAnsweredExtra(answer));
      if (gifHandle) {
        const field = (value: unknown): string => (typeof value === 'string' ? value : '');
        const reaction = field(gifFields?.reaction);
        const screen = field(gifFields?.screen);
        const known: LabelTag =
          description && (reaction || screen)
            ? {
                key: 'gifKnownFields',
                values: { id: gifHandle, text: description, reaction, action: field(gifFields?.action), screen },
              }
            : description
              ? { key: 'gifKnown', values: { id: gifHandle, text: description } }
              : { key: 'gifKnownNoText', values: { id: gifHandle, name } };
        return withExtra(known, answered);
      }
      return withExtra(
        description ? { key: 'gifDescribed', values: { text: description } } : { key: 'gif', values: { name } },
        answered
      );
    }
    case 'video': {
      const name = item.name ?? '';
      const duration = durationOrUnknown(item.durationSec, unknownDuration);
      if (video?.state === 'watched') {
        const watched: LabelTag = watchedPart(item.durationSec, video.watchedSeconds)
          ? {
              key: 'videoWatchedPart',
              values: {
                name,
                duration,
                watched: formatDurationShort(video.watchedSeconds),
                reason: 'clip',
                text: video.text ?? '',
              },
            }
          : { key: 'videoWatched', values: { name, duration, text: video.text ?? '' } };
        const extra = extraOf(answeredExtra(video));
        return extra ? { ...watched, extra } : watched;
      }
      if (video) {
        const reason = videoReasonCode(video);
        return description
          ? { key: 'videoNotWatchedFrame', values: { name, duration, reason, text: description } }
          : { key: 'videoNotWatched', values: { name, duration, reason } };
      }
      return description
        ? { key: 'videoDescribed', values: { name, duration, text: description } }
        : { key: 'video', values: { name, duration } };
    }
    case 'voice': {
      const duration = durationOrUnknown(item.durationSec, unknownDuration);
      return description
        ? { key: 'voiceDescribed', values: { duration, text: description } }
        : { key: 'voice', values: { duration } };
    }
    case 'audio': {
      const values = { name: item.name ?? '', duration: durationOrUnknown(item.durationSec, unknownDuration) };
      return description
        ? { key: 'audioDescribed', values: { ...values, text: description } }
        : { key: 'audio', values };
    }
    case 'text':
      return item.previewText
        ? { key: 'filePreview', values: { name: item.name ?? '', text: item.previewText } }
        : { key: 'file', values: { name: item.name ?? '' } };
    case 'link': {
      const base: LabelTag = item.text
        ? { key: 'linkText', values: { site: item.site ?? '', title: item.title ?? '', text: item.text } }
        : { key: 'link', values: { site: item.site ?? '', title: item.title ?? '' } };
      const readExtra = read ? { key: 'linkRead', values: { text: read } } : null;
      if (video) {
        const videoExtra = linkVideoExtra(video, description, item);
        return { ...base, extra: extraOf(videoExtra, answeredExtra(video), readExtra) };
      }
      const thumbnail = description ? { key: 'thumbnailDescribed', values: { text: description } } : null;
      const extra = extraOf(thumbnail, readExtra);
      return extra ? { ...base, extra } : base;
    }
    default:
      return { key: 'fileUnreadable', values: { name: safeFileName(item.name ?? '') } };
  }
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one
 * sticker item, mirroring `mediaLabelFor`'s priority for the picture-format
 * ones (PNG/APNG/GIF -- the adapter sets `sticker.url`): described >
 * blind (plain `sticker`, name only). A Lottie sticker (`sticker.url` is
 * null) is never a picture: always the `stickerUnreadable` form, regardless of
 * `description` -- see `senses.lottie`.
 */
export function stickerLabelFor(
  sticker: { name: string; url: string | null },
  { description = null }: { description?: string | null } = {}
): LabelTag {
  if (!sticker.url) return { key: 'stickerUnreadable', values: { name: sticker.name } };
  return description
    ? { key: 'stickerDescribed', values: { name: sticker.name, text: description } }
    : { key: 'sticker', values: { name: sticker.name } };
}

/**
 * The parts of one normalized message that carry media, in the order they
 * appear in it: the message itself, then every forwarded snapshot
 * (`message.forwarded`, src/protocol/events.ts#Message). A
 * snapshot has no id of its own, so each collector below stamps its items
 * with the OUTER message's id -- the one the history and the transcript
 * know. Item ids stay unique: attachment ids are
 * the platform's ids, link ids are cache keys or built from the original
 * message id. Shared with the analyzer and the GIF library, which walk the
 * same parts.
 * @param message A normalized (or slim buffered) message.
 */
export function mediaParts(message: object): Array<MediaPart & { id?: string }> {
  const given = asMediaMessage(message);
  return [given, ...(Array.isArray(given.forwarded) ? given.forwarded : [])];
}

/**
 * The `previewUrl` of an attachment or a link as a field of a picture item, or nothing: the address the adapter sized
 * the picture at, for the describer.
 */
function previewField(item: unknown): { previewUrl?: string } {
  const url = (item as { previewUrl?: unknown } | null | undefined)?.previewUrl;
  return typeof url === 'string' && url !== '' ? { previewUrl: url } : {};
}

/** One picture of a message, as `collectPictures` and `collectEmojiItems` list it. */
export type PictureItem = {
  source: 'attachment' | 'embed' | 'sticker';
  messageId: string;
  itemId: string;
  kind: string;
  url: string;
  name: string | undefined;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  previewUrl?: string;
  animationUrl?: string;
};

/** One custom emoji of a message's text as a describable item (`collectEmojiItems`). */
export type EmojiItem = {
  source: 'emoji';
  messageId: string;
  itemId: string;
  kind: 'emoji';
  url: string;
  name: string;
};

/** One video candidate of a message, as `collectVideos` lists it. */
export type VideoItem = {
  source: 'attachment' | 'link';
  messageId: string;
  itemId: string;
  kind: 'video' | 'link';
  url: string;
  name: string | undefined;
  durationSec: number | null | undefined;
  bytes?: number;
  site?: string;
};

/** The pictures of one message part (the message or one snapshot), see collectPictures. */
function partPictures(part: MediaPart, messageId: string): Array<PictureItem> {
  const items: Array<PictureItem> = [];
  for (const attachment of part.attachments ?? []) {
    if (!PICTURE_ATTACHMENT_KINDS.has(String(attachment.kind))) continue;
    items.push({
      source: 'attachment',
      messageId,
      itemId: attachment.id,
      kind: attachment.kind,
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      // The address the adapter sized the picture at, for the describer; absent: `url` is downloaded as it is.
      ...previewField(attachment),
    });
  }
  (part.links ?? []).forEach((link) => {
    if (!link.thumbnailUrl) return;
    items.push({
      source: 'embed',
      messageId,
      itemId: link.id,
      kind: link.kind,
      url: link.thumbnailUrl,
      name: link.title || link.site,
      width: link.thumbnailWidth ?? null,
      height: link.thumbnailHeight ?? null,
      ...previewField(link),
      // A gif embed's animation (see classifyEmbed), for the GIF watch.
      ...(link.kind === 'gif' && link.animationUrl ? { animationUrl: link.animationUrl } : {}),
    });
  });
  for (const sticker of part.stickers ?? []) {
    if (!sticker.url) continue; // Lottie: name only, never a picture
    items.push({
      source: 'sticker',
      messageId,
      itemId: `sticker:${sticker.id}`,
      kind: 'sticker',
      url: sticker.url,
      name: sticker.name,
    });
  }
  return items;
}

/**
 * Every "picture" of one normalized message, in the order they appear in it
 * (attachments first, then embeds/links, then a picture-format sticker; the
 * message's own first, then each forwarded snapshot's the same way): an
 * image/gif/video attachment, any embed carrying a thumbnail (gif or link
 * kind alike), or a PNG/APNG/GIF sticker (never a Lottie one -- `sticker.url`
 * is null for those, the adapter decides). Each item is stamped with a stable
 * `itemId` (the attachment's platform id; for an embed, the link's own id from
 * the interface package: `video:url:<hash>` for a video-site link,
 * `link:<hash>` for another link with a thumbnail, the message+embed-index
 * for a gif embed; or `sticker:<id>`) so it can be looked up in a
 * vision-selection or description-cache map, and with the outer message's
 * `messageId` (a
 * forwarded snapshot's item included). A gif embed's item also carries its
 * `animationUrl` when the embed has one (see classifyEmbed): the file the
 * GIF watch downloads, while `url` stays the still thumbnail. Custom emoji are never included here
 * -- see collectEmojiItems: they are never eligible to be attached as a vision
 * picture, only describable.
 * @param message A normalized message (src/protocol/events.ts#Message).
 */
export function collectPictures(message: object): Array<PictureItem> {
  const { id } = asMediaMessage(message);
  return mediaParts(message).flatMap((part) => partPictures(part, id));
}

/**
 * Every custom emoji written in one normalized message's text (see
 * src/protocol/events.ts#Message), the message's own first, then each forwarded
 * snapshot's, as a describable item, kept apart from collectPictures on
 * purpose (an emoji is not a picture of the chat: it is described once, see
 * docs/prompt-contract.md).
 * @param message A normalized message (src/protocol/events.ts#Message).
 */
export function collectEmojiItems(message: object): Array<EmojiItem> {
  const { id } = asMediaMessage(message);
  return mediaParts(message).flatMap((part) =>
    (part.emojis ?? []).map((emoji): EmojiItem => ({
      source: 'emoji',
      messageId: id,
      itemId: `emoji:${emoji.id}`,
      kind: 'emoji',
      url: emoji.url,
      name: emoji.name,
    }))
  );
}

/** One voice message or audio file of a message, as `collectAudio` lists it. */
export type AudioItem = {
  source: 'attachment';
  messageId: string;
  itemId: string;
  kind: string;
  url: string;
  name: string | undefined;
  durationSec: number | null | undefined;
};

/**
 * The voice messages and audio files of one normalized message, the message's own first, then each forwarded snapshot's, for
 * the describer. Kept apart from collectPictures so an audio file is never offered to a model's vision.
 */
export function collectAudio(message: object): Array<AudioItem> {
  const { id } = asMediaMessage(message);
  return mediaParts(message).flatMap((part) =>
    (part.attachments ?? [])
      .filter((attachment) => AUDIO_KINDS.has(attachment.kind))
      .map((attachment): AudioItem => ({
        source: 'attachment',
        messageId: id,
        itemId: attachment.id,
        kind: attachment.kind,
        url: attachment.url,
        name: attachment.name,
        durationSec: attachment.durationSec,
      }))
  );
}

/** One text file of a message, for the describer: its text form is its own words. */
export function collectTextFiles(message: object): Array<AudioItem> {
  const { id } = asMediaMessage(message);
  return mediaParts(message).flatMap((part) =>
    (part.attachments ?? [])
      .filter((attachment) => attachment.kind === 'text')
      .map((attachment): AudioItem => ({
        source: 'attachment',
        messageId: id,
        itemId: attachment.id,
        kind: 'text',
        url: attachment.url,
        name: attachment.name,
        durationSec: null,
      }))
  );
}

/** The video candidates of one message part (the message or one snapshot), see collectVideos. */
function partVideos(
  part: MediaPart,
  messageId: string,
  videoSites: ReadonlyArray<string> | undefined
): Array<VideoItem> {
  const items: Array<VideoItem> = [];
  for (const attachment of part.attachments ?? []) {
    if (attachment.kind !== 'video') continue;
    items.push({
      source: 'attachment',
      messageId,
      itemId: attachment.id,
      kind: 'video',
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
      bytes: attachment.size,
    });
  }
  if (!Array.isArray(videoSites) || videoSites.length === 0) return items;
  for (const link of part.links ?? []) {
    if (!link.url) continue;
    const site = videoSiteFor(link.url, videoSites);
    if (!site) continue;
    items.push({
      source: 'link',
      messageId,
      itemId: link.id,
      kind: 'link',
      url: link.url,
      site,
      name: link.title || link.site,
      durationSec: null,
    });
  }
  return items;
}

/**
 * The video candidates of one normalized message (src/protocol/events.ts#Message),
 * in the order they appear in it: every attachment of kind `video`, then every
 * link whose `url` belongs to one of `videoSites` (see videoSiteFor in
 * src/media/video-sites.ts) -- the message's own first, then each forwarded
 * snapshot's the same way, all stamped with the outer message's `messageId`.
 * `itemId` is the id the transcript's `videos`
 * state map is keyed by (the attachment's platform id, or the link's id).
 * `videoSites` missing or empty -> attachments only.
 * @param message A normalized message (src/protocol/events.ts#Message).
 */
export function collectVideos(
  message: object,
  { videoSites = [] }: { videoSites?: ReadonlyArray<string> } = {}
): Array<VideoItem> {
  const { id } = asMediaMessage(message);
  return mediaParts(message).flatMap((part) => partVideos(part, id, videoSites));
}

/**
 * The video states of a turn whose video stage missed its deadline, in the
 * shape of describeVideos' `videos` (src/memory/describe.ts): every state
 * `known` holds (the describer's cache) is kept, and the first `maxNew`
 * candidates it lacks -- the ones the stage was watching or had yet to
 * start, as describeVideos picks them -- become `{ state: 'pending' }`, so
 * the transcript says they were not watched rather than showing a bare
 * still frame. The candidates past `maxNew` are left out, as a finished
 * stage would leave them.
 * @param candidates collectVideos candidates, in the stage's order.
 * @param known itemId -> cached video state.
 * @param maxNew The stage's media.video.maxPerTurn.
 */
export function lateVideoStates(
  candidates: Array<{ itemId: string }>,
  known: Map<string, object> | null | undefined,
  maxNew: number
): Map<string, object> {
  const states = new Map();
  let pending = 0;
  for (const item of candidates) {
    const state = known?.get(item.itemId);
    if (state) states.set(item.itemId, state);
    else if (pending < maxNew) {
      states.set(item.itemId, { state: 'pending' });
      pending += 1;
    }
  }
  return states;
}

/**
 * The links of one normalized message (src/protocol/events.ts#Message) the web
 * lookup may read (src/web/lookup.ts#readLinks), in the order they appear in
 * it (the message's own first, then each forwarded snapshot's, all stamped
 * with the outer message's `messageId`): every `link` item with a url, minus
 * the ones on a video site of
 * `videoSites` (the video describer's, see collectVideos) and every gif embed.
 * `videoSites` missing or empty -> no link is excluded as a video.
 * @param message A normalized message (src/protocol/events.ts#Message).
 */
export function collectReadableLinks(
  message: object,
  { videoSites = [] }: { videoSites?: ReadonlyArray<string> } = {}
): Array<{ id: string; messageId: string; url: string; site: string; title: string }> {
  const { id } = asMediaMessage(message);
  const items = [];
  for (const part of mediaParts(message)) {
    for (const link of part.links ?? []) {
      if (link?.kind !== 'link' || !link.url || !link.id) continue;
      if (Array.isArray(videoSites) && videoSites.length > 0 && videoSiteFor(link.url, videoSites)) continue;
      items.push({ id: link.id, messageId: id, url: link.url, site: link.site ?? '', title: link.title ?? '' });
    }
  }
  return items;
}

/** Whether a picture item (see collectPictures/collectEmojiItems) is one the describer can caption. */
export function isDescribable(item: unknown): boolean {
  return DESCRIBABLE_KINDS.has(objOf(item).kind);
}
