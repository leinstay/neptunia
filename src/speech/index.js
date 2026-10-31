// The persona's voice messages: one `say` runs the whole pipeline -- the preparation pass
// (src/speech/prepare.js), the synthesis (synth.js) and the conversion to a voice note
// (convert.js) -- under its own daily rail, `speech.maxPerDay`, counted on the same state as the
// picture counter and only when the synthesis request is actually sent. Posting is the caller's
// (src/tools/impl/voice.ts): this module makes the file and says what it cost.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never the text.

import { log } from '../log.js';
import { bumpDaily, countToday } from '../time.js';
import { dailyCapOf } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { CODE } from '../tools/codes.ts';
import { prepareSpeech } from './prepare.js';
import { SpeechSynthError, SPEECH_ROLE, synthesizeSpeech } from './synth.js';
import { SpeechConvertError, toVoiceNote } from './convert.js';

/** The state.json fields of the instance-wide daily voice counter. */
const SPEECH_DAILY = { dayKey: 'speechDay', countKey: 'speechCount' };

/** The setting a spent rail names. */
export const SPEECH_CAP_KEY = 'speech.maxPerDay';

/** A voice message that could not be made; `stage` is 'cap' | 'prepare' | 'synth' | 'convert', `code` the skill code. */
export class SpeechError extends Error {
  /**
   * @param {'cap'|'prepare'|'synth'|'convert'} stage
   * @param {string} code
   * @param {string} message
   * @param {{ statusCode?: number|null, reason?: string|null, cause?: unknown }} [extra]  `reason`: why a preparation failed.
   */
  constructor(stage, code, message, { statusCode = null, reason = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpeechError';
    this.stage = stage;
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   The live config (hot-reloaded).
 * @param {() => object} [deps.getPrompts]  The live prompts (`hot.prompts`).
 * @param {object} [deps.env]             The parsed `.env`, for `llm.keyByRole`.
 * @param {string} deps.apiKey            The main OpenRouter key.
 * @param {{ complete: Function }} deps.llm
 * @param {object} deps.state             Persistent state; `speechDay` / `speechCount` live on `state.data`.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {string} [deps.ffmpeg]
 * @returns {{ say: Function, quota: Function }}
 */
export function createSpeech({
  getConfig,
  getPrompts = () => ({}),
  env = {},
  apiKey,
  llm,
  state,
  fetchImpl = fetch,
  now = () => Date.now(),
  ffmpeg = 'ffmpeg',
}) {
  /** Today's use of the rail, read only (yesterday's count shows as 0 but is not reset). */
  function quota() {
    const cap = dailyCapOf(getConfig().speech?.maxPerDay, SPEECH_CAP_KEY);
    const used = countToday(state.data, SPEECH_DAILY, now());
    return { used, cap, spent: used >= cap, code: CODE.SPEECH_CAP_DAILY, key: SPEECH_CAP_KEY };
  }

  /**
   * Make one voice message of `text` (already within `speech.maxChars`). Throws `SpeechError` for a
   * spent rail, a failed preparation (stage `prepare`, `reason` as the pass gave it; nothing is
   * synthesized or counted), a failed synthesis or a failed conversion. `model` is the speech role's own unless the
   * call is routed to the core model.
   * @param {{ text: string, model?: string|null }} args
   * @returns {Promise<{ ogg: Buffer, durationSecs: number, waveform: string, chars: number, cost: number, model: string, voiced: string, prepared: true, ms: number }>}
   */
  async function say({ text, model = null }) {
    const config = getConfig();
    const original = String(text ?? '');
    const { used, cap } = quota();
    if (used >= cap) {
      log.info('speech: refused', { reason: 'daily', used, cap });
      throw new SpeechError('cap', CODE.SPEECH_CAP_DAILY, `daily voice cap reached (${cap})`);
    }

    const prepared = await prepareSpeech({
      text: original,
      complete: llm.complete,
      prompt: getPrompts()['speech-prepare'],
      model: roleModel(config, 'analyzer', 'speech'),
      maxOutputTokens: config.speech?.prepareMaxOutputTokens,
      timeoutMs: config.llm?.analyzerTimeoutMs,
    });

    if (!prepared.prepared) {
      throw new SpeechError('prepare', CODE.SPEECH_PREPARE_FAILED, `pronunciation pass failed (${prepared.reason})`, {
        reason: prepared.reason ?? null,
      });
    }

    // Counted as the request goes out: a failure after this was possibly billed.
    bumpDaily(state.data, SPEECH_DAILY, now());
    state.markDirty();
    let made;
    try {
      made = await synthesizeSpeech({ text: prepared.text, getConfig, env, mainKey: apiKey, fetchImpl, now, model });
    } catch (err) {
      if (!(err instanceof SpeechSynthError)) throw err;
      const code = err.reason === 'not-configured' ? CODE.SPEECH_NOT_CONFIGURED : CODE.SPEECH_SYNTH_FAILED;
      throw new SpeechError('synth', code, err.message, { statusCode: err.statusCode, cause: err });
    }
    let note;
    try {
      note = await toVoiceNote(made.mp3, { ffmpeg });
    } catch (err) {
      if (!(err instanceof SpeechConvertError)) throw err;
      log.warn('speech: convert failed', { reason: err.reason });
      throw new SpeechError(
        'convert',
        err.reason === 'not-found' ? CODE.SPEECH_NOT_CONFIGURED : CODE.SPEECH_CONVERT_FAILED,
        err.message,
        { cause: err }
      );
    }
    log.info('speech: made', {
      chars: Array.from(prepared.text).length,
      prepared: prepared.prepared,
      seconds: note.durationSecs,
    });
    return {
      ...note,
      chars: Array.from(prepared.text).length,
      cost: made.cost,
      model: made.model,
      voiced: prepared.text,
      prepared: true,
      ms: made.ms,
    };
  }

  return { say, quota };
}
