// Pure functions for the measured audio map of a downloaded video clip. A video
// model told nothing about the sound tends to invent it for a clip with no
// audio stream, a silent track or a mostly silent one; the fetcher
// (src/media/fetch-video.js) therefore measures the clip it sends with one
// read-only ffmpeg `silencedetect` pass, and the describer
// (src/memory/describe.js) adds a measured note to the video model's system
// prompt (`labels.videoAudio.none` / `labels.videoAudio.map`). This module
// builds that ffmpeg run, reads its stderr, and turns the silences into the
// audible stretches and the `m:ss-m:ss` list the note carries. No I/O here.

import { fill } from '../format.js';
import { formatDurationShort } from './classify.js';

/** `media.video.audioMap` values used for a missing or invalid key (config.json carries the same). */
export const AUDIO_MAP_DEFAULTS = Object.freeze({
  noiseDb: -50,
  minSilenceSeconds: 0.5,
  mapBelowShare: 0.8,
  maxSpans: 20,
});

// An audible stretch shorter than this (seconds) is float noise at a clamp
// edge, not sound.
const AUDIBLE_EPSILON_SECONDS = 0.05;

const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const INPUT_LINE = /^Input #\d+,/m;
const AUDIO_STREAM_LINE = /^\s*Stream #\d+:\d+.*?:\s*Audio:/m;
const SILENCE_EVENT = /silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;

/** A finite number, else `fallback`. */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The measuring settings from `media.video.audioMap`: null when it is `null`
 * or `false` (measuring off); otherwise each of `noiseDb` (a finite number),
 * `minSilenceSeconds` (> 0), `mapBelowShare` (0..1) and `maxSpans` (an
 * integer >= 1) from the value, AUDIO_MAP_DEFAULTS for a missing or invalid
 * one -- a missing `audioMap` (or `true`) is all defaults. Pure.
 * @param {unknown} value
 * @returns {{ noiseDb: number, minSilenceSeconds: number, mapBelowShare: number, maxSpans: number }|null}
 */
export function audioMapSettings(value) {
  if (value === null || value === false) return null;
  const given = value && typeof value === 'object' ? value : {};
  const d = AUDIO_MAP_DEFAULTS;
  const minSilence = finiteOr(given.minSilenceSeconds, NaN);
  const share = finiteOr(given.mapBelowShare, NaN);
  const spans = finiteOr(given.maxSpans, NaN);
  return {
    noiseDb: finiteOr(given.noiseDb, d.noiseDb),
    minSilenceSeconds: minSilence > 0 ? minSilence : d.minSilenceSeconds,
    mapBelowShare: share >= 0 && share <= 1 ? share : d.mapBelowShare,
    maxSpans: spans >= 1 ? Math.floor(spans) : d.maxSpans,
  };
}

/**
 * The read-only ffmpeg run that measures `clipPath`'s audio: the input is
 * decoded and nothing is written (`-f null -`); `silencedetect` prints the
 * silences on stderr, the input section names the streams and the duration.
 * @param {string} clipPath
 * @param {{ ffmpegPath: string, noiseDb: number, minSilenceSeconds: number }} options
 * @returns {{ command: string, args: string[] }}
 */
export function silenceDetectArgs(clipPath, { ffmpegPath, noiseDb, minSilenceSeconds } = {}) {
  return {
    command: ffmpegPath,
    args: [
      '-nostats',
      '-hide_banner',
      '-i',
      String(clipPath),
      '-vn',
      '-af',
      `silencedetect=n=${noiseDb}dB:d=${minSilenceSeconds}`,
      '-f',
      'null',
      '-',
    ],
  };
}

/**
 * ffmpeg's stderr of a silenceDetectArgs run, read: `inputSeen` (the input
 * section was printed, so the file was opened), `hasAudio` (it lists an
 * audio stream), `durationSec` (the input's `Duration:`, null for `N/A` or
 * none) and `silences` in order, `{ start, end }` with `end` null for a
 * silence still running at the end of the file (an `end` with no `start`
 * before it counts from 0). Pure.
 * @param {string} stderr
 * @returns {{ inputSeen: boolean, hasAudio: boolean, durationSec: number|null,
 *   silences: { start: number, end: number|null }[] }}
 */
export function parseSilenceDetect(stderr) {
  const text = String(stderr ?? '');
  const duration = DURATION_LINE.exec(text);
  const durationSec = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
  const silences = [];
  let open = null;
  for (const match of text.matchAll(SILENCE_EVENT)) {
    const at = Number(match[2]);
    if (!Number.isFinite(at)) continue;
    if (match[1].toLowerCase() === 'start') {
      if (open === null) open = at;
    } else {
      silences.push({ start: open ?? 0, end: at });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: open, end: null });
  return {
    inputSeen: INPUT_LINE.test(text),
    hasAudio: AUDIO_STREAM_LINE.test(text),
    durationSec: durationSec !== null && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    silences,
  };
}

/**
 * The audible stretches of a clip `durationSec` long: the complement of
 * `silences` (an open end runs to the end of the clip), every bound clamped
 * to [0, durationSec], stretches shorter than AUDIBLE_EPSILON_SECONDS
 * dropped. `[[start, end], ...]` in order. Pure.
 * @param {{ start: number, end: number|null }[]} silences
 * @param {number} durationSec
 * @returns {[number, number][]}
 */
export function audibleSpans(silences, durationSec) {
  if (!(durationSec > 0)) return [];
  const clamp = (value) => Math.min(durationSec, Math.max(0, value));
  const quiet = (silences ?? [])
    .map(({ start, end }) => [clamp(start), clamp(end ?? durationSec)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const spans = [];
  let cursor = 0;
  for (const [start, end] of quiet) {
    if (start > cursor) spans.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < durationSec) spans.push([cursor, durationSec]);
  return spans.filter(([start, end]) => end - start >= AUDIBLE_EPSILON_SECONDS);
}

/**
 * `spans` (ordered) with neighbours closer than `minGapSeconds` joined, then
 * the two closest neighbours joined again and again until at most `maxSpans`
 * are left. Pure.
 * @param {[number, number][]} spans
 * @param {{ minGapSeconds: number, maxSpans: number }} options
 * @returns {[number, number][]}
 */
export function mergeSpans(spans, { minGapSeconds, maxSpans }) {
  const out = [];
  for (const [start, end] of spans ?? []) {
    const last = out[out.length - 1];
    if (last && start - last[1] < minGapSeconds) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  const cap = Math.max(1, Math.floor(maxSpans) || 1);
  while (out.length > cap) {
    let at = 1;
    for (let i = 2; i < out.length; i += 1) {
      if (out[i][0] - out[i - 1][1] < out[at][0] - out[at - 1][1]) at = i;
    }
    out[at - 1][1] = Math.max(out[at - 1][1], out[at][1]);
    out.splice(at, 1);
  }
  return out;
}

/**
 * What the video model is told about a measured clip: `{ kind: 'none' }`
 * with no audio stream or nothing audible; `{ kind: 'map', spans }` when the
 * audible share of the clip is below `mapBelowShare` (spans merged by
 * mergeSpans with `minSilenceSeconds` and `maxSpans`); `{ kind: 'full' }`
 * otherwise (nothing is said). Null when the measurement cannot be read: the
 * input was never opened, or the duration is unknown on both sides. `fallbackSec`
 * is the clip length the fetcher knows, for an input that prints none. Pure.
 * @param {ReturnType<typeof parseSilenceDetect>} parsed
 * @param {{ minSilenceSeconds: number, mapBelowShare: number, maxSpans: number }} settings
 * @param {number|null} [fallbackSec]
 * @returns {{ kind: 'none' } | { kind: 'map', spans: [number, number][] } | { kind: 'full' } | null}
 */
export function classifyAudio(parsed, settings, fallbackSec = null) {
  if (!parsed?.inputSeen) return null;
  if (!parsed.hasAudio) return { kind: 'none' };
  const durationSec = parsed.durationSec ?? (fallbackSec > 0 ? fallbackSec : null);
  if (durationSec === null) return null;
  const spans = audibleSpans(parsed.silences, durationSec);
  const audible = spans.reduce((sum, [start, end]) => sum + (end - start), 0);
  if (audible <= 0) return { kind: 'none' };
  if (audible / durationSec >= settings.mapBelowShare) return { kind: 'full' };
  return {
    kind: 'map',
    spans: mergeSpans(spans, { minGapSeconds: settings.minSilenceSeconds, maxSpans: settings.maxSpans }),
  };
}

/**
 * The `{spans}` text of `labels.videoAudio.map`: each stretch as `m:ss-m:ss`,
 * its start rounded down and its end up to whole seconds (a sub-second sound
 * still gets a one-second stretch), joined by `, `. Pure.
 * @param {[number, number][]} spans
 * @returns {string}
 */
export function formatSpans(spans) {
  return (spans ?? [])
    .map(([start, end]) => {
      const from = Math.floor(start);
      const to = Math.max(from + 1, Math.ceil(end));
      return `${formatDurationShort(from)}-${formatDurationShort(to)}`;
    })
    .join(', ');
}

/** A label that is a non-blank string, else ''. */
function labelText(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

/**
 * The measured-sound note for the video model: `labels.videoAudio.none` for
 * `{ kind: 'none' }`, `labels.videoAudio.map` with `{spans}` (formatSpans)
 * for a `map` with stretches, '' for anything else (`full`, no measurement)
 * or a missing or blank label. Pure.
 * @param {{ kind: string, spans?: [number, number][] }|null|undefined} audio
 * @param {object|undefined} labels  The live `prompts.labels`.
 * @returns {string}
 */
export function videoAudioNote(audio, labels) {
  const forms = labels?.videoAudio;
  if (audio?.kind === 'none') return labelText(forms?.none);
  if (audio?.kind === 'map' && Array.isArray(audio.spans) && audio.spans.length > 0) {
    const template = labelText(forms?.map);
    return template ? fill(template, { spans: formatSpans(audio.spans) }) : '';
  }
  return '';
}

/**
 * `systemText` with `note` appended after a blank line; `systemText` as it is
 * for an empty note. Pure.
 * @param {string} systemText
 * @param {string} note
 * @returns {string}
 */
export function withAudioNote(systemText, note) {
  return note ? `${systemText}\n\n${note}` : systemText;
}
