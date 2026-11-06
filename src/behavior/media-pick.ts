// The media pick: after the reply is written, its first message, when short, goes with its context to a cheap classifier
// (prompts/media-pick.md) with the candidates the engine found for it: GIFs of the shared library and the custom emoji
// the place uses most. The classifier chooses one or answers `none`, which is the normal result. A chosen GIF is posted
// in place of that message, an emoji appended to it or posted in its place, and the rest follow as written (src/turn/act.ts).
// Whether the pick runs at all, and which of the forms, is what the interface declares (src/interface/capabilities.ts).
// This module holds its settings, its candidate search over the library (src/memory/gifs.ts), the emoji rails per place,
// its one request and the reading of its JSON answer. Every failure is `none`.

import { isPlainObject } from '../config.ts';
import { fill, formatDuration, replyMarker } from '../format.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { strictJsonObject } from '../llm/parse.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { gifPostForm } from '../media/gif-post.ts';
import type { GifForm } from '../media/gif-post.ts';
import { EMOJI_HALF_LIFE_DAYS, rankEmojiUsage } from '../memory/emoji-usage.ts';
import { gifsOfPlace, searchGifs } from '../memory/gifs.ts';
import { HOUR_MS, MINUTE_MS } from '../time.ts';
import { block, classifierTranscript, fillPromptTemplate } from './prompt.ts';
import type { GifEntry } from '../memory/gifs.ts';
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

/** The embedding model of the pick's query and of the captions it is compared with: one model, or no comparing. */
export function gifVectorModel(config: unknown): string | null {
  return roleModel(config, 'embedding', 'recall-query') ?? null;
}

/** What a request offered, which an answer must stay inside. */
export type MediaPickOffer = {
  gifs: ReadonlyArray<string>;
  emoji: ReadonlyArray<string>;
  actions: ReadonlyArray<string>;
};

/** An answer read. */
export type MediaPickAnswer =
  | { kind: 'none' }
  | { kind: 'gif'; handle: string }
  | { kind: 'emoji'; name: string }
  | { kind: 'replace'; name: string };

const NONE = { kind: 'none' } as const;

/** What a place keeps for the emoji rails: the plain replies since its last emoji, and when each emoji last went out. */
export type EmojiRails = { repliesSince?: number; lastUsed: Record<string, number> };

/** The member of `listed` that equals `wanted` in any case, as it is listed. */
function listed(wanted: string, list: ReadonlyArray<string>): string | undefined {
  const lower = wanted.toLowerCase();
  return list.find((item) => String(item).toLowerCase() === lower);
}

/**
 * The schema of the pick's answer for one request, handed to the client as `responseFormat`:
 * `{ "pick": "none" | "gif" | "emoji" | "replace", "name": string | null }`, with `name` one of the GIF handles and emoji
 * names `offer` holds. Pure.
 */
export function mediaPickFormat(offer: MediaPickOffer): { name: string; schema: object } {
  const names = [...new Set([...offer.gifs, ...offer.emoji].map(String))];
  return {
    name: 'media-pick',
    schema: {
      type: 'object',
      properties: {
        pick: { type: 'string', enum: ['none', 'gif', 'emoji', 'replace'] },
        name: { type: ['string', 'null'], enum: [...names, null] },
      },
      required: ['pick', 'name'],
      additionalProperties: false,
    },
  };
}

/**
 * The classifier's answer read strictly: the JSON object of mediaPickFormat, whose `pick` is `gif` with a handle of
 * `offer`, `emoji` or `replace` with an emoji name of `offer` and an action the interface supports, or `none`. Anything
 * else is `none`, text that is not the object included. Pure.
 */
export function parseMediaPick(text: unknown, offer: MediaPickOffer): MediaPickAnswer {
  const answer = strictJsonObject(text);
  const { pick, name } = answer ?? {};
  if (typeof name !== 'string') return NONE;
  if (pick === 'gif') {
    const handle = listed(name, offer.gifs);
    return handle === undefined ? NONE : { kind: 'gif', handle };
  }
  const action = pick === 'emoji' ? 'append' : pick === 'replace' ? 'replace' : undefined;
  if (action === undefined || !offer.actions.includes(action)) return NONE;
  const emoji = listed(name, offer.emoji);
  if (emoji === undefined) return NONE;
  return pick === 'emoji' ? { kind: 'emoji', name: emoji } : { kind: 'replace', name: emoji };
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

/** A custom emoji as the interface knows it (src/behavior/emoji-index.ts). */
export type EmojiRef = { id: string; name: string; animated?: boolean };

/**
 * The emoji of `inventory` to offer, at most `cap`: the most used of this place first (`usage`, the place's
 * `emojiUsage`), then the rest of the inventory in its own order, so an interface with no ranking yet offers some. An
 * emoji the inventory no longer holds is no candidate, however used it was. Pure.
 */
export function rankEmojiCandidates(inventory: ReadonlyArray<EmojiRef>, usage: unknown, cap: number): Array<EmojiRef> {
  if (!(cap > 0)) return [];
  const byId = new Map(inventory.map((emoji) => [String(emoji.id), emoji]));
  const ranked = rankEmojiUsage(usage, EMOJI_HALF_LIFE_DAYS).flatMap((used) => byId.get(used.id) ?? []);
  return [...new Set([...ranked, ...inventory])].slice(0, cap);
}

/** A stored rails value made safe to read: anything else is no history. */
function railsOf(state: unknown): EmojiRails {
  if (state === null || typeof state !== 'object') return { lastUsed: {} };
  const { repliesSince, lastUsed } = state as { repliesSince?: unknown; lastUsed?: unknown };
  return {
    ...(typeof repliesSince === 'number' && Number.isFinite(repliesSince) ? { repliesSince } : {}),
    lastUsed: lastUsed !== null && typeof lastUsed === 'object' ? (lastUsed as Record<string, number>) : {},
  };
}

/**
 * The names of `names` the rails leave open at `now`. `emojiPerReplies`: at most one emoji per that many of her replies
 * in the place, so all are closed for that many less one replies after an emoji. `emojiCooldownMinutes`: one emoji is
 * closed for that long after it went out. 0 switches that rail off. Pure.
 */
export function openEmojiNames(
  state: unknown,
  names: ReadonlyArray<string>,
  { emojiPerReplies, emojiCooldownMinutes }: { emojiPerReplies: number; emojiCooldownMinutes: number },
  now: number
): Array<string> {
  const { repliesSince, lastUsed } = railsOf(state);
  if (emojiPerReplies > 0 && repliesSince !== undefined && repliesSince < emojiPerReplies - 1) return [];
  if (!(emojiCooldownMinutes > 0)) return [...names];
  return names.filter((name) => !(now < (lastUsed[name] ?? -Infinity) + emojiCooldownMinutes * MINUTE_MS));
}

/** The rails after one reply of hers in the place, `emoji` naming the emoji it carried or null. Pure. */
export function afterReply(state: unknown, emoji: string | null, now: number): EmojiRails {
  const { repliesSince, lastUsed } = railsOf(state);
  if (emoji !== null) return { repliesSince: 0, lastUsed: { ...lastUsed, [emoji]: now } };
  return { ...(repliesSince === undefined ? {} : { repliesSince: repliesSince + 1 }), lastUsed };
}

/** The template an interface renders a custom emoji with (`{name}`, `{id}`). */
export type EmojiRender = { still: string; animated?: string };

/** `text` with the emoji the pick chose, as the interface renders it: after the text, or alone in its place. Pure. */
export function applyEmojiPick(
  text: string,
  { action, emoji }: { action: 'append' | 'replace'; emoji: EmojiRef },
  render: EmojiRender
): string {
  const template = emoji.animated === true ? (render.animated ?? render.still) : render.still;
  const rendered = fill(template, { name: emoji.name, id: emoji.id });
  return action === 'append' ? `${text} ${rendered}` : rendered;
}

/** The labels the pick reads. */
type PickLabels = {
  gifs?: { entry?: string; entryNoText?: string; ownMark?: string } | null;
  emoji?: { entry?: string; entryNoText?: string } | null;
  transcript?: { replyTo?: unknown } | null;
  units?: Parameters<typeof formatDuration>[1];
} & Record<string, unknown>;

/** A candidate's line of `<gifs>`: its handle and its caption. */
function gifCandidateLine(entry: GifEntry, labels: PickLabels): string {
  const template = labels.gifs?.entry ?? '{id}: {text}';
  return fill(template, { id: entry.id, text: clampWithEllipsis(entry.caption ?? '', CAPTION_CHARS) });
}

/** A candidate's line of `<emoji>`: its name, and what it shows when the describer's cache knows. */
function emojiCandidateLine(emoji: EmojiRef, cache: Record<string, unknown> | null, labels: PickLabels): string {
  const cached = cache?.[`emoji:${emoji.id}`] as { miss?: unknown; text?: unknown } | undefined;
  const text = cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
  const { entry = ':{name}: {text}', entryNoText = ':{name}:' } = labels.emoji ?? {};
  return text ? fill(entry, { name: emoji.name, text }) : fill(entryNoText, { name: emoji.name });
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
  getGifVectors?: (model?: string | null) => ReadonlyMap<string, ArrayLike<number>>;
  getEmojiRails?: (placeId: string) => unknown;
  setEmojiRails?: (placeId: string, state: EmojiRails) => unknown;
};

/** The describer's cache of the emoji's captions, when the turn has it. */
type EmojiCache = Record<string, unknown> | null;

/** The language model client as the pick calls it. */
type PickLlm = {
  complete: (messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown>) => Promise<unknown>;
};

/** What one pick reads of the turn. */
export type MediaPickArgs = {
  /** The conversation the reply goes to, by the id the interface gives it. */
  placeId: string;
  /** What the interface declares (src/interface/capabilities.ts#portMediaPick); a form it does not know is never offered. */
  capability: {
    gifForms: ReadonlyArray<string>;
    emoji?: { actions: ReadonlyArray<string>; render: EmojiRender };
  } | null;
  messages: ReadonlyArray<{ text: string; replyTo?: number | null }>;
  history: ReadonlyArray<{ id?: string } & object>;
  selfName: string;
  idByIndex?: ReadonlyMap<number, string>;
  trigger?: { id?: string } | null;
  emoji?: ReadonlyArray<EmojiRef>;
  emojiUsage?: unknown;
  emojiCache?: EmojiCache;
};

/** What the act does with the pick: nothing, or post this GIF in place of the first message. */
export type MediaPickResult =
  | { kind: 'none' }
  | { kind: 'gif'; entry: GifEntry & { key: string }; replyTo: number | null }
  | { kind: 'emoji'; action: 'append' | 'replace'; emoji: EmojiRef };

/** What the act does for an answer read against what the request offered. */
function resultOf(
  answer: MediaPickAnswer,
  gifs: ReadonlyArray<GifEntry & { key: string }>,
  emoji: ReadonlyArray<EmojiRef>,
  replyTo: number | null
): MediaPickResult {
  if (answer.kind === 'gif') {
    const entry = gifs.find((candidate) => candidate.id === answer.handle);
    return entry ? { kind: 'gif', entry, replyTo } : NONE;
  }
  if (answer.kind === 'none') return NONE;
  const chosen = emoji.find((one) => one.name === answer.name);
  if (!chosen) return NONE;
  return { kind: 'emoji', action: answer.kind === 'emoji' ? 'append' : 'replace', emoji: chosen };
}

/** The completion's text, when the client answered with one. */
function textOf(completion: unknown): unknown {
  // The client answers a record whose `text` is the model's words.
  return (completion as { text?: unknown } | null | undefined)?.text;
}

export type MediaPick = {
  pick: (args: MediaPickArgs) => Promise<MediaPickResult>;
  /** One reply of hers posted in a place that counts the rails; `emoji` names the one it carried, or null. */
  noteReply: (reply: { placeId: string; emoji: string | null }) => void;
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
    const forms = (args.capability?.gifForms ?? []) as ReadonlyArray<GifForm>;
    const library = store.getGifs?.() ?? null;
    if (forms.length === 0 || !library) return { library, candidates: [] };
    const found = searchGifs(library, {
      words: query,
      vector: await queryVector(query, args.placeId),
      cap: settings.candidates,
      vectors: store.getGifVectors?.(gifVectorModel(hot.config)) ?? null,
      accept: (entry) => gifPostForm(entry, forms) !== null,
    });
    return { library, candidates: found.map(({ entry }) => entry) };
  }

  /** The emoji to offer: the place's most used that the rails leave open, cut by the cap. */
  function emojiCandidates(args: MediaPickArgs, settings: MediaPickSettings, at: number): Array<EmojiRef> {
    if (!args.capability?.emoji) return [];
    const inventory = args.emoji ?? [];
    const ranked = rankEmojiCandidates(inventory, args.emojiUsage, inventory.length);
    const open = new Set(
      openEmojiNames(
        store.getEmojiRails?.(args.placeId) ?? null,
        ranked.map((emoji) => emoji.name),
        settings,
        at
      )
    );
    return ranked.filter((emoji) => open.has(emoji.name)).slice(0, settings.emojiCandidates);
  }

  /** The classifier's words, or null when the request failed. */
  async function askClassifier(
    system: string,
    user: string,
    settings: MediaPickSettings,
    conversationId: string,
    offer: MediaPickOffer
  ) {
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
          responseFormat: mediaPickFormat(offer),
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
    const { placeId, capability, messages, selfName } = args;
    const prompt = hot.prompts?.['media-pick'];
    const labels = hot.prompts?.labels as PickLabels | undefined;
    const first = messages[0];
    if (!capability || typeof prompt !== 'string' || prompt.trim() === '' || !labels) return NONE;
    if (!first || typeof first.text !== 'string' || first.text.trim() === '') return NONE;
    const settings = mediaPickSettings(hot.config);
    if ([...first.text].length > settings.maxChars) return NONE;
    const { body, mark, query } = contextOf(args, settings, labels);
    const { library, candidates } = await gifCandidates(query, args, settings);
    const at = clock();
    const emoji = emojiCandidates(args, settings, at);
    if (candidates.length === 0 && emoji.length === 0) return NONE;
    const handles = candidates.map((entry) => entry.id);
    const user = [
      block('gifs', candidates.map((entry) => gifCandidateLine(entry, labels)).join('\n')),
      block('gifs_recent', recentGifLines(library, placeId, handles, labels, at).join('\n')),
      block('emoji', emoji.map((one) => emojiCandidateLine(one, args.emojiCache ?? null, labels)).join('\n')),
      block('context', body),
      block('reply', mark ? `${mark} ${first.text}` : first.text),
    ]
      .filter(Boolean)
      .join('\n\n');
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const offer: MediaPickOffer = {
      gifs: handles,
      emoji: emoji.map((one) => one.name),
      actions: capability.emoji?.actions ?? [],
    };
    const words = await askClassifier(system, user, settings, placeId, offer);
    const answer = parseMediaPick(words, offer);
    log.info('media-pick: answered', {
      channel: placeId,
      kind: answer.kind,
      gifs: handles.length,
      emoji: emoji.length,
    });
    return resultOf(answer, candidates, emoji, first.replyTo ?? null);
  }

  /** The pick that never rejects: an unexpected failure posts the messages as written. */
  function pick(args: MediaPickArgs): Promise<MediaPickResult> {
    return pickNow(args).catch((err: unknown) => {
      log.warn('media-pick: failed', { channel: args.placeId, error: err });
      return NONE;
    });
  }

  function noteReply({ placeId, emoji }: { placeId: string; emoji: string | null }): void {
    store.setEmojiRails?.(placeId, afterReply(store.getEmojiRails?.(placeId) ?? null, emoji, clock()));
  }

  return { pick, noteReply };
}
