// A diary request's own parts: her past entries (`<diary>`), the
// post's `<plan>`, the planner's `<kinds>` and `<topic>`, the `<seeds>`, the mirrors to choose among
// (`<publication_places>`), the brief the judge turned down (`<rejected>`) and the audiences she has not heard were refused. buildRequest (src/behavior/prompt.ts) calls
// `diaryFramedOf` for the planner and the writer on the frame, and `diaryOf` for a request with no frame.
// None of it reaches a request of another kind.

import { localDayKey, renderDiaryBlock } from '../../behavior/diary.ts';
import { fill } from '../../format.ts';
import { refusedAudience } from '../../tools/publication.ts';
import { kindOfRequest } from './frame.ts';
import type { KnownPlaces } from '../../tools/publication.ts';
import type { Labels, RequestInput } from './types.ts';

/**
 * A diary request's own input (buildRequest's `input.diary`): the store's posts (their refused
 * audiences), her past entries as memory holds them, the plan, the search's find, the seeds and the mirrors; the planner's
 * kinds, the owner's topic and the stored facts of the interval, each already rendered.
 */
export type DiaryInput = {
  readonly posts?: unknown;
  readonly entries?: ReadonlyArray<unknown> | null;
  readonly plan?: DiaryPlan | null;
  readonly found?: unknown;
  readonly seeds?: unknown;
  readonly publicationPlaces?: KnownPlaces;
  readonly kinds?: string;
  readonly topic?: string;
  readonly facts?: string;
  readonly rejected?: string;
};

export type DiaryPlan = {
  readonly kind?: unknown;
  readonly brief?: unknown;
  readonly picture?: unknown;
  readonly topic?: unknown;
};

/**
 * The `<plan>` body: `labels.diary.plan`, then one line per field of the plan: `planKind` and `planBrief` with
 * `{value}`, `planPicture` or `planNoPicture`, and `planTopic`
 * with `{value}` when the owner gave one. '' without a plan.
 */
export function planBody(plan: DiaryPlan | null | undefined, labels: Labels): string {
  if (!plan || typeof plan !== 'object') return '';
  const kind = typeof plan.kind === 'string' ? plan.kind : '';
  const brief = typeof plan.brief === 'string' ? plan.brief : '';
  const topic = typeof plan.topic === 'string' ? plan.topic : '';
  if (!kind && !brief && !topic) return '';
  const words = labels.diary ?? {};
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
 * The `<publication_places>` body: `labels.diary.publicationPlaces`, which carries the `<audience>` output
 * contract, then one `labels.diary.publicationPlace` line per mirror with its `place:<place id>` token, its name
 * and its `interface:<iface>` token. '' with fewer than two mirrors, where there is nothing to choose among.
 */
export function publicationPlacesBody(known: KnownPlaces | undefined, labels: Labels): string {
  if (!known || known.places.length < 2) return '';
  const line = labels.diary?.publicationPlace ?? '{place} {name}';
  return [
    labels.diary?.publicationPlaces,
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
 * The `<audience_refused>` block's body: one `labels.diary.audienceRefused` line per post of `posts` whose audience could
 * not be read and that she has not heard of, its reason from `labels.diary.audienceReasons`. '' when there is none.
 */
export function audienceRefusedBody(posts: unknown, labels: Labels, timezone: string | undefined): string {
  const template = labels.diary?.audienceRefused;
  const reasons = (labels.diary?.audienceReasons ?? {}) as unknown as Readonly<Record<string, string | undefined>>;
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

/** What a diary request on the frame adds: her past entries and the other parts of `<inner>`. */
export type DiaryFramed = {
  /** The first line of `<diary>` and one line per past entry, newest first; the budget cuts the oldest. */
  intro: string;
  entries: Array<string>;
  /** The parts of `<inner>` after `<diary>`, each its tag and body, in order. The budget cuts none. */
  parts: Array<{ tag: string; text: string }>;
  /** What she has not heard of: the audiences refused on her past entries, for `<feedback>`. */
  feedback: string;
};

/** How many past entries `<diary>` shows by default. */
export const DEFAULT_ENTRIES_SHOWN = 150;

/** How many past entries the writer's `<diary>` shows by default. */
export const DEFAULT_WRITER_ENTRIES = 30;

type DiaryConfig = { diary?: Readonly<Record<string, unknown>> | null } | null | undefined;

/** A `diary` setting that is a whole count from 0, else `fallback`; the setting read now. */
function settingOf(config: DiaryConfig, key: string, fallback: number): number {
  const value = config?.diary?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** How many past entries the planner's `<diary>` shows, the setting read now (docs/configuration.md, `diary`). */
export function entriesShownOf(config: DiaryConfig): number {
  return settingOf(config, 'entries', DEFAULT_ENTRIES_SHOWN);
}

/** How many past entries the writer's `<diary>` shows (`diary.writerEntries`), read now. */
export function writerEntriesShownOf(config: DiaryConfig): number {
  return settingOf(config, 'writerEntries', DEFAULT_WRITER_ENTRIES);
}

const textPart = (tag: string, text: unknown): Array<{ tag: string; text: string }> =>
  typeof text === 'string' && text.trim() !== '' ? [{ tag, text: text.trim() }] : [];

/**
 * The parts of the planner's or the writer's request on the frame, null on any other kind. Both carry her past entries, newest first: the planner the newest `diary.entries`, the writer the newest
 * `diary.writerEntries`. The planner adds `<kinds>`, `<seeds>`, `<topic>` and `<stored_facts>`, what it chooses from, and `<rejected>`, the brief
 * the judge turned down. The writer adds `<plan>` with what the search found, a set post's `<seeds>`, `<publication_places>` and the refused audiences.
 */
export function diaryFramedOf(given: RequestInput & { labels: Labels }): DiaryFramed | null {
  const { config, labels } = given;
  const kind = kindOfRequest(given);
  if (kind !== 'diary' && kind !== 'diary_plan') return null;
  const input = given.diary ?? {};
  const past = input.entries ?? [];
  const shown = renderDiaryBlock(past, labels, {
    timezone: config.bot?.timezone,
    max: kind === 'diary' ? writerEntriesShownOf(config) : past.length,
  });
  const lines = shown ? shown.split('\n') : [];
  const intro = labels.diary?.intro ?? '';
  const entries = intro && lines[0] === intro ? lines.slice(1) : lines;
  const found =
    typeof input.found === 'string' && input.found.trim()
      ? [labels.diary?.found, input.found.trim()].filter(Boolean).join('\n')
      : '';
  const parts =
    kind === 'diary_plan'
      ? [
          ...textPart('kinds', input.kinds),
          ...textPart('seeds', input.seeds),
          ...textPart('topic', input.topic),
          ...textPart('stored_facts', input.facts),
          ...textPart('rejected', input.rejected),
        ]
      : [
          ...textPart('plan', [planBody(input.plan, labels), found].filter(Boolean).join('\n')),
          ...textPart('seeds', input.seeds),
          ...textPart('publication_places', publicationPlacesBody(input.publicationPlaces, labels)),
        ];
  return {
    intro: entries.length > 0 ? intro : '',
    entries,
    parts,
    feedback: kind === 'diary' ? audienceRefusedBody(input.posts, labels, config.bot?.timezone) : '',
  };
}
