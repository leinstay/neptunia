// The core's own tools: what an agent of kind `tool` (src/agent-runner/profiles.js) runs, in this
// process, with no model loop and no runner in between. The one tool today is `draw`, the
// drawing agent's: the persona's scene goes into the drawing prompt exactly as she wrote it
// (prompts `draw` + `appearance` + the local time around it, the request only cut to
// `image.maxPromptChars`), the bot's avatar rides along as the reference for a picture she is in
// (`image.reference: 'avatar'`), and the Images client (src/llm/images.js, injected as `images`:
// the boundary every picture crosses, its own daily rails included) makes the picture. Nothing
// else touches her scene: no model rewrites, summarizes or "improves" it.
//
// Every call site goes through `drawPicture`: her `draw.create` tool (a diary post's pictures included) and
// `/nep draw`. With the errand service (`errands.runInline`, src/errands/service.js) the picture
// is also a task record of the drawing agent (queued -> running -> done | failed, `usage.usd` from
// the provider's own cost figure, outside `agents.maxOpen`, born seen); without it (a replay, a
// test) the same tool runs unrecorded. A failure comes back as the error the call sites already
// handle: `ImageCapError` (a rail, or the agent's daily caps `agents.drawing.daily`),
// `ImageGenError` (a generation that was sent and failed) and `UnsupportedImageModelError`, so
// limit notices and a call's result codes behave as before. The failure
// codes of the task record map to them one for one (`errorOfCode`).
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never a scene.

import { buildDrawPrompt } from '../behavior/prompt.js';
import { formatNow } from '../format.js';
import { avatarReference } from '../media/fetch-image.js';
import { clampAtBoundary } from '../memory/clamp.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../llm/images.js';
import { CODE } from '../skills/codes.js';

/** The agent's name (its folder under `agents/`). */
export const DRAWING_AGENT = 'drawing';

/** The failure codes of a drawing task, by the error a generation fails with. */
export const DRAW_CODES = Object.freeze({
  capDaily: 'image-cap-daily',
  capUserDaily: 'image-cap-user-daily',
  unsupported: 'unsupported-model',
  failed: CODE.ERROR,
});

/** The code of an `ImageGenError` of `reason` (`moderation`, `timeout`, `error`, `empty`). */
const genCode = (reason) => `image-${reason}`;

/** The generation failure reasons a code can name. */
const GEN_REASONS = Object.freeze(['moderation', 'timeout', 'error', 'empty']);

/**
 * The drawing tool's failure: `code` (kebab-case, what the task record keeps), `details` (what the
 * mapped error needs: `key`, `used`, `cap`, `statusCode`; numbers and codes only) and the original
 * error as `cause`.
 */
export class DrawToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ details?: object, cause?: unknown }} [extra]
   */
  constructor(code, message, { details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DrawToolError';
    this.code = code;
    this.details = details;
  }
}

/** The failure code and details of an error a generation threw. */
function failureOf(err) {
  if (err instanceof ImageCapError) {
    const { key, used, cap } = err;
    return { code: err.reason === 'userDaily' ? DRAW_CODES.capUserDaily : DRAW_CODES.capDaily, details: { key, used, cap } };
  }
  if (err instanceof ImageGenError) return { code: GEN_REASONS.includes(err.reason) ? genCode(err.reason) : DRAW_CODES.failed, details: { statusCode: err.statusCode ?? null } };
  if (err instanceof UnsupportedImageModelError) return { code: DRAW_CODES.unsupported, details: {} };
  return { code: DRAW_CODES.failed, details: {} };
}

/**
 * The error a failure code of a drawing task stands for: `image-cap-daily` / `image-cap-user-daily`
 * an `ImageCapError` (with `key`, `used`, `cap` from `details`), `image-<reason>` an
 * `ImageGenError` of that reason (its `statusCode` from `details`), `unsupported-model` an
 * `UnsupportedImageModelError`; any other code a plain `Error` carrying it as `code`.
 * @param {string} code
 * @param {{ key?: string, used?: number, cap?: number, statusCode?: number|null, message?: string, model?: string }} [details]
 * @returns {Error}
 */
export function errorOfCode(code, details = {}) {
  if (code === DRAW_CODES.capDaily || code === DRAW_CODES.capUserDaily) {
    const err = new ImageCapError(code === DRAW_CODES.capUserDaily ? 'userDaily' : 'daily', details.message);
    return Object.assign(err, { key: details.key, used: details.used, cap: details.cap });
  }
  const reason = GEN_REASONS.find((name) => genCode(name) === code);
  if (reason) return new ImageGenError(reason, details.message, { statusCode: details.statusCode ?? null });
  if (code === DRAW_CODES.unsupported) return new UnsupportedImageModelError(details.model ?? '');
  return Object.assign(new Error(details.message ?? `drawing failed (${code})`), { code });
}

/**
 * The drawing prompt of `scene`: prompts `draw` and `appearance` (read now) around the request,
 * cut to `image.maxPromptChars` at a boundary, with `{{when}}` the local date and time now
 * (`bot.timezone`) when `withTime` and a timezone is set (the owner's command carries none), and
 * the appearance only when `self`. The one builder of the prompt: the tool and the dry run share it.
 * @param {{ hot: { config: object, prompts: object }, selfName: string, scene: string, self?: boolean, withTime?: boolean, now?: () => number }} args
 * @returns {string}
 */
export function drawPromptOf({ hot, selfName, scene, self = false, withTime = false, now = Date.now }) {
  const timezone = hot.config.bot?.timezone;
  return buildDrawPrompt({
    prompts: hot.prompts,
    selfName,
    request: clampAtBoundary(scene, hot.config.image?.maxPromptChars),
    self: self === true,
    ...(withTime ? { when: timezone ? formatNow(now(), timezone, hot.prompts?.labels?.locale) : '' } : {}),
  });
}

/** The tokens a usage object reports under either of its names, or 0. */
function tokens(usage, ...names) {
  for (const name of names) if (Number.isFinite(usage?.[name]) && usage[name] >= 0) return usage[name];
  return 0;
}

/**
 * The drawing tool.
 * @param {object} deps
 * @param {{ generate: Function }} deps.images  src/llm/images.js#createImageGen: the boundary.
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} [deps.client]  The Discord client (the bot's avatar URL), for the reference.
 * @param {{ fetchAsDataUrl: Function }|null} [deps.imageFetcher]
 * @param {() => number} [deps.now]
 * @returns {{ name: string, run: (input: DrawInput) => Promise<{ output: { picture: object, referenceMissing: boolean }, usage: object, result: object }> }}
 *
 * @typedef {object} DrawInput
 * @property {string} scene  The persona's scene, as she wrote it.
 * @property {string} selfName
 * @property {boolean} [self]  A picture she is in: her appearance in the prompt, her avatar as reference.
 * @property {boolean} [withTime]  The local time in the prompt.
 * @property {string|null} [userId]  The member whose per-member rail counts it (null: nobody's).
 * @property {{ reference?: string|null }} [avatar]  A holder the avatar is fetched into once and
 *   reused (a diary set): a `reference` of null counts as fetched, absent as not yet.
 */
export function createDrawingTool({ images, hot, client = null, imageFetcher = null, now = Date.now }) {
  /**
   * One picture: the prompt, the avatar reference, then one generation through the Images client.
   * Throws a DrawToolError carrying the code of what went wrong (the original error as its `cause`).
   * Resolves what the task record keeps (`usage`, `result`) and the picture (`output`, in memory only).
   */
  async function run({ scene, selfName, self = false, withTime = false, userId = null, avatar = null }) {
    try {
      const prompt = drawPromptOf({ hot, selfName, scene, self, withTime, now });
      let reference = null;
      let referenceMissing = false;
      if (self === true && hot.config.image?.reference === 'avatar') {
        if (avatar && avatar.reference !== undefined) reference = avatar.reference;
        else {
          reference = await avatarReference({ client, imageFetcher, config: hot.config });
          referenceMissing = reference === null;
          if (avatar) avatar.reference = reference;
        }
      }
      const picture = await images.generate({ prompt, reference, userId });
      const spent = picture.usage;
      const usage = {
        input: tokens(spent, 'input_tokens', 'prompt_tokens'),
        output: tokens(spent, 'output_tokens', 'completion_tokens'),
        usd: Number.isFinite(picture.cost) && picture.cost >= 0 ? picture.cost : 0,
        steps: 1,
        seconds: Number.isFinite(picture.seconds) ? picture.seconds : 0,
        ...(picture.cost == null ? { costUnknown: 1 } : {}),
      };
      return { output: { picture, referenceMissing }, usage, result: { text: '' } };
    } catch (err) {
      const { code, details } = failureOf(err);
      throw new DrawToolError(code, err?.message ?? code, { details, cause: err });
    }
  }

  return { name: 'draw', run };
}

/**
 * The error a failed `runInline` outcome stands for, for the call sites: the original error of
 * the generation when the tool ran here (so `key`, `used`, `cap`, `statusCode` are exactly what
 * the Images client threw), else the one its code maps to (`errorOfCode`): a refusal of the
 * agent's daily caps (`cap-tasks`) is an `ImageCapError('daily')` naming
 * `agents.drawing.daily.tasks`, the same notice `image.maxPerDay` gives.
 * @param {{ code: string, error?: unknown, key?: string, used?: number, cap?: number }} outcome
 * @returns {Error}
 */
export function drawErrorOf(outcome) {
  const cause = outcome?.error instanceof DrawToolError ? outcome.error.cause : outcome?.error;
  if (cause instanceof ImageCapError || cause instanceof ImageGenError || cause instanceof UnsupportedImageModelError) return cause;
  // Anything else the tool threw is passed on as it was.
  if (outcome?.error instanceof DrawToolError && cause instanceof Error) return cause;
  if (outcome?.code === CODE.CAP_TASKS) {
    return errorOfCode(DRAW_CODES.capDaily, { key: outcome.key, used: outcome.used, cap: outcome.cap, message: `daily drawing cap reached (${outcome.key})` });
  }
  // The service's own cut-off of a run (`agents.drawing.limits.seconds`) is a generation that timed out.
  const code = outcome?.code === CODE.TIMEOUT ? genCode('timeout') : (outcome?.code ?? DRAW_CODES.failed);
  return errorOfCode(code, outcome?.error instanceof DrawToolError ? outcome.error.details : {});
}

/**
 * One picture through the drawing agent: as a task record when the errand service is there
 * (`errands.runInline`), else just the tool. Resolves `{ picture, referenceMissing }`; throws
 * `ImageCapError`, `ImageGenError` or `UnsupportedImageModelError` (drawErrorOf), as a direct call
 * of the Images client does.
 * @param {object} args
 * @param {ReturnType<typeof createDrawingTool>} args.tool
 * @param {{ runInline?: Function }|null} [args.errands]
 * @param {string|null} [args.guildId]
 * @param {DrawInput} args.input
 * @param {{ userId: string|null, kind: 'owner'|'member'|'persona' }} [args.requester]
 * @param {{ channelId?: string|null, messageId?: string|null }} [args.origin]
 * @param {'dm'|'group'} [args.scope]
 * @returns {Promise<{ picture: object, referenceMissing: boolean }>}
 */
export async function drawPicture({ tool, errands = null, guildId = null, input, requester = { userId: null, kind: 'persona' }, origin = {}, scope = 'group' }) {
  if (typeof errands?.runInline !== 'function') {
    try {
      return (await tool.run(input)).output;
    } catch (err) {
      throw err instanceof DrawToolError ? drawErrorOf({ code: err.code, error: err }) : err;
    }
  }
  const outcome = await errands.runInline({ guildId, agent: DRAWING_AGENT, goal: input.scene, requester, origin, scope, run: () => tool.run(input) });
  if (outcome.ok) return outcome.output;
  throw drawErrorOf(outcome);
}
