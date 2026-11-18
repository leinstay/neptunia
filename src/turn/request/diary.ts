// A diary request's own parts: the persona's past entries (`<diary>`), the entry's `<kind>`, its `<scene>` or its
// `<stored_facts>`, the owner's `<topic>`, the mirrors to choose among (`<publication_places>`) and the audiences the
// persona has not heard were refused. buildRequest (src/behavior/prompt.ts) calls `diaryFramedOf` on the frame, and
// `diaryTaskOf` gives the entry's task text. None of it reaches a request of another kind.

import { localDayKey, renderDiaryBlock, renderTopicBlock } from '../../behavior/diary.ts';
import { fill } from '../../format.ts';
import { refusedAudience } from '../../tools/publication.ts';
import { kindOfRequest } from './frame.ts';
import type { KnownPlaces } from '../../tools/publication.ts';
import type { Labels, RequestInput } from './types.ts';

/**
 * A diary request's own input (buildRequest's `input.diary`): the store's posts (their refused audiences), the past
 * entries as memory holds them, the entry's kind, the texts of its scenes, the owner's topic, the rendered stored facts
 * and the mirrors.
 */
export type DiaryInput = {
  readonly posts?: unknown;
  readonly entries?: ReadonlyArray<unknown> | null;
  readonly kind?: string | null;
  readonly scenes?: ReadonlyArray<string>;
  readonly topic?: string | null;
  readonly facts?: string;
  readonly publicationPlaces?: KnownPlaces;
};

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

/** What a diary request on the frame adds: the past entries and the other parts of `<inner>`. */
export type DiaryFramed = {
  /** The first line of `<diary>` and one line per past entry, newest first; the budget cuts the oldest. */
  intro: string;
  entries: Array<string>;
  /** The parts of `<inner>` after `<diary>`, each its tag and body, in order. The budget cuts none. */
  parts: Array<{ tag: string; text: string }>;
  /** What the persona has not heard of: the audiences refused on the past entries, for `<feedback>`. */
  feedback: string;
};

/** How many past entries `<diary>` shows by default. */
export const DEFAULT_ENTRIES_SHOWN = 30;

type DiaryConfig = { diary?: Readonly<Record<string, unknown>> | null } | null | undefined;

/** How many past entries `<diary>` shows (`diary.writerEntries`), read now: a whole count from 0, else the default. */
export function entriesShownOf(config: DiaryConfig): number {
  const value = config?.diary?.writerEntries;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_ENTRIES_SHOWN;
}

const textPart = (tag: string, text: unknown): Array<{ tag: string; text: string }> =>
  typeof text === 'string' && text.trim() !== '' ? [{ tag, text: text.trim() }] : [];

/**
 * The parts of a diary request on the frame, null on any other kind: the past entries, newest first, as many as
 * `diary.writerEntries`, then `<kind>`, the scenes one after another in `<scene>`, the owner's `<topic>`, the
 * `<stored_facts>` of a kind with no scene, `<publication_places>` and the refused audiences.
 */
export function diaryFramedOf(given: RequestInput & { labels: Labels }): DiaryFramed | null {
  const { config, labels } = given;
  if (kindOfRequest(given) !== 'diary') return null;
  const input = given.diary ?? {};
  const past = input.entries ?? [];
  const shown = renderDiaryBlock(past, labels, { timezone: config.bot?.timezone, max: past.length });
  const lines = shown ? shown.split('\n') : [];
  const intro = labels.diary?.intro ?? '';
  const entries = intro && lines[0] === intro ? lines.slice(1) : lines;
  const parts = [
    ...textPart('kind', input.kind),
    ...textPart('scene', (input.scenes ?? []).join('\n\n')),
    ...textPart('topic', renderTopicBlock(input.topic, labels)),
    ...textPart('stored_facts', input.facts),
    ...textPart('publication_places', publicationPlacesBody(input.publicationPlaces, labels)),
  ];
  return {
    intro: entries.length > 0 ? intro : '',
    entries,
    parts,
    feedback: audienceRefusedBody(input.posts, labels, config.bot?.timezone),
  };
}

/**
 * The task text of a diary entry of `kind`: the common text `task` (the mode's file, `diary/task`), then the kind's
 * own file `prompts['diary/kinds/<kind>']`, each read as the hot prompts hold it.
 */
export function diaryTaskOf(task: unknown, prompts: Readonly<Record<string, unknown>>, kind: unknown): string {
  const common = typeof task === 'string' ? task.trim() : '';
  const own = typeof kind === 'string' ? prompts[`diary/kinds/${kind}`] : undefined;
  // A kind whose file a deployment emptied or left out gets the common text alone.
  const section = typeof own === 'string' ? own.trim() : '';
  return [common, section].filter(Boolean).join('\n\n');
}
