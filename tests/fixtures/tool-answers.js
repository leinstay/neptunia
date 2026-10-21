// Answers of a fake model that calls tools: what `llm.complete` resolves for a turn on the native
// transport (src/llm/openrouter.js: `text`, `toolCalls` as `toolCallsOf` gives them, `finishReason`).
// `call` builds one tool call by the skill's dotted name (the API name is derived, the arguments are
// JSON as the model writes them), `badCall` one whose arguments could not be read, `toolAnswer` the
// answer holding them. A plain string is a speech-only answer and needs none of this.
import { apiNameOf } from '../../src/skills/definitions.js';

/** A tool call of `name` (dotted) with `args`; `id` is hers (omitted: the engine makes `s<step>c<n>`). */
export function call(name, args = {}, { id = null } = {}) {
  return { id, name: apiNameOf(name) ?? name, arguments: JSON.stringify(args), parsed: args, parseError: null };
}

/** A tool call whose arguments `raw` are not a JSON object (`error` the parser's message). */
export function badCall(name, raw = '{"text": ', { id = null, error = 'Unexpected end of JSON input' } = {}) {
  return { id, name: apiNameOf(name) ?? name, arguments: raw, parsed: null, parseError: error };
}

/**
 * One answer: `text` (her speech, `<think>` first) and `calls` (call() / badCall() results, in her order),
 * ended with `finishReason`.
 * @returns {{ text: string, toolCalls: object[], usage: object, estimated: number, finishReason: string }}
 */
export function toolAnswer(text = '', calls = [], { finishReason = 'stop', usage = {} } = {}) {
  return { text, toolCalls: calls, usage, estimated: 10, finishReason };
}

/** What a fake `complete` resolves for `answer`: an object as it is, a string as speech-only. */
export function completionOf(answer) {
  return typeof answer === 'string' ? { text: answer, usage: {}, estimated: 10 } : answer;
}
