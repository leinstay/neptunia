// The core of tools/vision-compare.mjs: the arguments, the media list, the pick from the media
// cache, the tool-local hot view that swaps the vision and video models, one item described
// through the live describer (src/memory/describe.js) with one model, the run with its USD stop,
// the per-model summary and the HTML sheet. Exists so a candidate media model can be judged
// against the current one on the same pictures, GIFs and videos, by the very code path the
// persona's senses use, before the owner switches `models.base.vision` / `models.base.video`.
// No clock or randomness of its own: `now` is injected.

import { CliError, parseFlags } from './cli.mjs';
import { escapeHtml } from './pair.mjs';
import { costOf, percentile } from './recall-eval.mjs';
import { createDescriber } from '../../src/memory/index.js';
import { classifyAttachment, discordCdnVideo } from '../../src/media/classify.js';
import { videoSiteFor } from '../../src/media/video-sites.js';
import { PURPOSE_ROLES } from '../../src/llm/roles.js';
import { railReason } from '../../src/llm/openrouter.js';
import { onLog } from '../../src/log.js';
import { isPlainObject } from '../../src/config.js';
import { DAY_MS } from '../../src/time.js';

/** The media kinds, in the order the sheet groups them. */
export const KINDS = Object.freeze(['picture', 'gif', 'video', 'emoji', 'sticker']);
/** The `origin` of every request the tool sends. */
export const ORIGIN = 'vision-compare';
export const DEFAULT_MAX_USD = 2;
/** OpenRouter's reasoning efforts `--reasoning` accepts. */
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
/** A downloaded picture or clip larger than this is linked in the sheet, not inlined. */
export const PREVIEW_MAX_BYTES = 1_500_000;
const MAX_LABEL_CHARS = 200;
const MAX_URL_CHARS = 2000;
const MAX_ITEMS = 500;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export const USAGE =
  'usage: node tools/vision-compare.mjs <modelA> <modelB> [more models...] (--media <file.json> | --from-cache N)\n' +
  '         [--kinds picture,gif,video,emoji,sticker] [--out <file.html>] [--max-usd 2] [--reasoning <effort>]\n' +
  '         [--guild <id>] [--data <dir>]';

/**
 * The command line as `{ models, media, fromCache, kinds, out, maxUsd, reasoning, guild, data }`;
 * a CliError with the usage for anything else: fewer than two models, a model given twice or
 * not shaped like a model id, neither or both of `--media` / `--from-cache`, an unknown kind,
 * a bad number or effort.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const flags = parseFlags(argv, {
    values: ['--media', '--from-cache', '--kinds', '--out', '--max-usd', '--reasoning', '--guild', '--data'],
    usage: USAGE,
  });
  const models = flags._;
  if (models.length < 2 || new Set(models).size !== models.length || !models.every((m) => MODEL_RE.test(m)))
    throw new CliError(USAGE);
  const hasMedia = flags['--media'] !== undefined;
  const hasCache = flags['--from-cache'] !== undefined;
  if (hasMedia === hasCache) throw new CliError(`${USAGE}\n(give exactly one of --media and --from-cache)`);
  let fromCache = null;
  if (hasCache) {
    fromCache = Number(flags['--from-cache']);
    if (!Number.isInteger(fromCache) || fromCache < 1 || fromCache > MAX_ITEMS) throw new CliError(USAGE);
  }
  let kinds = [...KINDS];
  if (flags['--kinds'] !== undefined) {
    kinds = String(flags['--kinds'])
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (kinds.length === 0 || !kinds.every((k) => KINDS.includes(k)))
      throw new CliError(`${USAGE}\n(kinds: ${KINDS.join(', ')})`);
    kinds = KINDS.filter((k) => kinds.includes(k));
  }
  let maxUsd = DEFAULT_MAX_USD;
  if (flags['--max-usd'] !== undefined) {
    maxUsd = Number(flags['--max-usd']);
    if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new CliError(USAGE);
  }
  const reasoning = flags['--reasoning'] ?? null;
  if (reasoning !== null && !REASONING_EFFORTS.includes(reasoning))
    throw new CliError(`${USAGE}\n(efforts: ${REASONING_EFFORTS.join(', ')})`);
  return {
    models,
    media: hasMedia ? flags['--media'] : null,
    fromCache,
    kinds,
    out: flags['--out'] ?? null,
    maxUsd,
    reasoning,
    guild: flags['--guild'] ?? null,
    data: flags['--data'] ?? null,
  };
}

/** Whether `url` is an http(s) URL. */
function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The last path segment of `url`, decoded when it can be. */
function fileNameOf(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return '';
  }
}

/**
 * The describer's item for one listed medium, in the shape the live collectors give it
 * (src/media/classify.js#collectPictures, collectEmojiItems, collectVideos): a picture as an
 * image attachment, a GIF as a gif attachment (its URL is the animation the watch downloads),
 * an emoji and a sticker as their own kinds, a video as an attachment when the URL is a video
 * file (a Discord CDN upload or a video file name), else as a link of one of `videoSites`.
 * Null for a video URL that is neither.
 */
function describerItem(kind, url, itemId, videoSites) {
  if (kind === 'picture') return { source: 'attachment', itemId, kind: 'image', url, width: null, height: null };
  if (kind === 'gif') return { source: 'attachment', itemId, kind: 'gif', url, width: null, height: null };
  if (kind === 'emoji') return { source: 'emoji', itemId, kind: 'emoji', url, name: null };
  if (kind === 'sticker') return { source: 'sticker', itemId, kind: 'sticker', url, name: null };
  const name = fileNameOf(url);
  if (discordCdnVideo(url) || classifyAttachment({ name }) === 'video') {
    return { source: 'attachment', itemId, kind: 'video', url, name, durationSec: null, bytes: null };
  }
  const site = videoSiteFor(url, videoSites);
  if (!site) return null;
  return { source: 'link', itemId, kind: 'link', url, site, name: null, durationSec: null };
}

/**
 * The `--media` file checked: a JSON array of `{ kind, url, label? }` (kind one of KINDS, an
 * http(s) URL, an optional label of at most 200 characters; a video URL a video file or a link
 * of `videoSites`). Returns the items (`{ id, kind, url, label, item }`, `item` the describer's)
 * of the `kinds` asked for, and one problem line per bad entry (its index, never its text).
 * @param {unknown} raw
 * @param {{ videoSites?: string[], kinds?: string[] }} [options]
 * @returns {{ items: object[], errors: string[] }}
 */
export function parseMediaList(raw, { videoSites = [], kinds = KINDS } = {}) {
  if (!Array.isArray(raw)) return { items: [], errors: ['the media file must be a JSON array'] };
  if (raw.length > MAX_ITEMS) return { items: [], errors: [`the media file holds more than ${MAX_ITEMS} entries`] };
  const items = [];
  const errors = [];
  raw.forEach((entry, index) => {
    const at = `entry ${index}`;
    if (!isPlainObject(entry)) return errors.push(`${at}: not an object`);
    if (!KINDS.includes(entry.kind)) return errors.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (typeof entry.url !== 'string' || entry.url.length > MAX_URL_CHARS || !isHttpUrl(entry.url))
      return errors.push(`${at}: url must be an http(s) URL`);
    if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > MAX_LABEL_CHARS)) {
      return errors.push(`${at}: label must be a string of at most ${MAX_LABEL_CHARS} characters`);
    }
    const id = `item-${index + 1}`;
    const item = describerItem(entry.kind, entry.url, `${ORIGIN}:${id}`, videoSites);
    if (!item) return errors.push(`${at}: a video url must be a video file or a link of media.video.sites`);
    if (!kinds.includes(entry.kind)) return undefined;
    items.push({ id, kind: entry.kind, url: entry.url, label: entry.label ?? null, item });
    return undefined;
  });
  return { items, errors };
}

/** A media cache entry's last use: `usedAt` or `ts`, whichever is later; -Infinity when neither. */
function lastUseOf(entry) {
  const times = [entry?.usedAt, entry?.ts].filter((v) => typeof v === 'number' && Number.isFinite(v));
  return times.length > 0 ? Math.max(...times) : -Infinity;
}

// A gif embed's per-message item id and an attachment's snowflake (src/memory/gif-recache.js).
const EMBED_ID_RE = /#e\d+$/;
const ATTACHMENT_ID_RE = /^\d+$/;

/**
 * The kind of one media cache entry (src/memory/describe.js's keys), or null for anything the
 * tool does not compare: a miss, an entry without a text, a question's answer (`:q:`), a web
 * entry. `video:<item id>` other than a `video:url:` thumbnail is a watched video; an entry
 * marked `gif` a GIF; `emoji:` and `sticker:` their kinds; an attachment, a gif embed, a
 * `link:` or `video:url:` thumbnail a picture.
 * @param {string} key
 * @param {object} entry
 * @returns {string|null}
 */
export function cacheKind(key, entry) {
  if (
    typeof key !== 'string' ||
    !isPlainObject(entry) ||
    entry.miss ||
    typeof entry.text !== 'string' ||
    !entry.text.trim()
  )
    return null;
  if (key.includes(':q:')) return null;
  if (key.startsWith('video:') && !key.startsWith('video:url:')) return entry.watched === true ? 'video' : null;
  if (entry.gif === true) return 'gif';
  if (key.startsWith('emoji:')) return 'emoji';
  if (key.startsWith('sticker:')) return 'sticker';
  if (ATTACHMENT_ID_RE.test(key) || EMBED_ID_RE.test(key) || key.startsWith('link:') || key.startsWith('video:url:'))
    return 'picture';
  return null;
}

/**
 * `n` recent media cache entries spread across `kinds`: each kind's entries newest first (by
 * their last use), taken one per kind in turn (in the order of KINDS) until `n` are picked or
 * every kind is spent. Returns `{ key, kind, itemId, ts, usedAt }`: `itemId` the describer's id
 * (a video's without its `video:` prefix). The cache is only read.
 * @param {object} cache  The guild's media cache.
 * @param {{ n: number, kinds?: string[] }} options
 * @returns {{ key: string, kind: string, itemId: string, ts: number|null, usedAt: number }[]}
 */
export function pickFromCache(cache, { n, kinds = KINDS }) {
  const byKind = new Map(kinds.map((kind) => [kind, []]));
  for (const [key, entry] of Object.entries(cache ?? {})) {
    const kind = cacheKind(key, entry);
    if (!kind || !byKind.has(kind)) continue;
    byKind.get(kind).push({
      key,
      kind,
      itemId: kind === 'video' ? key.slice('video:'.length) : key,
      ts: Number.isFinite(entry.ts) ? entry.ts : null,
      usedAt: lastUseOf(entry),
    });
  }
  for (const list of byKind.values()) list.sort((a, b) => b.usedAt - a.usedAt);
  const picked = [];
  const order = KINDS.filter((kind) => byKind.has(kind));
  for (let round = 0; picked.length < n; round += 1) {
    let took = false;
    for (const kind of order) {
      const next = byKind.get(kind)[round];
      if (!next || picked.length >= n) continue;
      picked.push(next);
      took = true;
    }
    if (!took) break;
  }
  return picked;
}

/**
 * The record window the picked entries' messages are looked for in: from a day before the
 * oldest write time (`ts`, else the last use) of the picked entries that are not emoji.
 * @param {{ kind: string, ts: number|null, usedAt: number }[]} picked
 * @param {number} nowMs
 */
export function lookupSince(picked, nowMs) {
  const times = picked
    .filter((p) => p.kind !== 'emoji')
    .map((p) => (Number.isFinite(p.ts) ? p.ts : p.usedAt))
    .filter(Number.isFinite);
  return (times.length > 0 ? Math.min(...times) : nowMs) - DAY_MS;
}

/**
 * The tool's own view over the live hot view: the same prompts, and a config whose
 * `models.base.vision` and `models.base.video` are `model` (every `models.byPurpose` entry of a vision or
 * video purpose dropped, so it cannot pin another model), with media descriptions and video
 * descriptions switched on. Built fresh on every read from `base.config`, which is never
 * changed: the live config of this process stays as it is.
 * @param {{ config: object, prompts: object }} base
 * @param {{ model: string }} options
 * @returns {{ readonly config: object, readonly prompts: object }}
 */
export function toolHot(base, { model }) {
  return {
    get config() {
      const live = base.config ?? {};
      const models = isPlainObject(live.models) ? live.models : {};
      const baseModels = isPlainObject(models.base) ? models.base : {};
      const byPurpose = isPlainObject(models.byPurpose)
        ? Object.fromEntries(
            Object.entries(models.byPurpose).filter(
              ([purpose]) => !['vision', 'video'].includes(PURPOSE_ROLES[purpose])
            )
          )
        : undefined;
      return {
        ...live,
        models: {
          ...models,
          base: { ...baseModels, vision: model, video: model },
          ...(byPurpose ? { byPurpose } : {}),
        },
        features: { ...(live.features ?? {}), mediaDescriptions: true, videoDescriptions: true },
      };
    },
    get prompts() {
      return base.prompts;
    },
  };
}

/** The reason code a describer log line carries for a failure, or null (src/memory/describe.js's lines). */
function failureCode(entry) {
  if (entry?.msg === 'describe: failed') return entry.reason ?? 'failed';
  if (entry?.msg === 'describe: video' && entry.state !== 'watched') return entry.reason ?? entry.state ?? 'error';
  return null;
}

/**
 * One item described with one model, through the live describer exactly as the bot reaches it
 * for that kind: `describe()` for a picture, an emoji, a sticker and a GIF (which watches the GIF
 * first and falls back to one frame, as live), `describeVideo(..., { force: true })` for a video.
 * The describer gets toolHot's view, an empty in-memory media cache and throwaway daily counters
 * of its own (nothing read from or written to data/), and a client wrapper that marks every
 * request `origin: vision-compare`, outside `llm.maxRequestsPerDay`, never calibrated, no
 * prompt-cache marker, with `{ effort: reasoning }` when given, and sums usage and cost.
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.base  The live hot view (read only).
 * @param {string} deps.model
 * @param {{ kind: string, item: object }} deps.entry  One parsed or resolved item.
 * @param {string} deps.guildId
 * @param {{ complete: Function }} deps.llm  The OpenRouter client (src/llm/openrouter.js) or a fake.
 * @param {string|null} [deps.reasoning]
 * @param {object} [deps.imageFetcher]  src/media/fetch-image.js shape; the live one when absent.
 * @param {object} [deps.videoFetcher]  src/media/fetch-video.js shape; the live one when absent.
 * @param {string|null} [deps.youtubeApiKey]
 * @param {() => number} [deps.now]
 * @returns {Promise<{ model: string, ok: boolean, text: string|null, error: string|null, mode: string|null,
 *   latencyMs: number, requests: number, promptTokens: number, completionTokens: number, costUsd: number,
 *   sentModels: string[], preview: { dataUrl: string, contentType: string }|null }>}
 */
export async function describeOne({
  base,
  model,
  entry,
  guildId,
  llm,
  reasoning = null,
  imageFetcher,
  videoFetcher,
  youtubeApiKey = null,
  now = Date.now,
}) {
  const hot = toolHot(base, { model });
  const cache = {};
  const store = { getMediaCache: () => cache, markMediaCacheDirty() {} };
  const state = { data: {}, markDirty() {} };
  const usage = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const sentModels = new Set();
  let requestFailure = null;
  let preview = null;
  const keepPreview = (got, fallbackType) => {
    if (preview || !got?.dataUrl || !(Number(got.bytes) > 0) || got.bytes > PREVIEW_MAX_BYTES) return;
    preview = { dataUrl: got.dataUrl, contentType: got.contentType ?? fallbackType };
  };
  const toolLlm = {
    capLeft: () => Infinity,
    async complete(messages, options = {}) {
      sentModels.add(options.model ?? null);
      try {
        const completion = await llm.complete(messages, {
          ...options,
          ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
          origin: ORIGIN,
          countAgainstDailyCap: false,
          skipCalibration: true,
          cache: false,
        });
        usage.requests += 1;
        usage.promptTokens += Number(completion?.usage?.prompt_tokens) || 0;
        usage.completionTokens += Number(completion?.usage?.completion_tokens) || 0;
        usage.costUsd += costOf(completion?.usage);
        return completion;
      } catch (err) {
        usage.requests += 1;
        requestFailure = railReason(
          err,
          Number.isFinite(err?.statusCode) ? `http-${err.statusCode}` : 'request-failed'
        );
        throw err;
      }
    },
  };
  const deps = { hot, store, llm: toolLlm, state, now, youtubeApiKey };
  if (imageFetcher) {
    deps.imageFetcher = {
      async fetchAsDataUrl(url, options) {
        const got = await imageFetcher.fetchAsDataUrl(url, options);
        keepPreview(got, 'image/png');
        return got;
      },
    };
  }
  if (videoFetcher) {
    deps.videoFetcher = {
      ...videoFetcher,
      async fetchGif(...args) {
        const got = await videoFetcher.fetchGif(...args);
        if (got?.ok) keepPreview(got, 'video/mp4');
        return got;
      },
    };
  }
  const describer = createDescriber(deps);
  const { item } = entry;
  let logged = null;
  let gifWatch = null;
  const off = onLog((line) => {
    const code = failureCode(line);
    if (code) logged = code;
    if (line?.msg === 'describe: gif') gifWatch = line.state === 'watched' ? null : (line.reason ?? line.state ?? null);
  });
  const started = now();
  let result = null;
  let thrown = null;
  try {
    if (entry.kind === 'video') result = await describer.describeVideo(guildId, item, { force: true });
    else result = await describer.describe(guildId, item);
  } catch (err) {
    thrown = err?.name ?? 'Error';
  } finally {
    off();
  }
  const latencyMs = now() - started;
  const watched = entry.kind === 'video' ? result?.state === 'watched' : true;
  const text = watched && typeof result?.text === 'string' && result.text ? result.text : null;
  let mode = null;
  if (entry.kind === 'gif' && text) {
    const cached = cache[item.itemId];
    mode = cached?.watched === true ? 'watched' : gifWatch ? `one frame (watch: ${gifWatch})` : 'one frame';
  }
  let error = null;
  if (!text) {
    const blocker = entry.kind === 'video' ? null : describer.pictureBlocker();
    const videoState =
      entry.kind === 'video' && result?.state && result.state !== 'watched' ? (result.reason ?? result.state) : null;
    // The describer's own code names the stage; a generic request failure is named by its status.
    const stage = logged === 'llm-error' && requestFailure ? requestFailure : logged;
    error = thrown ?? stage ?? requestFailure ?? videoState ?? blocker ?? 'no-result';
    if (entry.kind === 'gif' && gifWatch) error = `${error} (watch: ${gifWatch})`;
  }
  return { model, ok: Boolean(text), text, error, mode, latencyMs, ...usage, sentModels: [...sentModels], preview };
}

/**
 * Every item with every model, one request at a time, in order. Before each item the cost so
 * far is checked: once it has passed `maxUsd` the run stops and the rest are counted as skipped.
 * `runOne(model, item)` resolves a describeOne result; a throw becomes a failed cell with the
 * error's name.
 * @param {{ items: object[], models: string[], maxUsd: number, runOne: Function, onCell?: Function }} input
 * @returns {Promise<{ rows: { item: object, cells: object[], preview: object|null }[], spentUsd: number,
 *   stopped: string|null, skipped: number }>}
 */
export async function runComparison({ items, models, maxUsd, runOne, onCell = () => {} }) {
  const rows = [];
  let spentUsd = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (spentUsd > maxUsd) return { rows, spentUsd, stopped: 'max-usd', skipped: items.length - i };
    const item = items[i];
    const cells = [];
    for (const model of models) {
      let cell;
      try {
        cell = await runOne(model, item);
      } catch (err) {
        cell = {
          model,
          ok: false,
          text: null,
          error: err?.name ?? 'Error',
          mode: null,
          latencyMs: null,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          preview: null,
        };
      }
      spentUsd += Number.isFinite(cell.costUsd) ? cell.costUsd : 0;
      cells.push(cell);
      onCell(item, cell, i);
    }
    const preview = cells.find((cell) => cell.preview)?.preview ?? null;
    rows.push({ item, cells: cells.map(({ preview: _drop, ...cell }) => cell), preview });
  }
  return { rows, spentUsd, stopped: null, skipped: 0 };
}

/**
 * Per model: items, failures, total cost, median latency, prompt and completion tokens.
 * @param {{ cells: object[] }[]} rows
 * @param {string[]} models
 */
export function summarizeModels(rows, models) {
  return models.map((model) => {
    const cells = rows.map((row) => row.cells.find((cell) => cell.model === model)).filter(Boolean);
    const sum = (key) => cells.reduce((total, cell) => total + (Number.isFinite(cell[key]) ? cell[key] : 0), 0);
    return {
      model,
      items: cells.length,
      failures: cells.filter((cell) => !cell.ok).length,
      costUsd: Math.round(sum('costUsd') * 1e6) / 1e6,
      medianLatencyMs: percentile(
        cells.map((cell) => cell.latencyMs),
        50
      ),
      promptTokens: sum('promptTokens'),
      completionTokens: sum('completionTokens'),
    };
  });
}

const CSS =
  ':root{--bg:#f6f6f4;--fg:#1d1d1b;--card:#fff;--mut:#666;--line:#ddd;--bad:#b3261e}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#e8e8e6;--card:#262628;--mut:#9a9a9a;--line:#3a3a3c;--bad:#f2b8b5}}' +
  'body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px}' +
  'section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}' +
  '.media img,.media video{max-width:100%;width:auto;max-height:220px;border-radius:6px}' +
  '.row{display:flex;gap:14px;flex-wrap:wrap}.col{flex:1 1 260px;min-width:0}' +
  'h4{margin:8px 0 4px;color:var(--mut);font-size:13px;overflow-wrap:anywhere}h3{margin:0 0 8px;font-size:15px;overflow-wrap:anywhere}' +
  'p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit;overflow-wrap:anywhere}.note,.meta{color:var(--mut)}.meta{font-size:12px;margin-top:4px}' +
  '.err{color:var(--bad)}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}' +
  'th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap}';

/** A data: URL is inlined only when it is a picture or a video one; anything else is not trusted as a source. */
function safeDataUrl(preview) {
  const url = String(preview?.dataUrl ?? '');
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/=]+$/.exec(url);
  return match ? { url, type: match[1] } : null;
}

/** A link to `url` when it is http(s), else nothing. */
function linkHtml(url, text) {
  return isHttpUrl(url)
    ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(text)}</a>`
    : '';
}

/** The media cell of one row: the inlined picture or clip the describer downloaded, else a link. */
function mediaHtml(row) {
  const data = safeDataUrl(row.preview);
  const link = linkHtml(row.item.url, row.item.kind === 'video' ? 'open the video' : 'open');
  if (data?.type.startsWith('video/'))
    return `<video src="${data.url}" muted loop autoplay playsinline controls></video><div class="meta">${link}</div>`;
  if (data) return `<img src="${data.url}" alt=""><div class="meta">${link}</div>`;
  return link;
}

/** A number for the sheet, `-` when unknown. */
function fmt(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

/** One model's cell: the description (or the error code), the GIF mode, latency, tokens and cost. */
function cellHtml(cell) {
  const body = cell.ok
    ? `<p>${escapeHtml(cell.text)}</p>`
    : `<p class="err">error: ${escapeHtml(cell.error ?? 'unknown')}</p>`;
  const mode = cell.mode ? `<div class="meta">${escapeHtml(cell.mode)}</div>` : '';
  const meta = `<div class="meta">${fmt(cell.latencyMs)} ms · ${fmt(cell.promptTokens)} + ${fmt(cell.completionTokens)} tokens · ${fmt(cell.costUsd, 4)} USD</div>`;
  return `<div class="col"><h4>${escapeHtml(cell.model)}</h4>${body}${mode}${meta}</div>`;
}

/**
 * The whole sheet: one self-contained HTML page (inline CSS, no script, readable on a phone).
 * A summary table per model, then the items grouped by kind, each with its preview and one
 * column per model. Every text from outside (labels, descriptions, error codes, model ids,
 * URLs) is escaped; a preview is inlined only as a picture or video data: URL.
 * @param {{ at: string, models: string[], rows: object[], summary: object[], stopped?: string|null,
 *   skipped?: number, source: string, reasoning?: string|null, notes?: string[] }} input
 * @returns {string}
 */
export function renderHtml({
  at,
  models,
  rows,
  summary,
  stopped = null,
  skipped = 0,
  source,
  reasoning = null,
  notes = [],
}) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vision comparison</title><style>${CSS}</style></head><body>`;
  const facts = [`${escapeHtml(at)}`, `source: ${escapeHtml(source)}`, `${rows.length} item(s)`];
  if (reasoning) facts.push(`reasoning: ${escapeHtml(reasoning)}`);
  if (stopped)
    facts.push(`<span class="err">stopped: ${escapeHtml(stopped)}, ${fmt(skipped)} item(s) not described</span>`);
  const intro = `<h1>${models.map(escapeHtml).join(' vs ')}</h1><p class="note">${facts.join(' · ')}</p>${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}`;
  const table =
    '<section><h3>Summary</h3><div class="wrap"><table><thead><tr><th>model</th><th>items</th><th>failures</th><th>total USD</th><th>median ms</th><th>prompt tokens</th><th>completion tokens</th></tr></thead><tbody>' +
    summary
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.model)}</td><td>${fmt(s.items)}</td><td>${fmt(s.failures)}</td><td>${fmt(s.costUsd, 4)}</td><td>${fmt(s.medianLatencyMs)}</td><td>${fmt(s.promptTokens)}</td><td>${fmt(s.completionTokens)}</td></tr>`
      )
      .join('') +
    '</tbody></table></div></section>';
  const groups = KINDS.map((kind) => {
    const list = rows.filter((row) => row.item.kind === kind);
    if (list.length === 0) return '';
    const sections = list
      .map(
        (row) =>
          `<section><h3>${escapeHtml(row.item.label ?? row.item.id)}</h3><div class="media">${mediaHtml(row)}</div><div class="row">${row.cells.map(cellHtml).join('')}</div></section>`
      )
      .join('');
    return `<h2>${escapeHtml(kind)}</h2>${sections}`;
  }).join('');
  return `${head}${intro}${table}${groups}</body></html>\n`;
}
