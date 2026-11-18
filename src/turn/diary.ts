// A diary entry's first step and its picture gate: the post history, whether the entry may carry a picture, the kind
// the code draws, and before the persona's turn either the scenes of the director for a kind of SCENE_KINDS
// (src/behavior/diary-scene.ts) or the stored facts of the days since the last entry for any other kind.
// createTurnRunner (src/behavior/turn.ts) builds it once per runner with createDiary; the request's setup step calls
// prepareDiary before it builds a diary entry's request, and runTurn asks diaryPictureGate before a forced picture kind.

import { PERSONA_ID } from '../memory/db/ids.ts';
import { diaryRestricted } from '../tools/publication.ts';
import { fill } from '../format.ts';
import { personOfMember } from '../memory/addresses.ts';
import { listOf, objOf } from '../tools/types.ts';
import { isIssuedReadAllContext } from '../memory/db/scope.ts';
import type { MemoryPage } from '../memory/db/semantic-types.ts';
import { factStateWords } from '../memory/retrieval-input.ts';
import type { RetrievalInput } from '../memory/retrieval-input.ts';
import type { Context } from '../memory/db/scope.ts';
import {
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  drawWeights,
  DIARY_KINDS,
  diaryTopic,
  pickKind,
  withoutPictureKinds,
} from '../behavior/diary.ts';
import { entryScenes, isSceneKind } from '../behavior/diary-scene.ts';
import type { SceneFailure, SceneLlm, SceneResult } from '../behavior/diary-scene.ts';
import { pictureGate } from '../behavior/diary-turn.ts';
import type { PictureGate } from '../behavior/diary-turn.ts';
import { log } from '../log.ts';
import type { ChatInfo } from '../protocol/adapter.ts';

/** The live config of a diary entry, as its first step reads it. */
export type DiaryConfig = Parameters<typeof pictureGate>[0]['config'] & { bot?: { timezone?: unknown } | null };

/** The prompt files and labels the first step reads (hot.prompts). */
type DiaryPrompts = Record<string, unknown> & { labels?: unknown };

/** The memory store, as a diary entry reads it. */
export type DiaryStore = {
  getDiary?: () => { posts?: Array<object> } | null | undefined;
  getPlace: (placeId: string) => object | null;
  listUserProfiles: () => Array<object>;
  state: { data: Parameters<typeof pictureGate>[0]['data'] };
};

/** The image client (src/llm/images.ts#createImageGen), as far as its presence is read. */
export type DiaryImages = { quota?: (options: object) => { used: number; cap: number } | null } | null;

/** What createDiary reads. */
export type DiaryContext = {
  /** A diary entry's stored facts through the one retrieval service. */
  diaryFacts?: ((input: RetrievalInput) => Promise<MemoryPage | null>) | null;
  hot: { readonly config: unknown; readonly prompts: DiaryPrompts | null | undefined };
  store: DiaryStore;
  llm: SceneLlm;
  rng: () => number;
  images: DiaryImages | undefined;
};

/** What the owner's command asked of a diary entry: a forced kind, a topic, whether it was forced. */
type DiaryParams = { kind?: unknown; topic?: unknown; forced?: unknown } | null | undefined;

/** A scene the director gave: the sets offered, the lines it kept and the scene. */
export type EntryScene = Extract<SceneResult, { ok: true }>;

/** What a diary entry's request is built from, or the skip of an entry the director gave no scene. */
export type DiaryPrepared =
  | {
      skipped: false;
      posts: Array<object>;
      kind: string | null;
      topic: string | null;
      pictureAllowed: boolean;
      /** The scenes of a kind of SCENE_KINDS, at least one; [] for any other kind. */
      scenes: Array<EntryScene>;
      /** The rendered stored facts of a kind with no scene; '' for a scene kind or when there are none. */
      facts: string;
    }
  | { skipped: true; kind: string; failures: Array<SceneFailure>; tried: Array<SceneResult> };

export type Diary = {
  prepareDiary: (args: {
    config: DiaryConfig;
    channel: ChatInfo;
    now: number;
    params: DiaryParams;
    memoryOn: boolean;
    draft?: { memoryContext?: Context } | null;
  }) => Promise<DiaryPrepared>;
  diaryPictureGate: (config: DiaryConfig, channel: ChatInfo, now: number) => PictureGate;
};

/** One place note's fields, as `<about_chat>` reads them: its texts and its lists. */
type PlaceNotes = Record<string, unknown>;

/** The notes of several places as one: the texts one after another, the lists end to end, a first value kept otherwise. */
function mergedNotes(notes: ReadonlyArray<PlaceNotes>): PlaceNotes {
  const merged: PlaceNotes = {};
  for (const note of notes)
    for (const [key, value] of Object.entries(note)) {
      const held = merged[key];
      if (Array.isArray(held) && Array.isArray(value))
        merged[key] = [...(held as Array<unknown>), ...(value as Array<unknown>)];
      else if (typeof held === 'string' && typeof value === 'string' && value !== '')
        merged[key] = held === '' ? value : `${held}\n${value}`;
      else if (held === undefined) merged[key] = value;
    }
  return merged;
}

/**
 * The stored facts of a diary entry's interval, for a kind with no scene: the people the persona knows and the days
 * since the last entry, read under the diary's context, so no DM reaches a mirror. '' when there are none or the read
 * failed.
 */
async function reflectionFacts(
  read: ((input: RetrievalInput) => Promise<MemoryPage | null>) | null,
  store: { listUserProfiles?: () => unknown },
  posts: ReadonlyArray<{ at?: unknown }>,
  now: number,
  labels: unknown,
  logger: { warn(message: string, fields: Record<string, unknown>): void }
): Promise<string> {
  if (typeof read !== 'function') return '';
  try {
    const last = Math.max(0, ...posts.map((post) => Number(post.at) || 0));
    const profiles = listOf(store.listUserProfiles?.()).map(objOf);
    const page = await read({
      purpose: 'reflection',
      from: new Date(last).toISOString(),
      to: new Date(now).toISOString(),
      participants: profiles.flatMap((one: Record<string, unknown>) =>
        typeof one.id === 'string' ? (personOfMember(store, one.id) ?? []) : []
      ),
      entities: [],
    });
    const words = objOf(objOf(labels).diaryFacts);
    if (!page?.assertions.length || typeof words.header !== 'string' || typeof words.fact !== 'string') return '';
    const states = objOf(objOf(objOf(labels).prefetch).factStates);
    const line = words.fact;
    const lines = page.assertions.map((fact) => fill(line, { state: factStateWords(fact, states), text: fact.text }));
    return [words.header, ...lines].join('\n');
  } catch (err) {
    logger.warn('diary: retrieval failed', { code: objOf(err).code ?? null });
    return '';
  }
}

/**
 * What a diary plan reads of the places she knows: the notes of the top places the entry's readers may see. With one top
 * place, its notes. With several, a place's notes reach the plan only when the entry stays inside its tree (its readers
 * read that server), and every place's when the entry is posted in no server at all: nobody outside reads it yet.
 */
export function diaryPlaceNotes(
  store: Pick<DiaryStore, 'getPlace'>,
  tops: ReadonlyArray<string>,
  entryTop: string | null
): object | null {
  if (tops.length === 0) return store.getPlace(PERSONA_ID);
  const [only] = tops;
  if (tops.length === 1 && only !== undefined) return store.getPlace(only);
  const readable = entryTop === null ? tops : tops.filter((place) => place === entryTop);
  return mergedNotes(readable.map((place) => (store.getPlace(place) ?? {}) as PlaceNotes));
}

export function createDiary(ctx: DiaryContext): Diary {
  const { hot, store, llm, rng, images, diaryFacts = null } = ctx;

  /**
   * A diary entry's first step (mode `diary`), before its request is built: the post history (store.getDiary), whether
   * the entry may carry a picture (the image client and Attach Files here), and the kind the code draws with `rng` over
   * src/behavior/diary.ts#drawWeights, the weights corrected for their use among the newest 150 entries. While the entry
   * may not carry a picture the picture kinds are dropped before the draw and the log line carries `picturesOff: true`.
   * A forced kind (`params.kind`) replaces the draw (a forced picture kind with pictures off never gets here: the setup
   * refuses it first, diaryPictureGate). A kind of SCENE_KINDS then asks the director for its scenes
   * (src/behavior/diary-scene.ts#entryScenes): with none the entry is skipped (`diary: skip`, reason `no-scene`, the
   * failures by name), and a request or token cap throws. Any other kind reads the stored facts of the days since the
   * last entry. The owner's topic (`params.topic`) rides along. Settings come from `config`, the turn's live config.
   */
  async function prepareDiary({
    config,
    channel,
    now,
    params,
    memoryOn,
    draft = null,
  }: Parameters<Diary['prepareDiary']>[0]): Promise<DiaryPrepared> {
    const prompts = hot.prompts;
    const stored = typeof store.getDiary === 'function' ? store.getDiary() : null;
    const posts = (Array.isArray(stored?.posts) ? stored.posts : []).filter(
      (post) => isIssuedReadAllContext(draft?.memoryContext) || !diaryRestricted(post)
    );
    const forcedKind = typeof params?.kind === 'string' && params.kind ? params.kind : null;
    const topic = diaryTopic(params?.topic);
    const pictureAllowed = diaryPictureGate(config, channel, now).allowed;
    const picturesOff = !forcedKind && !pictureAllowed;
    const drawable: Record<string, number> = picturesOff
      ? // withoutPictureKinds drops entries of `kinds` and keeps the rest as they are, numbers.
        (withoutPictureKinds(DIARY_KINDS, DEFAULT_PICTURE_KINDS) as Record<string, number>)
      : DIARY_KINDS;
    const drawnKind = forcedKind
      ? null
      : pickKind(drawWeights(drawable, posts, { window: DEFAULT_HISTORY_POSTS }), rng);
    const kind = forcedKind ?? drawnKind;
    let scenes: Array<EntryScene> = [];
    let facts = '';
    if (isSceneKind(kind)) {
      const timezone = typeof config.bot?.timezone === 'string' && config.bot.timezone ? config.bot.timezone : 'UTC';
      // Every stored entry, restricted ones included, so no kept line comes back in a scene of a later entry.
      const tried = await entryScenes({ hot, llm, kind, posts: stored?.posts, rng, now, timezone });
      scenes = tried.filter((one): one is EntryScene => one.ok);
      if (scenes.length === 0) {
        const failures = tried.flatMap((one) => (one.ok ? [] : [one.reason]));
        log.info('diary: skip', { reason: 'no-scene', kind, failures });
        return { skipped: true, kind, failures, tried };
      }
    } else if (memoryOn) {
      facts = await reflectionFacts(diaryFacts, store, posts, now, prompts?.labels, log);
    }
    log.info('diary: prepared', {
      channel: channel.id,
      kind,
      scenes: scenes.length,
      forced: params?.forced === true,
      ...(drawnKind ? { drawn: true } : {}),
      ...(picturesOff ? { picturesOff: true } : {}),
    });
    return { skipped: false, posts, kind, topic, pictureAllowed, scenes, facts };
  }

  /** Whether a diary post in `channel` may carry a picture now (src/behavior/diary-turn.ts#pictureGate). */
  function diaryPictureGate(config: DiaryConfig, channel: ChatInfo, now: number): PictureGate {
    return pictureGate({
      config,
      attach: channel.permissions.attach,
      drawing: Boolean(images),
      data: store.state.data,
      now,
    });
  }

  return { prepareDiary, diaryPictureGate };
}
