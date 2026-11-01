// The persona's voice messages: one `say` runs the whole pipeline -- the preparation pass
// (src/speech/prepare.js), the synthesis (synth.js) and the conversion to a voice note
// (convert.js). Posting is the caller's
// (src/tools/impl/voice.ts): this module makes the file and says what it cost.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never the text.

import { log } from '../log.js';
import { roleModel } from '../llm/roles.js';
import { CODE } from '../tools/codes.ts';
import { prepareSpeech } from './prepare.js';
import { SpeechSynthError, SPEECH_ROLE, synthesizeSpeech } from './synth.js';
import { SpeechConvertError, toVoiceNote } from './convert.js';

/** A voice message that could not be made; `stage` is 'prepare' | 'synth' | 'convert', `code` the skill code. */
export class SpeechError extends Error {
  /**
   * @param {'prepare'|'synth'|'convert'} stage
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
 * @typedef {{ ogg: Buffer, durationSecs: number, waveform: string, chars: number, cost: number, model: string,
 *   voiced: string, prepared: true, ms: number }} SpeechMade
 */

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   The live config (hot-reloaded).
 * @param {() => object} [deps.getPrompts]  The live prompts (`hot.prompts`).
 * @param {object} [deps.env]             The parsed `.env`, for `llm.keyByRole`.
 * @param {string} deps.apiKey            The main OpenRouter key.
 * @param {{ complete: Function }} deps.llm
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {string} [deps.ffmpeg]
 * @returns {{ say: (args: { text: string, model?: string|null }) => Promise<SpeechMade> }}
 */
export function createSpeech({
  getConfig,
  getPrompts = () => ({}),
  env = {},
  apiKey,
  llm,
  fetchImpl = fetch,
  now = () => Date.now(),
  ffmpeg = 'ffmpeg',
}) {
  /**
   * Make one voice message of `text` (already within `speech.maxChars`). Throws `SpeechError` for a
   * failed preparation (stage `prepare`, `reason` as the pass gave it; nothing is synthesized), a failed synthesis or
   * a failed conversion. `model` is the speech role's own unless the
   * call is routed to the core model.
   * @param {{ text: string, model?: string|null }} args
   * @returns {Promise<SpeechMade>}
   */
  async function say({ text, model = null }) {
    const config = getConfig();
    const original = String(text ?? '');

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

  return { say };
}
