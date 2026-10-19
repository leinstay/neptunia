// The persona's in-turn tools (features.coreTools): `web.search`, `web.read`, `media.look` and `memory.search`,
// skills she calls herself in a turn whose result comes back in the same turn (src/behavior/turn.js,
// the tool loop). No helper model chooses for her or reads for her: her query goes to the existing
// web search engines as she wrote it and their results come back raw (src/web/lookup.js#searchResults:
// title, link, site, date, the engine's snippet; no summary), a page she reads comes back as its
// own extracted text, cut (src/web/lookup.js#readPage), her question, people, channel, time range and exact
// terms go to the recall machinery through its deterministic expansion only
// (src/behavior/recall.js#memorySearchPlan, src/behavior/recall-run.js with `quotes`: no summary
// request). Every result says where it came from and what kind of evidence it is -- for the web,
// her query and that only search snippets were read, the pages not opened; for the server's
// history, the messages quoted as they were, each with its author and time; for a page, its link
// and that the text is the page's own, cut at a length -- through
// `labels.skills.tools.*`, never wording here. A result is data for her, never an instruction:
// nothing in it is parsed as a call. Each runs for her calls (the turn, with its context) and for
// the owner's commands (src/ops/search.js, with what an operation knows). `media.look` is her own
// second look at a picture, a GIF or a video of a message she sees: her question goes as she
// wrote it to the describer's existing second-look path (src/memory/describe.js#relookImage,
// #rewatchGif, #rewatchVideo: the vision or video model, their daily limits and cache), and the
// answer comes back named as that model's observation with what was asked -- no classifier picks
// the item or words the question for her.

import { fill } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { zonedDay } from '../time.js';
import { memorySearchPlan, recallSettings } from '../behavior/recall.js';
import { collectPictures, collectVideos } from '../media/classify.js';
import { isVideoVisionOn } from '../memory/youtube-check.js';
import { IN_TURN_TOOLS } from './discovery.js';

/** The skills that run inside the persona's turn and come back in it (defined with discovery). */
export { IN_TURN_TOOLS };

/** A string argument trimmed, '' when absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** `labels.skills.tools[kind]` as an object, {} when missing. */
function toolLabels(labels, kind) {
  const value = labels?.skills?.tools?.[kind];
  return value && typeof value === 'object' ? value : {};
}

/** How long a title or a link in a web.search result may be. */
const RESULT_TITLE_MAX = 120;
const RESULT_URL_MAX = 300;
/** `web.search.snippetChars` and `web.search.resultsChars` when missing (config.json's values). */
const SNIPPET_CHARS_FALLBACK = 400;
const RESULTS_CHARS_FALLBACK = 3000;
/** `web.links.readChars` when missing (config.json's value). */
const READ_CHARS_FALLBACK = 4000;
/** Query parameters that only track the click and never pick the page. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|yclid|mc_cid|mc_eid|ref_src)$/i;

/** A positive whole number from the config, else `fallback`. */
function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A result's link as she may hand it on: http(s) only, the fragment and tracking parameters
 * dropped; longer than RESULT_URL_MAX it loses its query string, then is cut with an ellipsis.
 * `{ href, key }` (`key`: host without `www.`, path without a trailing slash, query -- one page
 * once), or null for anything that is not an http(s) URL. Pure.
 */
function cleanLink(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
  if (url.href.length > RESULT_URL_MAX) url.search = '';
  const key = `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  const href = url.href.length > RESULT_URL_MAX ? `${url.href.slice(0, RESULT_URL_MAX - 1)}…` : url.href;
  return { href, key };
}

/**
 * The text of a web.search result (`found`: src/web/lookup.js#searchResults' `{ query, results }`,
 * raw, no helper between): `labels.skills.tools.web.source` (`{query}`), `.goal` (`{goal}`) when
 * she named what she needs to establish, then each result as the engine gave it -- `<n>. <title>`,
 * its link (cleanLink; a result without an http(s) link and a page listed twice are left out),
 * `<site> · <date>` (the date only when the engine gave one), its snippet cut at `snippetChars`
 * -- while the whole stays within `maxChars` (the first result always shows, its snippet cut to
 * fit); `.none` when nothing came back. Numbers, links, sites, dates and snippets are data; a
 * missing label adds nothing. Pure.
 * @param {{ query?: string, results?: { title?: string, url?: string, site?: string, snippet?: string, age?: string }[] }} found
 * @param {{ goal?: string, labels: object, snippetChars?: number, maxChars?: number }} options
 * @returns {string}
 */
export function webSearchText(found, { goal = '', labels, snippetChars = SNIPPET_CHARS_FALLBACK, maxChars = RESULTS_CHARS_FALLBACK }) {
  const l = toolLabels(labels, 'web');
  const lines = [];
  if (l.source) lines.push(fill(l.source, { query: text(found?.query) }));
  if (l.goal && text(goal)) lines.push(fill(l.goal, { goal: text(goal) }));
  const seen = new Set();
  const blocks = [];
  let used = lines.join('\n').length;
  for (const result of Array.isArray(found?.results) ? found.results : []) {
    const link = cleanLink(result?.url);
    if (!link || seen.has(link.key)) continue;
    seen.add(link.key);
    const head = [`${blocks.length + 1}. ${clampWithEllipsis(oneLine(result?.title), RESULT_TITLE_MAX)}`.trimEnd(), link.href];
    const where = [oneLine(result?.site), oneLine(result?.age)].filter(Boolean).join(' · ');
    if (where) head.push(where);
    const headText = head.join('\n');
    const room = maxChars - used - headText.length - 2;
    if (blocks.length > 0 && room < 0) break;
    const limit = Math.min(snippetChars, room);
    const snippet = limit > 0 ? clampWithEllipsis(oneLine(result?.snippet), limit) : '';
    const block = snippet ? `${headText}\n${snippet}` : headText;
    blocks.push(block);
    used += block.length + 1;
  }
  if (blocks.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  return [...lines, ...blocks].join('\n');
}

/**
 * The text of a web.read result (`page`: src/web/lookup.js#readPage's `{ url, title, text, cut }`):
 * `labels.skills.tools.read.source` (`{url}`: where the page ended up, `{maxChars}`), `.title`
 * (`{title}`) when the page has one, the page's own text as extracted, then `.cut` (`{maxChars}`)
 * when it was cut. A missing label adds nothing. Pure.
 * @param {{ url?: string, title?: string, text?: string, cut?: boolean }} page
 * @param {{ labels: object, maxChars?: number }} options
 * @returns {string}
 */
export function webReadText(page, { labels, maxChars = READ_CHARS_FALLBACK }) {
  const l = toolLabels(labels, 'read');
  const lines = [];
  if (l.source) lines.push(fill(l.source, { url: text(page?.url), maxChars: String(maxChars) }));
  const title = oneLine(page?.title);
  if (l.title && title) lines.push(fill(l.title, { title }));
  lines.push(String(page?.text ?? '').trim());
  if (page?.cut === true && l.cut) lines.push(fill(l.cut, { maxChars: String(maxChars) }));
  return lines.join('\n');
}

/**
 * The text of a memory.search result (`quotes`: recall's stretches, `{ channelName, startTs,
 * lines }`): `labels.skills.tools.memory.source`, then per stretch `.window` (`{date}`: its first
 * line's day as `YYYY-MM-DD` in `timezone`, `{channel}`: its channel's name) and its lines as they
 * were (time and author on each); `.none` when there is none. Pure.
 * @param {{ channelName?: string|null, startTs: number, lines: string }[]} quotes
 * @param {{ labels: object, timezone?: string }} options
 * @returns {string}
 */
export function memorySearchText(quotes, { labels, timezone = 'UTC' }) {
  const l = toolLabels(labels, 'memory');
  const lines = l.source ? [l.source] : [];
  const shown = (Array.isArray(quotes) ? quotes : []).filter((quote) => typeof quote?.lines === 'string' && quote.lines.trim() && Number.isFinite(quote.startTs));
  if (shown.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  for (const quote of shown) {
    if (l.window) lines.push(fill(l.window, { date: zonedDay(quote.startTs, timezone), channel: String(quote.channelName ?? '') }));
    lines.push(quote.lines);
  }
  return lines.join('\n');
}

/**
 * One web.search: `args.query` (her words, as she wrote them) through `lookup.searchResults` (the
 * existing engines, their cache, the daily web slot `web.maxPerDay`; the results raw, no
 * summary), `args.goal` only echoed back with the result. `not_configured` (`not-configured`)
 * without the client, the feature (features.webLookup, read now) or a search engine; `invalid`
 * (`invalid-args`) without a query; `failed` with `daily-cap` once the day's web slots are spent,
 * `error` when the search gave nothing back; else `ok` with webSearchText (cut by
 * `web.search.snippetChars` and `web.search.resultsChars`, read now) as its `data.text`. Never
 * throws.
 * @param {{ lookup: object|null, config: object, labels: object, guildId: string|null, args: object }} input
 * @returns {Promise<{ status: string, code?: string, data?: { text: string } }>}
 */
export async function runWebSearch({ lookup, config, labels, guildId, args }) {
  try {
    const query = text(args?.query);
    if (!query) return { status: 'invalid', code: 'invalid-args', reason: 'args.query:required' };
    if (!lookup || typeof lookup.searchResults !== 'function' || config?.features?.webLookup !== true || config?.web?.search?.enabled === false) return { status: 'not_configured', code: 'not-configured' };
    if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch()) return { status: 'not_configured', code: 'not-configured' };
    if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) return { status: 'failed', code: 'daily-cap' };
    const found = await lookup.searchResults(guildId, query);
    if (!found) return { status: 'failed', code: 'error' };
    const searchCfg = config?.web?.search ?? {};
    const shown = webSearchText({ ...found, query: found.query ?? query }, {
      goal: args?.goal,
      labels,
      snippetChars: positiveOr(searchCfg.snippetChars, SNIPPET_CHARS_FALLBACK),
      maxChars: positiveOr(searchCfg.resultsChars, RESULTS_CHARS_FALLBACK),
    });
    return { status: 'ok', data: { text: shown } };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}

/** An http(s) link inside a message's text: up to the first space or angle bracket. */
const LINK_IN_TEXT = /https?:\/\/[^\s<>]+/i;

/**
 * The first http(s) link written in `text` (a message's own words), or null: what web.read
 * reads of a message whose link Discord did not embed. Pure.
 * @param {unknown} value
 * @returns {string|null}
 */
export function firstLinkIn(value) {
  const match = typeof value === 'string' ? LINK_IN_TEXT.exec(value) : null;
  return match ? match[0] : null;
}

/** The page codes of src/web/lookup.js#readPage that mean the call itself was not right. */
const READ_INVALID = new Set(['scheme']);

/**
 * One web.read: the page at `args.url`, or the first link of the message `args.message` names
 * (an id her `#N` resolved to: `linkOf(id)`, the caller's, resolves to a url or null), through
 * `lookup.readPage` (the SSRF-guarded fetcher, the daily web slot, no model request).
 * `invalid` (`invalid-args`) without either, (`no-link`) when that message holds no link, and
 * (`scheme`) for a url that is not http(s); `not_configured` (`not-configured`) without the
 * client or the feature (features.webLookup, read now); `failed` with `daily-cap` once the day's
 * web slots are spent, else with the page's code (`private`, `type`, `size`, `http`,
 * `timeout`, ...); `ok` with webReadText (`web.links.readChars`, read now) as its `data.text`, or
 * `.none` when the page had no text. Never throws.
 * @param {{ lookup: object|null, config: object, labels: object, guildId: string|null, args: object,
 *   linkOf?: ((messageId: string) => (string|null|Promise<string|null>))|null }} input
 * @returns {Promise<{ status: string, code?: string, data?: { text: string } }>}
 */
export async function runWebRead({ lookup, config, labels, guildId, args, linkOf = null }) {
  try {
    let url = text(args?.url);
    const messageId = text(args?.message);
    if (!url && !messageId) return { status: 'invalid', code: 'invalid-args', reason: 'args.url:required' };
    if (!lookup || typeof lookup.readPage !== 'function' || config?.features?.webLookup !== true) return { status: 'not_configured', code: 'not-configured' };
    if (!url) {
      url = text(typeof linkOf === 'function' ? await linkOf(messageId) : null);
      if (!url) return { status: 'invalid', code: 'no-link' };
    }
    if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) return { status: 'failed', code: 'daily-cap' };
    const page = await lookup.readPage(guildId, url);
    const maxChars = positiveOr(config?.web?.links?.readChars, READ_CHARS_FALLBACK);
    if (page?.ok === true) return { status: 'ok', data: { text: webReadText(page, { labels, maxChars }) } };
    const code = String(page?.reason ?? 'error');
    if (code === 'empty') {
      const l = toolLabels(labels, 'read');
      return { status: 'ok', data: { text: [l.source ? fill(l.source, { url, maxChars: String(maxChars) }) : '', l.none ?? ''].filter(Boolean).join('\n') } };
    }
    if (code === 'not-configured') return { status: 'not_configured', code };
    return { status: READ_INVALID.has(code) ? 'invalid' : 'failed', code };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}

/**
 * One memory.search: her `question`, `people`, `when` and `terms` as memorySearchPlan reads them
 * (the stored profiles for the names, `recall.maxForms`, `bot.timezone`, read now), her
 * `channel` (already an id) bounding the stretches, then `recall.run` with `quotes` -- the server
 * search of the recall runner, its daily cap and its rails, without the summary request --
 * over the turn's `history` (its lines are left out: she sees them already) and `decorate`.
 * `not_configured` without the runner or while it is not available; `not_configured`
 * (`unsupported`) in a private chat without its partner; `invalid` (`no-query`) when nothing is
 * left to search; else `ok` with memorySearchText as its `data.text`. Never throws.
 * @returns {Promise<{ status: string, code?: string, data?: { text: string } }>}
 */
export async function runMemorySearch({ recall, store, config, labels, guild, guildId, channel, partner = null, selfId = null, selfName = '', history = [], decorate = null, args, now = Date.now() }) {
  try {
    if (!recall || typeof recall.run !== 'function' || (typeof recall.available === 'function' && !recall.available())) return { status: 'not_configured', code: 'not-configured' };
    if (!guild || (!channel?.guild && !partner)) return { status: 'not_configured', code: 'unsupported' };
    const settings = recallSettings(config);
    const timezone = config?.bot?.timezone ?? 'UTC';
    const plan = memorySearchPlan({
      question: text(args?.question),
      people: text(args?.people),
      terms: text(args?.terms),
      when: text(args?.when),
      channelId: text(args?.channelId) || null,
      profiles: typeof store?.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [],
      selfId,
      selfName,
      maxForms: settings?.maxForms,
      timezone,
      now,
    });
    if (!plan) return { status: 'invalid', code: 'no-query' };
    const candidate = { id: null, content: text(args?.question) };
    const found = await recall.run({ guild, guildId, channel, partner, selfId, selfName, history, candidate, server: plan, decorate, quotes: true });
    return { status: 'ok', data: { text: memorySearchText(found?.quotes ?? [], { labels, timezone }) } };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}

/** `media.look.maxPerTurn` when missing (config.json's value). */
export const LOOK_PER_TURN_FALLBACK = 2;

/**
 * The most second looks one turn of hers may take (`media.look.maxPerTurn`, read by the caller
 * now; a whole number of at least 1, else LOOK_PER_TURN_FALLBACK). Pure.
 * @param {object} config
 * @returns {number}
 */
export function lookPerTurn(config) {
  return positiveOr(config?.media?.look?.maxPerTurn, LOOK_PER_TURN_FALLBACK);
}

/**
 * What media.look can look at in one normalized message, in the order the message shows them
 * (src/media/classify.js#collectPictures: attachments, then embeds, the forwarded parts after),
 * numbered 1.. by that order: an attached or embedded picture (`image`), a GIF (`gif`: watched
 * as a clip), a video (`video`: an attachment, or a link of a `videoSites` site --
 * collectVideos -- listed once, where it first shows; one without a preview picture after the
 * rest). Stickers are not looked at again. [] for no message. Pure.
 * @param {object|null|undefined} message
 * @param {{ videoSites?: string[] }} [options]
 * @returns {{ kind: 'image'|'gif'|'video', item: object }[]}
 */
export function lookableMedia(message, { videoSites = [] } = {}) {
  if (!message || typeof message !== 'object') return [];
  const videos = collectVideos(message, { videoSites: Array.isArray(videoSites) ? videoSites : [] });
  const videoById = new Map(videos.map((video) => [video.itemId, video]));
  const seen = new Set();
  const out = [];
  for (const item of collectPictures(message)) {
    if (!item?.itemId || seen.has(item.itemId)) continue;
    const video = videoById.get(item.itemId);
    if (video) out.push({ kind: 'video', item: video });
    else if (item.kind === 'image' || item.kind === 'gif') out.push({ kind: item.kind, item });
    else continue;
    seen.add(item.itemId);
  }
  for (const video of videos) {
    if (seen.has(video.itemId)) continue;
    seen.add(video.itemId);
    out.push({ kind: 'video', item: video });
  }
  return out;
}

/**
 * The text of a media.look result: `labels.skills.tools.look.image` for a picture, `.video` for
 * a video or a GIF (watched as a clip), each with `{name}` (the item's name) and `{question}`
 * (what was asked), then the model's answer as it gave it. A missing label adds nothing. Pure.
 * @param {{ kind: string, name?: string, question?: string, text?: string }} look
 * @param {{ labels: object }} options
 * @returns {string}
 */
export function mediaLookText({ kind, name = '', question = '', text: answer = '' }, { labels }) {
  const l = toolLabels(labels, 'look');
  const label = kind === 'image' ? l.image : l.video;
  const lines = [];
  if (label) lines.push(fill(label, { name: oneLine(name), question: oneLine(question) }));
  lines.push(String(answer ?? '').trim());
  return lines.join('\n');
}

/**
 * The describer's second look for each kind and whether its switches let it run now: a picture
 * under features.imageRelook alone (features.vision gates only pictures in the persona's own
 * request; the look runs through the vision model like a caption), a video and a GIF under video vision
 * (src/memory/youtube-check.js#isVideoVisionOn) and features.videoRewatch (a missing key counts
 * as on, each, as the describer reads them).
 */
const LOOKS = Object.freeze({
  image: { method: 'relookImage', on: (features) => features.imageRelook !== false },
  video: { method: 'rewatchVideo', on: (features, config) => isVideoVisionOn(config) && features.videoRewatch !== false },
  gif: { method: 'rewatchGif', on: (features, config) => isVideoVisionOn(config) && features.videoRewatch !== false },
});

/**
 * One media.look: the picture, GIF or video number `args.item` (1.., default 1; lookableMedia's
 * order) of the message `args.message` names (an id her `#N` resolved to; `mediaOf(id)`, the
 * caller's, gives the normalized message or null), looked at again with her `args.question` as
 * she wrote it through the describer's second look (relookImage, rewatchGif, rewatchVideo: their
 * daily counters, their cache, `llm.maxRequestsPerDay`). `invalid` (`invalid-args`) without a
 * message or a question, or with an item the message does not hold; `invalid`
 * (`unknown-message`) when the message is not one she sees, (`no-media`) when it holds nothing to
 * look at; `not_configured` (`not-configured`) without the describer or its second look for that
 * kind, or while the kind's switches are off (read now); `failed` with `daily-cap` when the
 * describer's `videoCapsLeft()` says the day's second looks are spent (a video also needs a video
 * slot, a GIF a GIF watch slot), with `turn-cap` when `takeTurnSlot()` (the caller's per-turn
 * count, asked only once every other check passed) refuses, with `error` when the second look
 * gave nothing back; else `ok` with mediaLookText as its `data.text`. Never throws.
 * @param {{ describer: object|null, config: object, labels: object, guildId: string|null, args: object,
 *   mediaOf: (messageId: string) => (object|null|Promise<object|null>), takeTurnSlot?: (() => boolean)|null }} input
 * @returns {Promise<{ status: string, code?: string, reason?: string, data?: { text: string } }>}
 */
export async function runMediaLook({ describer, config, labels, guildId, args, mediaOf, takeTurnSlot = null }) {
  try {
    const messageId = text(args?.message);
    const question = text(args?.question);
    if (!messageId) return { status: 'invalid', code: 'invalid-args', reason: 'args.message:required' };
    if (!question) return { status: 'invalid', code: 'invalid-args', reason: 'args.question:required' };
    if (!describer) return { status: 'not_configured', code: 'not-configured' };
    const message = typeof mediaOf === 'function' ? await mediaOf(messageId) : null;
    if (!message) return { status: 'invalid', code: 'unknown-message' };
    const media = lookableMedia(message, { videoSites: config?.media?.video?.sites });
    if (media.length === 0) return { status: 'invalid', code: 'no-media' };
    const given = args?.item;
    const n = given === undefined || given === null || given === '' ? 1 : Number(given);
    if (!Number.isInteger(n) || n < 1 || n > media.length) return { status: 'invalid', code: 'invalid-args', reason: 'args.item:range' };
    const { kind, item } = media[n - 1];
    const look = LOOKS[kind];
    if (!look.on(config?.features ?? {}, config) || typeof describer[look.method] !== 'function') return { status: 'not_configured', code: 'not-configured' };
    const slots = typeof describer.videoCapsLeft === 'function' ? describer.videoCapsLeft() : null;
    if (slots && (!(slots.rewatch > 0) || (kind === 'video' && !(slots.video > 0)) || (kind === 'gif' && !((slots.gif ?? Infinity) > 0)))) return { status: 'failed', code: 'daily-cap' };
    if (typeof takeTurnSlot === 'function' && !takeTurnSlot()) return { status: 'failed', code: 'turn-cap' };
    const answer = await describer[look.method](guildId, item, question);
    const said = typeof answer?.text === 'string' ? answer.text.trim() : '';
    if (!said) return { status: 'failed', code: 'error' };
    return { status: 'ok', data: { text: mediaLookText({ kind, name: item.name, question: text(answer.question) || question, text: said }, { labels }) } };
  } catch {
    return { status: 'failed', code: 'error' };
  }
}
