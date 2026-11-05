// The media pick: after the reply is written, its first message, when short, goes with its context to a cheap classifier
// (prompts/media-pick.md) with the candidates the engine found for it. The classifier chooses one or answers `none`,
// which is the normal result; a chosen GIF is posted in place of that message and the rest follow as written
// (src/turn/act.ts). Whether the pick runs at all is what the interface declares (src/interface/capabilities.ts). This
// module holds its settings, its candidate search over the shared library (src/memory/gifs.ts), its one request and the
// reading of its one-line answer. It never rewrites her words: the act posts what comes back. Every failure is `none`.

import { isPlainObject } from '../config.ts';
import { fill, formatDuration, replyMarker } from '../format.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { gifPostForm } from '../media/gif-post.ts';
import { gifsOfPlace, searchGifs } from '../memory/gifs.ts';
import { HOUR_MS } from '../time.ts';
import { block, classifierTranscript, fillPromptTemplate } from './prompt.ts';
import type { GifEntry } from '../memory/gifs.ts';
import type { MediaPickCapability } from '../protocol/adapter.ts';
import type { Untyped } from '../tools/types.ts';

/**
 * The pick's measures. `maxChars` is the longest message in code points it may stand in for, `contextMessages` the last
 * chat lines its `<context>` shows, `graceMs` how long the first message, once its typing imitation is over, still waits
 * for the answer. The rest are `media.pick.*` in config/config.json, and this is their fallback.
 */
export const MEDIA_PICK_DEFAULTS = Object.freeze({
  maxChars: 160,
  contextMessages: 4,
  maxOutputTokens: 60,
  graceMs: 1000,
  candidates: 20,
  emojiCandidates: 20,
  emojiPerReplies: 5,
  emojiCooldownMinutes: 60,
});

/** How long, in hours, a GIF she posted counts as recent for the pick. */
const OWN_MARK_HOURS = 24;
/** The longest caption a candidate line carries. */
const CAPTION_CHARS = 180;

/** The pick's settings, read from the whole live config at the moment of use. */
export type MediaPickSettings = {
  maxChars: number;
  contextMessages: number;
  maxOutputTokens: number;
  graceMs: number | null;
  candidates: number;
  emojiCandidates: number;
  emojiPerReplies: number;
  emojiCooldownMinutes: number;
};

/**
 * The pick's settings: MEDIA_PICK_DEFAULTS with `media.pick.*` read from the live config (floored; a rail takes 0, which
 * switches it off, and the others are above 0; a missing or unusable value takes the default).
 * @param config  The whole live config.
 */
export function mediaPickSettings(config: Record<string, Untyped>): MediaPickSettings {
  const pick: unknown = (config?.media as { pick?: unknown } | undefined)?.pick;
  const group = (isPlainObject(pick) ? pick : {}) as Record<string, unknown>;
  const read = (
    key: 'maxOutputTokens' | 'candidates' | 'emojiCandidates' | 'emojiPerReplies' | 'emojiCooldownMinutes',
    min: number
  ): number => {
    const value = group[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min
      ? Math.floor(value)
      : MEDIA_PICK_DEFAULTS[key];
  };
  return {
    maxChars: MEDIA_PICK_DEFAULTS.maxChars,
    contextMessages: MEDIA_PICK_DEFAULTS.contextMessages,
    maxOutputTokens: read('maxOutputTokens', 1),
    graceMs: MEDIA_PICK_DEFAULTS.graceMs,
    candidates: read('candidates', 1),
    emojiCandidates: read('emojiCandidates', 1),
    emojiPerReplies: read('emojiPerReplies', 0),
    emojiCooldownMinutes: read('emojiCooldownMinutes', 0),
  };
}

/** What a request offered, which an answer must stay inside. */
export type MediaPickOffer = {
  gifs: ReadonlyArray<string>;
  emoji: ReadonlyArray<string>;
  actions: ReadonlyArray<string>;
};

/** An answer read. */
export type MediaPickAnswer = { kind: 'none' } | { kind: 'gif'; handle: string };

const NONE = { kind: 'none' } as const;

/** What a place keeps for the emoji rails: the plain replies since its last emoji, and when each emoji last went out. */
export type EmojiRails = { repliesSince?: number; lastUsed: Record<string, number> };

/** The member of `listed` that equals `wanted` in any case, as it is listed. */
function listed(wanted: string, list: ReadonlyArray<string>): string | undefined {
  const lower = wanted.toLowerCase();
  return list.find((item) => String(item).toLowerCase() === lower);
}

/**
 * The classifier's answer read strictly: one line of `none` or `gif <handle>` naming what was offered, in any case and
 * spacing. Anything else is `none`. Pure.
 */
export function parseMediaPick(text: unknown, offer: MediaPickOffer): MediaPickAnswer {
  if (typeof text !== 'string') return NONE;
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) return NONE;
  const words = line.split(/\s+/);
  if (words.length !== 2) return NONE;
  const [form, name] = words;
  if (form.toLowerCase() === 'gif') {
    const handle = listed(name, offer.gifs);
    return handle === undefined ? NONE : { kind: 'gif', handle };
  }
  return NONE;
}

/**
 * The chat lines of the pick's `<context>`, oldest first: the last `contextMessages` lines of `history`, and before them
 * the line the reply answers (`answeredId`) when it is in `history` but older than those; with `answeredIndex` its
 * 1-based place among the returned lines (the `#n` the transcript gives it), or null when the answered line is unknown
 * or not in `history`. `contextMessages` 0 -> no lines at all. Pure.
 * @param history  The turn's chat lines, oldest first (each with an `id`).
 */
export function pickContext<Line extends { id?: unknown }>(
  history: ReadonlyArray<Line>,
  { contextMessages, answeredId = null }: { contextMessages: number; answeredId?: string | null }
): { messages: Array<Line>; answeredIndex: number | null } {
  const lines: ReadonlyArray<Line> = Array.isArray(history) ? history : [];
  if (!(contextMessages > 0) || lines.length === 0) return { messages: [], answeredIndex: null };
  const last = lines.slice(-contextMessages);
  const answered = answeredId == null ? null : lines.find((message) => message?.id === answeredId);
  if (!answered) return { messages: last, answeredIndex: null };
  const inLast = last.indexOf(answered);
  if (inLast !== -1) return { messages: last, answeredIndex: inLast + 1 };
  return { messages: [answered, ...last], answeredIndex: 1 };
}

/** The labels the pick reads. */
type PickLabels = {
  gifs?: { entry?: string; entryNoText?: string; ownMark?: string } | null;
  transcript?: { replyTo?: unknown } | null;
  units?: Parameters<typeof formatDuration>[1];
} & Record<string, unknown>;

/** A candidate's line of `<gifs>`: its handle and its caption. */
function gifCandidateLine(entry: GifEntry, labels: PickLabels): string {
  const template = labels.gifs?.entry ?? '{id}: {text}';
  return fill(template, { id: entry.id, text: clampWithEllipsis(entry.caption ?? '', CAPTION_CHARS) });
}

/** The `<gifs_recent>` lines: the listed GIFs she posted in this place lately, newest first, with how long ago. */
function recentGifLines(
  gifs: unknown,
  placeId: string,
  handles: ReadonlyArray<string>,
  labels: PickLabels,
  now: number
): Array<string> {
  const mark = labels.gifs?.ownMark;
  if (!mark || !labels.units) return [];
  const units = labels.units;
  const shown = new Set(handles);
  return gifsOfPlace(gifs, placeId)
    .filter(
      (entry) =>
        shown.has(entry.id) &&
        typeof entry.ownLast === 'number' &&
        Math.max(0, now - entry.ownLast) <= OWN_MARK_HOURS * HOUR_MS
    )
    .sort((one, two) => (two.ownLast ?? 0) - (one.ownLast ?? 0))
    .map(
      (entry) => `${entry.id} ${fill(mark, { ago: formatDuration(Math.max(0, now - (entry.ownLast ?? 0)), units) })}`
    );
}

/** The store as the pick reads it. */
type PickStore = {
  getGifs?: () => unknown;
  getEmojiRails?: (placeId: string) => unknown;
  setEmojiRails?: (placeId: string, state: EmojiRails) => unknown;
};

/** The language model client as the pick calls it. */
type PickLlm = {
  complete: (messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => Promise<unknown>;
};

/** What one pick reads of the turn. */
export type MediaPickArgs = {
  placeId: string;
  conversationId: string;
  capability: MediaPickCapability | null;
  messages: ReadonlyArray<{ text: string; replyTo?: number | null }>;
  history: ReadonlyArray<{ id?: string } & object>;
  selfName: string;
  idByIndex?: ReadonlyMap<number, string>;
  trigger?: { id?: string } | null;
};

/** What the act does with the pick: nothing, or post this GIF in place of the first message. */
export type MediaPickResult =
  { kind: 'none' } | { kind: 'gif'; entry: GifEntry & { key: string }; replyTo: number | null };

/** The completion's text, when the client answered with one. */
function textOf(completion: unknown): unknown {
  // The client answers a record whose `text` is the model's words.
  return (completion as { text?: unknown } | null | undefined)?.text;
}

export type MediaPick = {
  pick: (args: MediaPickArgs) => Promise<MediaPickResult>;
};

/**
 * The media pick over the live config and prompts. `embedQuery` is the embedder of the candidate search: absent or
 * failing, the search reads the caption's words alone.
 */
export function createMediaPick({
  hot,
  store,
  llm,
  clock,
  embedQuery = null,
}: {
  hot: { readonly config: Record<string, Untyped>; readonly prompts: Record<string, unknown> };
  store: PickStore;
  llm: PickLlm;
  clock: () => number;
  embedQuery?: ((text: string) => Promise<ArrayLike<number> | null>) | null;
}): MediaPick {
  /** The vector of the search's query; a failure leaves the words alone. */
  async function queryVector(text: string, conversationId: string): Promise<ArrayLike<number> | null> {
    if (!embedQuery) return null;
    try {
      return await embedQuery(text);
    } catch (err) {
      log.info('media-pick: no vector', { channel: conversationId, reason: railReason(err) });
      return null;
    }
  }

  /** The chat lines of the request and the mark of the line the first message answers, with what to search by. */
  function contextOf(args: MediaPickArgs, settings: MediaPickSettings, labels: PickLabels) {
    const { history, selfName, messages } = args;
    const { idByIndex = new Map<number, string>(), trigger = null } = args;
    const first = messages[0];
    // The line the first message answers: its reply target (a pulled line is not in `history`), else the trigger.
    const replyId =
      first.replyTo !== null && first.replyTo !== undefined ? (idByIndex.get(first.replyTo) ?? null) : null;
    const context = pickContext(history as ReadonlyArray<{ id?: string; content?: unknown }>, {
      contextMessages: settings.contextMessages,
      answeredId: replyId ?? trigger?.id ?? null,
    });
    const answered = context.answeredIndex === null ? null : context.messages[context.answeredIndex - 1];
    const body =
      context.messages.length > 0
        ? classifierTranscript(context.messages, { config: hot.config, selfName, labels })
        : '';
    // The reply is marked as a transcript line replying to that line would be: its #n, author and a quote.
    const mark =
      answered && labels.transcript?.replyTo
        ? replyMarker(answered, context.answeredIndex as number, { labels, selfName })
        : '';
    const query = [first.text, typeof answered?.content === 'string' ? answered.content : ''].join('\n').trim();
    return { body, mark, query };
  }

  /** The candidates the library has for the query, in a form the interface takes. */
  async function gifCandidates(query: string, args: MediaPickArgs, settings: MediaPickSettings) {
    const forms = args.capability?.gifForms ?? [];
    const library = store.getGifs?.() ?? null;
    if (forms.length === 0 || !library) return { library, candidates: [] };
    const found = searchGifs(library, {
      words: query,
      vector: await queryVector(query, args.conversationId),
      cap: settings.candidates,
      accept: (entry) => gifPostForm(entry, forms) !== null,
    });
    return { library, candidates: found.map(({ entry }) => entry) };
  }

  /** The classifier's words, or null when the request failed. */
  async function askClassifier(system: string, user: string, settings: MediaPickSettings, conversationId: string) {
    const config = hot.config;
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'media-pick'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'media-pick',
          }),
        }
      );
      return textOf(completion);
    } catch (err) {
      log.warn('media-pick: failed', {
        channel: conversationId,
        reason: railReason(err),
        // A thrown value is anything; an HTTP error of the client carries its status.
        status: (err as { statusCode?: unknown } | null)?.statusCode ?? null,
      });
      return null;
    }
  }

  async function pickNow(args: MediaPickArgs): Promise<MediaPickResult> {
    const { placeId, conversationId, capability, messages, selfName } = args;
    const prompt = hot.prompts?.['media-pick'];
    const labels = hot.prompts?.labels as PickLabels | undefined;
    const first = messages[0];
    if (!capability || typeof prompt !== 'string' || prompt.trim() === '' || !labels) return NONE;
    if (!first || typeof first.text !== 'string' || first.text.trim() === '') return NONE;
    const settings = mediaPickSettings(hot.config);
    if ([...first.text].length > settings.maxChars) return NONE;
    const { body, mark, query } = contextOf(args, settings, labels);
    const { library, candidates } = await gifCandidates(query, args, settings);
    if (candidates.length === 0) return NONE;
    const handles = candidates.map((entry) => entry.id);
    const user = [
      block('gifs', candidates.map((entry) => gifCandidateLine(entry, labels)).join('\n')),
      block('gifs_recent', recentGifLines(library, placeId, handles, labels, clock()).join('\n')),
      block('context', body),
      block('reply', mark ? `${mark} ${first.text}` : first.text),
    ]
      .filter(Boolean)
      .join('\n\n');
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const words = await askClassifier(system, user, settings, conversationId);
    const answer = parseMediaPick(words, { gifs: handles, emoji: [], actions: [] });
    log.info('media-pick: answered', { channel: conversationId, kind: answer.kind, gifs: handles.length });
    if (answer.kind === 'gif') {
      const entry = candidates.find((candidate) => candidate.id === answer.handle);
      if (entry) return { kind: 'gif', entry, replyTo: first.replyTo ?? null };
    }
    return NONE;
  }

  /** The pick that never rejects: an unexpected failure posts the messages as written. */
  function pick(args: MediaPickArgs): Promise<MediaPickResult> {
    return pickNow(args).catch((err: unknown) => {
      log.warn('media-pick: failed', { channel: args.conversationId, error: err });
      return NONE;
    });
  }

  return { pick };
}
