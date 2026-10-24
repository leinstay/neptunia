// Operations: `voice.say`: her words spoken in her voice and posted as a Discord voice message. A skill of
// hers only, no owner command. The pipeline (preparation, synthesis, conversion) is src/speech/;
// this operation resolves where it goes, runs it, posts one attachment with no text through her
// interface (`env.port`) and tells her what happened, stage by stage. A reply and a channel
// resolve as `draw.create` resolves them (src/ops/shared.js#postingConversation, need `attach`).

import { SpeechError } from '../speech/index.js';
import { messageRefOf, postingConversation } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';
import { CODE } from '../skills/codes.js';
import { log } from '../log.js';

/** The stage of a SpeechError, as the result words it. */
const STAGE_NAMES = Object.freeze({ cap: 'limit', synth: 'synthesis', convert: 'conversion' });

const handlers = perEnv((env) => {
  const { hot, client, discord, speech, port, assertNotPaused, resolvedGuildId } = env;

  /**
   * One voice message. Answers `{ text, ref, at }` when it was posted: the duration, the
   * characters, the estimated cost, whether the preparation passed and the text as voiced; the same
   * as a `partial` result (`speech-prepare-failed`) when the preparation was dropped and her text
   * went out as written. A failure is `{ status: 'failed', code, summary }` naming the stage
   * (limit, synthesis, conversion, post); a post that may have gone out is `data.unknown`: never
   * made again.
   */
  async function cmdVoice(args, context) {
    if (!speech || !port || typeof port.send !== 'function') {
      return { status: 'failed', code: CODE.SPEECH_NOT_CONFIGURED, summary: 'voice: not available here' };
    }
    assertNotPaused();
    const text = String(args?.text ?? '').trim();
    if (!text) throw invalid('text is required');
    const maxChars = Number.isFinite(hot.config.speech?.maxChars) && hot.config.speech.maxChars > 0 ? hot.config.speech.maxChars : 1500;
    if (Array.from(text).length > maxChars) throw invalid(`text is too long for a voice message (${maxChars} characters at most)`);
    const reply = args?.replyTo ? messageRefOf(args.replyTo) : null;
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId) throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const target = given ?? reply?.channelId ?? null;
    // Checked before anything is made or paid for.
    const postTo = await postingConversation({ client, discord, guildId: resolvedGuildId(context), channelId: target, context, need: 'attach' });

    let made;
    try {
      made = await speech.say({ text });
    } catch (err) {
      if (!(err instanceof SpeechError)) throw err;
      const status = err.statusCode ? `, HTTP ${err.statusCode}` : '';
      return { status: 'failed', code: err.code, summary: `voice: ${STAGE_NAMES[err.stage] ?? err.stage} failed (${err.code}${status}); nothing was posted` };
    }

    const sent = await port.send(
      { iface: port.iface, conversationId: postTo },
      {
        attachments: [{ name: `voice-${Date.now().toString(36)}.ogg`, data: made.ogg, contentType: 'audio/ogg', voice: { durationSecs: made.durationSecs, waveform: made.waveform } }],
        ...(reply ? { replyTo: { iface: port.iface, conversationId: postTo, messageId: reply.messageId } } : {}),
      },
    );
    if (sent?.status !== 'ok') {
      const code = String(sent?.error?.code ?? sent?.status ?? CODE.ERROR);
      const unknown = sent?.status === 'unknown';
      log.warn('voice: post failed', { code, unknown });
      return { status: 'failed', code, summary: `voice: ${unknown ? 'unclear whether the voice message was posted' : 'the voice message was not posted'} (${code})`, data: { unknown, portStatus: sent?.status ?? null } };
    }

    const lines = [
      `voice message posted in ${postTo} · ${made.durationSecs}s · ${made.chars} characters · estimated cost ${made.cost.toFixed(4)} USD · prepared: ${made.prepared ? 'yes' : 'no'}`,
      `as voiced: ${made.voiced}`,
    ];
    log.info('voice: posted', { seconds: made.durationSecs, chars: made.chars, prepared: made.prepared });
    const data = { text: lines.join('\n'), ref: sent.ref ?? null, at: sent.at, voice: { text: made.voiced, durationSecs: made.durationSecs } };
    if (made.prepared) return data;
    return { status: 'partial', code: CODE.SPEECH_PREPARE_FAILED, summary: data.text, data };
  }

  return { cmdVoice };
});

defineOp({
  name: 'voice.say',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdVoice(args, ctx),
});
