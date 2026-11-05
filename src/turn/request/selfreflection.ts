// A selfreflection post's own blocks: the persona's world (`<world>`), its past posts (`<diary>`), the post's `<plan>`, a set
// post's `<seeds>` and what its search found (`<found>`). buildRequest and buildSelfreflectionPlanRequest
// (src/behavior/prompt.ts) call them. None of it reaches a request of another mode.

import { DEFAULT_HISTORY_POSTS, localDayKey, renderSelfreflectionBlock } from '../../behavior/selfreflection.ts';
import { fill } from '../../format.ts';
import { refusedAudience } from '../../tools/publication.ts';
import { fillPromptTemplate } from './text.ts';
import type { KnownPlaces } from '../../tools/publication.ts';
import type { Labels, Prompts, RequestConfig, RequestInput } from './types.ts';

/** A selfreflection post's plan (src/turn/selfreflection.ts): its kind, its brief, whether it has a picture and the owner's topic. */
/** A selfreflection post's own input (buildRequest's `input.selfreflection`): the past posts, the plan, the search's find, the seeds. */
export type SelfreflectionInput = {
  readonly posts?: unknown;
  readonly plan?: SelfreflectionPlan | null;
  readonly found?: unknown;
  readonly seeds?: unknown;
  readonly publicationPlaces?: KnownPlaces;
};

export type SelfreflectionPlan = {
  readonly kind?: unknown;
  readonly brief?: unknown;
  readonly picture?: unknown;
  readonly topic?: unknown;
};

/**
 * The `<world>` block's body of a selfreflection request (the plan and the post):
 * prompts/world.md with `{{name}}` filled, only while `selfreflection.world === true`
 * in `config` (the live config, read at the moment of use); '' with the
 * switch off or the file missing or blank. Never part of an ordinary turn:
 * only the selfreflection's two requests call it.
 */
export function worldText(
  config: Pick<RequestConfig, 'selfreflection'> | null | undefined,
  prompts: Prompts | null | undefined,
  selfName: string
): string {
  if (config?.selfreflection?.world !== true) return '';
  const text = prompts?.world;
  if (typeof text !== 'string' || !text.trim()) return '';
  return fillPromptTemplate(text, { name: selfName }).trim();
}

/** The `<diary>` block's post lines (no intro), oldest first: the newest `selfreflection.historyPosts` (150). */
export function selfreflectionHistoryLines(
  posts: unknown,
  labels: Labels,
  config: Pick<RequestConfig, 'bot' | 'selfreflection'>
): Array<string> {
  const body = renderSelfreflectionBlock(posts, labels, {
    timezone: config.bot?.timezone,
    max: DEFAULT_HISTORY_POSTS,
  });
  if (!body) return [];
  const lines = body.split('\n');
  const intro = labels.selfreflection?.intro;
  return intro && lines[0] === intro ? lines.slice(1) : lines;
}

/** The `<plan>` block's body: `labels.selfreflection.plan`, then the plan as one JSON line (`topic` only
 * when the owner gave one); '' without a plan. */
export function planBody(plan: SelfreflectionPlan | null | undefined, labels: Labels): string {
  if (!plan || typeof plan !== 'object') return '';
  const kind = typeof plan.kind === 'string' ? plan.kind : '';
  const brief = typeof plan.brief === 'string' ? plan.brief : '';
  const topic = typeof plan.topic === 'string' ? plan.topic : '';
  if (!kind && !brief && !topic) return '';
  const line = { kind, brief, picture: plan.picture === true, ...(topic ? { topic } : {}) };
  return [labels.selfreflection?.plan, JSON.stringify(line)].filter(Boolean).join('\n');
}

/**
 * The `<publication_places>` block's body: `labels.selfreflection.publicationPlaces`, which carries the `<audience>` output
 * contract, then one `interface:<iface>` line per interface and one `place:<place id> <name>` line per place, a place
 * indented under its parent. '' when memory knows no place, so she has nothing to name.
 */
export function publicationPlacesBody(known: KnownPlaces | undefined, labels: Labels): string {
  if (!known || known.places.length === 0) return '';
  const ids = new Set(known.places.map((place) => place.id));
  const under = Map.groupBy(known.places, (place) =>
    place.parentId !== null && ids.has(place.parentId) ? place.parentId : null
  );
  const lines = (parent: string | null, depth: number): Array<string> =>
    (under.get(parent) ?? []).flatMap((place) => [
      `${'  '.repeat(depth)}place:${place.id}${place.name ? ` ${place.name}` : ''}`,
      ...lines(place.id, depth + 1),
    ]);
  return [
    labels.selfreflection?.publicationPlaces,
    ...known.interfaces.map((iface) => `interface:${iface}`),
    ...lines(null, 0),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The `<audience_refused>` block's body: one `labels.selfreflection.audienceRefused` line per post of `posts` whose audience could
 * not be read and that she has not heard of, its reason from `labels.selfreflection.audienceReasons`. '' when there is none.
 */
export function audienceRefusedBody(posts: unknown, labels: Labels, timezone: string | undefined): string {
  const template = labels.selfreflection?.audienceRefused;
  const reasons = (labels.selfreflection?.audienceReasons ?? {}) as unknown as Readonly<
    Record<string, string | undefined>
  >;
  if (typeof template !== 'string' || !Array.isArray(posts)) return '';
  return (posts as ReadonlyArray<{ at?: unknown; gist?: unknown; publicationAudience?: unknown }>)
    .flatMap((post) => {
      const refused = refusedAudience(post.publicationAudience);
      if (!refused || refused.told) return [];
      const date = typeof post.at === 'number' ? localDayKey(post.at, timezone) : '';
      return [
        fill(template, {
          date,
          gist: typeof post.gist === 'string' ? post.gist : '',
          reason: reasons[refused.reason] ?? '',
        }),
      ];
    })
    .join('\n');
}

/** A selfreflection post's blocks: the world, the past posts with their intro, the plan, what the search found, the seeds. */
export type SelfreflectionParts = {
  worldItem: string;
  selfreflectionLines: Array<string>;
  selfreflectionIntro: string;
  planText: string;
  foundText: string;
  seedsText: string;
  publicationPlacesText: string;
  audienceRefusedText: string;
  selfreflectionParts: {
    intro: string;
    plan: string;
    seeds: string;
    publicationPlaces: string;
    audienceRefused: string;
  } | null;
};

/**
 * A selfreflection post (mode `selfreflection`): the persona's world (under `selfreflection.world`), its past posts, the post's plan and what
 * its search found. None of it in any other mode.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function selfreflectionOf(given: RequestInput & { labels: Labels }): SelfreflectionParts {
  const { config, prompts, mode, selfName, labels } = given;
  // A selfreflection post (mode `selfreflection`): the persona's world (under `selfreflection.world`), its past posts, the
  // post's plan and what its search found. None of it in any other mode.
  const selfreflectionMode = mode === 'selfreflection';
  const selfreflectionInput =
    selfreflectionMode && given.selfreflection && typeof given.selfreflection === 'object'
      ? given.selfreflection
      : null;
  const worldItem = selfreflectionMode ? worldText(config, prompts, selfName) : '';
  const selfreflectionLines = selfreflectionInput
    ? selfreflectionHistoryLines(selfreflectionInput.posts, labels, config)
    : [];
  const selfreflectionIntro = selfreflectionLines.length > 0 ? (labels.selfreflection?.intro ?? '') : '';
  const planText = selfreflectionInput ? planBody(selfreflectionInput.plan, labels) : '';
  const foundText =
    selfreflectionInput && typeof selfreflectionInput.found === 'string' && selfreflectionInput.found.trim()
      ? [labels.selfreflection?.found, selfreflectionInput.found.trim()].filter(Boolean).join('\n')
      : '';
  // A set post's seed combinations (already rendered by src/behavior/selfreflection.ts#renderSeedsBlock).
  const seedsText =
    selfreflectionInput && typeof selfreflectionInput.seeds === 'string' ? selfreflectionInput.seeds.trim() : '';
  const publicationPlacesText = publicationPlacesBody(selfreflectionInput?.publicationPlaces, labels);
  const audienceRefusedText = selfreflectionInput
    ? audienceRefusedBody(selfreflectionInput.posts, labels, config.bot?.timezone)
    : '';
  const selfreflectionParts = selfreflectionMode
    ? {
        intro: selfreflectionIntro,
        plan: planText,
        seeds: seedsText,
        publicationPlaces: publicationPlacesText,
        audienceRefused: audienceRefusedText,
      }
    : null;
  return {
    worldItem,
    selfreflectionLines,
    selfreflectionIntro,
    planText,
    foundText,
    seedsText,
    publicationPlacesText,
    audienceRefusedText,
    selfreflectionParts,
  };
}
