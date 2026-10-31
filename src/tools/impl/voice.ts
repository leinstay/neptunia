// Operations: `voice.say`: her words spoken in her voice and posted as a voice message. A skill of
// hers only, no owner command. The pipeline (preparation, synthesis, conversion) is src/speech/;
// this operation resolves where it goes, runs it, posts one attachment with no text through her
// interface (`env.port`) and tells her what happened, stage by stage. A reply and a channel
// resolve as `draw.create` resolves them (src/tools/impl/shared.ts#postingConversation, need `attach`). The voice is
// made on the speech role's route (src/tools/gateway.ts#callOnRoute over `env.roleHealth`): with the role down it is
// made on the core model when the core declares `audioOut`, else the call answers `ability-unavailable`.

import { SpeechError } from '../../speech/index.js';
import { voiceAttachment } from '../../behavior/mirror.ts';
import { messageRefOf, postingConversation } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { abilityUnavailable, callOnRoute } from '../gateway.ts';
import type { RoleHealth } from '../../llm/role-health.ts';
import { log } from '../../log.js';
import { idText, objOf } from '../types.ts';
import type { Adapter } from '../../protocol/adapter.ts';
import type { OpContext } from '../types.ts';

/** The stage of a SpeechError, as the result words it. */
const STAGE_NAMES = Object.freeze({
  cap: 'limit',
  prepare: 'pronunciation pass',
  synth: 'synthesis',
  convert: 'conversion',
});

/** The longest text a voice message may hold: `speech.maxChars` when it is a positive number, else 1500. */
function maxCharsOf(config: unknown): number {
  const configured = objOf(objOf(config).speech).maxChars;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 1500;
}

/** What a SpeechError tells her: the stage that failed, its code and HTTP status, and nothing posted. */
function speechFailure(err: SpeechError): unknown {
  const status = err.statusCode ? `, HTTP ${err.statusCode}` : '';
  const reason = err.reason ? { data: { stage: err.stage, reason: err.reason } } : {};
  return {
    status: 'failed',
    code: err.code,
    summary: `voice: ${STAGE_NAMES[err.stage] ?? err.stage} failed (${err.code}${status}${err.reason ? `, ${err.reason}` : ''}); nothing was posted`,
    ...reason,
  };
}

/** A voice message as src/speech/index.js#say makes it, the fields this operation reads. */
type Made = { ogg: Buffer; durationSecs: number; waveform: string; chars: number; cost: number; voiced: string };
type Speech = { say: (args: { text: string; model?: string | null }) => Promise<Made> };

/**
 * One voice message of `text` on the speech role's route: null when the route says it cannot be made (the role is
 * down and the core model has no `audioOut`), else what `speech.say` made and whether it went to the core model. A
 * synthesis on the role's own model tells `health` how it went. Throws what `speech.say` throws.
 */
async function sayOnRoute({
  speech,
  text,
  config,
  health,
}: {
  speech: Speech;
  text: string;
  config: unknown;
  health: RoleHealth | null;
}): Promise<{ made: Made; routed: boolean } | { made: null; unavailable: unknown }> {
  const { route, value } = await callOnRoute({
    config,
    role: 'speech',
    health,
    call: async (model) => {
      try {
        const made = await speech.say({ text, ...(model ? { model } : {}) });
        if (!model) health?.succeeded('speech');
        return { made, error: null };
      } catch (err) {
        if (!model && err instanceof SpeechError && err.stage === 'synth') health?.failed('speech', err);
        return { made: null, error: err };
      }
    },
  });
  if (route.kind === 'unavailable' || value === null) return { made: null, unavailable: abilityUnavailable(route) };
  if (value.made === null) throw value.error instanceof Error ? value.error : new Error('voice: speech failed');
  return { made: value.made, routed: route.kind === 'core' };
}

const handlers = perEnv((env) => {
  const { hot, speech, assertNotPaused, resolvedGuildId } = env;
  const { reads } = env;
  const port = env.port as Adapter | null | undefined;

  /**
   * One voice message. Answers `{ text, ref, at }` when it was posted: the duration, the
   * characters, the estimated cost and the text as voiced. A failure is `{ status: 'failed', code,
   * summary }` naming the stage (limit, pronunciation pass, synthesis, conversion, post); a failed
   * pronunciation pass (`speech-prepare-failed`) stops the call before anything is synthesized or
   * sent, with the pass's reason (timeout, error, empty, mismatch, no-prompt) in `data.reason`; a post that may have gone out is `data.unknown`: never
   * made again.
   */
  async function cmdVoice(args: unknown, context: OpContext): Promise<unknown> {
    const given = objOf(args);
    if (!speech || !port || typeof port.send !== 'function') {
      return { status: 'failed', code: CODE.SPEECH_NOT_CONFIGURED, summary: 'voice: not available here' };
    }
    assertNotPaused();
    const text = (typeof given.text === 'string' ? given.text : '').trim();
    if (!text) throw invalid('text is required');
    const maxChars = maxCharsOf(hot.config);
    if (Array.from(text).length > maxChars)
      throw invalid(`text is too long for a voice message (${maxChars} characters at most)`);
    const reply = given.replyTo ? await messageRefOf(given.replyTo, reads) : null;
    const inChannel = given.channelId ? idText(given.channelId) : null;
    if (inChannel && reply?.channelId && inChannel !== reply.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const target = inChannel ?? reply?.channelId ?? null;
    // Checked before anything is made or paid for.
    const postTo = await postingConversation({
      reads,
      iface: port.iface,
      guildId: resolvedGuildId(context),
      channelId: target,
      context,
      need: 'attach',
    });

    let spoken;
    try {
      // `env.speech` is src/speech/index.js#createSpeech's client, untyped in the environment.
      spoken = await sayOnRoute({ speech: speech as Speech, text, config: hot.config, health: env.roleHealth });
    } catch (err) {
      if (!(err instanceof SpeechError)) throw err;
      return speechFailure(err);
    }
    if (spoken.made === null) return spoken.unavailable;
    const made = spoken.made;

    const sent = await port.send(
      { iface: port.iface, conversationId: postTo },
      {
        attachments: [
          voiceAttachment({ ogg: made.ogg, durationSecs: made.durationSecs, waveform: made.waveform }, Date.now()),
        ],
        ...(reply ? { replyTo: { iface: port.iface, conversationId: postTo, messageId: reply.messageId } } : {}),
      }
    );
    if (sent?.status !== 'ok') {
      const code = String(sent?.error?.code ?? sent?.status ?? CODE.ERROR);
      const unknown = sent?.status === 'unknown';
      log.warn('voice: post failed', { code, unknown });
      return {
        status: 'failed',
        code,
        summary: `voice: ${unknown ? 'unclear whether the voice message was posted' : 'the voice message was not posted'} (${code})`,
        data: { unknown, portStatus: sent?.status ?? null },
      };
    }

    const lines = [
      `voice message posted in ${postTo} · ${made.durationSecs}s · ${made.chars} characters · estimated cost ${made.cost.toFixed(4)} USD`,
      `as voiced: ${made.voiced}`,
    ];
    log.info('voice: posted', { seconds: made.durationSecs, chars: made.chars });
    return {
      text: lines.join('\n'),
      ref: sent.ref ?? null,
      at: sent.at,
      voice: { text: made.voiced, durationSecs: made.durationSecs },
      ...('routed' in spoken && spoken.routed ? { route: 'core' } : {}),
    };
  }

  return { cmdVoice };
});

defineOp({
  name: 'voice.say',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdVoice(args, ctx),
});
