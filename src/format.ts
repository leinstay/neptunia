// Pure text formatting of normalized messages (see normalizeMessage in
// collect.js) into the transcript the model reads. No platform SDK imports here,
// so everything is unit-testable. Every word that ends up in the prompt comes
// from `labels` (see prompts/labels.json and docs/prompt-contract.md);
// this module only knows the shape of a transcript line, e.g.:
//   #87 [14:32] nick: text (replyTo marker) [image]
//   #12 [13:43 · 2 h 58 min ago] nick: text   (chat mode, an old line with its age)
//   #90 [14:33] self (triggeredBy marker): text   (the persona's line, the turn's trigger)
//   #91 [14:34] self: text [called marker]        (a skill call of the turn that posted it)
//   [14:35] self: [called marker]                 (a call of a turn that posted nothing here)
//   --- {duration} passed ---
// Time gaps and date changes are spelled out because the model must tell a
// live chat from a dead chat that somebody has just poked.

import { reasonText } from './tools/codes.ts';
import { objOf } from './tools/types.ts';
import { clipWithEllipsis, mediaLabelFor, stickerLabelFor } from './media/classify.ts';
import { gifHandleOf } from './memory/index.ts';
import type { CallMark } from './behavior/lines.ts';
import { MINUTE_MS, HOUR_MS, DAY_MS } from './time.ts';
import { clampText, clampWithEllipsis, oneLine } from './memory/clamp.ts';
import { isWordChar, outsideUrls } from './memory/mentions.ts';
import { untaggedNames, withUserHandles } from './handles-text.ts';
import { LINK_EXCERPT_CHARS } from './web/cache.ts';
// A parsed JSON value or an argument no module types yet: the alias of src/tools/types.ts, restated so this leaf
// imports nothing from src/tools/ (src/memory/ reaches it).
type Untyped = ReturnType<typeof JSON.parse>;

// The transcript's measures. Production values, config cut of 2026-10-31.
/** How much of a reply's parent its line quotes. */
const DEFAULT_REPLY_QUOTE_CHARS = 80;
/** A silence longer than this many minutes gets a gap marker. */
export const GAP_MARKER_MINUTES = 20;
/** Characters of one message's text in a transcript. */
export const MAX_MESSAGE_CHARS = 2000;

// A language-neutral marker (memory transcript only) for a message addressed
// to the persona, so the analyzer can weigh "how people talk TO it" apart
// from general chatter. See docs/prompt-contract.md, "The analyzer".
const DIRECT_MARKER = '→ '; // "→ "

// A value no real placeId can equal, so the very first message of a memory
// transcript always opens with a channel heading (see formatTranscript).
const NO_CHANNEL = Symbol('no-channel');

const formatters = new Map();

function formatter(timezone: Untyped, locale: Untyped, options: Untyped) {
  const key = `${timezone}|${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options }));
  }
  return formatters.get(key);
}

/**
 * Fill `{key}` placeholders in a label template with `values[key]`. Unknown
 * keys are left untouched (e.g. a typo in a deployment's labels.json does not
 * silently swallow text); a missing/empty template returns ''.
 */
export function fill(template: string, values: Record<string, Untyped> = {}): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : all));
}

// A field slot of a GIF's three-field label (labels.gifs.entryFields,
// transcript.gifKnownFields): the placeholder with the quote or bracket that
// hugs it in the label, if any (`"{text}"`, `({reaction})`).
const GIF_FIELD_SLOT = /(["'«“„‘([]?)\{(reaction|action|text|screen)\}(["'»”“’)\]]?)/g;

/**
 * `template` (labels.gifs.entryFields in the `<gifs>` list,
 * transcript.gifKnownFields in the transcript) filled with `id` and the
 * non-empty `fields`: an empty or absent field leaves out its slot (the
 * placeholder with any quote or bracket hugging it) together with the label
 * text that separates it from the previous kept field -- the first kept field
 * takes no separator -- so no dangling separator or empty quotes remain. The
 * text before the first slot and after the last one is kept as written. Field
 * values are inserted as they are (a brace in a caption is never read as a
 * placeholder). The one copy for both labels. Pure.
 */
export function fillGifFields(template: string, id: string, fields: Record<string, string | undefined>): string {
  const slots = [...template.matchAll(GIF_FIELD_SLOT)];
  if (slots.length === 0) return fill(template, { id });
  const endOf = (slot: Untyped) => slot.index + slot[0].length;
  let out = fill(template.slice(0, slots[0].index), { id });
  let kept = 0;
  for (const [i, slot] of slots.entries()) {
    const value = Object.hasOwn(fields, slot[2]) ? fields[slot[2]] : '';
    if (!value) continue;
    if (kept > 0) out += fill(template.slice(endOf(slots[i - 1]), slot.index), { id });
    out += `${slot[1]}${value}${slot[3]}`;
    kept += 1;
  }
  return out + fill(template.slice(endOf(slots.at(-1))), { id });
}

/**
 * Wall-clock time of `ts` in `timezone`, 24-hour `HH:MM` as `locale` writes it.
 * @param ts  epoch milliseconds
 * @param timezone  IANA zone name
 */
export function formatClock(ts: number, timezone: string, locale: string = 'en-US'): string {
  return formatter(timezone, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

/**
 * The date of `ts` in `timezone`: short weekday, day and month name in
 * `locale` (the transcript's date and gap markers).
 * @param ts  epoch milliseconds
 * @param timezone  IANA zone
 */
export function formatDate(ts: number, timezone: string, locale: string = 'en-US'): string {
  return formatter(timezone, locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
}

/**
 * The full "now" of `ts` in `timezone`: long weekday, day, month and year in
 * `locale`, then the clock (formatClock) and the zone name in parentheses.
 * @param ts  epoch milliseconds
 * @param timezone  IANA zone
 */
export function formatNow(ts: number, timezone: string, locale: string = 'en-US'): string {
  const date = formatter(timezone, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    ts
  );
  return `${date}, ${formatClock(ts, timezone, locale)} (${timezone})`;
}

/** Local hour 0-23 in the given timezone. Locale-independent by design. */
export function localHour(ts: Untyped, timezone: Untyped): number {
  return Number(formatter(timezone, 'en-US', { hour: 'numeric', hourCycle: 'h23' }).format(ts)) % 24;
}

/**
 * Coarse, human-scale duration, e.g. "5 min", "3 h 12 min", "2 d 4 h". Rounds
 * to the nearest minute/hour and rolls the result over into the next unit
 * rather than ever printing "60 min" or "24 h".
 */
export function formatDuration(
  ms: number,
  units: { lessThanMinute: string; minute: string; hour: string; day: string }
): string {
  if (ms < MINUTE_MS) return units.lessThanMinute;

  if (ms < HOUR_MS) {
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes >= 60) return `1 ${units.hour}`;
    return `${minutes} ${units.minute}`;
  }

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    let minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
    let wholeHours = hours;
    if (minutes >= 60) {
      wholeHours += 1;
      minutes = 0;
    }
    if (wholeHours >= 24) return `1 ${units.day}`;
    return minutes ? `${wholeHours} ${units.hour} ${minutes} ${units.minute}` : `${wholeHours} ${units.hour}`;
  }

  const days = Math.floor(ms / DAY_MS);
  let hours = Math.round((ms - days * DAY_MS) / HOUR_MS);
  let wholeDays = days;
  if (hours >= 24) {
    wholeDays += 1;
    hours = 0;
  }
  return hours ? `${wholeDays} ${units.day} ${hours} ${units.hour}` : `${wholeDays} ${units.day}`;
}

/**
 * One rendered tag per attachment/embed/sticker of `message`, most
 * informative form available (see docs/prompt-contract.md, "Media in
 * a transcript line" and src/media/classify.js#mediaLabelFor/stickerLabelFor):
 * described > blind, plus one extra tag per distinct described custom emoji
 * unless `context.emojiInline` is false (the request describes them once
 * elsewhere). `context.descriptions` is an optional `Map` keyed by the item's id (an
 * attachment's platform id, a link's synthesized id, `sticker:<id>` or
 * `emoji:<id>` — see normalizeMessage). `context.videos` is an optional
 * `Map` of the same ids to a video state (see mediaLabelFor); it only takes
 * effect when the labels carry `transcript.videoWatched` (a key blanked in
 * prompts.local/labels.json switches this form off); a video watched only in
 * part renders `transcript.videoWatchedPart` (a link `transcript.linkWatchedPart`;
 * the reason from `transcript.videoPartReason`), or `videoWatched` / `linkWatched`
 * with that key blanked; a video state's
 * `answer` (a second look on a question) likewise needs
 * `transcript.videoAnswered`. `context.reads` is an optional `Map` of link
 * ids to the excerpt the web lookup read from that page (src/web/lookup.js);
 * it needs `transcript.linkRead`, blanked the same way to switch it off.
 * `context.imageAnswers` is an optional `Map` of picture ids to a second look
 * on a question (`{ question, text }`, src/memory/describe.js#relookImage);
 * it needs `transcript.imageAnswered`, blanked the same way to switch it off.
 * A GIF's id may carry one too (src/memory/describe.js#rewatchGif): it
 * renders `transcript.videoAnswered` and needs that key instead.
 * `context.gifHandles` is an optional `Map` from src/memory/gifs.js#gifHandleMap:
 * a GIF (attachment or embed) the library knows renders `transcript.gifKnown` /
 * `gifKnownNoText` with its handle; with the key in question blanked it
 * renders `gifDescribed` / `gif` instead. `context.gifFields` is an optional
 * read by GIF id of their three caption fields (`{ reaction, action, screen }`,
 * cut for display, src/turn/request/emoji-gifs.ts#gifFieldsLookup): such a GIF with a
 * handle and a non-empty reaction or on-screen text renders
 * `transcript.gifKnownFields` (fillGifFields: an empty field leaves out its
 * separator); with that key blanked it renders `gifKnown` instead.
 */
// The part-watched forms: their reason code reads labels.transcript.videoPartReason.
const PART_KEYS = new Set(['videoWatchedPart', 'linkWatchedPart']);
// A form with a blank label (a deployment's labels.json from before it, or one switching it off) renders its plain form.
const PLAIN_FORM: Record<string, string> = {
  voiceDescribed: 'voice',
  audioDescribed: 'audio',
  fileUnreadable: 'file',
  stickerUnreadable: 'sticker',
};

/** A tag in its plain form when its label is blank, or null for a form that has its label or no plain form. */
function plainTagOf(given: unknown, labels: unknown): object | null {
  const tag = given as { key?: unknown };
  const plain = typeof tag.key === 'string' ? PLAIN_FORM[tag.key] : undefined;
  const transcript = (labels as { transcript?: Record<string, unknown> }).transcript;
  return plain && !transcript?.[tag.key as string] ? { ...tag, key: plain } : null;
}

/** The text form a stored line carries on its item (src/memory/db/media-store.ts#mediaMessageParts), or null. */
function toldOf(item: unknown): { text: string; origin: unknown } | null {
  const told = (item as { told?: { text?: unknown; origin?: unknown } } | null)?.told;
  return typeof told?.text === 'string' ? { text: told.text, origin: told.origin } : null;
}

/** A stored video told by its watched summary, as a state of the renderer. */
function storedWatch(item: unknown, videosOn: boolean): { state: 'watched'; text: string } | null {
  const told = toldOf(item);
  const isVideo = (item as { kind?: unknown } | null)?.kind === 'video';
  return videosOn && isVideo && told?.origin === 'retelling' ? { state: 'watched', text: told.text } : null;
}

/** Whether an emoji comes from a stored line: it shows that the line holds it even before its text form. */
const isStoredEmoji = (emoji: unknown): boolean => (emoji as { stored?: unknown } | null)?.stored === true;

/** A link's read text as a line of chat shows it: a link she read with web.read holds up to a whole page, and a line shows what a preview shows. */
function excerptOf(whole: string | undefined): string | null {
  return whole === undefined ? null : clampText(oneLine(whole), LINK_EXCERPT_CHARS, { tolerance: 1 });
}

/** A part-watched tag whose label is blank, as its whole-video form; any other tag as it is. */
function partFallback(tag: Untyped, labels: Untyped) {
  const plain = plainTagOf(tag, labels);
  if (plain) return plain;
  if (PART_KEYS.has(tag.key) && !labels.transcript[tag.key]) {
    return tag.key === 'videoWatchedPart'
      ? { key: 'videoWatched', values: { name: tag.values.name, duration: tag.values.duration, text: tag.values.text } }
      : { key: 'linkWatched', values: { text: tag.values.text } };
  }
  return tag;
}

// health: allow complexity until 2027-04-01 -- one walk over every media field of a line; a stored item only adds its own text form
function mediaTags(message: Untyped, labels: Untyped, context: MediaContext = {}) {
  const unknownDuration = labels.transcript.unknownDuration ?? '?';
  const videosOn = Boolean(labels.transcript.videoWatched);
  // A second look's answer (videoAnswered): a key blanked in
  // prompts.local/labels.json switches this form off.
  const answersOn = Boolean(labels.transcript.videoAnswered);
  // A read page's excerpt (linkRead): blanking the key switches it off too.
  const readsOn = Boolean(labels.transcript.linkRead);
  // A picture's second look on a question (imageAnswered): blanking the key switches it off.
  // A GIF's (rewatchGif) renders as a video's (videoAnswered) and goes off with that key.
  const answerOf = (item: Untyped) => {
    const on = item.kind === 'gif' ? answersOn : Boolean(labels.transcript.imageAnswered);
    return on ? (context.imageAnswers?.get(item.id) ?? null) : null;
  };
  const videoOf = (id: Untyped) => {
    const video = videosOn ? (context.videos?.get(id) ?? null) : null;
    if (!video?.answer || answersOn) return video;
    const { answer, ...rest } = video;
    return rest;
  };
  const tags = [];
  // A video tag's `reason` is a code (media.js is label-free): swap it for
  // its label before filling -- a part-watched video's from videoPartReason.
  // A blank videoWatchedPart / linkWatchedPart falls back to the whole-video
  // videoWatched / linkWatched.
  const pushTag = (tag: Untyped) => {
    const { key, values } = partFallback(tag, labels);
    const reasons = PART_KEYS.has(key) ? labels.transcript.videoPartReason : labels.transcript.videoReason;
    const filled =
      values && Object.hasOwn(values as object, 'reason')
        ? { ...values, reason: reasons?.[values.reason] ?? '' }
        : values;
    // A library GIF's three caption fields drop an empty field with its separator.
    if (key === 'gifKnownFields') {
      const { id, reaction, action, screen } = values;
      tags.push(fillGifFields(labels.transcript.gifKnownFields, id, { reaction, action, screen }));
      return;
    }
    tags.push(fill(labels.transcript[key], filled));
  };
  const pushLabel = ({ key, values, extra }: { key: Untyped; values: Untyped; extra?: Untyped }) => {
    pushTag({ key, values });
    for (const tag of Array.isArray(extra) ? extra : extra ? [extra] : []) pushTag(tag);
  };
  // A library GIF's handle (gifKnown / gifKnownNoText): blanking the one
  // chosen switches it off, the plain GIF form renders instead.
  const handleOf = (item: Untyped, kind: Untyped) =>
    item.kind === 'gif' ? gifHandleOf(context.gifHandles, item, kind) : null;
  const gifFieldsOf = (item: Untyped) => (item.kind === 'gif' ? (context.gifFields?.get(item.id) ?? null) : null);
  const withGifFallback = (given: Untyped) => {
    // The three fields blanked: the one-line gifKnown, itself falling back below.
    const label =
      given.key === 'gifKnownFields' && !labels.transcript.gifKnownFields
        ? { ...given, key: 'gifKnown', values: { id: given.values.id, text: given.values.text } }
        : given;
    if (label.key === 'gifKnown' && !labels.transcript.gifKnown) {
      return { ...label, key: 'gifDescribed', values: { text: label.values.text } };
    }
    if (label.key === 'gifKnownNoText' && !labels.transcript.gifKnownNoText) {
      return { ...label, key: 'gif', values: { name: label.values.name } };
    }
    return label;
  };
  for (const attachment of message.attachments ?? []) {
    const description = context.descriptions?.get(attachment.id) ?? toldOf(attachment)?.text ?? null;
    const video = videoOf(attachment.id) ?? storedWatch(attachment, videosOn);
    const gifHandle = handleOf(attachment, 'attachment');
    const answer = answerOf(attachment);
    pushLabel(
      withGifFallback(
        mediaLabelFor(attachment, {
          description,
          unknownDuration,
          video,
          gifHandle,
          gifFields: gifFieldsOf(attachment),
          answer,
        })
      )
    );
  }
  for (const link of message.links ?? []) {
    // A plain 'link' (video-site preview) thumbnail description
    // (transcript.thumbnailDescribed): a key blanked in
    // prompts.local/labels.json switches this form off -- a 'gif' embed's
    // own description (gifDescribed) is a base contract key and is never
    // gated this way.
    const canDescribe = link.kind !== 'link' || Boolean(labels.transcript.thumbnailDescribed);
    const description = canDescribe ? (context.descriptions?.get(link.id) ?? null) : null;
    const read = readsOn ? excerptOf(context.reads?.get(link.id)) : null;
    const gifHandle = handleOf(link, 'link');
    const answer = answerOf(link);
    pushLabel(
      withGifFallback(
        mediaLabelFor(link, {
          description,
          unknownDuration,
          video: videoOf(link.id),
          read,
          gifHandle,
          gifFields: gifFieldsOf(link),
          answer,
        })
      )
    );
  }
  for (const sticker of message.stickers ?? []) {
    const description = labels.transcript.stickerDescribed
      ? (context.descriptions?.get(`sticker:${sticker.id}`) ?? toldOf(sticker)?.text ?? null)
      : null;
    // `url` is null for a sticker with no picture. A slim message keeps `url` too (src/memory/update.js#slimMessage), so a
    // memory transcript tells a picture sticker from one without exactly like a live chat transcript does.
    pushLabel(stickerLabelFor(sticker, { description }));
  }
  // `context.emojiInline === false`: the caller lists the emoji with their descriptions elsewhere, so the line keeps the
  // bare `:name:`.
  if (labels.transcript.emojiDescribed && context.emojiInline !== false) {
    for (const emoji of message.emojis ?? []) {
      const description = context.descriptions?.get(`emoji:${emoji.id}`) ?? toldOf(emoji)?.text ?? null;
      // A stored line shows that it holds the emoji even before its text form: a read has no message to look at.
      if (!description && !isStoredEmoji(emoji)) continue;
      tags.push(fill(labels.transcript.emojiDescribed, { name: emoji.name, text: description }));
    }
  }
  // A key blanked in prompts.local/labels.json (fill() returns '' for it)
  // must not leave a stray double space where that tag would have sat.
  return tags.filter(Boolean);
}

/** The tags of a stored line's media, for a reader that is not a transcript (the memory session's batch). */
export function storedMediaTags(parts: Record<string, unknown>, labels: unknown): Array<string> {
  return (labels as { transcript?: unknown } | null)?.transcript ? mediaTags(parts, labels) : [];
}

/**
 * The reactions tag of a message (`transcript.reactions` over at most `max`
 * items, `reactionMine` for the bot's own, else `reactionItem`), or '' when
 * the list is empty or the labels have no `transcript.reactions` key. The
 * items are joined with `transcript.reactionSeparator` (", " for a labels file
 * without it); names inside one item are joined with ", ". With
 * `names` (chat mode, features.reactionNames) a reaction on the persona's own
 * line whose `users` are known names them instead of counting them
 * (reactionNamesItem).
 */
function reactionsTag(
  message: Record<string, Untyped>,
  labels: Record<string, Untyped>,
  max: number,
  names: { max: number; nameOf: (user: Untyped) => string } | null = null
) {
  const template = labels.transcript.reactions;
  const reactions = Array.isArray(message.reactions) ? message.reactions.slice(0, Math.max(0, max)) : [];
  if (!template || reactions.length === 0) return '';
  const named =
    names &&
    message.self &&
    typeof labels.transcript.reactionNames === 'string' &&
    labels.transcript.reactionNames !== '';
  const list = reactions
    .map((reaction: Untyped) => {
      const { emoji, count, mine } = reaction;
      const item = named ? reactionNamesItem(reaction, labels, names) : '';
      if (item) return item;
      return fill(
        mine ? (labels.transcript.reactionMine ?? labels.transcript.reactionItem) : labels.transcript.reactionItem,
        { emoji, count }
      );
    })
    .filter(Boolean)
    .join(labels.transcript.reactionSeparator ?? ', ');
  return list ? fill(template, { list }) : '';
}

/**
 * One reaction on the persona's line by name: its known reactors (`users`), each named by
 * `names.nameOf` (the transcript's author form), at most `names.max` of them joined with ", ";
 * the members it counts beyond the names shown (more than `max`, or not known) add
 * `transcript.reactionMore` with `{n}`. When the persona reacted too, she is named after them
 * the way her own lines name her (`names.nameOf` with `self`: the `labels.self` form), before
 * the "+N". Rendered through `transcript.reactionNames` (`{emoji}`, `{names}`, `{count}`).
 * '' without known reactors (the caller counts it as before, `reactionMine` included).
 */
function reactionNamesItem(reaction: Untyped, labels: Untyped, names: Untyped) {
  const users = Array.isArray(reaction.users)
    ? reaction.users.filter((user: Untyped) => user && typeof user.name === 'string' && user.name !== '')
    : [];
  if (users.length === 0) return '';
  const count = Number(reaction.count);
  const others = Math.max(users.length, Number.isInteger(count) ? count - (reaction.mine ? 1 : 0) : 0);
  const max = Number.isInteger(names.max) && names.max > 0 ? names.max : users.length;
  const shown = users.slice(0, max).map((user: Untyped) => names.nameOf(user));
  const rest = others - shown.length;
  if (reaction.mine) shown.push(names.nameOf({ self: true }));
  const more = rest > 0 ? fill(labels.transcript.reactionMore, { n: rest }) : '';
  const list = [shown.join(', '), more].filter(Boolean).join(' ');
  return fill(labels.transcript.reactionNames, { emoji: reaction.emoji, names: list, count: reaction.count });
}

/**
 * The member ids that react on the persona's lines of `messages` (the reactions' `users`, filled
 * by src/behavior/reactor-store.ts#withReactors), each once: they are in view, so
 * they get a mention handle like an author. It reads normalized lines only, so it lives in the
 * core.
 */
export function reactorIdsOf(messages: Array<Record<string, Untyped>>): Array<string> {
  const ids = new Set<string>();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.self) continue;
    for (const reaction of Array.isArray(message.reactions) ? message.reactions : []) {
      for (const user of Array.isArray(reaction?.users) ? reaction.users : []) if (user?.id) ids.add(String(user.id));
    }
  }
  return [...ids];
}

/**
 * What a reply line quotes of its parent: the parent's text on one line, else
 * its media tags (mediaTags) joined, cut to `maxChars` code points at a word
 * boundary with an ellipsis (src/memory/clamp.js#clampWithEllipsis; 0 =
 * whole); '' when the parent has neither.
 */
function replyQuote(parent: Untyped, labels: Untyped, context: Untyped, maxChars: Untyped) {
  const text = oneLine(parent.content) || oneLine(mediaTags(parent, labels, context).join(' '));
  return clampWithEllipsis(text, maxChars);
}

/**
 * The marker of a line that replies to `parent`, shown in the list as `#index`:
 * `labels.transcript.replyTo` with `{index}`, `{author}` (the parent's name,
 * `labels.self` filled with `selfName` for the persona's own line) and
 * `{quote}` (replyQuote under `replyQuoteChars`, 80 when omitted; 0 = whole;
 * `context` as mediaTags reads it, every map optional). With `mode: 'memory'`
 * (the analyzer's transcript, which shows no `#index`) it renders
 * `labels.transcript.replyToMemory` instead, same `{author}` and `{quote}`,
 * `index` unused. The one copy for both transcript modes and the media pick's
 * `<reply>` (src/behavior/turn.ts). Pure.
 * @param parent  A normalized message.
 */
export function replyMarker(
  parent: Untyped,
  index: number,
  {
    labels,
    selfName,
    replyQuoteChars,
    context = {},
    mode = 'chat',
  }: {
    labels: Record<string, Untyped>;
    selfName: string;
    replyQuoteChars?: number;
    context?: MediaContext;
    mode?: 'chat' | 'memory';
  }
): string {
  const author = parent.self ? fill(labels.self, { name: selfName }) : parent.authorName;
  const quote = replyQuote(parent, labels, context, replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS);
  const template = mode === 'memory' ? labels.transcript.replyToMemory : labels.transcript.replyTo;
  return fill(template, { index, author, quote });
}

/**
 * The persona's own lines with the message that started the turn which posted each:
 * `links` (a Map, or a function, posted message id -> trigger message id; src/behavior/turn.ts
 * keeps it) read for every line of hers, and a line with a link comes back as a new object
 * carrying `triggerId` (the fetched line is never changed); every other line is returned as it
 * is. formatTranscript renders the field (`transcript.triggeredBy` / `triggeredByOlder`). No
 * links: `messages` itself; not a list: []. Pure.
 * @param messages  Normalized messages.
 */
export function withTriggers(
  messages: Array<Record<string, Untyped>>,
  links: Map<string, string> | ((id: string) => string | null | undefined) | null
): Array<Record<string, Untyped>> {
  if (!Array.isArray(messages)) return [];
  const lookup =
    typeof links === 'function' ? links : typeof links?.get === 'function' ? (id: Untyped) => links.get(id) : null;
  if (!lookup) return messages;
  return messages.map((message) => {
    if (!message?.self || typeof message.id !== 'string' || !message.id) return message;
    const triggerId = lookup(message.id);
    return typeof triggerId === 'string' && triggerId && triggerId !== message.id ? { ...message, triggerId } : message;
  });
}

/**
 * `messages` with the persona's lines posted from another place's turn marked with that place's name
 * (`postedFrom`), so `<chat>` says where she wrote it from. `postedFrom` (a Map, or a function): posted message id ->
 * the place of the turn that posted it. `nameOf(placeId)` gives a place's name, null when unknown. A line marked
 * before loses its old mark first; every untouched line is returned as it is; not a list: []. Pure.
 */
export function withPostedFrom(
  messages: Array<Record<string, Untyped>>,
  postedFrom: Map<string, string> | ((id: string) => string | null | undefined) | null | undefined,
  nameOf: (placeId: string) => string | null = () => null
): Array<Record<string, Untyped>> {
  if (!Array.isArray(messages)) return [];
  const out = messages.map((message) => {
    if (!message || !('postedFrom' in message)) return message;
    const copy = { ...message };
    delete copy.postedFrom;
    return copy;
  });
  const text = (value: Untyped) => (typeof value === 'string' && value ? value : null);
  const originOf =
    typeof postedFrom === 'function'
      ? postedFrom
      : typeof postedFrom?.get === 'function'
        ? (id: string) => postedFrom.get(id)
        : null;
  if (!originOf) return out;
  out.forEach((message, i) => {
    if (!message?.self || !text(message.id)) return;
    const origin = text(originOf(message.id));
    const channel = origin && origin !== message.placeId ? text(nameOf(origin)) : null;
    if (channel) out[i] = { ...message, postedFrom: channel };
  });
  return out;
}

/**
 * The call marks `<chat>` shows (src/turn/history.ts#orderedHistory), from the persona's remembered skill calls
 * (src/turn/skill-calls.ts notes them, src/memory/journal.ts#callMarksOf seeds them at start): `{ placeId, at,
 * skill, status }` each, with `args` (the main arguments as worded when the call ran), `from` (the name of the place
 * of the turn that made it), `searched` (the name of the place a lookup searched, from the call's `searched` place id),
 * `aimed` (the name of the place its target lives in, else of the place of the turn, for a reason that names it) and `detail` (why a call that did not work did not, when it has a `kind`) when known. A call without a place, a
 * skill or a finite time is left out. `nameOf(placeId)` gives a place's name, null when unknown. Pure.
 */
export function callMarksFor(
  calls: ReadonlyArray<Record<string, Untyped>> | null | undefined,
  nameOf: (placeId: string) => string | null = () => null
): Array<CallMark> {
  const text = (value: Untyped) => (typeof value === 'string' && value ? value : null);
  const name = (id: Untyped) => (text(id) ? text(nameOf(id)) : null);
  const out: Array<CallMark> = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    if (!text(call?.placeId) || !text(call?.skill) || !Number.isFinite(call?.at)) continue;
    out.push({
      placeId: call.placeId,
      at: call.at,
      skill: call.skill,
      status: String(call.status ?? ''),
      ...(text(call.args) ? { args: call.args } : {}),
      ...(name(call.placeId) ? { from: name(call.placeId) } : {}),
      ...(name(call.searched) ? { searched: name(call.searched) } : {}),
      ...(name(text(call.target?.placeId) ?? call.placeId)
        ? { aimed: name(text(call.target?.placeId) ?? call.placeId) }
        : {}),
      ...(call.detail && typeof call.detail.kind === 'string' ? { detail: call.detail } : {}),
    });
  }
  return out;
}

/**
 * One call mark as its line reads it: `labels.transcript.called` with `{skill}`, `{args}` and `{status}`. `{args}`
 * holds, in this order, `calledFrom` with `{place}` the place she called from, `calledSearched` with `{place}` the
 * place a lookup searched, and `calledArgs` with the call's main arguments, each only when the mark has it and the
 * label is set. `{status}` is the status's word in `transcript.callStatus`, else the status code itself; with a mark's
 * `detail` worded by callReason and `transcript.callStatusReason` set, that label with `{status}` and `{reason}`.
 * '' with `called` blank.
 */
function callText(mark: CallMark, labels: Untyped) {
  const t = labels.transcript;
  if (typeof t.called !== 'string' || !t.called) return '';
  const part = (label: Untyped, values: Record<string, Untyped>) =>
    typeof label === 'string' && label ? fill(label, values) : '';
  const args = [
    mark.from ? part(t.calledFrom, { place: mark.from }) : '',
    mark.searched ? part(t.calledSearched, { place: mark.searched }) : '',
    mark.args ? part(t.calledArgs, { args: mark.args }) : '',
  ].join('');
  const words = t.callStatus;
  const word = words && typeof words === 'object' && Object.hasOwn(words, mark.status) ? words[mark.status] : null;
  const statusWord = typeof word === 'string' && word ? word : mark.status;
  const reason = callReason({ detail: mark.detail, targetChannel: mark.aimed }, labels);
  const status =
    reason && typeof t.callStatusReason === 'string' && t.callStatusReason
      ? fill(t.callStatusReason, { status: statusWord, reason })
      : statusWord;
  return fill(t.called, { skill: mark.skill, args, status });
}

/** The refusals worded by their own `labels.tools.refusals` key before any other phrase: kind -> key. */
const REFUSAL_LABELS = Object.freeze({ 'agent-required': 'agentRequired', 'unknown-arg': 'unknownArg' });

/**
 * Why a call of the persona's did not work, worded (`mark.detail`, callMarksFor's), the first of: a
 * refusal's own `labels.tools.refusals[<key>]` (REFUSAL_LABELS; `{arg}` the argument, `{agents}`
 * and `{args}` the values it lists, comma-separated: the agents of an errand, the arguments a skill
 * takes for an argument it does not); the
 * specific `labels.transcript.callReasons[<kind>]` (`{arg}` the argument, `{channel}` the target
 * channel's name); the operation's own message (`detail.text`, one line, cut by its maker) as it
 * is; the generic `labels.tools.result.reasons[<code>]`; `labels.tools.result.reasons.other`. A
 * phrase counts when it is a non-empty string whose `{arg}`, `{channel}`, `{agents}` and `{args}` can be filled. ''
 * without a detail or anything to say.
 */
export function callReason(mark: Untyped, labels: Untyped): string {
  const detail = mark.detail;
  if (!detail) return '';
  const arg = typeof detail.arg === 'string' && detail.arg ? detail.arg : '';
  const channel = typeof mark.targetChannel === 'string' && mark.targetChannel ? mark.targetChannel : '';
  const agents = Array.isArray(detail.values)
    ? detail.values.filter((value: Untyped) => typeof value === 'string' && value).join(', ')
    : '';
  const fields = detail.fields && typeof detail.fields === 'object' ? detail.fields : {};
  const usable = (phrase: Untyped) =>
    typeof phrase === 'string' &&
    phrase !== '' &&
    (!phrase.includes('{status}') || fields.status) &&
    (arg || !phrase.includes('{arg}')) &&
    (channel || !phrase.includes('{channel}')) &&
    (agents || (!phrase.includes('{agents}') && !phrase.includes('{args}')));
  const own = labels.transcript.callReasons;
  const coded = objOf(objOf(labels.tools).result).reasons;
  const lookup = (map: Untyped, key: Untyped) =>
    map && typeof map === 'object' && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : null;
  const refusal = lookup(labels.tools?.refusals, lookup(REFUSAL_LABELS, detail.kind));
  if (usable(refusal)) return fill(refusal, { arg, agents, args: agents });
  const specific = lookup(own, detail.kind);
  if (usable(specific)) return fill(specific, { arg, channel });
  // Before any generic phrase: the operation's own message, as it said it (one line, already cut),
  // which names what exactly went wrong.
  if (typeof detail.text === 'string' && detail.text) return detail.text;
  // The code's own words with its values (src/tools/codes.ts#reasonText, the lookup the `<result>` block shares), else `other`.
  const worded = reasonText(
    labels,
    detail.code,
    { ...(arg ? { arg } : {}), ...(channel ? { channel } : {}), ...fields },
    fill
  );
  if (worded) return worded;
  const other = lookup(coded, 'other');
  return usable(other) ? fill(other, { arg, channel, ...fields }) : '';
}

/**
 * The marker naming the message that started the turn which posted the persona's `message`
 * (chat mode only): `labels.transcript.triggeredBy` with `{n}`, the trigger's `#n` in this list,
 * or `labels.transcript.triggeredByOlder` when the trigger is not in it (never a guessed
 * number). '' for another member's line, a line without `triggerId`, a reply to its own trigger
 * (its reply marker already names it) or a blanked key.
 */
function triggerMarker(message: Untyped, indexById: Untyped, labels: Untyped) {
  const triggerId = message.self ? message.triggerId : null;
  if (typeof triggerId !== 'string' || !triggerId || triggerId === message.replyToId) return '';
  const n = indexById.get(triggerId);
  return n ? fill(labels.transcript.triggeredBy, { n }) : fill(labels.transcript.triggeredByOlder);
}

/**
 * One forwarded message-snapshot, wrapped in `labels.transcript.forwardedFrom`
 * when the source channel's name is known AND that key is set (a key blanked
 * in prompts.local/labels.json switches this form off); otherwise the plain
 * `labels.transcript.forwarded`. A media-only snapshot (no text) still
 * renders its media tags inside the wrapper.
 */
function renderForwarded(
  snapshot: Untyped,
  labels: Untyped,
  context: Untyped,
  maxChars: Untyped,
  channelName: Untyped
) {
  const body = [];
  if (snapshot.content) body.push(clipWithEllipsis(snapshot.content, maxChars));
  body.push(...mediaTags(snapshot, labels, context));
  const text = body.filter(Boolean).join(' ').trim();
  if (channelName && labels.transcript.forwardedFrom) {
    return fill(labels.transcript.forwardedFrom, { channel: channelName, text });
  }
  return fill(labels.transcript.forwarded, { text });
}

/** A raw channel mention `<#id>` left in a text; the group is the id. */
const RAW_CHANNEL_RE = /<#(\d+)>/g;

/**
 * `content` with each channel it mentions carrying its handle: every raw `<#id>` and every whole
 * `#name` of a channel in `mentionedIds` (the ids of the message's `<#id>` mentions, which the
 * text reads as `#name`) that `channels` knows becomes `template` filled
 * with `{name}` (`#` + the channel's name) and `{handle}` (`#` + its handle). Whole: no word
 * character right before the `#` or after the name; the longest name first; URLs left alone. Pure.
 */
function withChannelHandles(content: string, mentionedIds: Untyped, channels: Untyped, template: Untyped) {
  if (typeof content !== 'string' || !content.includes('#')) return content;
  const marked = (entry: Untyped) => fill(template, { name: `#${entry.name}`, handle: `#${entry.handle}` });
  const named = [...new Set((Array.isArray(mentionedIds) ? mentionedIds : []).map(String))]
    .map((id) => channels.get(id))
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name && entry.handle)
    .sort((a, b) => b.name.length - a.name.length);
  return outsideUrls(content, (part) => {
    const raw = part.replace(RAW_CHANNEL_RE, (whole, id) => {
      const entry = channels.get(id);
      return entry?.name && entry.handle ? marked(entry) : whole;
    });
    if (named.length === 0) return raw;
    let out = '';
    let index = 0;
    while (index < raw.length) {
      const at = raw.indexOf('#', index);
      if (at === -1) break;
      out += raw.slice(index, at);
      const entry = isWordChar(raw[at - 1])
        ? null
        : named.find(({ name }) => raw.startsWith(name, at + 1) && !isWordChar(raw[at + 1 + name.length]));
      if (entry) {
        out += marked(entry);
        index = at + 1 + entry.name.length;
      } else {
        out += '#';
        index = at + 1;
      }
    }
    return out + raw.slice(index);
  });
}

/**
 * `text` with every written span of a message reference (`ref.text`, as the interface found it in the text, brackets
 * included) to a message `numberOf` knows turned into that message's transcript number `#n`; a reference to any other
 * message, and a span the text no longer holds, stays as written. The references come in the order they are written.
 * Pure.
 */
function numberMessageRefs(
  text: string,
  refs: Array<{ messageId?: string; text?: string }> | undefined,
  numberOf: (messageId: string) => number | null | undefined
): string {
  if (typeof text !== 'string' || !text || !Array.isArray(refs)) return text;
  let result = '';
  let cursor = 0;
  for (const ref of refs) {
    if (typeof ref?.text !== 'string' || ref.text === '') continue;
    const at = text.indexOf(ref.text, cursor);
    if (at === -1) continue;
    const n = numberOf(String(ref.messageId));
    result += text.slice(cursor, at) + (Number.isInteger(n) ? `#${n}` : ref.text);
    cursor = at + ref.text.length;
  }
  return result + text.slice(cursor);
}

/** What a transcript says of a video: whether it was watched, and its text or the reason it was not. */
export type VideoState = {
  state: 'watched' | 'limit' | 'error' | 'pending';
  text?: string;
  reason?: string;
  /** A second look's answer on a question. */
  answer?: Untyped;
};

/** The options of `formatTranscript`, each described in its comment below. */
export type TranscriptOptions = {
  timezone: string;
  gapMinutes?: number;
  maxChars?: number;
  selfName: string;
  labels: Untyped;
  mode?: 'chat' | 'memory';
  descriptions?: Map<string, string>;
  videos?: Map<string, VideoState>;
  reads?: Map<string, string>;
  gifHandles?: Map<string, string>;
  gifFields?: { get: (id: string) => { reaction: string; action: string; screen: string } | undefined };
  imageAnswers?: Map<string, { question: string; text: string }> | null;
  seeReactions?: boolean;
  reactionsPerMessage?: number;
  reactionNames?: boolean;
  reactionNamesMax?: number;
  replyQuoteChars?: number;
  emojiInline?: boolean;
  indexOffset?: number;
  now?: number;
  handles?: Map<string, string>;
  /** The interface the lines' author ids belong to, for the account mark of `authors.lineAccount`. */
  iface?: string;
  memberNames?: Map<string, Array<string>>;
  channels?: Map<string, { handle: string; name: string }>;
  messageNumbers?: boolean;
  lineNumbers?: boolean;
  skip?: (message: Untyped) => boolean;
};

/** The media of a transcript the caller already holds: the part of the options `mediaTags` and `replyMarker` read. */
type MediaContext = Pick<
  TranscriptOptions,
  'descriptions' | 'videos' | 'reads' | 'gifHandles' | 'gifFields' | 'imageAnswers' | 'emojiInline'
>;

/** The handles two or more author ids of `messages` share: one person writing from several accounts. */
function sharedHandles(messages: ReadonlyArray<Record<string, Untyped>>, handles: Map<string, string>): Set<string> {
  const idsOf = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message?.self || message?.authorId === undefined || message?.authorId === null) continue;
    const id = String(message.authorId);
    const handle = handles.get(id);
    if (!handle) continue;
    idsOf.set(handle, (idsOf.get(handle) ?? new Set()).add(id));
  }
  return new Set([...idsOf].filter(([, ids]) => ids.size > 1).map(([handle]) => handle));
}

/** A member's mention token as a platform writes it in a text, `<@id>` or `<@!id>` (a role's `<@&id>` is none). */
const RAW_MENTION_RE = /<@!?([^>\s&][^>\s]*)>/g;

/** `text` with each member's mention token (`<@id>`) written as `named` gives the id, outside URLs. */
export function mentionsNamed(text: Untyped, named: (id: string) => string): Untyped {
  if (typeof text !== 'string' || !text.includes('<@')) return text;
  return outsideUrls(text, (part) => part.replace(RAW_MENTION_RE, (_token, id: string) => named(id)));
}

/**
 * `text` with each mention token the platform left in it (`<@id>`) written as the member's `@handle`, and as `unknown`
 * (`authors.unknown`) for a member the request gives no handle, so no platform id reaches her. URLs are left alone.
 */
export function rawMentionsAsHandles(text: Untyped, handles: ReadonlyMap<string, string>, unknown: string): Untyped {
  return mentionsNamed(text, (id) => {
    const handle = handles.get(id);
    return handle ? `@${handle}` : unknown;
  });
}

/**
 * How a transcript names a member (chat mode with `authors.line` set and `handles` given): the persona's self label for
 * her, else the member's handle (`authors.line`), with the account's interface and platform id (`authors.lineAccount`)
 * when one person writes in the list from several accounts; without a handle the bare name, and `authors.unknown` for a
 * member with no name. Authors and the reactors of her lines are named by it alike. Without the label or the handles,
 * the bare name.
 */
function authorNaming(
  messages: ReadonlyArray<Record<string, Untyped>>,
  options: TranscriptOptions,
  selfLabel: string
): {
  authorHandles: Map<string, string> | null;
  nameOf: (who: { id: Untyped; name: string; self?: boolean }) => string;
  unknown: string;
} {
  const authors = options.labels.authors ?? {};
  const line = authors.line;
  const authorHandles =
    (options.mode ?? 'chat') === 'chat' && options.handles instanceof Map && typeof line === 'string' && line !== ''
      ? options.handles
      : null;
  const unknown = typeof authors.unknown === 'string' ? authors.unknown : '';
  // The handles one person writes under from two or more accounts in this rendering: their lines mark the account.
  const marked = authorHandles ? sharedHandles(messages, authorHandles) : new Set<string>();
  const nameOf = ({ id, name, self = false }: { id: Untyped; name: string; self?: boolean }): string => {
    if (self) return selfLabel;
    const handle = authorHandles?.get(String(id));
    if (!handle) return name || (authorHandles ? unknown : name);
    if (marked.has(handle) && typeof authors.lineAccount === 'string' && authors.lineAccount)
      return fill(authors.lineAccount, { handle: `@${handle}`, iface: options.iface ?? '', id: String(id) });
    return fill(line, { handle: `@${handle}` });
  };
  return { authorHandles, nameOf, unknown };
}

/**
 * A line's text with the members it mentions as their `@handle`: the names of its real mentions (withUserHandles), then
 * each mention token the platform left (rawMentionsAsHandles).
 */
function contentWithHandles(
  message: Record<string, Untyped>,
  mentionedIds: ReadonlyArray<string>,
  { names, handles, unknown }: { names: Map<string, Array<string>>; handles: Map<string, string>; unknown: string }
): Untyped {
  const named =
    mentionedIds.length > 0 ? withUserHandles(message.content, mentionedIds, { names, handles }) : message.content;
  return rawMentionsAsHandles(named, handles, unknown);
}

/**
 * Format messages (oldest first) into transcript items, one per message.
 * `item.text` already carries the gap/date marker that precedes the message,
 * so dropping items from the start keeps the rest self-explanatory.
 *
 * @param messages  Normalized messages, oldest first.
 * @param [options.gapMinutes]   Silence longer than this gets a marker (GAP_MARKER_MINUTES when omitted).
 * @param [options.maxChars]     Per-message content limit (MAX_MESSAGE_CHARS when omitted).
 * @param options.selfName     The persona's display name, used to fill `labels.self`.
 * @param options.labels       Live `prompts.labels` (locale, self, units, transcript.*).
 * @param [options.mode]  'memory' drops #indexes and adds user ids;
 *   a reply renders `transcript.replyToMemory` (`{author}`, `{quote}`, no `{index}`) in place
 *   of `transcript.replyTo`; it also groups by channel (see below).
 * @param [options.descriptions]  Item id -> a describer
 *   caption (src/memory/describe.js); renders the `*Described` label forms.
 *   Item id -> a video state (the video describer); renders the
 *   `videoWatched`/`videoNotWatched*`/`linkWatched`/`linkNotWatched*` forms.
 *   Ignored when the labels have no `transcript.videoWatched` key.
 * @param [options.reads]  Link id -> the excerpt the web lookup read from
 *   that page (src/web/lookup.js); renders `transcript.linkRead`. Ignored when the labels have
 *   no `transcript.linkRead` key.
 * @param [options.gifHandles]  The GIF library's handles
 *   (src/memory/gifs.js#gifHandleMap); a GIF it knows renders `transcript.gifKnown` /
 *   `transcript.gifKnownNoText` with its handle, falling back to `gifDescribed` / `gif`
 *   when the labels lack that key.
 *   GIF id -> its three caption fields, cut for display (src/turn/request/emoji-gifs.ts#gifFieldsLookup);
 *   a GIF with a handle, a caption and a non-empty reaction or on-screen text renders
 *   `transcript.gifKnownFields`, falling back to `gifKnown` when the labels lack that key.
 * @param [options.imageAnswers]  Picture id -> a
 *   second look on a question (src/memory/describe.js#relookImage); renders `transcript.imageAnswered`
 *   after the picture's tag. Ignored when the labels have no `transcript.imageAnswered` key.
 * @param [options.seeReactions]  Default true: a message's `reactions` render as
 *   `transcript.reactions` at the end of its line. Ignored when the labels have no
 *   `transcript.reactions` key.
 * @param [options.reactionsPerMessage]  Default 6: at most this many reactions per message.
 * @param [options.reactionNames]  Default false (features.reactionNames, read by the caller):
 *   in `mode: 'chat'`, a reaction on the persona's own line whose `users` are known (src/behavior/
 *   reactor-store.ts#withReactors) renders `transcript.reactionNames` with the
 *   reactors named exactly like the authors of lines (the `handles` and `authors.line` below),
 *   at most `reactionNamesMax` (5 when omitted) of them, the rest as `transcript.reactionMore`.
 *   Off, without the label or on anyone else's line: the counts as before.
 * @param [options.reactionNamesMax]  5 when omitted.
 * @param [options.replyQuoteChars]  `context.replyQuoteChars` (80 when omitted; 0 = whole):
 *   a reply to a message of the list renders `transcript.replyTo` with `{index}`, `{author}` (the
 *   parent's name, the persona's self label for its own line) and `{quote}` (replyQuote); in
 *   memory mode `transcript.replyToMemory`. A reply to a message outside the list renders
 *   `transcript.replyToOld` in both modes.
 * @param [options.emojiInline]  Default true; false leaves out the `emojiDescribed` tag of a
 *   custom emoji (the caller lists the emoji with their descriptions elsewhere).
 * @param [options.indexOffset]  Default 0 (when undefined or null): the first message
 *   is numbered `indexOffset + 1`, and every index (the `#index`, a reply target inside the
 *   list, `item.index`) shifts by it, so a second block (another channel's lines) continues
 *   the numbering of the first and its indices never collide with it.
 *   In `mode: 'chat'`, a line of the persona carrying `triggerId` (withTriggers) names the message
 *   that started the turn which posted it after the author: `transcript.triggeredBy` with `{n}`
 *   (the trigger's index, offset like the rest), `transcript.triggeredByOlder` when the trigger is
 *   not in the list; nothing when its reply target is that same message (the reply marker names it)
 *   or the key is blank. A line without `triggerId` renders exactly as it did before.
 *   Also in `mode: 'chat'` only, a line of the persona marked by withPostedFrom renders
 *   `transcript.postedFrom` with `{channel}` after the author (before the trigger marker), and a
 *   call mark (a line of kind `call`, src/turn/history.ts#orderedHistory) renders as a line of
 *   hers of its own, `[time] self: called tag` (callText), with no `#n` and no index, inside the
 *   item of the line before it; the gap and date markers are measured to it like to any line.
 *   `transcript.called` blank, or memory mode: no call line. Every line shows one clock and no age.
 * @param [options.now]  The request's clock (epoch ms). A line's time is its clock alone, so the
 *   text does not depend on it.
 * @param [options.handles]  Member id -> the handle of the person behind the account (src/turn/request/head.ts).
 *   In `mode: 'chat'` with a non-empty `authors.line` label, the author of a line that is not the persona's and has a
 *   handle renders as that label with `{handle}` (the exact token to write, `@` included), and as `authors.lineAccount`
 *   with `{iface}` (`options.iface`) and `{id}` (the member id) when two or more member ids of the list share the
 *   handle; an author without a handle renders the bare name, else `authors.unknown`. A mention token `<@id>` left in a
 *   line's text reads as the member's `@handle`, else `authors.unknown` (rawMentionsAsHandles). Omitted, or without
 *   the label: the bare name.
 * @param [options.iface]  The interface the member ids belong to, the account mark of `authors.lineAccount`.
 * @param [options.memberNames]  Member id -> the names and aliases the request
 *   knows (src/behavior/handles.ts#memberNameMap). With `handles` (chat mode, the same conditions),
 *   a member a line really mentions (`mentionedAccountIds`; their name from the line's `mentionedUsers`
 *   or here) reads in its text as their `@handle`, not the platform's `@DisplayName`
 *   (withUserHandles); a mentioned member without a handle keeps the name. With a non-empty
 *   `transcript.untagged`, a line of the persona's whose text holds a whole `@name` of a member
 *   in `memberNames` who has a handle and is not among the line's mentions ends with that label
 *   (`{names}`: the `@name`s as written, joined by ", "; untaggedNames), for as long as it is shown.
 * @param [options.channels]  Channel id -> its handle
 *   (without `#`) and name (src/behavior/handles.ts#assignChannelHandles over the channel
 *   directory). In `mode: 'chat'` with a non-empty `transcript.channel` label, a channel a line's
 *   text mentions (its `mentionedChannelIds`, read as `#name`, or a raw `<#id>`) renders as that
 *   label with `{name}` and `{handle}` (both with their `#`; withChannelHandles). Omitted, or
 *   without the label: the text as it came.
 * @param [options.messageNumbers]  Default false (features.messageLinks, read by the
 *   caller): in `mode: 'chat'`, a message reference of a line (`messageRefs`, put on the message by
 *   the interface) to a message of this list reads as that line's `#index`; a reference to
 *   anything else, and a link in the text with no reference, stays as written.
 * @param [options.lineNumbers]  Default false: a message's own `lineNumber` (src/turn/chat-numbers.ts) is its number
 *   when it is a whole number above the number of the message before it, and every other message takes the number
 *   after the one before it. Without it the messages are numbered on from `indexOffset`.
 * @param [options.skip]  A message it holds true for keeps its
 *   number (`#index`, reply markers and message links to it read as that number) but renders no
 *   item, and a gap marker is measured from the last line that does render: the request builder
 *   shows such lines in another block (src/behavior/prompt.ts, the anchored window). Omitted:
 *   every message renders.
 * @throws {RangeError} when `indexOffset` is given but is not an integer of at least 0.
 *
 * In `mode: 'memory'`, messages come from possibly several channels (see
 * docs/prompt-contract.md, "The analyzer"): whenever the channel
 * changes between two consecutive messages — including before the very first
 * one — the item opens with a `## #channel-name (id:placeId)` heading, and
 * the gap/date marker is computed against the previous message of the SAME
 * channel run, never across a channel switch.
 */
export function formatTranscript(
  messages: Array<Record<string, Untyped>>,
  options: TranscriptOptions
): Array<{ id: string; index: number; ts: number; text: string }> {
  const {
    timezone,
    gapMinutes = GAP_MARKER_MINUTES,
    maxChars = MAX_MESSAGE_CHARS,
    selfName,
    labels,
    mode = 'chat',
    descriptions,
    videos,
    reads,
    gifHandles,
    gifFields,
    imageAnswers,
  } = options;
  const skip = typeof options.skip === 'function' ? options.skip : null;
  const seeReactions = options.seeReactions ?? true;
  const reactionsPerMessage = options.reactionsPerMessage ?? 6;
  const replyQuoteChars = options.replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS;
  const mediaContext = {
    descriptions,
    videos,
    reads,
    gifHandles,
    gifFields,
    imageAnswers,
    emojiInline: options.emojiInline !== false,
  };
  const locale = labels.locale;
  const selfLabel = fill(labels.self, { name: selfName });
  const indexOffset = options.indexOffset ?? 0;
  /** The bracketed clock of a line at `ts`: one clock, no age. */
  const timeOf = (ts: Untyped) => `[${formatClock(ts, timezone, locale)}]`;
  // The persona's call marks (lines of kind `call`): chat mode only, and only with `transcript.called` set.
  const callsOn = mode === 'chat' && typeof labels.transcript.called === 'string' && labels.transcript.called !== '';
  // Each author's handle (chat mode only, and only with `authors.line` set), and how a member is named by it.
  const { authorHandles, nameOf, unknown } = authorNaming(messages, options, selfLabel);
  const memberNames = authorHandles && options.memberNames instanceof Map ? options.memberNames : new Map();
  const untaggedLabel =
    authorHandles && typeof labels.transcript.untagged === 'string' && labels.transcript.untagged !== ''
      ? labels.transcript.untagged
      : null;
  /** The names a line's mentions go by: the line's own (as the platform rendered them), then the request's. */
  const mentionNamesOf = (message: Untyped) => {
    const names = new Map(memberNames);
    for (const user of Array.isArray(message.mentionedUsers) ? message.mentionedUsers : []) {
      if (user?.id !== undefined && typeof user.name === 'string' && user.name)
        names.set(String(user.id), [user.name, ...(names.get(String(user.id)) ?? [])]);
    }
    return names;
  };
  // Each channel a line mentions with its handle (chat mode only, and only with `transcript.channel` set).
  const channelLabel = labels.transcript.channel;
  const channelMarks =
    mode === 'chat' &&
    options.channels instanceof Map &&
    options.channels.size > 0 &&
    typeof channelLabel === 'string' &&
    channelLabel !== ''
      ? options.channels
      : null;
  // Reactors named on the persona's lines (chat mode, features.reactionNames).
  const reactorNames =
    mode === 'chat' && options.reactionNames === true ? { max: options.reactionNamesMax ?? 5, nameOf } : null;
  // A bad offset is a caller bug: counting it as 0 would renumber a second
  // block from #1 over the first block's indices, so a tag aimed at one line
  // would silently land on another.
  if (!Number.isInteger(indexOffset) || indexOffset < 0) {
    throw new RangeError(`formatTranscript: indexOffset must be an integer >= 0, got ${String(indexOffset)}`);
  }
  // A call mark takes no number: the messages alone are numbered, in their order.
  const numbered = messages.filter((message) => message?.kind !== 'call');
  const ownNumbers = options.lineNumbers === true;
  const indexById = new Map<unknown, number>();
  let last = indexOffset;
  for (const message of numbered) {
    const own: unknown = ownNumbers ? message.lineNumber : undefined;
    last = typeof own === 'number' && Number.isInteger(own) && own > last ? own : last + 1;
    indexById.set(message.id, last);
  }
  // A message link to a line of this list reads as that line's number (chat mode, `messageNumbers`).
  const linkNumbers = mode === 'chat' && options.messageNumbers === true;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const items: Array<{ id: string; index: number; ts: number; text: string }> = [];
  let previous = null;
  let previousChannelId = NO_CHANNEL;
  // Call lines waiting for an item to join: the marks that come before any rendered line.
  let pending: Array<string> = [];
  /** The gap or date marker between the line before and `message`, when there is one. */
  const markerOf = (message: Untyped, before: Untyped): string | null => {
    if (!before) return null;
    const gap = message.ts - before.ts;
    const date = formatDate(message.ts, timezone, locale);
    const dayChanged = date !== formatDate(before.ts, timezone, locale);
    if (gap >= gapMinutes * MINUTE_MS) {
      const duration = formatDuration(gap, labels.units);
      return dayChanged
        ? fill(labels.transcript.gapWithDate, { duration, date })
        : fill(labels.transcript.gap, { duration });
    }
    return dayChanged ? fill(labels.transcript.date, { date }) : null;
  };

  for (const message of messages) {
    // A call mark: a line of hers of its own at the call's time, inside the item of the line before it.
    if (message?.kind === 'call') {
      const called = callsOn && message.call ? callText(message.call, labels) : '';
      if (!called) continue;
      const rows = [markerOf(message, previous), `${timeOf(message.ts)} ${selfLabel}: ${called}`].filter(
        (row): row is string => Boolean(row)
      );
      const last = items.at(-1);
      if (last) last.text = [last.text, ...rows].join('\n');
      else pending.push(...rows);
      previous = message;
      continue;
    }
    // A line shown elsewhere keeps its number and stays a reply target, but renders no item here.
    if (skip && skip(message)) continue;
    const index = indexById.get(message.id) as number; // every message of the list is in `indexById`
    const parts = pending;
    pending = [];

    const channelChanged = mode === 'memory' && message.placeId !== previousChannelId;
    if (channelChanged) {
      parts.push(`## #${message.channelName} (id:${message.placeId})`);
    }

    const marker = markerOf(message, channelChanged ? null : previous);
    if (marker) parts.push(marker);

    const name = nameOf({ id: message.authorId, name: message.authorName, self: message.self });
    // The persona's own line names the message that started its turn (chat mode; see withTriggers)
    // and, posted from another channel's turn, that channel (withPostedFrom).
    const triggered = mode === 'chat' ? triggerMarker(message, indexById, labels) : '';
    const postedFrom =
      mode === 'chat' && message.self && typeof message.postedFrom === 'string' && message.postedFrom
        ? fill(labels.transcript.postedFrom, { channel: message.postedFrom })
        : '';
    const who =
      mode === 'memory' && !message.self
        ? `${name} (id:${message.authorId})`
        : [name, postedFrom, triggered].filter(Boolean).join(' ');
    const time = timeOf(message.ts);
    const head = mode === 'memory' ? time : `#${index} ${time}`;

    const body = [];
    // A message deleted since (a placeholder the turn put in its place): the author and the time only, no text.
    if (message.deleted === true) {
      const gone = labels.transcript.deleted;
      parts.push(`${head} ${who}: ${typeof gone === 'string' ? fill(gone, { author: name }) : ''}`.trimEnd());
      items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
      previous = message;
      previousChannelId = message.placeId;
      continue;
    }
    const mentionedIds = Array.isArray(message.mentionedAccountIds) ? message.mentionedAccountIds : [];
    const named = authorHandles
      ? contentWithHandles(message, mentionedIds, { names: mentionNamesOf(message), handles: authorHandles, unknown })
      : message.content;
    const marked = channelMarks
      ? withChannelHandles(named, message.mentionedChannelIds, channelMarks, channelLabel)
      : named;
    const content = linkNumbers ? numberMessageRefs(marked, message.messageRefs, (id) => indexById.get(id)) : marked;
    if (content) body.push(clipWithEllipsis(content, maxChars));
    if (message.replyToId) {
      const target = indexById.get(message.replyToId);
      if (target) {
        body.push(
          replyMarker(byId.get(message.replyToId), target, {
            labels,
            selfName,
            replyQuoteChars,
            context: mediaContext,
            mode,
          })
        );
      } else {
        body.push(labels.transcript.replyToOld);
      }
    }
    body.push(...mediaTags(message, labels, mediaContext));
    for (const snapshot of message.forwarded ?? []) {
      body.push(renderForwarded(snapshot, labels, mediaContext, maxChars, message.forwardedFrom));
    }
    if (seeReactions) body.push(reactionsTag(message, labels, reactionsPerMessage, reactorNames));
    // An edited message ends with the mark (chat mode, with `transcript.edited` set).
    if (mode === 'chat' && message.editedAt && typeof labels.transcript.edited === 'string')
      body.push(labels.transcript.edited);
    // A tag of hers that named a member and tagged nobody (its text still reads `@name`).
    if (untaggedLabel && message.self && typeof message.content === 'string') {
      const untagged = untaggedNames(message.content, {
        names: mentionNamesOf(message),
        // `untaggedLabel` is set only with `authorHandles`.
        handles: authorHandles as Map<string, string>,
        mentionedIds,
      });
      if (untagged.length > 0)
        body.push(fill(untaggedLabel, { names: untagged.map((hit) => `@${hit.name}`).join(', ') }));
    }
    const direct = mode === 'memory' && message.direct ? DIRECT_MARKER : '';
    parts.push(`${direct}${head} ${who}: ${body.filter(Boolean).join(' ')}`.trimEnd());
    items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
    previous = message;
    previousChannelId = message.placeId;
  }

  return items;
}

/**
 * Join kept items under a date header taken from the first surviving message, with `foot` (the chat's tempo,
 * renderTempo) after the last item when given. No items: `transcript.empty`, then the foot.
 */
export function renderTranscript(items: Untyped, timezone: Untyped, labels: Untyped, foot: string = ''): string {
  const body =
    items.length === 0
      ? [labels.transcript.empty]
      : [
          fill(labels.transcript.header, { date: formatDate(items[0].ts, timezone, labels.locale) }),
          ...items.map((item: Untyped) => item.text),
        ];
  return [...body, ...(foot ? [foot] : [])].join('\n');
}

/**
 * Facts about the pace of a channel. `trigger` is the message that called the
 * persona (null for spontaneous turns, where silence is measured up to `now`).
 */
export function computeTempo(
  messages: Untyped,
  now: number,
  trigger: Untyped = null
): {
  last10min: number;
  lastHour: number;
  lastDay: number;
  authorsLastHour: number;
  silenceMs: number | null;
  lastIsOwn: boolean;
  sinceOwnMs: number | null;
  hasTrigger: boolean;
} {
  const others = trigger ? messages.filter((message: Untyped) => message.id !== trigger.id) : messages;
  const edge = trigger ? trigger.ts : now;
  const within = (ms: number) => others.filter((message: Untyped) => edge - message.ts <= ms && message.ts <= edge);
  const last = others.at(-1) ?? null;
  const lastOwn = [...others].reverse().find((message) => message.self) ?? null;
  const lastHour = within(HOUR_MS);

  return {
    last10min: within(10 * MINUTE_MS).length,
    lastHour: lastHour.length,
    lastDay: within(DAY_MS).length,
    authorsLastHour: new Set(
      lastHour.filter((message: Untyped) => !message.self).map((message: Untyped) => message.authorId)
    ).size,
    silenceMs: last ? Math.max(0, edge - last.ts) : null,
    lastIsOwn: Boolean(last?.self),
    sinceOwnMs: lastOwn ? Math.max(0, now - lastOwn.ts) : null,
    hasTrigger: Boolean(trigger),
  };
}

// The tempo verdict's thresholds when the caller gives none. Production values, config cut of 2026-10-31.
const DEFAULT_TEMPO_THRESHOLDS = { liveMessages10min: 4, deadSilenceMinutes: 45 };

/**
 * Render the tempo block. The verdict looks at silence, not only at message
 * counts: a channel can have few messages in the last 10 minutes and still be
 * "live" if the silence right now is short (e.g. 2 messages 4-5 minutes ago).
 * `silenceMs` already means "silence before the trigger" in reply mode and
 * "time since the last message" in spontaneous mode (see computeTempo), so
 * one rule serves both.
 *
 * @param tempo       Output of computeTempo.
 * @param labels      Live prompts.labels.
 *   Defaults to DEFAULT_TEMPO_THRESHOLDS when omitted or missing a key.
 */
export function renderTempo(
  tempo: ReturnType<typeof computeTempo>,
  labels: { tempo: Record<string, string>; units: Parameters<typeof formatDuration>[1] },
  thresholds?: { liveMessages10min: number; deadSilenceMinutes: number }
): string {
  const liveMessages10min = thresholds?.liveMessages10min ?? DEFAULT_TEMPO_THRESHOLDS.liveMessages10min;
  const deadSilenceMinutes = thresholds?.deadSilenceMinutes ?? DEFAULT_TEMPO_THRESHOLDS.deadSilenceMinutes;
  const t = labels.tempo;
  const lines = [
    fill(t.counts, { last10min: tempo.last10min, lastHour: tempo.lastHour, lastDay: tempo.lastDay }),
    fill(t.authors, { authors: tempo.authorsLastHour }),
  ];
  if (tempo.silenceMs === null) {
    lines.push(t.emptyChannel);
  } else if (tempo.hasTrigger) {
    lines.push(fill(t.silenceBeforeTrigger, { duration: formatDuration(tempo.silenceMs, labels.units) }));
  } else {
    lines.push(fill(t.lastMessageAgo, { duration: formatDuration(tempo.silenceMs, labels.units) }));
  }
  if (tempo.sinceOwnMs !== null) {
    lines.push(fill(t.sinceOwn, { duration: formatDuration(tempo.sinceOwnMs, labels.units) }));
  }
  if (tempo.lastIsOwn && !tempo.hasTrigger) lines.push(t.ownUnanswered);

  let verdict;
  if (tempo.last10min >= liveMessages10min) verdict = t.verdictLive;
  else if (tempo.silenceMs === null || tempo.silenceMs >= deadSilenceMinutes * MINUTE_MS) verdict = t.verdictDead;
  else verdict = t.verdictSlow;
  lines.push(fill(t.verdict, { verdict }));
  return lines.join('\n');
}
