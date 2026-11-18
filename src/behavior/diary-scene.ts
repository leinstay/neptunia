// The diary's director: one request on the role `director` with the purpose `diary-scene` that builds a scene for one entry
// from numbered seed sets, a place with its circumstances and nothing of what the persona does or feels. Its system
// message is the task text `prompts/diary/scene.md`, never the persona, and its one user message holds `<kind>`,
// `<sets>` and `<now>` alone. The diary's turn asks `entryScenes` before the persona's request (src/turn/diary.ts), and
// scripts/diary-scenes.ts runs `buildScene` alone to calibrate the prompt.

import { DEFAULT_HISTORY_POSTS, usedSeedLines } from './diary.ts';
import { pickSeeds, seedLines } from './seeds.ts';
import { formatNow } from '../format.ts';
import { DailyCapError, TokenLimitError, roleRequestOptions } from '../llm/openrouter.ts';
import { parseJsonObject } from '../llm/parse.ts';
import { DIARY_DIRECTOR_ROLE, roleModel } from '../llm/roles.ts';
import { block } from '../turn/request/text.ts';

/** The kinds of entry a scene is built for. */
export const SCENE_KINDS = ['story', 'selfPicture', 'picture', 'photoset', 'randomSet'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** How many seed sets one request offers. */
export const SCENE_SETS = 8;

/** How many scenes an entry of `randomSet` asks for, one request each: its pictures come from several places. */
const RANDOM_SET_SCENES = 3;

const PURPOSE = 'diary-scene';
// A scene answer is a few sentences in a small JSON object; a minute covers a slow route.
const MAX_OUTPUT_TOKENS = 2000;
const TIMEOUT_MS = 60000;

/** Why an answer is no scene. */
export type SceneFailure =
  | 'no-prompt'
  | 'request-failed'
  | 'not-json'
  | 'fields'
  | 'set-out-of-range'
  | 'line-not-in-set'
  | 'scene-empty'
  | 'scene-without-set';

/** The tokens one request spent, 0 when the answer reports none. */
export type SceneTokens = { in: number; out: number };

/** One run of the director: the sets offered, then the scene or why there is none. */
export type SceneResult = { sets: Array<Array<string>>; tokens: SceneTokens } & (
  { ok: true; set: number; used: Array<string>; scene: string } | { ok: false; reason: SceneFailure }
);

/** The part of the llm client the director calls. */
export type SceneLlm = {
  complete(messages: Array<{ role: string; content: string }>, options: object): Promise<unknown>;
};

export function isSceneKind(kind: unknown): kind is SceneKind {
  return SCENE_KINDS.some((one) => one === kind);
}

/** The diary's seed families, each a file of `prompts/diary/seeds/`, in the order prompts/diary/scene.md names a set's lines. */
export const DIARY_SEED_FAMILIES = ['place', 'setting', 'detail', 'activity', 'subject', 'twist', 'where'] as const;

/**
 * `SCENE_SETS` seed sets for each of `requests` requests (1 by default), drawn with `rng` in one draw from the files
 * `prompts['diary/seeds/<family>']` of DIARY_SEED_FAMILIES, so no two sets share a line while a family has a line left
 * for each, and leaving out the lines the newest `DEFAULT_HISTORY_POSTS` of `posts` (oldest first) kept.
 */
export function drawSceneSets({
  prompts,
  posts,
  rng,
  requests = 1,
}: {
  prompts: Readonly<Record<string, unknown>> | null | undefined;
  posts: unknown;
  rng: () => number;
  requests?: number;
}): Array<Array<string>> {
  const used = usedSeedLines(posts, DEFAULT_HISTORY_POSTS);
  const families = Object.fromEntries(
    DIARY_SEED_FAMILIES.map((family) => [family, seedLines(prompts?.[`diary/seeds/${family}`])])
  );
  return pickSeeds(families, SCENE_SETS * requests, rng, used).map((set) => set.map(String));
}

/** The schema of the answer, sent as the strict `response_format`. */
const SCENE_FORMAT = {
  name: 'diary-scene',
  schema: {
    type: 'object',
    properties: {
      set: { type: 'integer' },
      used: { type: 'array', items: { type: 'string' } },
      scene: { type: 'string' },
    },
    required: ['set', 'used', 'scene'],
    additionalProperties: false,
  },
};

/**
 * The JSON object of an answer, null when it holds none. A harness route takes no strict response format and may wrap
 * its JSON in a code fence, so the object is read out of the text around it.
 */
function answerObject(text: unknown): Record<string, unknown> | null {
  try {
    const parsed = parseJsonObject(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // No `{...}` span in the answer, or one that is not JSON.
    return null;
  }
}

/** The answer `text` read against the `sets` offered: every field checked, the text around the object left out. */
function parseSceneAnswer(
  text: unknown,
  sets: ReadonlyArray<ReadonlyArray<string>>
): { ok: true; set: number; used: Array<string>; scene: string } | { ok: false; reason: SceneFailure } {
  const answer = answerObject(text);
  if (!answer) return { ok: false, reason: 'not-json' };
  const { set, used, scene } = answer;
  const shaped =
    Object.keys(answer).length === 3 &&
    Number.isInteger(set) &&
    Array.isArray(used) &&
    used.every((line) => typeof line === 'string') &&
    typeof scene === 'string';
  if (!shaped) return { ok: false, reason: 'fields' };
  // `shaped` checked the set; Number.isInteger narrows nothing for the compiler.
  const number = set as number;
  const lines = used;
  const told = scene;
  if (number < 0 || number > sets.length) return { ok: false, reason: 'set-out-of-range' };
  const offered = number === 0 ? [] : sets[number - 1];
  if (!lines.every((line) => offered.includes(line))) return { ok: false, reason: 'line-not-in-set' };
  if (number === 0 && told.trim()) return { ok: false, reason: 'scene-without-set' };
  if (number !== 0 && !told.trim()) return { ok: false, reason: 'scene-empty' };
  return { ok: true, set: number, used: lines, scene: told.trim() };
}

/** An answer of the client as the director reads it: its text and the provider's `usage`. */
type Completion = { text?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;

/** The tokens of an answer's `usage`, as the provider reports them. */
function tokensOf(completion: Completion): SceneTokens {
  const usage = completion?.usage;
  return { in: Number(usage?.prompt_tokens) || 0, out: Number(usage?.completion_tokens) || 0 };
}

/**
 * One scene for `kind` over `sets` (drawSceneSets) at the moment `now` in `timezone`: the request of the director on the
 * role `director`, which takes the analyzer's chain while it has no route, its prompt `prompts['diary/scene']` and
 * its settings read from `hot` at the moment of use. A request or token cap throws; any other failure of the request is
 * `request-failed`. Throws for a kind outside SCENE_KINDS.
 */
export async function buildScene({
  hot,
  llm,
  kind,
  sets,
  now,
  timezone,
}: {
  hot: { config: unknown; prompts: Record<string, unknown> | null | undefined };
  llm: SceneLlm;
  kind: string;
  sets: Array<Array<string>>;
  now: number;
  timezone: string;
}): Promise<SceneResult> {
  if (!isSceneKind(kind))
    throw new Error(`diary scene: kind "${kind}" gets no scene; use one of ${SCENE_KINDS.join(', ')}`);
  const none: SceneTokens = { in: 0, out: 0 };
  const prompt = hot.prompts?.['diary/scene'];
  if (typeof prompt !== 'string' || !prompt.trim()) return { sets, tokens: none, ok: false, reason: 'no-prompt' };
  const numbered = sets.map((set, index) => [`${index + 1}.`, ...set].join('\n')).join('\n\n');
  const user = [block('kind', kind), block('sets', numbered), block('now', formatNow(now, timezone))].join('\n\n');
  const config = hot.config;
  let completion: Completion;
  try {
    // The client answers `{ text, usage }` (src/llm/openrouter.ts).
    completion = (await llm.complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: user },
      ],
      {
        model: roleModel(config, DIARY_DIRECTOR_ROLE, PURPOSE),
        ...roleRequestOptions(config, {
          role: DIARY_DIRECTOR_ROLE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          purpose: PURPOSE,
          timeoutMs: TIMEOUT_MS,
        }),
        responseFormat: SCENE_FORMAT,
      }
    )) as Completion;
  } catch (err) {
    if (err instanceof DailyCapError || err instanceof TokenLimitError) throw err;
    return { sets, tokens: none, ok: false, reason: 'request-failed' };
  }
  return { sets, tokens: tokensOf(completion), ...parseSceneAnswer(completion?.text, sets) };
}

/**
 * The scenes of one entry of `kind`: one request of buildScene over fresh sets, and for `randomSet` `RANDOM_SET_SCENES`
 * requests at once, whose sets come from one draw (drawSceneSets) and so share no line while the families allow it.
 * Every result is returned, failed ones included, in the order of the requests.
 */
export async function entryScenes({
  hot,
  llm,
  kind,
  posts,
  rng,
  now,
  timezone,
}: {
  hot: { config: unknown; prompts: Record<string, unknown> | null | undefined };
  llm: SceneLlm;
  kind: SceneKind;
  posts: unknown;
  rng: () => number;
  now: number;
  timezone: string;
}): Promise<Array<SceneResult>> {
  const requests = kind === 'randomSet' ? RANDOM_SET_SCENES : 1;
  const sets = drawSceneSets({ prompts: hot.prompts, posts, rng, requests });
  const groups = Array.from({ length: requests }, (_, index) =>
    sets.slice(index * SCENE_SETS, (index + 1) * SCENE_SETS)
  );
  return Promise.all(groups.map((group) => buildScene({ hot, llm, kind, sets: group, now, timezone })));
}
