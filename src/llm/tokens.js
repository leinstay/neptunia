// Token estimation without a tokenizer dependency. Non-Latin text (Cyrillic, Greek, CJK) costs far more
// tokens per character than ASCII, so the two are weighed separately and both
// weights are deliberately pessimistic. The estimate is then multiplied by a
// calibration ratio learned from the real `usage.prompt_tokens` OpenRouter
// reports (see createCalibrator), so the 50k request cap is enforced against
// numbers that track the actual tokenizer.

const ASCII_CHARS_PER_TOKEN = 3.5;
const OTHER_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD = 6;

/** Raw, uncalibrated token estimate for a piece of text. */
export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN);
}

/**
 * Raw estimate for a chat-completions `messages` array. Image parts are
 * charged a flat `tokensPerImage` each (400 when null or unset, config.json's
 * `context.vision.tokensPerImage`; only helper requests carry them, the
 * describer's and the avatar queue's: the persona's own never does). A
 * `video_url` part is charged 0: its cost depends on the clip's length, which
 * the caller passes to the client as `videoSeconds` (see src/llm/openrouter.js).
 * @param {{ content: string|object[] }[]} messages
 * @param {number|null} [tokensPerImage]
 * @returns {number}
 */
export function estimateMessages(messages, tokensPerImage) {
  const perImage = tokensPerImage ?? 400;
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) total += estimateTokens(call?.function?.name) + estimateTokens(call?.function?.arguments) + estimateTokens(call?.id);
    }
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
      continue;
    }
    for (const part of message.content ?? []) {
      if (part.type === 'text') total += estimateTokens(part.text);
      else if (part.type !== 'video_url') total += perImage;
    }
  }
  return total;
}

/** Raw estimate for a `tools` array: its JSON as the provider reads it, plus a little per definition. */
export function estimateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools)) + tools.length * MESSAGE_OVERHEAD;
}

const RATIO_MIN = 0.6;
const RATIO_MAX = 1.6;
const EMA_ALPHA = 0.2;

/**
 * Tracks actual/estimated as an exponential moving average. `initial` comes
 * from persisted state so the ratio survives restarts.
 */
export function createCalibrator(initial = 1) {
  let ratio = Number.isFinite(initial) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, initial)) : 1;
  return {
    get ratio() {
      return ratio;
    },
    /** Calibrated estimate: what the provider will most likely count. */
    apply(rawEstimate) {
      return Math.ceil(rawEstimate * ratio);
    },
    /** Feed one observation; returns the new ratio. */
    observe(rawEstimate, actualTokens) {
      if (!(rawEstimate > 200) || !(actualTokens > 0)) return ratio;
      const sample = Math.min(RATIO_MAX, Math.max(RATIO_MIN, actualTokens / rawEstimate));
      const blended = ratio * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
      // Re-clamp: floating-point rounding can otherwise nudge the blend a hair
      // outside [RATIO_MIN, RATIO_MAX] even when ratio and sample are both in range.
      ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, blended));
      return ratio;
    },
  };
}
