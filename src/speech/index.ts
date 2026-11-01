// The persona's voice messages: one `say` runs the whole pipeline -- the preparation pass
// (src/speech/prepare.ts), the synthesis (synth.ts) and the conversion to a voice note
// (convert.ts). Posting is the caller's
// (src/tools/impl/voice.ts): this module makes the file and says what it cost.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never the text.

import { log } from '../log.ts';
import { objOf } from '../tools/types.ts';
import { roleModel } from '../llm/roles.ts';
import { CODE } from '../tools/codes.ts';
import { prepareSpeech } from './prepare.ts';
import { SpeechSynthError, SPEECH_ROLE, synthesizeSpeech } from './synth.ts';
import { SpeechConvertError, toVoiceNote } from './convert.ts';

/** A voice message that could not be made; `stage` is 'prepare' | 'synth' | 'convert', `code` the skill code. */
export class SpeechError extends Error {
  stage: 'prepare' | 'synth' | 'convert';
  code: string;
  statusCode: number | null;
  reason: string | null;

  /** `reason` of the last argument: why a preparation failed. */
  constructor(
    stage: 'prepare' | 'synth' | 'convert',
    code: string,
    message: string,
    {
      statusCode = null,
      reason = null,
      cause,
    }: { statusCode?: number | null; reason?: string | null; cause?: unknown } = {}
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpeechError';
    this.stage = stage;
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export type SpeechMade = {
  ogg: Buffer;
  durationSecs: number;
  waveform: string;
  chars: number;
  cost: number;
  model: string;
  voiced: string;
  prepared: true;
  ms: number;
};

/**
 * @param deps.getConfig The live config (hot-reloaded).
 * @param deps.getPrompts The live prompts (`hot.prompts`).
 * @param deps.env The parsed `.env`, for `llm.keyByRole`.
 * @param deps.apiKey The main OpenRouter key.
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
}: {
  getConfig: () => unknown;
  getPrompts?: () => object;
  env?: Record<string, string | undefined>;
  apiKey: string;
  llm: { complete: Parameters<typeof prepareSpeech>[0]['complete'] };
  fetchImpl?: typeof fetch;
  now?: () => number;
  ffmpeg?: string;
}): { say: (args: { text: string; model?: string | null }) => Promise<SpeechMade> } {
  /**
   * Make one voice message of `text` (already within `speech.maxChars`). Throws `SpeechError` for a
   * failed preparation (stage `prepare`, `reason` as the pass gave it; nothing is synthesized), a failed synthesis or
   * a failed conversion. `model` is the speech role's own unless the
   * call is routed to the core model.
   */
  async function say({ text, model = null }: { text: string; model?: string | null }): Promise<SpeechMade> {
    const config = getConfig();
    const original = String(text ?? '');

    const prepared = await prepareSpeech({
      text: original,
      complete: llm.complete,
      prompt: objOf(getPrompts())['speech-prepare'],
      model: roleModel(config, 'analyzer', 'speech'),
      maxOutputTokens: objOf(objOf(config).speech).prepareMaxOutputTokens,
      timeoutMs: objOf(objOf(config).llm).analyzerTimeoutMs,
    });

    if (!prepared.prepared) {
      throw new SpeechError('prepare', CODE.SPEECH_PREPARE_FAILED, `pronunciation pass failed (${prepared.reason})`, {
        reason: prepared.reason ?? null,
      });
    }

    let made: Awaited<ReturnType<typeof synthesizeSpeech>>;
    try {
      made = await synthesizeSpeech({ text: prepared.text, getConfig, env, mainKey: apiKey, fetchImpl, now, model });
    } catch (err) {
      if (!(err instanceof SpeechSynthError)) throw err;
      const code = err.reason === 'not-configured' ? CODE.SPEECH_NOT_CONFIGURED : CODE.SPEECH_SYNTH_FAILED;
      throw new SpeechError('synth', code, err.message, { statusCode: err.statusCode, cause: err });
    }
    let note: Awaited<ReturnType<typeof toVoiceNote>>;
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
