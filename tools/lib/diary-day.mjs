// The pure parts of tools/replay.mjs's `--diary-day` mode: one diary day run as the live diary
// would run it, slot by slot, with nothing posted. Here: the seeded random streams (the day plan
// and the turns draw from separate ones, so a change in what a turn draws never moves the
// slots), the day plan for a local date (src/behavior/diary.js#planDay, injected), the spend
// estimate, the image client wrapper that records every `generate()` call's arguments (the
// "fake" one answers a fixture PNG through the real client's own request path; the "live" one
// stops at `--max-pictures`), the short description of an avatar reference, and the report.
// Exists so the drawing calls of a whole diary day can be recorded before and after a change and
// diffed. Not for one diary brief (`--diary`).

import { createHash } from 'node:crypto';
import { mulberry32 } from './search-compare.mjs';

/** How `--draw` makes the pictures: the fixture PNG (default) or the real image client. */
export const DRAW_MODES = Object.freeze(['fake', 'live']);
/** The pictures a `--draw live` day makes at most without `--max-pictures`. */
export const DEFAULT_LIVE_PICTURES = 2;
/** The largest `--max-pictures`. */
export const MAX_PICTURES = 50;
/** The estimate per live picture (the drawing model's price, about). */
export const USD_PER_PICTURE = 0.025;
/** The limit key a live picture past `--max-pictures` is refused under (an image cap, as the turn sees it). */
export const MAX_PICTURES_KEY = 'replay.maxPictures';
/** A 1x1 transparent PNG: what every fake generation answers. */
export const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `value` is a calendar date `YYYY-MM-DD` (no 2026-02-30).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * A random stream in [0, 1) that depends only on `seed` and `stream` (mulberry32 seeded by the
 * sha256 of both).
 * @param {string} seed
 * @param {string} stream  'plan' or 'turns'.
 * @returns {() => number}
 */
export function seededRng(seed, stream) {
  const digest = createHash('sha256').update(`${seed}\u0000${stream}`).digest();
  return mulberry32(digest.readUInt32BE(0));
}

/**
 * The diary's plan for the local day `date` in `timezone`, as the live diary plans it at the
 * day's first tick (planDay at local midnight) with no hunger carried in, on the seed's `plan`
 * stream: the same config, date and seed give the same slots. `start` is the local midnight.
 * @param {{ diaryCfg: object|undefined, timezone: string|undefined, date: string, seed: string,
 *   planDay: Function, zonedEpoch: Function }} input  planDay and zonedEpoch from src/behavior/diary.js and src/time.js.
 * @returns {{ day: string, start: number, slots: number[], quiet: boolean, hunger: number[], quietStreak: number }}
 */
export function planDiaryDay({ diaryCfg, timezone, date, seed, planDay, zonedEpoch }) {
  const zone = timezone || 'UTC';
  const start = zonedEpoch(date, 0, 0, zone);
  if (!Number.isFinite(start)) throw new Error(`not a date: ${date}`);
  const plan = planDay(diaryCfg ?? {}, start, zone, seededRng(seed, 'plan'), {});
  return {
    day: plan.day,
    start,
    slots: [...plan.slots],
    quiet: plan.quiet,
    hunger: [...plan.hunger],
    quietStreak: plan.quietStreak,
  };
}

/**
 * What a diary day would cost: `requestsPerSlot` model requests per slot at `usdPerRequest`, and
 * with `draw` 'live' up to `maxPictures` pictures at USD_PER_PICTURE (none on a day without a
 * slot). For tools/lib/cli.mjs#spendGate.
 * @param {{ slots: number, draw: string, maxPictures: number, requestsPerSlot: number, usdPerRequest: number }} input
 * @returns {{ requests: number, pictures: number, estimateUsd: number, detail: string }}
 */
export function diaryDayEstimate({ slots, draw, maxPictures, requestsPerSlot, usdPerRequest }) {
  const requests = Math.max(0, slots) * requestsPerSlot;
  const pictures = draw === 'live' && slots > 0 ? maxPictures : 0;
  const estimateUsd = Math.round((requests * usdPerRequest + pictures * USD_PER_PICTURE) * 10000) / 10000;
  const detail =
    `${slots} slot(s), ${requestsPerSlot} request(s) each (the plan and the compose) at ~${usdPerRequest} USD` +
    (draw === 'live' ? `, up to ${pictures} live picture(s) at ~${USD_PER_PICTURE} USD` : ', pictures faked');
  return { requests, pictures, estimateUsd, detail };
}

/**
 * A reference image as the report shows it: never its bytes. A `data:` URL gives its media type,
 * its decoded size and the first 16 hex digits of its sha256; any other string its length and
 * hash; null stays null.
 * @param {unknown} reference
 * @returns {{ mediaType: string|null, bytes: number, sha256: string }|{ chars: number, sha256: string }|null}
 */
export function referenceOf(reference) {
  if (typeof reference !== 'string' || reference === '') return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(reference);
  if (!match)
    return { chars: reference.length, sha256: createHash('sha256').update(reference).digest('hex').slice(0, 16) };
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
  return {
    mediaType: match[1] ?? null,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

/**
 * The fetch the fake image client sends through: every request answered 200 with FIXTURE_PNG and
 * no cost, so the real client's caps, model check and routing run as live and nothing leaves.
 * @returns {typeof fetch}
 */
export function fixtureImagesFetch() {
  const answer = { data: [{ b64_json: FIXTURE_PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0 } };
  return async () => ({
    ok: true,
    status: 200,
    json: async () => structuredClone(answer),
    text: async () => JSON.stringify(answer),
  });
}

/**
 * An image client over `images` (createImageGen's shape) whose `generate()` records every call
 * first -- `{ prompt, reference: referenceOf(reference), userId }` -- in `calls`, then, past
 * `maxPictures` generations (`maxPictures` null: no cap), refuses it with `ImageCapError` (key
 * MAX_PICTURES_KEY, as an image cap reads to the turn) before anything is sent. Each call's
 * `result` is filled once it ends: `{ bytes, mediaType, cost, seconds }`, or `{ error, reason }`;
 * `onPicture(picture, index)` sees every picture that came out (`index` from 1); a string it
 * returns is kept as the call's `file`.
 * @param {{ images: object, ImageCapError: Function, maxPictures?: number|null,
 *   onPicture?: ((picture: object, index: number) => string|null|void)|null }} input
 * @returns {{ calls: object[], quota: Function, familyOf: Function, generate: Function }}
 */
export function recordingImages({ images, ImageCapError, maxPictures = null, onPicture = null }) {
  const calls = [];
  let made = 0;
  return {
    calls,
    quota: (...args) => images.quota(...args),
    familyOf: (...args) => images.familyOf(...args),
    async generate(args = {}) {
      const call = {
        prompt: args.prompt,
        reference: referenceOf(args.reference ?? null),
        userId: args.userId ?? null,
        result: null,
      };
      calls.push(call);
      if (maxPictures !== null && made >= maxPictures) {
        const err = Object.assign(new ImageCapError('daily', `replay picture cap reached (${maxPictures})`), {
          key: MAX_PICTURES_KEY,
          used: made,
          cap: maxPictures,
        });
        call.result = { error: err.name, reason: err.reason };
        throw err;
      }
      try {
        const picture = await images.generate(args);
        made += 1;
        call.result = {
          bytes: picture.buffer?.length ?? 0,
          mediaType: picture.mediaType ?? null,
          cost: picture.cost ?? null,
          seconds: picture.seconds ?? null,
        };
        const file = typeof onPicture === 'function' ? onPicture(picture, made) : null;
        if (typeof file === 'string' && file) call.file = file;
        return picture;
      } catch (err) {
        call.result = { error: err?.name ?? 'Error', reason: err?.reason ?? null };
        throw err;
      }
    },
  };
}

/** One line of a markdown table cell: pipes escaped, line breaks as spaces. */
function cell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * The report's markdown: the day's plan, then per slot its outcome, its plan, her messages and
 * every drawing call (the whole prompt in a block, the reference's description, the member it
 * is charged to, what came out).
 * @param {{ date: string, timezone: string, seed: string, draw: string, quiet: boolean, slots: object[],
 *   usage?: object, stopped?: string|null }} report
 * @returns {string}
 */
export function renderDiaryDayReport(report) {
  const lines = [`# Diary day ${report.date} (${report.timezone})`, ''];
  lines.push(
    `- seed: \`${report.seed}\``,
    `- draw: ${report.draw}`,
    `- slots: ${report.slots.length}${report.quiet ? ' (a quiet day)' : ''}`
  );
  if (report.usage)
    lines.push(
      `- requests: ${report.usage.requests}, cost: ${report.usage.cost} USD, pictures: ${report.usage.pictures ?? 0}`
    );
  if (report.stopped) lines.push(`- stopped: ${report.stopped}`);
  lines.push('');
  for (const slot of report.slots) {
    lines.push(`## Slot ${slot.n}: ${slot.local ?? slot.at}`, '');
    lines.push(`- outcome: ${slot.outcome ?? '-'}${slot.reason ? ` (${slot.reason})` : ''}`);
    if (slot.plan) lines.push(`- plan: \`${cell(JSON.stringify(slot.plan))}\``);
    for (const [i, text] of (slot.messages ?? []).entries()) lines.push(`- message ${i + 1}: ${cell(text)}`);
    if (slot.attachments) lines.push(`- files posted: ${slot.attachments}`);
    for (const [i, draw] of (slot.draws ?? []).entries()) {
      lines.push('', `### Drawing ${i + 1}`, '');
      lines.push(`- reference: ${draw.reference ? `\`${JSON.stringify(draw.reference)}\`` : 'none'}`);
      lines.push(`- userId: ${draw.userId ?? 'none'}`);
      lines.push(`- result: ${draw.result ? `\`${JSON.stringify(draw.result)}\`` : '-'}`);
      if (draw.file) lines.push(`- file: ${draw.file}`);
      lines.push('', '```text', String(draw.prompt ?? ''), '```');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
