// A selfreflection post's first step and its picture gate: the post history, whether the post may carry a picture, the plan
// request with its kinds, seeds and the owner's topic, the search the plan asks for, and the seeds of a set post. The plan
// request itself is built on the turn frame by the request step (src/turn/phases/request/build.ts#plannerRequest).
// createTurnRunner (src/behavior/turn.ts) builds it once per runner with createSelfreflection; the attempt calls prepareSelfreflection
// before it builds a selfreflection post's request, and runTurn asks selfreflectionPictureGate before a forced picture kind.

import { PERSONA_ID } from '../memory/db/storage-keys.ts';
import { selfreflectionRestricted } from '../tools/publication.ts';
import { fill } from '../format.ts';
import { personOfMember } from '../memory/addresses.ts';
import { listOf, objOf } from '../tools/types.ts';
import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { MemoryPage } from '../memory/db/semantic-types.ts';
import { factStateWords } from '../memory/retrieval-input.ts';
import type { RetrievalInput } from '../memory/retrieval-input.ts';
import type { Context } from '../memory/db/scope.ts';
import {
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  DEFAULT_SEARCH_KINDS,
  DEFAULT_SET_KINDS,
  drawWeights,
  SELFREFLECTION_KINDS,
  selfreflectionPlanFormat,
  selfreflectionTopic,
  isSetKind,
  parsePlanAnswer,
  parseSeedFamilies,
  pickKind,
  pickSeeds,
  planSeed,
  renderKindsBlock,
  renderSeedsBlock,
  renderTopicBlock,
  SEED_SETS,
  setSettings,
  usedSeedLines,
  validatePlan,
  withoutPictureKinds,
} from '../behavior/selfreflection.ts';
import { pictureGate } from '../behavior/selfreflection-turn.ts';
import type { PictureGate } from '../behavior/selfreflection-turn.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { DailyCapError, TokenLimitError, hedgeSettings, railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import type { ChatInfo } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import type { JournalNotes } from './journal-notes.ts';

/** The `selfreflection` section of the live config, as the first step reads it. */
type SelfreflectionSection = {
  kinds?: Record<string, number>;
  pictureKinds?: unknown;
  searchKinds?: unknown;
  setKinds?: unknown;
  seedSets?: unknown;
  planTimeoutMs?: number;
  planMaxOutputTokens?: number;
};

/** The live config of a selfreflection post: the `selfreflection` section; the settings functions read their own sections. */
export type SelfreflectionConfig = Parameters<typeof pictureGate>[0]['config'] & {
  selfreflection?: SelfreflectionSection | null;
};

/** The prompt files and labels the plan request reads (hot.prompts). */
type SelfreflectionPrompts = Record<string, unknown> & { labels?: unknown };

/** The memory store, as a selfreflection post reads it. */
export type SelfreflectionStore = {
  getSelfreflection?: () => { posts?: Array<object> } | null | undefined;
  getPlace: (placeId: string) => object | null;
  listUserProfiles: () => Array<object>;
  state: { data: Parameters<typeof pictureGate>[0]['data'] };
};

/** The messages of a request, as the client sends them. */
type PlanMessages = ReadonlyArray<{ role: string; content: unknown }>;

/** What the planner chooses from, each already rendered: the kinds, the seeds, the owner's topic and the stored facts. */
export type PlanParts = { kinds: string; seeds: string; topic: string; facts: string };

/** The language model client (src/llm/openrouter.ts#createLlm), as the plan request uses it. */
export type SelfreflectionLlm = {
  complete: (messages: PlanMessages, options: object) => Promise<unknown>;
};

/** The web lookup (src/web/lookup.ts#createLookup), as the plan's search uses it. */
export type SelfreflectionLookup = {
  search?: (placeId: string, query: string) => Promise<{ text?: unknown; sources?: unknown } | null | undefined>;
} | null;

/** The image client (src/llm/images.ts#createImageGen), as far as its cap is read. */
export type SelfreflectionImages = { quota?: (options: object) => { used: number; cap: number } | null } | null;

/** What createSelfreflection reads: the dependencies and the functions of the notes and of participation it calls. */
export type SelfreflectionContext = {
  /** A selfreflection post's stored facts through the one retrieval service. */
  selfreflectionFacts?: ((input: RetrievalInput) => Promise<MemoryPage | null>) | null;
  hot: { readonly prompts: SelfreflectionPrompts | null | undefined };
  store: SelfreflectionStore;
  llm: SelfreflectionLlm;
  rng: () => number;
  lookup: SelfreflectionLookup | undefined;
  images: SelfreflectionImages | undefined;
  journalOp: JournalNotes['journalOp'];
};

/** What the owner's command asked of a selfreflection post: a forced kind, a topic, whether it was forced. */
type SelfreflectionParams = { kind?: unknown; topic?: unknown; forced?: unknown } | null | undefined;

/** The seed combinations a plan request offered and the 1-based one the planner built on (0 for none). */
export type PlanSeeding = { seeds: Array<Array<string>>; seed: number };

/** The plan of a selfreflection post, with the owner's topic when there is one and its seeding when the planner answered. */
type SelfreflectionPlan = ReturnType<typeof validatePlan> & { topic?: string; seeding?: PlanSeeding };

export type SelfreflectionPrepared = {
  posts: Array<object>;
  plan: SelfreflectionPlan;
  found: string | null;
  pictureAllowed: boolean;
  seeds: string;
};

export type Selfreflection = {
  prepareSelfreflection: (args: {
    config: SelfreflectionConfig;

    channel: ChatInfo;
    now: number;
    params: SelfreflectionParams;
    memoryOn: boolean;
    /** The planner's request on the turn frame over what it chooses from; null when it cannot be built. */
    planMessages: (parts: PlanParts) => PlanMessages | null;
    draft?:
      | (NonNullable<Parameters<JournalNotes['journalOp']>[0]> & {
          snapshot?: Snapshot | null;
          memoryContext?: Context;
        })
      | null;
  }) => Promise<SelfreflectionPrepared>;
  selfreflectionPictureGate: (config: SelfreflectionConfig, channel: ChatInfo, now: number) => PictureGate;
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
 * The stored facts of a selfreflection post's interval, for its plan: the people she knows and the days since her last post, read
 * under the selfreflection's context, so no DM reaches a mirror. '' when there are none or the read failed.
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
        typeof one.id === 'string' ? [personOfMember(store, one.id)] : []
      ),
      entities: [],
    });
    const words = objOf(objOf(labels).selfreflectionFacts);
    if (!page?.assertions.length || typeof words.header !== 'string' || typeof words.fact !== 'string') return '';
    const states = objOf(objOf(objOf(labels).prefetch).factStates);
    const line = words.fact;
    const lines = page.assertions.map((fact) => fill(line, { state: factStateWords(fact, states), text: fact.text }));
    return [words.header, ...lines].join('\n');
  } catch (err) {
    logger.warn('selfreflection: retrieval failed', { code: objOf(err).code ?? null });
    return '';
  }
}

/**
 * What a selfreflection plan reads of the places she knows: the notes of the top places the entry's readers may see. With one top
 * place, its notes. With several, a place's notes reach the plan only when the entry stays inside its tree (its readers
 * read that server), and every place's when the entry is posted in no server at all: nobody outside reads it yet.
 */
export function selfreflectionPlaceNotes(
  store: Pick<SelfreflectionStore, 'getPlace'>,
  tops: ReadonlyArray<string>,
  entryTop: string | null
): object | null {
  if (tops.length === 0) return store.getPlace(PERSONA_ID);
  const [only] = tops;
  if (tops.length === 1 && only !== undefined) return store.getPlace(only);
  const readable = entryTop === null ? tops : tops.filter((place) => place === entryTop);
  return mergedNotes(readable.map((place) => (store.getPlace(place) ?? {}) as PlaceNotes));
}

export function createSelfreflection(ctx: SelfreflectionContext): Selfreflection {
  const { hot, store, llm, rng, lookup, images, journalOp, selfreflectionFacts = null } = ctx;

  /**
   * A selfreflection post's first step (mode `selfreflection`), before its request is built:
   * the post history (store.getSelfreflection), whether it may carry a picture (the
   * image client and Attach Files here), then the plan request (`planMessages`, the turn frame's request of the kind
   * `selfreflection_plan` with prompts/selfreflection-planner.md as its task, on the `analyzer` role,
   * `selfreflection.planMaxOutputTokens` (2000), `selfreflection.planTimeoutMs` (60000), usage purpose
   * `selfreflection-planner`; when
   * `llm.hedge` hedges `analyzer`, the hedged call is limited by
   * `selfreflection.planTimeoutMs` rather than `llm.hedge.timeoutMs`) with
   * `<seeds>` drawn from prompts/selfreflection-seeds.md (SEED_SETS, without the lines the newest
   * `selfreflection.historyPosts` entries built on: src/behavior/selfreflection.ts#usedSeedLines) and,
   * with an owner's topic (`params.topic`, src/behavior/selfreflection.ts#selfreflectionTopic),
   * a `<topic>` after them, and the stored facts of the interval as `<stored_facts>`; the topic also rides on the plan as its
   * `topic` field (the `<plan>` block of the post). The request hands the client src/behavior/selfreflection.ts#selfreflectionPlanFormat over the kinds it offers,
   * and the answer goes through parsePlanAnswer and validatePlan
   * (the given kind with an empty brief when the answer is missing or broken; `selfreflection.searchKinds`,
   * `selfreflection.pictureKinds`). A plan the planner answered keeps its
   * `seeding`: the combinations offered and the answer's `seed` (src/behavior/selfreflection.ts#planSeed). Before the
   * plan request the code draws the kind with `rng` over src/behavior/selfreflection.ts#drawWeights (the weights
   * corrected for their use among the newest `selfreflection.historyPosts` posts); the plan request offers that kind
   * alone, the plan keeps it over the answer's kind, and the `selfreflection: planned` line carries `drawn: true`.
   * While the post may not carry a picture, the kinds in `selfreflection.pictureKinds` are dropped before the draw
   * (src/behavior/selfreflection.ts#withoutPictureKinds) and the line carries `picturesOff: true`. A forced kind
   * (`params.kind`) replaces the draw, its brief kept (a forced picture kind with pictures off never gets here:
   * runTurn refuses it first, selfreflectionPictureGate). Then the search the plan asks for (lookup.search, its own
   * cache): its text is `found`; a failure or nothing
   * found logs `selfreflection: search failed` and the post goes without it. A request
   * or token cap on the plan request throws (the turn is refused); any other
   * failure of it falls back. A planned kind in `selfreflection.setKinds` (a set post) also draws
   * `selfreflection.set.seedSets` (6) seed combinations for the compose request (`seeds`, the rendered
   * `<seeds>` body; '' for any other kind). Settings come from `config`, the turn's live config.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5b, a pure move
  async function prepareSelfreflection({
    config,
    channel,
    now,
    params,
    memoryOn,
    planMessages,
    draft = null,
  }: Parameters<Selfreflection['prepareSelfreflection']>[0]): Promise<SelfreflectionPrepared> {
    const prompts = hot.prompts;
    const labels = prompts?.labels;
    const selfreflectionCfg = config.selfreflection ?? {};
    const stored = typeof store.getSelfreflection === 'function' ? store.getSelfreflection() : null;
    const posts = (Array.isArray(stored?.posts) ? stored.posts : []).filter(
      (post) => isIssuedInternalContext(draft?.memoryContext) || !selfreflectionRestricted(post)
    );
    const forcedKind = typeof params?.kind === 'string' && params.kind ? params.kind : null;
    const topic = selfreflectionTopic(params?.topic);
    const pictureAllowed = selfreflectionPictureGate(config, channel, now).allowed;
    // Pictures off: only the text kinds may be drawn.
    const picturesOff = !forcedKind && !pictureAllowed;
    const drawable: Record<string, number> = picturesOff
      ? // withoutPictureKinds drops entries of `kinds` and keeps the rest as they are, numbers.
        (withoutPictureKinds(SELFREFLECTION_KINDS, DEFAULT_PICTURE_KINDS) as Record<string, number>)
      : SELFREFLECTION_KINDS;
    // The code draws the kind, corrected for recent use; a forced kind wins. The planner is offered that kind alone.
    const drawnKind = forcedKind
      ? null
      : pickKind(drawWeights(drawable, posts, { window: DEFAULT_HISTORY_POSTS }), rng);
    const chosenKind = forcedKind ?? drawnKind;
    const kinds: Record<string, number> = chosenKind ? { [chosenKind]: 1 } : drawable;

    let answer: unknown = null;
    let offered: Array<Array<string>> = [];
    const planPrompt = prompts?.['selfreflection-planner'];
    let messages: PlanMessages | null = null;
    if (typeof planPrompt === 'string' && planPrompt.trim() && labels) {
      const facts = memoryOn ? await reflectionFacts(selfreflectionFacts, store, posts, now, labels, log) : '';
      // The lines the newest entries built on stay out of the draw, so the planner is offered other scenes.
      const used = usedSeedLines(stored?.posts, DEFAULT_HISTORY_POSTS);
      offered = pickSeeds(parseSeedFamilies(prompts['selfreflection-seeds']), SEED_SETS, rng, used).map((set) =>
        set.map(String)
      );
      messages = planMessages({
        kinds: renderKindsBlock(kinds, posts, labels, { window: DEFAULT_HISTORY_POSTS }),
        seeds: renderSeedsBlock(offered, labels),
        topic: renderTopicBlock(topic, labels),
        facts,
      });
    }
    if (messages) {
      const planTimeoutMs = selfreflectionCfg.planTimeoutMs ?? 60000;
      // A hedged plan request gets the plan's own limit, not llm.hedge.timeoutMs.
      const hedge = hedgeSettings(config);
      const planHedge =
        hedge && hedge.afterMs > 0 && hedge.roles.includes('analyzer')
          ? { hedge: { afterMs: hedge.afterMs, timeoutMs: planTimeoutMs } }
          : {};
      const offeredKinds = Object.keys(kinds);
      let completion: unknown = null;
      try {
        completion = await llm.complete(messages, {
          model: roleModel(config, 'analyzer', 'selfreflection-planner'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: selfreflectionCfg.planMaxOutputTokens ?? 2000,
            purpose: 'selfreflection-planner',
            timeoutMs: planTimeoutMs,
          }),
          ...planHedge,
          responseFormat: selfreflectionPlanFormat(offeredKinds),
        });
      } catch (err) {
        if (err instanceof DailyCapError || err instanceof TokenLimitError) throw err;
        log.warn('selfreflection: plan failed', {
          channel: channel.id,
          reason: railReason(err),
          // A thrown value is anything; an HTTP error of the client carries its status.
          status: (err as { statusCode?: unknown } | null)?.statusCode ?? null,
        });
      }
      if (completion) {
        answer = parsePlanAnswer(textOf(completion), offeredKinds);
        if (!answer) log.warn('selfreflection: plan failed', { channel: channel.id, reason: 'unparsed', status: null });
      }
    } else {
      log.warn('selfreflection: plan failed', { channel: channel.id, reason: 'no-prompt', status: null });
    }
    if (chosenKind && answer && typeof answer === 'object' && !Array.isArray(answer))
      answer = { ...answer, kind: chosenKind };
    const validated = validatePlan(
      answer,
      kinds,
      { pictureAllowed, searchKinds: DEFAULT_SEARCH_KINDS, pictureKinds: DEFAULT_PICTURE_KINDS },
      rng
    );
    // The owner's topic reaches the post even when the planner ignored it.
    const plan: SelfreflectionPlan = {
      ...validated,
      ...(topic ? { topic } : {}),
      ...(validated.fallback ? {} : { seeding: { seeds: offered, seed: planSeed(answer, offered.length) } }),
    };

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
          log.info('selfreflection: search failed', { channel: channel.id, reason: result ? 'nothing' : 'refused' });
      } catch (err) {
        if (op.opId) await op.failed(CODE.ERROR);
        log.warn('selfreflection: search failed', { channel: channel.id, reason: 'error', error: err });
      }
    }
    // A set post (selfreflection.setKinds): its compose request gets selfreflection.set.seedSets seed combinations.
    const seeds = isSetKind(plan.kind, DEFAULT_SET_KINDS)
      ? renderSeedsBlock(
          pickSeeds(parseSeedFamilies(prompts?.['selfreflection-seeds']), setSettings(selfreflectionCfg).seedSets, rng),
          labels ?? {}
        )
      : '';
    log.info('selfreflection: planned', {
      channel: channel.id,
      kind: plan.kind,
      fallback: plan.fallback,
      picture: plan.picture,
      search: Boolean(plan.search),
      found: found !== null,
      forced: params?.forced === true,
      ...(drawnKind ? { drawn: true } : {}),
      ...(picturesOff ? { picturesOff: true } : {}),
    });
    return { posts, plan, found, pictureAllowed, seeds };
  }

  /** Whether a selfreflection post in `channel` may carry a picture now (src/behavior/selfreflection-turn.ts#pictureGate). */
  function selfreflectionPictureGate(config: SelfreflectionConfig, channel: ChatInfo, now: number): PictureGate {
    return pictureGate({
      config,
      attach: channel.permissions.attach,
      drawing: Boolean(images),
      data: store.state.data,
      now,
    });
  }

  return { prepareSelfreflection, selfreflectionPictureGate };
}
