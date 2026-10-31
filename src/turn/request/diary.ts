// A diary post's own blocks: the persona's world (`<world>`), its past posts (`<diary>`), the post's `<plan>`, a set
// post's `<seeds>` and what its search found (`<found>`). buildRequest and buildDiaryPlanRequest
// (src/behavior/prompt.js) call them. None of it reaches a request of another mode.

import { renderDiaryBlock } from '../../behavior/diary.ts';
import { fillPromptTemplate } from './text.ts';
import type { Labels, Prompts, RequestConfig, RequestInput } from './types.ts';

/** A diary post's plan (src/turn/diary.ts): its kind, its brief, whether it has a picture and the owner's topic. */
/** A diary post's own input (buildRequest's `input.diary`): the past posts, the plan, the search's find, the seeds. */
export type DiaryInput = {
  readonly posts?: unknown;
  readonly plan?: DiaryPlan | null;
  readonly found?: unknown;
  readonly seeds?: unknown;
};

export type DiaryPlan = {
  readonly kind?: unknown;
  readonly brief?: unknown;
  readonly picture?: unknown;
  readonly topic?: unknown;
};

/**
 * The `<world>` block's body of a diary request (the plan and the post):
 * prompts/world.md with `{{name}}` filled, only while `diary.world === true`
 * in `config` (the live config, read at the moment of use); '' with the
 * switch off or the file missing or blank. Never part of an ordinary turn:
 * only the diary's two requests call it.
 */
export function worldText(
  config: Pick<RequestConfig, 'diary'> | null | undefined,
  prompts: Prompts | null | undefined,
  selfName: string
): string {
  if (config?.diary?.world !== true) return '';
  const text = prompts?.world;
  if (typeof text !== 'string' || !text.trim()) return '';
  return fillPromptTemplate(text, { name: selfName }).trim();
}

/** The `<diary>` block's post lines (no intro), oldest first: the newest `diary.historyPosts` (150). */
export function diaryHistoryLines(
  posts: unknown,
  labels: Labels,
  config: Pick<RequestConfig, 'bot' | 'diary'>
): Array<string> {
  const body = renderDiaryBlock(posts, labels, {
    timezone: config.bot?.timezone,
    max: config.diary?.historyPosts ?? 150,
  });
  if (!body) return [];
  const lines = body.split('\n');
  const intro = labels.diary?.intro;
  return intro && lines[0] === intro ? lines.slice(1) : lines;
}

/** The `<plan>` block's body: `labels.diary.plan`, then the plan as one JSON line (`topic` only
 * when the owner gave one); '' without a plan. */
export function planBody(plan: DiaryPlan | null | undefined, labels: Labels): string {
  if (!plan || typeof plan !== 'object') return '';
  const kind = typeof plan.kind === 'string' ? plan.kind : '';
  const brief = typeof plan.brief === 'string' ? plan.brief : '';
  const topic = typeof plan.topic === 'string' ? plan.topic : '';
  if (!kind && !brief && !topic) return '';
  const line = { kind, brief, picture: plan.picture === true, ...(topic ? { topic } : {}) };
  return [labels.diary?.plan, JSON.stringify(line)].filter(Boolean).join('\n');
}

/** A diary post's blocks: the world, the past posts with their intro, the plan, what the search found, the seeds. */
export type DiaryParts = {
  worldItem: string;
  diaryLines: Array<string>;
  diaryIntro: string;
  planText: string;
  foundText: string;
  seedsText: string;
  diaryParts: { intro: string; plan: string; seeds: string } | null;
};

/**
 * A diary post (mode `diary`): the persona's world (under `diary.world`), its past posts, the post's plan and what
 * its search found. None of it in any other mode.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function diaryOf(given: RequestInput & { labels: Labels }): DiaryParts {
  const { config, prompts, mode, selfName, labels } = given;
  // A diary post (mode `diary`): the persona's world (under `diary.world`), its past posts, the
  // post's plan and what its search found. None of it in any other mode.
  const diaryMode = mode === 'diary';
  const diaryInput = diaryMode && given.diary && typeof given.diary === 'object' ? given.diary : null;
  const worldItem = diaryMode ? worldText(config, prompts, selfName) : '';
  const diaryLines = diaryInput ? diaryHistoryLines(diaryInput.posts, labels, config) : [];
  const diaryIntro = diaryLines.length > 0 ? (labels.diary?.intro ?? '') : '';
  const planText = diaryInput ? planBody(diaryInput.plan, labels) : '';
  const foundText =
    diaryInput && typeof diaryInput.found === 'string' && diaryInput.found.trim()
      ? [labels.diary?.found, diaryInput.found.trim()].filter(Boolean).join('\n')
      : '';
  // A set post's seed combinations (already rendered by src/behavior/diary.ts#renderSeedsBlock).
  const seedsText = diaryInput && typeof diaryInput.seeds === 'string' ? diaryInput.seeds.trim() : '';
  const diaryParts = diaryMode ? { intro: diaryIntro, plan: planText, seeds: seedsText } : null;
  return { worldItem, diaryLines, diaryIntro, planText, foundText, seedsText, diaryParts };
}
