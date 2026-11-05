// A diary post's first step and its picture gate: the post history, whether the post may carry a picture, the plan
// request with its seeds and the owner's topic, the search the plan asks for, and the seeds of a set post.
// createTurnRunner (src/behavior/turn.ts) builds it once per runner with createDiary; the attempt calls prepareDiary
// before it builds a diary post's request, and runTurn asks diaryPictureGate before a forced picture kind.

import { accountOf, sharedPlaceOf } from '../memory/addresses.ts';
import { PERSONA_ID } from '../memory/db/storage-keys.ts';
import { diaryRestricted } from '../tools/publication.ts';
import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { Context } from '../memory/db/scope.ts';
import {
  DEFAULT_PICTURE_KINDS,
  DEFAULT_SEARCH_KINDS,
  DEFAULT_SET_KINDS,
  DIARY_KINDS,
  diaryTopic,
  isSetKind,
  parseSeedFamilies,
  pickSeeds,
  renderSeedsBlock,
  renderTopicBlock,
  SEED_SETS,
  setSettings,
  validatePlan,
  withoutPictureKinds,
} from '../behavior/diary.ts';
import { pictureGate } from '../behavior/diary-turn.ts';
import type { PictureGate } from '../behavior/diary-turn.ts';
import { diaryConversationIds } from '../behavior/mirror.ts';
import { buildDiaryPlanRequest } from '../behavior/prompt.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { DailyCapError, TokenLimitError, hedgeSettings, railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { parseJsonObject } from '../llm/parse.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import { NO_RECENT } from './history.ts';
import type { JournalNotes } from './journal-notes.ts';
import type { Participation } from './participation.ts';
import { snapshotOfDraft } from './routing.ts';

/** The `selfreflection` section of the live config, as the first step reads it. */
type DiarySection = {
  kinds?: Record<string, number>;
  pictureKinds?: unknown;
  searchKinds?: unknown;
  setKinds?: unknown;
  seedSets?: unknown;
  planTimeoutMs?: number;
  planMaxOutputTokens?: number;
};

/** The live config of a diary post: the `selfreflection` section; the settings functions read their own sections. */
export type DiaryConfig = Parameters<typeof pictureGate>[0]['config'] & { selfreflection?: DiarySection | null };

/** The prompt files and labels the plan request reads (hot.prompts). */
type DiaryPrompts = Record<string, unknown> & { labels?: unknown };

/** The memory store, as a diary post reads it. */
export type DiaryStore = {
  getDiary?: () => { posts?: Array<object> } | null | undefined;
  getPlace: (placeId: string) => object | null;
  listChannels: (placeId: string) => Array<object>;
  getLore: (placeId: string) => Array<object>;
  topPlaces?: () => Array<string>;
  listUserProfiles: () => Array<object>;
  getUser: (accountId: string) => { names?: Array<string | null> } | null | undefined;
  state: { data: Parameters<typeof pictureGate>[0]['data'] };
};

/** The language model client (src/llm/openrouter.ts#createLlm), as the plan request uses it. */
export type DiaryLlm = {
  complete: (messages: ReturnType<typeof buildDiaryPlanRequest>['messages'], options: object) => Promise<unknown>;
};

/** The web lookup (src/web/lookup.ts#createLookup), as the plan's search uses it. */
export type DiaryLookup = {
  search?: (placeId: string, query: string) => Promise<{ text?: unknown; sources?: unknown } | null | undefined>;
} | null;

/** The image client (src/llm/images.ts#createImageGen), as far as its cap is read. */
export type DiaryImages = { quota?: (options: object) => { used: number; cap: number } | null } | null;

/** What createDiary reads: the dependencies and the functions of the notes and of participation it calls. */
export type DiaryContext = {
  hot: { readonly prompts: DiaryPrompts | null | undefined };
  store: DiaryStore;
  llm: DiaryLlm;
  calibrator: object;
  rng: () => number;
  lookup: DiaryLookup | undefined;
  images: DiaryImages | undefined;
  journalOp: JournalNotes['journalOp'];
  recentOfPlaces: Participation['recentOfPlaces'];
};

/** What the owner's command asked of a diary post: a forced kind, a topic, whether it was forced. */
type DiaryParams = { kind?: unknown; topic?: unknown; forced?: unknown } | null | undefined;

/** The plan of a diary post, with the owner's topic when there is one. */
type DiaryPlan = ReturnType<typeof validatePlan> & { topic?: string };

export type DiaryPrepared = {
  posts: Array<object>;
  plan: DiaryPlan;
  found: string | null;
  pictureAllowed: boolean;
  seeds: string;
};

export type Diary = {
  prepareDiary: (args: {
    config: DiaryConfig;

    channel: ConversationInfo;
    selfName: string;
    history: Array<object>;
    now: number;
    params: DiaryParams;
    memoryOn: boolean;
    draft?:
      | (NonNullable<Parameters<JournalNotes['journalOp']>[0]> & {
          snapshot?: Snapshot | null;
          memoryContext?: Context;
        })
      | null;
  }) => Promise<DiaryPrepared>;
  diaryPictureGate: (config: DiaryConfig, channel: ConversationInfo, now: number) => PictureGate;
};

/** The completion's text, when the client answered with one. */
function textOf(completion: unknown): unknown {
  // The client answers a record whose `text` is the model's words.
  return (completion as { text?: unknown }).text;
}

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
  const { hot, store, llm, calibrator, rng, lookup, images, journalOp, recentOfPlaces } = ctx;

  /**
   * A diary post's first step (mode `diary`), before its request is built:
   * the post history (store.getDiary), whether it may carry a picture (the
   * image client and Attach Files here), then the plan request (src/behavior/prompt.ts#buildDiaryPlanRequest:
   * prompts/diary-plan.md on the classifier model, `selfreflection.planMaxOutputTokens`
   * (300), `selfreflection.planTimeoutMs` (20000), usage purpose `diary-plan`; when
   * `llm.hedge` hedges `analyzer`, the hedged call is limited by
   * `selfreflection.planTimeoutMs` rather than `llm.hedge.timeoutMs`) with
   * `<seeds>` drawn from prompts/diary-seeds.md (SEED_SETS) and,
   * with an owner's topic (`params.topic`, src/behavior/diary.ts#diaryTopic),
   * a `<topic>` block after them; the topic also rides on the plan as its
   * `topic` field (the `<plan>` block of the post). The answer goes through parseJsonObject and src/behavior/diary.ts#validatePlan
   * (a weighted random kind when it is missing, broken or names no weighted
   * kind; `selfreflection.searchKinds`, `selfreflection.pictureKinds`). While the post may not
   * carry a picture, the kinds in `selfreflection.pictureKinds` are dropped before the
   * plan request and validatePlan (src/behavior/diary.ts#withoutPictureKinds),
   * so neither the planner nor the random fallback picks one, and the
   * `diary: planned` line carries `picturesOff: true`. A forced kind
   * (`params.kind`) is the only kind offered and replaces the answer's kind,
   * its brief kept (a forced picture kind with pictures off never gets here:
   * runTurn refuses it first, diaryPictureGate). Then the search the plan asks for (lookup.search, its own
   * cache): its text is `found`; a failure or nothing
   * found logs `diary: search failed` and the post goes without it. A request
   * or token cap on the plan request throws (the turn is refused); any other
   * failure of it falls back. A planned kind in `selfreflection.setKinds` (a set post) also draws
   * `selfreflection.set.seedSets` (6) seed combinations for the compose request (`seeds`, the rendered
   * `<seeds>` body; '' for any other kind). Settings come from `config`, the turn's live config.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5b, a pure move
  async function prepareDiary({
    config,
    channel,
    selfName,
    history,
    now,
    params,
    memoryOn,
    draft = null,
  }: Parameters<Diary['prepareDiary']>[0]): Promise<DiaryPrepared> {
    const prompts = hot.prompts;
    const labels = prompts?.labels;
    const diaryCfg = config.selfreflection ?? {};
    const stored = typeof store.getDiary === 'function' ? store.getDiary() : null;
    const posts = (Array.isArray(stored?.posts) ? stored.posts : []).filter(
      (post) => isIssuedInternalContext(draft?.memoryContext) || !diaryRestricted(post)
    );
    const forcedKind = typeof params?.kind === 'string' && params.kind ? params.kind : null;
    const topic = diaryTopic(params?.topic);
    const pictureAllowed = diaryPictureGate(config, channel, now).allowed;
    // Pictures off: only the text kinds are offered (a forced kind is offered alone).
    const picturesOff = !forcedKind && !pictureAllowed;
    const kinds: Record<string, number> = forcedKind
      ? { [forcedKind]: 1 }
      : picturesOff
        ? // withoutPictureKinds drops entries of `kinds` and keeps the rest as they are, numbers.
          (withoutPictureKinds(DIARY_KINDS, DEFAULT_PICTURE_KINDS) as Record<string, number>)
        : DIARY_KINDS;

    // What the entry may draw on: the notes of every server she is in.
    const tops = store.topPlaces?.() ?? [];
    let answer: unknown = null;
    const planPrompt = prompts?.['diary-plan'];
    if (typeof planPrompt === 'string' && planPrompt.trim() && labels) {
      const recent = memoryOn
        ? recentOfPlaces(tops, { channel, snapshot: snapshotOfDraft(draft), isPrivate: false, config, now })
        : NO_RECENT;
      const seedsText = renderSeedsBlock(pickSeeds(parseSeedFamilies(prompts['diary-seeds']), SEED_SETS, rng), labels);
      const request = buildDiaryPlanRequest({
        config,
        prompts,
        calibrator,
        now,
        selfName,
        history,
        placeMemory: memoryOn
          ? diaryPlaceNotes(store, tops, channel.rootId ? sharedPlaceOf(store, channel) : null)
          : null,
        channels: memoryOn ? tops.flatMap((place) => store.listChannels(place)) : [],
        loreEntries: memoryOn ? tops.flatMap((place) => store.getLore(place)) : [],
        currentChannelId: channel.id,
        diaryChannelIds: diaryConversationIds(store),
        recentLines: recent.lines ?? null,
        recentAudience: recent.audience ?? null,
        candidateProfiles: memoryOn ? store.listUserProfiles() : [],
        nameOf: memoryOn ? (id: string) => store.getUser(accountOf(store, id))?.names?.[0] ?? null : null,
        posts,
        kinds,
        seedsText,
        topicText: renderTopicBlock(topic, labels),
      });
      const planTimeoutMs = diaryCfg.planTimeoutMs ?? 60000;
      // A hedged plan request gets the plan's own limit, not llm.hedge.timeoutMs.
      const hedge = hedgeSettings(config);
      const planHedge =
        hedge && hedge.afterMs > 0 && hedge.roles.includes('analyzer')
          ? { hedge: { afterMs: hedge.afterMs, timeoutMs: planTimeoutMs } }
          : {};
      let completion: unknown = null;
      try {
        completion = await llm.complete(request.messages, {
          model: roleModel(config, 'analyzer', 'diary-plan'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: diaryCfg.planMaxOutputTokens ?? 2000,
            purpose: 'diary-plan',
            timeoutMs: planTimeoutMs,
          }),
          ...planHedge,
        });
      } catch (err) {
        if (err instanceof DailyCapError || err instanceof TokenLimitError) throw err;
        log.warn('diary: plan failed', {
          channel: channel.id,
          reason: railReason(err),
          // A thrown value is anything; an HTTP error of the client carries its status.
          status: (err as { statusCode?: unknown } | null)?.statusCode ?? null,
        });
      }
      if (completion) {
        try {
          answer = parseJsonObject(textOf(completion));
        } catch {
          log.warn('diary: plan failed', { channel: channel.id, reason: 'unparsed', status: null });
        }
      }
    } else {
      log.warn('diary: plan failed', { channel: channel.id, reason: 'no-prompt', status: null });
    }
    if (forcedKind && answer && typeof answer === 'object' && !Array.isArray(answer))
      answer = { ...answer, kind: forcedKind };
    const validated = validatePlan(
      answer,
      kinds,
      { pictureAllowed, searchKinds: DEFAULT_SEARCH_KINDS, pictureKinds: DEFAULT_PICTURE_KINDS },
      rng
    );
    // The owner's topic reaches the post even when the planner ignored it.
    const plan: DiaryPlan = topic ? { ...validated, topic } : validated;

    let found: string | null = null;
    if (plan.search && typeof lookup?.search === 'function') {
      // The journal: the plan's search is the engine's operation; what it found enters the post's request.
      const op = journalOp(draft, 'lookup', 'engine', { input: { query: plan.search } });
      if (op.opId) await op.started();
      try {
        const result = await lookup.search(PERSONA_ID, plan.search);
        found = typeof result?.text === 'string' && result.text.trim() ? result.text.trim() : null;
        if (op.opId)
          await (result
            ? op.succeeded({
                results: Array.isArray(result.sources) ? result.sources.length : 0,
                delivered: found !== null,
              })
            : op.failed(CODE.NO_RESULT));
        if (found === null)
          log.info('diary: search failed', { channel: channel.id, reason: result ? 'nothing' : 'refused' });
      } catch (err) {
        if (op.opId) await op.failed(CODE.ERROR);
        log.warn('diary: search failed', { channel: channel.id, reason: 'error', error: err });
      }
    }
    // A set post (selfreflection.setKinds): its compose request gets selfreflection.set.seedSets seed combinations.
    const seeds = isSetKind(plan.kind, DEFAULT_SET_KINDS)
      ? renderSeedsBlock(
          pickSeeds(parseSeedFamilies(prompts?.['diary-seeds']), setSettings(diaryCfg).seedSets, rng),
          labels ?? {}
        )
      : '';
    log.info('diary: planned', {
      channel: channel.id,
      kind: plan.kind,
      fallback: plan.fallback,
      picture: plan.picture,
      search: Boolean(plan.search),
      found: found !== null,
      forced: params?.forced === true,
      ...(picturesOff ? { picturesOff: true } : {}),
    });
    return { posts, plan, found, pictureAllowed, seeds };
  }

  /** Whether a diary post in `channel` may carry a picture now (src/behavior/diary-turn.ts#pictureGate). */
  function diaryPictureGate(config: DiaryConfig, channel: ConversationInfo, now: number): PictureGate {
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
