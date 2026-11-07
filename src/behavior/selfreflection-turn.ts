// The selfreflection turn's own steps, beside the turn runner (src/behavior/turn.ts, mode `selfreflection`). A selfreflection turn writes her
// entry and sends nothing: the entry is recorded in memory first (`recordEntry`, the store's selfreflection unit), and the
// selfreflection's mirrors publish it (src/behavior/mirror.ts). The turn runs nowhere, with no conversation and no
// history. `pictureGate` says whether the post may carry a picture, and
// `selfreflectionVoiceTool` keeps her voice message for the entry instead of posting it. Logs: none.

import { UNRESTRICTED, refusedAudience } from '../tools/publication.ts';
import type { AudienceChoice, PublicationBoundary } from '../tools/publication.ts';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GIST_CHARS,
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  gistOf,
  isPictureKind,
  setSettings,
} from './selfreflection.ts';
import type { SelfreflectionEntry, EntryPicture, EntryVoice } from './mirror.ts';
import { CODE } from '../tools/codes.ts';

type Config = Record<string, unknown>;

const sectionOf = (config: Config, name: string): Config => {
  const found = config[name];
  return typeof found === 'object' && found !== null ? (found as Config) : {};
};

/** Whether a selfreflection post may carry a picture now, and the cap that closed when not (`limit: null` for the switches). */
export type PictureGate = { allowed: boolean; limit: { key: string; used: number; cap: number } | null };

/**
 * Whether a selfreflection post may carry a picture: an image client (`drawing`) and Attach Files in the conversation
 * (`attach`). Pure.
 */
export function pictureGate({
  attach,
  drawing,
}: {
  config?: Config;
  attach: boolean;
  drawing: boolean;
  data?: Record<string, unknown>;
  now?: number;
}): PictureGate {
  return drawing && attach ? { allowed: true, limit: null } : { allowed: false, limit: null };
}

/**
 * The refusal of a forced picture kind (`/nep selfreflection post <kind>`) while the post may carry no picture, naming the
 * gate that closed, or null. Asked before any request.
 */
export function forcedPictureRefusal({
  kind,
  gate,
}: {
  config?: Config;
  kind: unknown;
  gate: () => PictureGate;
}): { outcome: 'refused'; reason: 'pictures'; limit: PictureGate['limit'] } | null {
  if (typeof kind !== 'string' || !isPictureKind(kind, DEFAULT_PICTURE_KINDS)) return null;
  const closed = gate();
  return closed.allowed ? null : { outcome: 'refused', reason: 'pictures', limit: closed.limit };
}

/**
 * The voice message of a selfreflection post: what was voiced and its length, and the file when the turn made it (a voice
 * posted through her operation instead leaves only the text and the length).
 */
export type HeldVoice = Partial<EntryVoice> & { text: string; durationSecs: number };

/** What a selfreflection turn holds instead of sending: her messages as written and as they would be sent. */
export type HeldSpeech = {
  texts: Array<string>;
  rendered: Array<{ text: string; accountIds: Array<string>; notify?: boolean }>;
};

/**
 * `voice.say` as a selfreflection turn runs it (in the turn, src/tools/executors.ts#executeCall's `inTurn`): the voice file is
 * made through `speech.say` and kept in `held.selfreflectionVoice` for the entry; nothing is posted. Without a speech client that
 * can say, there is no such tool and the call takes its usual way.
 */
export function selfreflectionVoiceTool({
  speech,
  held,
}: {
  speech: unknown;
  held: { selfreflectionVoice?: HeldVoice | null };
}): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const say = (speech as { say?: unknown } | null)?.say;
  if (typeof say !== 'function') return {};
  return {
    'voice.say': async (args) => {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { status: 'invalid', code: CODE.INVALID_ARGS, data: { text: '' } };
      // src/speech/index.ts#createSpeech answers the file and what was voiced.
      const made = (await (say as (input: { text: string }) => Promise<unknown>)({ text })) as {
        ogg: Uint8Array;
        durationSecs: number;
        waveform: string;
        voiced: string;
      };
      held.selfreflectionVoice = {
        ogg: made.ogg,
        durationSecs: made.durationSecs,
        waveform: made.waveform,
        text: made.voiced,
      };
      return { status: 'ok', code: CODE.STAGED, data: { text: '' } };
    },
  };
}

/** A staged picture of the post: the generated picture and its scene. */
export type StagedPicture = EntryPicture & { text: string };

/** The part of the store `recordEntry` uses. */
export type SelfreflectionStore = {
  appendSelfreflectionPost?: (post: Record<string, unknown>, opts: { max: number }) => unknown;
  getSelfreflection?: () => { posts: Array<Record<string, unknown>> };
  setSelfreflectionPosts?: (posts: Array<Record<string, unknown>>, opts: { max: number }) => unknown;
  state: { data: Record<string, unknown>; markDirty(): void };
};

/** The plan of a selfreflection post as recordEntry reads it: its kind, search and brief, and the seeding its planner answered. */
export type EntryPlan = {
  kind: string | null;
  search?: string | null;
  brief?: string;
  seeding?: { seeds: Array<Array<string>>; seed: number };
};

/**
 * The post of the place's selfreflection an entry is (recordEntry): its gist and its first picture's scene cut to
 * `selfreflection.gistChars` (200), her full text, the entry's id as its `itemId`, its search query, how it is sent (`send`),
 * with a voice message the text as voiced and its length, and with a planner's answer its `plan` (`brief`, the `seeds`
 * offered, the `seed` taken), which the memory database keeps in the entry's `extra`.
 */
function selfreflectionPostOf({
  config,
  at,
  plan,
  held,
  staged,
  set,
  voice,
  id,
}: {
  config: Config;
  at: number;
  plan: EntryPlan;
  held: HeldSpeech;
  staged: ReadonlyArray<StagedPicture>;
  set: boolean;
  voice: HeldVoice | null;
  id: string;
}): {
  post: Record<string, unknown>;
  rendered: { messages: Array<string>; mentions: Array<Array<string>>; notify?: Array<boolean> };
  maxMessageBytes: number;
} {
  const selfreflectionCfg = sectionOf(config, 'selfreflection');
  const gistChars = DEFAULT_GIST_CHARS;
  const first = staged[0];
  const maxMessageBytes = setSettings(selfreflectionCfg).maxMessageBytes;
  const rendered = {
    messages: held.rendered.map((part) => part.text),
    mentions: held.rendered.map((part) => part.accountIds),
    // Kept only when a message notifies everyone it names (src/turn/mentions.ts#mentionsUnderPings).
    ...(held.rendered.some((part) => part.notify === true)
      ? { notify: held.rendered.map((part) => part.notify === true) }
      : {}),
  };
  const post = {
    at,
    kind: plan.kind,
    gist: gistOf(held.texts.join(' '), gistChars),
    picture: first ? gistOf(first.text, gistChars) : null,
    ...(set ? { pictures: staged.length } : {}),
    search: plan.search || null,
    text: held.texts.join('\n'),
    itemId: id,
    ...(voice ? { voice: { text: voice.text, durationSec: voice.durationSecs } } : {}),
    ...(plan.seeding ? { plan: { brief: plan.brief ?? '', seeds: plan.seeding.seeds, seed: plan.seeding.seed } } : {}),
    // How the entry goes out, kept so a publication sent after a restart sends it whole (src/behavior/mirror.ts).
    send: { ...rendered, maxMessageBytes },
  };
  return { post, rendered, maxMessageBytes };
}

/** What a post keeps of her audience choice: the audience, or for a failed choice a value that publishes nowhere. */
const publicationAudienceOf = (choice: AudienceChoice) =>
  choice.ok ? choice.audience : { kind: 'invalid' as const, code: choice.code };

/**
 * A selfreflection post recorded before anything is sent: one post in the place's selfreflection (`store.appendSelfreflectionPost`, the newest
 * `selfreflection.historyPosts` (150) kept) with its gist and its first picture's scene cut to `selfreflection.gistChars` (200), her
 * full text, the entry's id as its `itemId`, its search query, how it is sent (`send`: her messages as sent, their
 * mentions, the set's byte limit) and, with a voice message, the text as voiced and its length; the day's selfreflection post
 * counted. Every picture was counted when it was generated. `audience` is what her `<audience>` tags came to: the post
 * keeps it as `publicationAudience`, and a failed choice is kept as a value that publishes nowhere
 * (src/memory/db/selfreflection-audience.ts). `turnId`, the turn that wrote it, is kept as the post's `turnId`. Returns
 * the outcome's `selfreflection` field: the counts, the audience and the entry the mirrors publish.
 */
export function recordEntry({
  store,
  config,
  now,
  plan,
  held,
  staged,
  set,
  voice,
  publicationBoundary,
  audience = { ok: true, audience: UNRESTRICTED },
  turnId,
  newId = () => `selfreflection:${randomUUID()}`,
}: {
  store: SelfreflectionStore;
  config: Config;

  now: number;
  plan: EntryPlan;
  held: HeldSpeech;
  staged: ReadonlyArray<StagedPicture>;
  set: boolean;
  voice: HeldVoice | null;
  publicationBoundary?: PublicationBoundary;
  audience?: AudienceChoice;
  turnId?: string;
  newId?: () => string;
}): {
  kind: string | null;
  picture: boolean;
  search: boolean;
  messages: number;
  pictures: number;
  audience: AudienceChoice;
  entry: SelfreflectionEntry;
} {
  const id = newId();
  const { post, rendered, maxMessageBytes } = selfreflectionPostOf({
    config,
    at: now,
    plan,
    held,
    staged,
    set,
    voice,
    id,
  });
  if (publicationBoundary !== undefined) post.publicationBoundary = publicationBoundary;
  post.publicationAudience = publicationAudienceOf(audience);
  if (turnId !== undefined) post.turnId = turnId;
  if (typeof store.appendSelfreflectionPost === 'function')
    store.appendSelfreflectionPost(post, { max: DEFAULT_HISTORY_POSTS });
  const entry: SelfreflectionEntry = {
    id,
    ...(publicationBoundary !== undefined ? { publicationBoundary } : {}),
    ...rendered,
    pictures: staged.map((item) => ({ buffer: item.buffer, mediaType: item.mediaType })),
    voice: voice?.ogg ? { ogg: voice.ogg, durationSecs: voice.durationSecs, waveform: voice.waveform ?? '' } : null,
    maxMessageBytes,
  };
  return {
    kind: plan.kind,
    picture: staged.length > 0,
    search: Boolean(plan.search),
    messages: held.texts.length,
    pictures: staged.length,
    audience,
    entry,
  };
}

/**
 * The refusals `posts` showed in a selfreflection request (its `<feedback>`), marked on their posts once she answered it, so
 * she hears of each one once. A request that never got an answer marks nothing.
 */
export function markRefusalsTold(store: SelfreflectionStore, posts: ReadonlyArray<object>): void {
  const shown = new Set(
    posts.flatMap((post) => {
      const { itemId, publicationAudience } = post as { itemId?: unknown; publicationAudience?: unknown };
      return refusedAudience(publicationAudience)?.told === false ? [itemId] : [];
    })
  );
  if (shown.size === 0 || !store.getSelfreflection || !store.setSelfreflectionPosts) return;
  const marked = store
    .getSelfreflection()
    .posts.map((post) =>
      shown.has(post.itemId)
        ? { ...post, publicationAudience: { ...(post.publicationAudience as object), told: true } }
        : post
    );
  store.setSelfreflectionPosts(marked, { max: DEFAULT_HISTORY_POSTS });
}
