// The diary's scene helper: one `analyzer` request with the purpose `diary-scene` that builds a scene for one entry
// from numbered seed sets, a place with its circumstances and nothing of what the persona does or feels. Its system
// message is the task text `prompts/diary-scene.md`, never the persona, and its one user message holds `<kind>`,
// `<sets>` and `<now>` alone. scripts/diary-scenes.ts runs it to calibrate the prompt; nothing in a turn calls it.

import { DEFAULT_HISTORY_POSTS, usedSeedLines } from './diary.ts';
import { parseSeedFamilies, pickSeeds } from './seeds.ts';
import { formatNow } from '../format.ts';
import { DailyCapError, TokenLimitError, roleRequestOptions } from '../llm/openrouter.ts';
import { parseJsonObject } from '../llm/parse.ts';
import { roleModel } from '../llm/roles.ts';
import { block } from '../turn/request/text.ts';

/** The kinds of entry a scene is built for. */
export const SCENE_KINDS = ['status', 'selfPicture', 'picture', 'photoset', 'randomSet'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** How many seed sets one request offers. */
export const SCENE_SETS = 8;

const PURPOSE = 'diary-scene';
// The planner's own defaults (`diary.planMaxOutputTokens`, `diary.planTimeoutMs`): a scene is shorter than a plan.
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

/** One run of the helper: the sets offered, then the scene or why there is none. */
export type SceneResult = { sets: Array<Array<string>>; tokens: SceneTokens } & (
  { ok: true; set: number; used: Array<string>; scene: string } | { ok: false; reason: SceneFailure }
);

/** The part of the llm client the helper calls. */
export type SceneLlm = {
  complete(messages: Array<{ role: string; content: string }>, options: object): Promise<unknown>;
};

export function isSceneKind(kind: unknown): kind is SceneKind {
  return SCENE_KINDS.some((one) => one === kind);
}

/**
 * The `SCENE_SETS` seed sets of one request, drawn with `rng` from the families of `seedsText` (prompts/diary-seeds.md),
 * leaving out the lines the newest `DEFAULT_HISTORY_POSTS` of `posts` (oldest first) built on, as the planner's draw does.
 */
export function drawSceneSets({
  seedsText,
  posts,
  rng,
}: {
  seedsText: unknown;
  posts: unknown;
  rng: () => number;
}): Array<Array<string>> {
  const used = usedSeedLines(posts, DEFAULT_HISTORY_POSTS);
  return pickSeeds(parseSeedFamilies(seedsText), SCENE_SETS, rng, used).map((set) => set.map(String));
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
 * The JSON object of an answer, null when it holds none. A route with no strict response format, the core model through
 * a harness, wraps its JSON in a code fence, so the object is read out of the text around it.
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

/** An answer of the client as the helper reads it: its text and the provider's `usage`. */
type Completion = { text?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;

/** The tokens of an answer's `usage`, as the provider reports them. */
function tokensOf(completion: Completion): SceneTokens {
  const usage = completion?.usage;
  return { in: Number(usage?.prompt_tokens) || 0, out: Number(usage?.completion_tokens) || 0 };
}

/**
 * One scene for `kind` over `sets` (drawSceneSets) at the moment `now` in `timezone`: the request of the helper on
 * `role` (the `analyzer` unless the caller names the `core` to compare the two), its prompt `prompts['diary-scene']` and its settings read from `hot` at the moment of use. A request
 * or token cap throws; any other failure of the request is `request-failed`. Throws for a kind outside SCENE_KINDS.
 */
/** The model roles a scene request may go out on. */
export const SCENE_ROLES = ['analyzer', 'core'] as const;
export type SceneRole = (typeof SCENE_ROLES)[number];

export async function buildScene({
  hot,
  llm,
  kind,
  sets,
  now,
  timezone,
  role = 'analyzer',
}: {
  hot: { config: unknown; prompts: Record<string, unknown> | null | undefined };
  llm: SceneLlm;
  kind: string;
  sets: Array<Array<string>>;
  now: number;
  timezone: string;
  role?: SceneRole;
}): Promise<SceneResult> {
  if (!isSceneKind(kind))
    throw new Error(`diary scene: kind "${kind}" gets no scene; use one of ${SCENE_KINDS.join(', ')}`);
  const none: SceneTokens = { in: 0, out: 0 };
  const prompt = hot.prompts?.[PURPOSE];
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
        model: roleModel(config, role, PURPOSE),
        ...roleRequestOptions(config, {
          role,
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
