// A selfreflection request's own parts: the persona's world (`<virtual_world>`), her past entries (`<selfreflection>`), the
// post's `<plan>`, the planner's `<kinds>` and `<topic>`, the `<seeds>`, the mirrors to choose among
// (`<publication_places>`) and the audiences she has not heard were refused. buildRequest (src/behavior/prompt.ts) calls
// `selfreflectionFramedOf` for the planner and the writer on the frame, and `selfreflectionOf` for a request with no frame.
// None of it reaches a request of another kind.

import { DEFAULT_HISTORY_POSTS, localDayKey, renderSelfreflectionBlock } from '../../behavior/selfreflection.ts';
import { fill } from '../../format.ts';
import { refusedAudience } from '../../tools/publication.ts';
import { kindOfRequest } from './frame.ts';
import { fillPromptTemplate } from './text.ts';
import type { KnownPlaces } from '../../tools/publication.ts';
import type { Labels, Prompts, RequestConfig, RequestInput } from './types.ts';

/**
 * A selfreflection request's own input (buildRequest's `input.selfreflection`): the store's posts (their refused
 * audiences), her past entries as memory holds them, the plan, the search's find, the seeds and the mirrors; the planner's
 * kinds, the owner's topic and the stored facts of the interval, each already rendered.
 */
export type SelfreflectionInput = {
  readonly posts?: unknown;
  readonly entries?: ReadonlyArray<unknown> | null;
  readonly plan?: SelfreflectionPlan | null;
  readonly found?: unknown;
  readonly seeds?: unknown;
  readonly publicationPlaces?: KnownPlaces;
  readonly kinds?: string;
  readonly topic?: string;
  readonly facts?: string;
};

export type SelfreflectionPlan = {
  readonly kind?: unknown;
  readonly brief?: unknown;
  readonly picture?: unknown;
  readonly topic?: unknown;
};

/**
 * The world of a selfreflection request (the plan and the post): prompts/world.md with `{{name}}` filled, '' with the
 * file missing or blank. Never part of an ordinary turn: only the selfreflection's two requests call it.
 */
export function worldText(_config: unknown, prompts: Prompts | null | undefined, selfName: string): string {
  const text = prompts?.world;
  if (typeof text !== 'string' || !text.trim()) return '';
  return fillPromptTemplate(text, { name: selfName }).trim();
}

/** The `<diary>` block's post lines (no intro), oldest first: the newest `selfreflection.historyPosts` (150), a picture
 * post's scene cut to `selfreflection.sceneChars` (400). */
export function selfreflectionHistoryLines(
  posts: unknown,
  labels: Labels,
  config: Pick<RequestConfig, 'bot' | 'selfreflection'>
): Array<string> {
  const body = renderSelfreflectionBlock(posts, labels, {
    timezone: config.bot?.timezone,
    max: DEFAULT_HISTORY_POSTS,
    sceneChars: config.selfreflection?.sceneChars,
  });
  if (!body) return [];
  const lines = body.split('\n');
  const intro = labels.selfreflection?.intro;
  return intro && lines[0] === intro ? lines.slice(1) : lines;
}

/**
 * The `<plan>` body: `labels.selfreflection.plan`, then one line per field of the plan: `planKind` and `planBrief` with
 * `{value}`, `planPicture` or `planNoPicture`, and `planTopic` with `{value}` when the owner gave one. '' without a plan.
 */
export function planBody(plan: SelfreflectionPlan | null | undefined, labels: Labels): string {
  if (!plan || typeof plan !== 'object') return '';
  const kind = typeof plan.kind === 'string' ? plan.kind : '';
  const brief = typeof plan.brief === 'string' ? plan.brief : '';
  const topic = typeof plan.topic === 'string' ? plan.topic : '';
  if (!kind && !brief && !topic) return '';
  const words = labels.selfreflection ?? {};
  const line = (template: string | undefined, value: string): string =>
    template && value ? fill(template, { value }) : '';
  return [
    words.plan,
    line(words.planKind, kind),
    line(words.planBrief, brief),
    plan.picture === true ? words.planPicture : words.planNoPicture,
    line(words.planTopic, topic),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The `<publication_places>` body: `labels.selfreflection.publicationPlaces`, which carries the `<audience>` output
 * contract, then one `labels.selfreflection.publicationPlace` line per mirror with its `place:<place id>` token, its name
 * and its `interface:<iface>` token. '' with fewer than two mirrors, where there is nothing to choose among.
 */
export function publicationPlacesBody(known: KnownPlaces | undefined, labels: Labels): string {
  if (!known || known.places.length < 2) return '';
  const line = labels.selfreflection?.publicationPlace ?? '{place} {name}';
  return [
    labels.selfreflection?.publicationPlaces,
    ...known.places.map((place) =>
      fill(line, {
        place: `place:${place.id}`,
        name: place.name ?? '',
        iface: `interface:${place.iface ?? place.id.slice(0, Math.max(0, place.id.indexOf(':')))}`,
      }).trim()
    ),
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
 * A selfreflection post (mode `selfreflection`) on a request with no frame: the persona's world, its past posts, the
 * post's plan and what its search found. None of it in any other mode.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function selfreflectionOf(given: RequestInput & { labels: Labels }): SelfreflectionParts {
  const { config, prompts, mode, selfName, labels } = given;
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

/** What a selfreflection request on the frame adds: `<virtual_world>`, her past entries and the other parts of `<inner>`. */
export type SelfreflectionFramed = {
  /** The body of `<virtual_world>`, '' when world.md is empty. */
  world: string;
  /** The first line of `<selfreflection>` and one line per past entry, oldest first; the budget cuts the oldest. */
  intro: string;
  entries: Array<string>;
  /** The parts of `<inner>` after `<selfreflection>`, each its tag and body, in order. The budget cuts none. */
  parts: Array<{ tag: string; text: string }>;
  /** What she has not heard of: the audiences refused on her past entries, for `<feedback>`. */
  feedback: string;
};

/** How many past entries `<selfreflection>` shows by default. */
export const DEFAULT_ENTRIES_SHOWN = 150;

/** How many past entries `<selfreflection>` shows, the setting read now (docs/configuration.md, `selfreflection`). */
export function entriesShownOf(config: { selfreflection?: { entries?: unknown } | null } | null | undefined): number {
  const value = config?.selfreflection?.entries;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_ENTRIES_SHOWN;
}

const textPart = (tag: string, text: unknown): Array<{ tag: string; text: string }> =>
  typeof text === 'string' && text.trim() !== '' ? [{ tag, text: text.trim() }] : [];

/**
 * The parts of the planner's or the writer's request on the frame, null on any other kind. Both carry the world and
 * her past entries. The planner adds `<kinds>`, `<seeds>`, `<topic>` and `<stored_facts>`, what it chooses from. The writer
 * adds `<plan>` with what the search found, a set post's `<seeds>`, `<publication_places>` and the refused audiences.
 */
export function selfreflectionFramedOf(given: RequestInput & { labels: Labels }): SelfreflectionFramed | null {
  const { config, prompts, selfName, labels } = given;
  const kind = kindOfRequest(given);
  if (kind !== 'selfreflection' && kind !== 'selfreflection_plan') return null;
  const input = given.selfreflection ?? {};
  const shown = renderSelfreflectionBlock(input.entries ?? [], labels, {
    timezone: config.bot?.timezone,
    max: (input.entries ?? []).length,
    sceneChars: config.selfreflection?.sceneChars,
  });
  const lines = shown ? shown.split('\n') : [];
  const intro = labels.selfreflection?.intro ?? '';
  const entries = intro && lines[0] === intro ? lines.slice(1) : lines;
  const found =
    typeof input.found === 'string' && input.found.trim()
      ? [labels.selfreflection?.found, input.found.trim()].filter(Boolean).join('\n')
      : '';
  const parts =
    kind === 'selfreflection_plan'
      ? [
          ...textPart('kinds', input.kinds),
          ...textPart('seeds', input.seeds),
          ...textPart('topic', input.topic),
          ...textPart('stored_facts', input.facts),
        ]
      : [
          ...textPart('plan', [planBody(input.plan, labels), found].filter(Boolean).join('\n')),
          ...textPart('seeds', input.seeds),
          ...textPart('publication_places', publicationPlacesBody(input.publicationPlaces, labels)),
        ];
  return {
    world: worldText(config, prompts, selfName),
    intro: entries.length > 0 ? intro : '',
    entries,
    parts,
    feedback: kind === 'selfreflection' ? audienceRefusedBody(input.posts, labels, config.bot?.timezone) : '',
  };
}
