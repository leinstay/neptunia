// Pure text formatting of normalized messages (see normalizeMessage in
// collect.js) into the transcript the model reads. No discord.js imports here,
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
// live conversation from a dead chat that somebody has just poked.

import { reasonText } from './skills/codes.js';
import { clipWithEllipsis, mediaLabelFor, stickerLabelFor, stickerUrl } from './media/classify.js';
import { gifHandleOf } from './memory/index.js';
import { MINUTE_MS, HOUR_MS, DAY_MS } from './time.js';
import { clampWithEllipsis, oneLine } from './memory/clamp.js';
import { isWordChar, numberMessageLinks, outsideUrls } from './memory/mentions.js';

// config.json's context.replyQuoteChars: how much of a reply's parent its line quotes.
const DEFAULT_REPLY_QUOTE_CHARS = 80;

// config.json's context.ageAfterMinutes: from what age a chat line shows how long ago it was.
const DEFAULT_AGE_MINUTES = 60;

// A language-neutral marker (memory transcript only) for a message addressed
// to the persona, so the analyzer can weigh "how people talk TO it" apart
// from general chatter. See docs/prompt-contract.md, "The analyzer".
const DIRECT_MARKER = '→ '; // "→ "

// A value no real channelId can equal, so the very first message of a memory
// transcript always opens with a channel heading (see formatTranscript).
const NO_CHANNEL = Symbol('no-channel');

const formatters = new Map();

function formatter(timezone, locale, options) {
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
 * @param {string} template
 * @param {object} [values]
 */
export function fill(template, values = {}) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all,
  );
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
 * @param {string} template
 * @param {string} id
 * @param {{ reaction?: string, action?: string, text?: string, screen?: string }} fields
 * @returns {string}
 */
export function fillGifFields(template, id, fields) {
  const slots = [...template.matchAll(GIF_FIELD_SLOT)];
  if (slots.length === 0) return fill(template, { id });
  const endOf = (slot) => slot.index + slot[0].length;
  let out = fill(template.slice(0, slots[0].index), { id });
  let kept = 0;
  for (const [i, slot] of slots.entries()) {
    const value = Object.prototype.hasOwnProperty.call(fields, slot[2]) ? fields[slot[2]] : '';
    if (!value) continue;
    if (kept > 0) out += fill(template.slice(endOf(slots[i - 1]), slot.index), { id });
    out += `${slot[1]}${value}${slot[3]}`;
    kept += 1;
  }
  return out + fill(template.slice(endOf(slots.at(-1))), { id });
}

/**
 * Wall-clock time of `ts` in `timezone`, 24-hour `HH:MM` as `locale` writes it.
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone name
 * @param {string} [locale]
 * @returns {string}
 */
export function formatClock(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

/**
 * The date of `ts` in `timezone`: short weekday, day and month name in
 * `locale` (the transcript's date and gap markers).
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDate(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
}

/**
 * The full "now" of `ts` in `timezone`: long weekday, day, month and year in
 * `locale`, then the clock (formatClock) and the zone name in parentheses.
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone
 * @param {string} [locale]
 * @returns {string}
 */
export function formatNow(ts, timezone, locale = 'en-US') {
  const date = formatter(timezone, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts);
  return `${date}, ${formatClock(ts, timezone, locale)} (${timezone})`;
}

/** Local hour 0-23 in the given timezone. Locale-independent by design. */
export function localHour(ts, timezone) {
  return Number(formatter(timezone, 'en-US', { hour: 'numeric', hourCycle: 'h23' }).format(ts)) % 24;
}

/**
 * Coarse, human-scale duration, e.g. "5 min", "3 h 12 min", "2 d 4 h". Rounds
 * to the nearest minute/hour and rolls the result over into the next unit
 * rather than ever printing "60 min" or "24 h".
 * @param {number} ms
 * @param {{lessThanMinute: string, minute: string, hour: string, day: string}} units
 */
export function formatDuration(ms, units) {
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
 * attachment's Discord id, a link's synthesized id, `sticker:<id>` or
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
 * `Map` of GIF ids to their three caption fields (`{ reaction, action, screen }`,
 * cut for display, src/behavior/prompt.js#gifFieldsMap): such a GIF with a
 * handle and a non-empty reaction or on-screen text renders
 * `transcript.gifKnownFields` (fillGifFields: an empty field leaves out its
 * separator); with that key blanked it renders `gifKnown` instead.
 */
// The part-watched forms: their reason code reads labels.transcript.videoPartReason.
const PART_KEYS = new Set(['videoWatchedPart', 'linkWatchedPart']);

/** A part-watched tag whose label is blank, as its whole-video form; any other tag as it is. */
function partFallback(tag, labels) {
  if (PART_KEYS.has(tag.key) && !labels.transcript[tag.key]) {
    return tag.key === 'videoWatchedPart'
      ? { key: 'videoWatched', values: { name: tag.values.name, duration: tag.values.duration, text: tag.values.text } }
      : { key: 'linkWatched', values: { text: tag.values.text } };
  }
  return tag;
}

function mediaTags(message, labels, context = {}) {
  const unknownDuration = labels.transcript.unknownDuration ?? '?';
  const videosOn = Boolean(labels.transcript.videoWatched);
  // A second look's answer (videoAnswered): a key blanked in
  // prompts.local/labels.json switches this form off.
  const answersOn = Boolean(labels.transcript.videoAnswered);
  // A read page's excerpt (linkRead): blanking the key switches it off too.
  const readsOn = Boolean(labels.transcript.linkRead);
  // A picture's second look on a question (imageAnswered): blanking the key switches it off.
  // A GIF's (rewatchGif) renders as a video's (videoAnswered) and goes off with that key.
  const answerOf = (item) => {
    const on = item.kind === 'gif' ? answersOn : Boolean(labels.transcript.imageAnswered);
    return on ? (context.imageAnswers?.get(item.id) ?? null) : null;
  };
  const videoOf = (id) => {
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
  const pushTag = (tag) => {
    const { key, values } = partFallback(tag, labels);
    const reasons = PART_KEYS.has(key) ? labels.transcript.videoPartReason : labels.transcript.videoReason;
    const filled =
      values && Object.prototype.hasOwnProperty.call(values, 'reason')
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
  const pushLabel = ({ key, values, extra }) => {
    pushTag({ key, values });
    for (const tag of Array.isArray(extra) ? extra : extra ? [extra] : []) pushTag(tag);
  };
  // A library GIF's handle (gifKnown / gifKnownNoText): blanking the one
  // chosen switches it off, the plain GIF form renders instead.
  const handleOf = (item, kind) => (item.kind === 'gif' ? gifHandleOf(context.gifHandles, item, kind) : null);
  const gifFieldsOf = (item) => (item.kind === 'gif' ? (context.gifFields?.get(item.id) ?? null) : null);
  const withGifFallback = (given) => {
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
    const description = context.descriptions?.get(attachment.id) ?? null;
    const video = videoOf(attachment.id);
    const gifHandle = handleOf(attachment, 'attachment');
    const answer = answerOf(attachment);
    pushLabel(withGifFallback(mediaLabelFor(attachment, { description, unknownDuration, video, gifHandle, gifFields: gifFieldsOf(attachment), answer })));
  }
  for (const link of message.links ?? []) {
    // A plain 'link' (video-site preview) thumbnail description
    // (transcript.thumbnailDescribed): a key blanked in
    // prompts.local/labels.json switches this form off -- a 'gif' embed's
    // own description (gifDescribed) is a base contract key and is never
    // gated this way.
    const canDescribe = link.kind !== 'link' || Boolean(labels.transcript.thumbnailDescribed);
    const description = canDescribe ? (context.descriptions?.get(link.id) ?? null) : null;
    const read = readsOn ? (context.reads?.get(link.id) ?? null) : null;
    const gifHandle = handleOf(link, 'link');
    const answer = answerOf(link);
    pushLabel(withGifFallback(mediaLabelFor(link, { description, unknownDuration, video: videoOf(link.id), read, gifHandle, gifFields: gifFieldsOf(link), answer })));
  }
  for (const sticker of message.stickers ?? []) {
    const description = labels.transcript.stickerDescribed
      ? (context.descriptions?.get(`sticker:${sticker.id}`) ?? null)
      : null;
    // The slim memory buffer keeps no `url` (see src/memory/update.js
    // `observe()`) -- rebuild it from id/format when absent, so a memory
    // transcript tells a picture-format sticker from a Lottie one exactly
    // like a live chat transcript does.
    const url = sticker.url ?? stickerUrl(sticker.id, sticker.format);
    pushLabel(stickerLabelFor({ ...sticker, url }, { description }));
  }
  // `context.emojiInline === false`: the request lists the emoji once in its
  // `<emoji>` block (src/behavior/prompt.js), so the line keeps the bare `:name:`.
  if (labels.transcript.emojiDescribed && context.emojiInline !== false) {
    for (const emoji of message.emojis ?? []) {
      const description = context.descriptions?.get(`emoji:${emoji.id}`) ?? null;
      if (!description) continue;
      tags.push(fill(labels.transcript.emojiDescribed, { name: emoji.name, text: description }));
    }
  }
  // A key blanked in prompts.local/labels.json (fill() returns '' for it)
  // must not leave a stray double space where that tag would have sat.
  return tags.filter(Boolean);
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
 * @param {object} message
 * @param {object} labels
 * @param {number} max
 * @param {{ max: number, nameOf: (user: object) => string }|null} [names]
 */
function reactionsTag(message, labels, max, names = null) {
  const template = labels.transcript.reactions;
  const reactions = Array.isArray(message.reactions) ? message.reactions.slice(0, Math.max(0, max)) : [];
  if (!template || reactions.length === 0) return '';
  const named = names && message.self && typeof labels.transcript.reactionNames === 'string' && labels.transcript.reactionNames !== '';
  const list = reactions
    .map((reaction) => {
      const { emoji, count, mine } = reaction;
      const item = named ? reactionNamesItem(reaction, labels, names) : '';
      if (item) return item;
      return fill(mine ? (labels.transcript.reactionMine ?? labels.transcript.reactionItem) : labels.transcript.reactionItem, { emoji, count });
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
function reactionNamesItem(reaction, labels, names) {
  const users = Array.isArray(reaction.users) ? reaction.users.filter((user) => user && typeof user.name === 'string' && user.name !== '') : [];
  if (users.length === 0) return '';
  const count = Number(reaction.count);
  const others = Math.max(users.length, Number.isInteger(count) ? count - (reaction.mine ? 1 : 0) : 0);
  const max = Number.isInteger(names.max) && names.max > 0 ? names.max : users.length;
  const shown = users.slice(0, max).map((user) => names.nameOf(user));
  const rest = others - shown.length;
  if (reaction.mine) shown.push(names.nameOf({ self: true }));
  const more = rest > 0 ? fill(labels.transcript.reactionMore, { n: rest }) : '';
  const list = [shown.join(', '), more].filter(Boolean).join(' ');
  return fill(labels.transcript.reactionNames, { emoji: reaction.emoji, names: list, count: reaction.count });
}

/**
 * The member ids that react on the persona's lines of `messages` (the reactions' `users`, filled
 * by interfaces/discord/reactors.js#withReactors; never a bot), each once: they are in view, so
 * they get a mention handle like an author. It reads normalized lines only, so it lives in the
 * core; the Discord interface re-exports it (and carries it in its capabilities object).
 * @param {object[]} messages
 * @returns {string[]}
 */
export function reactorIdsOf(messages) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.self) continue;
    for (const reaction of Array.isArray(message.reactions) ? message.reactions : []) {
      for (const user of Array.isArray(reaction?.users) ? reaction.users : []) if (user?.id && !user.bot) ids.add(String(user.id));
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
function replyQuote(parent, labels, context, maxChars) {
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
 * `index` unused. The one copy for both transcript modes and the GIF picker's
 * `<reply>` (src/behavior/turn.js). Pure.
 * @param {object} parent  A normalized message.
 * @param {number} index
 * @param {{ labels: object, selfName: string, replyQuoteChars?: number, context?: object, mode?: 'chat'|'memory' }} options
 * @returns {string}
 */
export function replyMarker(parent, index, { labels, selfName, replyQuoteChars, context = {}, mode = 'chat' }) {
  const author = parent.self ? fill(labels.self, { name: selfName }) : parent.authorName;
  const quote = replyQuote(parent, labels, context, replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS);
  const template = mode === 'memory' ? labels.transcript.replyToMemory : labels.transcript.replyTo;
  return fill(template, { index, author, quote });
}

/**
 * The persona's own lines with the message that started the turn which posted each:
 * `links` (a Map, or a function, posted message id -> trigger message id; src/behavior/turn.js
 * keeps it) read for every line of hers, and a line with a link comes back as a new object
 * carrying `triggerId` (the fetched line is never changed); every other line is returned as it
 * is. formatTranscript renders the field (`transcript.triggeredBy` / `triggeredByOlder`). No
 * links: `messages` itself; not a list: []. Pure.
 * @param {object[]} messages  Normalized messages.
 * @param {Map<string, string>|((id: string) => string|null|undefined)|null} links
 * @returns {object[]}
 */
export function withTriggers(messages, links) {
  if (!Array.isArray(messages)) return [];
  const lookup = typeof links === 'function' ? links : typeof links?.get === 'function' ? (id) => links.get(id) : null;
  if (!lookup) return messages;
  return messages.map((message) => {
    if (!message?.self || typeof message.id !== 'string' || !message.id) return message;
    const triggerId = lookup(message.id);
    return typeof triggerId === 'string' && triggerId && triggerId !== message.id ? { ...message, triggerId } : message;
  });
}

// The fields withCalls puts on a line; a line marked again loses its old ones first.
const CALL_FIELDS = ['calls', 'callsAfter', 'postedFrom'];

/** `message` without the fields withCalls put on it (a new object). */
function withoutCallFields(message) {
  const copy = { ...message };
  for (const key of CALL_FIELDS) delete copy[key];
  return copy;
}

/**
 * The persona's own lines with the skill calls she made (src/behavior/turn.js keeps them, seeded
 * from src/memory/journal.js#callMarksOf at start), so a later turn sees what she called and how it
 * went. `marks.calls`: `{ channelId, at, skill, status, target: { messageId, channelId }, postedId,
 * posted }` each -- `channelId` the channel of the turn that made the call, `at` when its result
 * came back, `target` what it aimed at (a message and its channel; null fields when unknown; a
 * missing channel is the call's own), `postedId` the message the call itself posted (null when
 * none; in the target channel), `posted` every message id that turn posted, and optionally
 * `detail` (src/skills/executors.js#outcomeDetail: why a call that did not work did not; the mark
 * carries it when it has a `kind`). Among `messages`
 * of the call's own channel, the last line of hers its turn posted carries it (`calls`); when the
 * turn posted none of them, the last line at or before `at` carries it as a line of hers of its
 * own (`callsAfter`); a call older than every line of that channel here, or made in another
 * channel, marks nothing. `marks.postedFrom` (a Map, or a function, posted message id -> the
 * channel of the turn that posted it): her line posted from another channel's turn carries that
 * channel's name (`postedFrom`). Each mark holds `{ skill, status, targetId, targetLink,
 * targetChannel, postedLink, ts }`: `nameOf(channelId)` gives a channel's name, `linkOf(channelId,
 * messageId)` a message's link (each null when unknown). formatTranscript renders them. Lines
 * marked before lose those marks first; every untouched line is returned as it is; not a list: [].
 * Pure.
 * @param {object[]} messages  Normalized messages.
 * @param {{ calls?: object[], postedFrom?: Map<string, string>|((id: string) => string|null|undefined) }|null} marks
 * @param {{ nameOf?: (channelId: string) => string|null, linkOf?: (channelId: string, messageId: string) => string|null }} [resolvers]
 * @returns {object[]}
 */
export function withCalls(messages, marks, { nameOf = () => null, linkOf = () => null } = {}) {
  if (!Array.isArray(messages)) return [];
  const out = messages.map((message) => (message && CALL_FIELDS.some((key) => key in message) ? withoutCallFields(message) : message));
  if (!marks) return out;
  const text = (value) => (typeof value === 'string' && value ? value : null);
  const name = (id) => (text(id) ? text(nameOf(id)) : null);
  const link = (channelId, messageId) => (text(channelId) && text(messageId) ? text(linkOf(channelId, messageId)) : null);
  const add = (i, field, mark) => {
    out[i] = { ...out[i], [field]: [...(out[i][field] ?? []), mark] };
  };
  const calls = (Array.isArray(marks.calls) ? marks.calls : []).filter((call) => text(call?.channelId) && text(call?.skill));
  for (const call of [...calls].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const here = [];
    out.forEach((message, i) => {
      if (message?.channelId === call.channelId) here.push(i);
    });
    if (here.length === 0) continue;
    const targetId = text(call.target?.messageId);
    const targetChannelId = text(call.target?.channelId) ?? call.channelId;
    const postedId = text(call.postedId);
    const mark = {
      skill: call.skill,
      status: String(call.status ?? ''),
      targetId,
      targetLink: targetId ? link(targetChannelId, targetId) : null,
      targetChannel: name(targetChannelId),
      postedLink: postedId ? link(targetChannelId, postedId) : null,
      ts: call.at,
      // Why a call that did not work did not (src/skills/executors.js#outcomeDetail), when known.
      ...(call.detail && typeof call.detail.kind === 'string' ? { detail: call.detail } : {}),
    };
    const posted = new Set(Array.isArray(call.posted) ? call.posted : []);
    let host = -1;
    for (const i of here) if (out[i].self && posted.has(out[i].id)) host = i;
    if (host !== -1) {
      add(host, 'calls', mark);
      continue;
    }
    if (!Number.isFinite(call.at)) continue;
    let after = -1;
    for (const i of here) if (out[i].ts <= call.at) after = i;
    if (after !== -1) add(after, 'callsAfter', mark);
  }
  const from = marks.postedFrom;
  const originOf = typeof from === 'function' ? from : typeof from?.get === 'function' ? (id) => from.get(id) : null;
  if (originOf) {
    out.forEach((message, i) => {
      if (!message?.self || !text(message.id)) return;
      const origin = text(originOf(message.id));
      const channel = origin && origin !== message.channelId ? name(origin) : null;
      if (channel) out[i] = { ...message, postedFrom: channel };
    });
  }
  return out;
}

/**
 * One call mark of withCalls as the line reads it: `labels.transcript.called` with `{skill}`,
 * `{target}` (`calledTargetMessage` with the target's `#n` in this list, else `calledTargetLink`
 * with its link, else `calledTargetChannel` with its channel's name, else ''), `{status}` (the
 * status's word in `transcript.callStatus`, else the status code itself; with a mark's `detail`
 * worded by callReason and `transcript.callStatusReason` set, that label with `{status}` and
 * `{reason}`) and `{posted}` (`calledPosted` with the link of the message the call posted, else
 * ''). '' with `called` blank.
 */
function callText(mark, indexById, labels) {
  const t = labels.transcript;
  if (typeof t.called !== 'string' || !t.called) return '';
  const n = mark.targetId ? indexById.get(mark.targetId) : undefined;
  let target = '';
  if (n) target = fill(t.calledTargetMessage, { n });
  else if (mark.targetLink) target = fill(t.calledTargetLink, { link: mark.targetLink });
  else if (mark.targetChannel) target = fill(t.calledTargetChannel, { channel: mark.targetChannel });
  const posted = mark.postedLink ? fill(t.calledPosted, { link: mark.postedLink }) : '';
  const words = t.callStatus;
  const word = words && typeof words === 'object' && Object.hasOwn(words, mark.status) ? words[mark.status] : null;
  const statusWord = typeof word === 'string' && word ? word : mark.status;
  const reason = callReason(mark, labels);
  const status = reason && typeof t.callStatusReason === 'string' && t.callStatusReason ? fill(t.callStatusReason, { status: statusWord, reason }) : statusWord;
  return fill(t.called, { skill: mark.skill, target, status, posted });
}

/** The refusals worded by their own `labels.skills.refusals` key before any other phrase: kind -> key. */
const REFUSAL_LABELS = Object.freeze({ 'agent-required': 'agentRequired', 'unknown-arg': 'unknownArg' });

/**
 * Why a call of the persona's did not work, worded (`mark.detail`, withCalls'), the first of: a
 * refusal's own `labels.skills.refusals[<key>]` (REFUSAL_LABELS; `{arg}` the argument, `{agents}`
 * and `{args}` the values it lists, comma-separated: the agents of an errand, the arguments a skill
 * takes for an argument it does not); the
 * specific `labels.transcript.callReasons[<kind>]` (`{arg}` the argument, `{channel}` the target
 * channel's name); the operation's own message (`detail.text`, one line, cut by its maker) as it
 * is; the generic `labels.skills.result.reasons[<code>]`; `labels.skills.result.reasons.other`. A
 * phrase counts when it is a non-empty string whose `{arg}`, `{channel}`, `{agents}` and `{args}` can be filled. ''
 * without a detail or anything to say.
 */
function callReason(mark, labels) {
  const detail = mark.detail;
  if (!detail) return '';
  const arg = typeof detail.arg === 'string' && detail.arg ? detail.arg : '';
  const channel = typeof mark.targetChannel === 'string' && mark.targetChannel ? mark.targetChannel : '';
  const agents = Array.isArray(detail.values) ? detail.values.filter((value) => typeof value === 'string' && value).join(', ') : '';
  const fields = detail.fields && typeof detail.fields === 'object' ? detail.fields : {};
  const usable = (phrase) => typeof phrase === 'string' && phrase !== '' && (!phrase.includes('{status}') || fields.status) && (arg || !phrase.includes('{arg}')) && (channel || !phrase.includes('{channel}')) && (agents || (!phrase.includes('{agents}') && !phrase.includes('{args}')));
  const own = labels.transcript.callReasons;
  const coded = labels.skills?.result?.reasons;
  const lookup = (map, key) => (map && typeof map === 'object' && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : null);
  const refusal = lookup(labels.skills?.refusals, lookup(REFUSAL_LABELS, detail.kind));
  if (usable(refusal)) return fill(refusal, { arg, agents, args: agents });
  const specific = lookup(own, detail.kind);
  if (usable(specific)) return fill(specific, { arg, channel });
  // Before any generic phrase: the operation's own message, as it said it (one line, already cut),
  // which names what exactly went wrong.
  if (typeof detail.text === 'string' && detail.text) return detail.text;
  // The code's own words with its values (src/skills/codes.js#reasonText, the lookup the `<result>` block shares), else `other`.
  const worded = reasonText(labels, detail.code, { ...(arg ? { arg } : {}), ...(channel ? { channel } : {}), ...fields }, fill);
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
function triggerMarker(message, indexById, labels) {
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
function renderForwarded(snapshot, labels, context, maxChars, channelName) {
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
 * text reads as `#name`: interfaces/discord/collect.js) that `channels` knows becomes `template` filled
 * with `{name}` (`#` + the channel's name) and `{handle}` (`#` + its handle). Whole: no word
 * character right before the `#` or after the name; the longest name first; URLs left alone. Pure.
 */
function withChannelHandles(content, mentionedIds, channels, template) {
  if (typeof content !== 'string' || !content.includes('#')) return content;
  const marked = (entry) => fill(template, { name: `#${entry.name}`, handle: `#${entry.handle}` });
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
      const entry = isWordChar(raw[at - 1]) ? null : named.find(({ name }) => raw.startsWith(name, at + 1) && !isWordChar(raw[at + 1 + name.length]));
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
 * Format messages (oldest first) into transcript items, one per message.
 * `item.text` already carries the gap/date marker that precedes the message,
 * so dropping items from the start keeps the rest self-explanatory.
 *
 * @param {object[]} messages  Normalized messages, oldest first.
 * @param {object} options
 * @param {string} options.timezone
 * @param {number} options.gapMinutes   Silence longer than this gets a marker.
 * @param {number} options.maxChars     Per-message content limit.
 * @param {string} options.selfName     The persona's display name, used to fill `labels.self`.
 * @param {object} options.labels       Live `prompts.labels` (locale, self, units, transcript.*).
 * @param {'chat'|'memory'} [options.mode]  'memory' drops #indexes and adds user ids;
 *   a reply renders `transcript.replyToMemory` (`{author}`, `{quote}`, no `{index}`) in place
 *   of `transcript.replyTo`; it also groups by channel (see below).
 * @param {Map<string, string>} [options.descriptions]  Item id -> a describer
 *   caption (src/memory/describe.js); renders the `*Described` label forms.
 * @param {Map<string, { state: 'watched'|'limit'|'error'|'pending', text?: string, reason?: string }>} [options.videos]
 *   Item id -> a video state (the video describer); renders the
 *   `videoWatched`/`videoNotWatched*`/`linkWatched`/`linkNotWatched*` forms.
 *   Ignored when the labels have no `transcript.videoWatched` key.
 * @param {Map<string, string>} [options.reads]  Link id -> the excerpt the web lookup read from
 *   that page (src/web/lookup.js); renders `transcript.linkRead`. Ignored when the labels have
 *   no `transcript.linkRead` key.
 * @param {Map<string, string>} [options.gifHandles]  The GIF library's handles
 *   (src/memory/gifs.js#gifHandleMap); a GIF it knows renders `transcript.gifKnown` /
 *   `transcript.gifKnownNoText` with its handle, falling back to `gifDescribed` / `gif`
 *   when the labels lack that key.
 * @param {Map<string, { reaction: string, action: string, screen: string }>} [options.gifFields]
 *   GIF id -> its three caption fields, cut for display (src/behavior/prompt.js#gifFieldsMap);
 *   a GIF with a handle, a caption and a non-empty reaction or on-screen text renders
 *   `transcript.gifKnownFields`, falling back to `gifKnown` when the labels lack that key.
 * @param {Map<string, { question: string, text: string }>} [options.imageAnswers]  Picture id -> a
 *   second look on a question (src/memory/describe.js#relookImage); renders `transcript.imageAnswered`
 *   after the picture's tag. Ignored when the labels have no `transcript.imageAnswered` key.
 * @param {boolean} [options.seeReactions]  Default true: a message's `reactions` render as
 *   `transcript.reactions` at the end of its line. Ignored when the labels have no
 *   `transcript.reactions` key.
 * @param {number} [options.reactionsPerMessage]  Default 6: at most this many reactions per message.
 * @param {boolean} [options.reactionNames]  Default false (features.reactionNames, read by the caller):
 *   in `mode: 'chat'`, a reaction on the persona's own line whose `users` are known (interfaces/discord/
 *   reactors.js#withReactors) renders `transcript.reactionNames` with the
 *   reactors named exactly like the authors of lines (the `handles` and `transcript.author` below),
 *   at most `reactionNamesMax` (5 when omitted) of them, the rest as `transcript.reactionMore`.
 *   Off, without the label or on anyone else's line: the counts as before.
 * @param {number} [options.reactionNamesMax]  `context.reactions.maxNames`.
 * @param {number} [options.replyQuoteChars]  `context.replyQuoteChars` (80 when omitted; 0 = whole):
 *   a reply to a message of the list renders `transcript.replyTo` with `{index}`, `{author}` (the
 *   parent's name, the persona's self label for its own line) and `{quote}` (replyQuote); in
 *   memory mode `transcript.replyToMemory`. A reply to a message outside the list renders
 *   `transcript.replyToOld` in both modes.
 * @param {boolean} [options.emojiInline]  Default true; false leaves out the `emojiDescribed` tag of a
 *   custom emoji (the request lists the emoji with their descriptions in `<emoji>` instead).
 * @param {number} [options.indexOffset]  Default 0 (when undefined or null): the first message
 *   is numbered `indexOffset + 1`, and every index (the `#index`, a reply target inside the
 *   list, `item.index`) shifts by it, so a second block (another channel's lines) continues
 *   the numbering of the first and its indices never collide with it.
 *   In `mode: 'chat'`, a line of the persona carrying `triggerId` (withTriggers) names the message
 *   that started the turn which posted it after the author: `transcript.triggeredBy` with `{n}`
 *   (the trigger's index, offset like the rest), `transcript.triggeredByOlder` when the trigger is
 *   not in the list; nothing when its reply target is that same message (the reply marker names it)
 *   or the key is blank. A line without `triggerId` renders exactly as it did before.
 *   Also in `mode: 'chat'` only, the marks of withCalls on a line of the persona: `postedFrom`
 *   renders `transcript.postedFrom` with `{channel}` after the author (before the trigger marker),
 *   each of `calls` a `transcript.called` tag at the end of the line (callText), and each of
 *   `callsAfter` a line of its own after it inside the same item -- `[time] self: called tag`, its
 *   time (aged like any line) the call's, no `#n` and no index. `transcript.called` blank: no call
 *   tag and no call line.
 * @param {number} [options.now]  The request's clock (epoch ms), the same moment as its `<now>` and
 *   `<tempo>`; never read here from the system clock. In `mode: 'chat'`, a line at least
 *   `ageMinutes` older than `now` renders its head time as `transcript.timeAged` with `{clock}`
 *   and `{age}` (formatDuration of `now - ts`). No `now`, or labels without a non-empty
 *   `transcript.timeAged`, keeps the plain `[clock]`. Memory mode never shows ages. The age is
 *   relative to this clock, so the items' text is for this request only and is never stored.
 * @param {number} [options.ageMinutes]  `context.ageAfterMinutes` (60 when omitted): how old a
 *   line must be, in minutes, to carry its age.
 * @param {Map<string, string>} [options.handles]  Member id -> handle (src/behavior/handles.js,
 *   features.mentionHandles). In `mode: 'chat'` with a non-empty `transcript.author` label, the
 *   author of a line that is neither the persona's nor a bot's and has a handle renders as that
 *   label with `{name}` and `{handle}` (the exact token to write, `@` included). Omitted, or
 *   without the label: the bare name, as before.
 * @param {Map<string, { handle: string, name: string }>} [options.channels]  Channel id -> its handle
 *   (without `#`) and name (src/behavior/handles.js#assignChannelHandles over the channel
 *   directory). In `mode: 'chat'` with a non-empty `transcript.channel` label, a channel a line's
 *   text mentions (its `mentionedChannelIds`, read as `#name`, or a raw `<#id>`) renders as that
 *   label with `{name}` and `{handle}` (both with their `#`; withChannelHandles). Omitted, or
 *   without the label: the text as it came.
 * @param {boolean} [options.messageNumbers]  Default false (features.messageLinks, read by the
 *   caller): in `mode: 'chat'`, a Discord message link in a line's text to a message of this list
 *   reads as that line's `#index` (src/memory/mentions.js#numberMessageLinks); a link to anything
 *   else stays as written.
 * @param {(message: object) => boolean} [options.skip]  A message it holds true for keeps its
 *   number (`#index`, reply markers and message links to it read as that number) but renders no
 *   item, and a gap marker is measured from the last line that does render: the request builder
 *   shows such lines in another block (src/behavior/prompt.js, the anchored window). Omitted:
 *   every message renders.
 * @throws {RangeError} when `indexOffset` is given but is not an integer of at least 0.
 * @returns {{ id: string, index: number, ts: number, text: string }[]}
 *
 * In `mode: 'memory'`, messages come from possibly several channels (see
 * docs/prompt-contract.md, "The analyzer"): whenever the channel
 * changes between two consecutive messages — including before the very first
 * one — the item opens with a `## #channel-name (id:channelId)` heading, and
 * the gap/date marker is computed against the previous message of the SAME
 * channel run, never across a channel switch.
 */
export function formatTranscript(messages, options) {
  const { timezone, gapMinutes, maxChars, selfName, labels, mode = 'chat', descriptions, videos, reads, gifHandles, gifFields, imageAnswers } = options;
  const skip = typeof options.skip === 'function' ? options.skip : null;
  const seeReactions = options.seeReactions ?? true;
  const reactionsPerMessage = options.reactionsPerMessage ?? 6;
  const replyQuoteChars = options.replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS;
  const mediaContext = { descriptions, videos, reads, gifHandles, gifFields, imageAnswers, emojiInline: options.emojiInline !== false };
  const locale = labels.locale;
  const selfLabel = fill(labels.self, { name: selfName });
  const indexOffset = options.indexOffset ?? 0;
  // A line's age (chat mode only): relative to the request's clock, never Date.now().
  const agedTemplate = labels.transcript.timeAged;
  const agesOn = mode === 'chat' && typeof options.now === 'number' && typeof agedTemplate === 'string' && agedTemplate !== '';
  const ageMs = (options.ageMinutes ?? DEFAULT_AGE_MINUTES) * MINUTE_MS;
  /** The bracketed time of a line at `ts`, with its age when old enough (see agesOn). */
  const timeOf = (ts) => {
    const clock = formatClock(ts, timezone, locale);
    const age = options.now - ts;
    return agesOn && age >= ageMs ? fill(agedTemplate, { clock, age: formatDuration(age, labels.units) }) : `[${clock}]`;
  };
  // The persona's skill calls (withCalls): chat mode only, and only with `transcript.called` set.
  const callsOn = mode === 'chat' && typeof labels.transcript.called === 'string' && labels.transcript.called !== '';
  // Each author's mention handle (chat mode only, and only with `transcript.author` set).
  const authorLabel = labels.transcript.author;
  const authorHandles = mode === 'chat' && options.handles instanceof Map && typeof authorLabel === 'string' && authorLabel !== '' ? options.handles : null;
  /**
   * How the transcript names a member: the persona's self label for her, else the name with the
   * member's mention handle (transcript.author) when they have one and are not a bot, else the
   * bare name. Authors and the reactors of her lines are named by it alike.
   */
  const nameOf = ({ id, name, self = false, bot = false }) => {
    if (self) return selfLabel;
    const handle = authorHandles && !bot ? authorHandles.get(String(id)) : undefined;
    return handle ? fill(authorLabel, { name, handle: `@${handle}` }) : name;
  };
  // Each channel a line mentions with its handle (chat mode only, and only with `transcript.channel` set).
  const channelLabel = labels.transcript.channel;
  const channelMarks =
    mode === 'chat' && options.channels instanceof Map && options.channels.size > 0 && typeof channelLabel === 'string' && channelLabel !== '' ? options.channels : null;
  // Reactors named on the persona's lines (chat mode, features.reactionNames).
  const reactorNames = mode === 'chat' && options.reactionNames === true ? { max: options.reactionNamesMax ?? 5, nameOf } : null;
  // A bad offset is a caller bug: counting it as 0 would renumber a second
  // block from #1 over the first block's indices, so a tag aimed at one line
  // would silently land on another.
  if (!Number.isInteger(indexOffset) || indexOffset < 0) {
    throw new RangeError(`formatTranscript: indexOffset must be an integer >= 0, got ${String(indexOffset)}`);
  }
  const indexById = new Map(messages.map((message, i) => [message.id, indexOffset + i + 1]));
  // A message link to a line of this list reads as that line's number (chat mode, `messageNumbers`).
  const linkNumbers = mode === 'chat' && options.messageNumbers === true;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const items = [];
  let previous = null;
  let previousChannelId = NO_CHANNEL;

  for (const message of messages) {
    // A line shown elsewhere keeps its number and stays a reply target, but renders no item here.
    if (skip && skip(message)) continue;
    const index = indexById.get(message.id);
    const parts = [];

    const channelChanged = mode === 'memory' && message.channelId !== previousChannelId;
    if (channelChanged) {
      parts.push(`## #${message.channelName} (id:${message.channelId})`);
    }

    const gapPrevious = channelChanged ? null : previous;
    if (gapPrevious) {
      const gap = message.ts - gapPrevious.ts;
      const date = formatDate(message.ts, timezone, locale);
      const dayChanged = date !== formatDate(gapPrevious.ts, timezone, locale);
      if (gap >= gapMinutes * MINUTE_MS) {
        const duration = formatDuration(gap, labels.units);
        parts.push(dayChanged ? fill(labels.transcript.gapWithDate, { duration, date }) : fill(labels.transcript.gap, { duration }));
      } else if (dayChanged) {
        parts.push(fill(labels.transcript.date, { date }));
      }
    }

    const name = nameOf({ id: message.authorId, name: message.authorName, self: message.self, bot: message.bot });
    // The persona's own line names the message that started its turn (chat mode; see withTriggers)
    // and, posted from another channel's turn, that channel (withCalls).
    const triggered = mode === 'chat' ? triggerMarker(message, indexById, labels) : '';
    const postedFrom = mode === 'chat' && message.self && typeof message.postedFrom === 'string' && message.postedFrom ? fill(labels.transcript.postedFrom, { channel: message.postedFrom }) : '';
    const who = mode === 'memory' && !message.self ? `${name} (id:${message.authorId})` : [name, postedFrom, triggered].filter(Boolean).join(' ');
    const time = timeOf(message.ts);
    const head = mode === 'memory' ? time : `#${index} ${time}`;

    const body = [];
    // A message deleted since (a placeholder the turn put in its place): the author and the time only, no text.
    if (message.deleted === true) {
      const gone = labels.transcript.deleted;
      parts.push(`${head} ${who}: ${typeof gone === 'string' ? fill(gone, { author: name }) : ''}`.trimEnd());
      items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
      previous = message;
      previousChannelId = message.channelId;
      continue;
    }
    const marked = channelMarks ? withChannelHandles(message.content, message.mentionedChannelIds, channelMarks, channelLabel) : message.content;
    const content = linkNumbers ? numberMessageLinks(marked, (id) => indexById.get(id)) : marked;
    if (content) body.push(clipWithEllipsis(content, maxChars));
    if (message.replyToId) {
      const target = indexById.get(message.replyToId);
      if (target) {
        body.push(replyMarker(byId.get(message.replyToId), target, { labels, selfName, replyQuoteChars, context: mediaContext, mode }));
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
    if (mode === 'chat' && message.editedAt && typeof labels.transcript.edited === 'string') body.push(labels.transcript.edited);
    // The skill calls of the turn that posted this line of hers (chat mode; see withCalls).
    if (callsOn && message.self) for (const mark of message.calls ?? []) body.push(callText(mark, indexById, labels));

    const marker = mode === 'memory' && message.direct ? DIRECT_MARKER : '';
    parts.push(`${marker}${head} ${who}: ${body.filter(Boolean).join(' ')}`.trimEnd());
    // A call of a turn that posted no line here: a line of hers of its own, at its time, no number.
    if (callsOn) {
      for (const mark of message.callsAfter ?? []) {
        const called = callText(mark, indexById, labels);
        if (called) parts.push(`${timeOf(mark.ts)} ${selfLabel}: ${called}`);
      }
    }
    items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
    previous = message;
    previousChannelId = message.channelId;
  }

  return items;
}

/** Join kept items under a date header taken from the first surviving message. */
export function renderTranscript(items, timezone, labels) {
  if (items.length === 0) return labels.transcript.empty;
  return [fill(labels.transcript.header, { date: formatDate(items[0].ts, timezone, labels.locale) }), ...items.map((item) => item.text)].join(
    '\n',
  );
}

/**
 * Facts about the pace of a channel. `trigger` is the message that called the
 * persona (null for spontaneous turns, where silence is measured up to `now`).
 */
export function computeTempo(messages, now, trigger = null) {
  const others = trigger ? messages.filter((message) => message.id !== trigger.id) : messages;
  const edge = trigger ? trigger.ts : now;
  const within = (ms) => others.filter((message) => edge - message.ts <= ms && message.ts <= edge);
  const last = others.at(-1) ?? null;
  const lastOwn = [...others].reverse().find((message) => message.self) ?? null;
  const lastHour = within(HOUR_MS);

  return {
    last10min: within(10 * MINUTE_MS).length,
    lastHour: lastHour.length,
    lastDay: within(DAY_MS).length,
    authorsLastHour: new Set(lastHour.filter((message) => !message.self).map((message) => message.authorId)).size,
    silenceMs: last ? Math.max(0, edge - last.ts) : null,
    lastIsOwn: Boolean(last?.self),
    sinceOwnMs: lastOwn ? Math.max(0, now - lastOwn.ts) : null,
    hasTrigger: Boolean(trigger),
  };
}

// Defaults mirror config.json's context.tempo; used whenever the caller omits
// `thresholds` or one of its two keys (e.g. an older config.local.json).
const DEFAULT_TEMPO_THRESHOLDS = { liveMessages10min: 4, deadSilenceMinutes: 45 };

/**
 * Render the tempo block. The verdict looks at silence, not only at message
 * counts: a channel can have few messages in the last 10 minutes and still be
 * "live" if the silence right now is short (e.g. 2 messages 4-5 minutes ago).
 * `silenceMs` already means "silence before the trigger" in reply mode and
 * "time since the last message" in spontaneous mode (see computeTempo), so
 * one rule serves both.
 *
 * @param {object} tempo       Output of computeTempo.
 * @param {object} labels      Live prompts.labels.
 * @param {{liveMessages10min: number, deadSilenceMinutes: number}} [thresholds]
 *   Defaults to DEFAULT_TEMPO_THRESHOLDS when omitted or missing a key.
 */
export function renderTempo(tempo, labels, thresholds) {
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
