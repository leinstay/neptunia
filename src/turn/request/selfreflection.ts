// A selfreflection request's own parts: the persona's world (`<virtual_world>`), her past entries (`<selfreflection>`), the
// post's `<plan>`, the planner's `<kinds>` and `<topic>`, the `<seeds>`, the mirrors to choose among
// (`<publication_places>`) and the audiences she has not heard were refused. buildRequest (src/behavior/prompt.ts) calls
// `selfreflectionFramedOf` for the planner and the writer on the frame, and `selfreflectionOf` for a request with no frame.
// None of it reaches a request of another kind.

import {
  localDayKey,
  recentOpenings,
  renderOpenings,
  renderSelfreflectionBlock,
} from '../../behavior/selfreflection.ts';
import { fill } from '../../format.ts';
import { refusedAudience } from '../../tools/publication.ts';
import { kindOfRequest } from './frame.ts';
import { fillPromptTemplate } from './text.ts';
import type { KnownPlaces } from '../../tools/publication.ts';
import type { Labels, Prompts, RequestInput } from './types.ts';

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

/**
 * The `<plan>` body: `labels.selfreflection.plan`, then one line per field of the plan: `planKind` and `planBrief` with
 * `{value}`, the `openings` lines (renderOpenings) under the brief, `planPicture` or `planNoPicture`, and `planTopic`
 * with `{value}` when the owner gave one. '' without a plan.
 */
export function planBody(
  plan: SelfreflectionPlan | null | undefined,
  labels: Labels,
  openings: ReadonlyArray<string> = []
): string {
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
    ...openings,
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
        iface: `interface:${place.iface ?? ''}`,
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

/** What a selfreflection request on the frame adds: `<virtual_world>`, her past entries and the other parts of `<inner>`. */
export type SelfreflectionFramed = {
  /** The body of `<virtual_world>`, '' when world.md is empty. */
  world: string;
  /** The first line of `<selfreflection>` and one line per past entry, newest first; the budget cuts the oldest. */
  intro: string;
  entries: Array<string>;
  /** The parts of `<inner>` after `<selfreflection>`, each its tag and body, in order. The budget cuts none. */
  parts: Array<{ tag: string; text: string }>;
  /** What she has not heard of: the audiences refused on her past entries, for `<feedback>`. */
  feedback: string;
};

/** How many past entries `<selfreflection>` shows by default. */
export const DEFAULT_ENTRIES_SHOWN = 150;

/** How many past entries the writer's `<selfreflection>` shows by default. */
export const DEFAULT_WRITER_ENTRIES = 30;

/** How many entries of the plan's kind `<plan>` tells how they opened, and how many words of each, by default. */
export const DEFAULT_OPENINGS_SHOWN = 5;
export const DEFAULT_OPENING_WORDS = 4;

type SelfreflectionConfig = { selfreflection?: Readonly<Record<string, unknown>> | null } | null | undefined;

/** A `selfreflection` setting that is a whole count from 0, else `fallback`; the setting read now. */
function settingOf(config: SelfreflectionConfig, key: string, fallback: number): number {
  const value = config?.selfreflection?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** How many past entries the planner's `<selfreflection>` shows, the setting read now (docs/configuration.md, `selfreflection`). */
export function entriesShownOf(config: SelfreflectionConfig): number {
  return settingOf(config, 'entries', DEFAULT_ENTRIES_SHOWN);
}

/** How many past entries the writer's `<selfreflection>` shows (`selfreflection.writerEntries`), read now. */
export function writerEntriesShownOf(config: SelfreflectionConfig): number {
  return settingOf(config, 'writerEntries', DEFAULT_WRITER_ENTRIES);
}

const textPart = (tag: string, text: unknown): Array<{ tag: string; text: string }> =>
  typeof text === 'string' && text.trim() !== '' ? [{ tag, text: text.trim() }] : [];

/**
 * The parts of the planner's or the writer's request on the frame, null on any other kind. Both carry the world and
 * her past entries, newest first: the planner the newest `selfreflection.entries`, the writer the newest
 * `selfreflection.writerEntries`. The planner adds `<kinds>`, `<seeds>`, `<topic>` and `<stored_facts>`, what it chooses from. The writer
 * adds `<plan>` with what the search found and how her last entries of the plan's kind opened, a set post's `<seeds>`, `<publication_places>` and the refused audiences.
 */
export function selfreflectionFramedOf(given: RequestInput & { labels: Labels }): SelfreflectionFramed | null {
  const { config, prompts, selfName, labels } = given;
  const kind = kindOfRequest(given);
  if (kind !== 'selfreflection' && kind !== 'selfreflection_plan') return null;
  const input = given.selfreflection ?? {};
  const past = input.entries ?? [];
  const shown = renderSelfreflectionBlock(past, labels, {
    timezone: config.bot?.timezone,
    max: kind === 'selfreflection' ? writerEntriesShownOf(config) : past.length,
    sceneChars: config.selfreflection?.sceneChars,
  });
  const lines = shown ? shown.split('\n') : [];
  const intro = labels.selfreflection?.intro ?? '';
  const entries = intro && lines[0] === intro ? lines.slice(1) : lines;
  const found =
    typeof input.found === 'string' && input.found.trim()
      ? [labels.selfreflection?.found, input.found.trim()].filter(Boolean).join('\n')
      : '';
  const planKind = typeof input.plan?.kind === 'string' ? input.plan.kind : '';
  const openings = renderOpenings(
    recentOpenings(past, planKind, {
      count: settingOf(config, 'openingsShown', DEFAULT_OPENINGS_SHOWN),
      words: settingOf(config, 'openingWords', DEFAULT_OPENING_WORDS),
    }),
    labels
  );
  const parts =
    kind === 'selfreflection_plan'
      ? [
          ...textPart('kinds', input.kinds),
          ...textPart('seeds', input.seeds),
          ...textPart('topic', input.topic),
          ...textPart('stored_facts', input.facts),
        ]
      : [
          ...textPart('plan', [planBody(input.plan, labels, openings), found].filter(Boolean).join('\n')),
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
