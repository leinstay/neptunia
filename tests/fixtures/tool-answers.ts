// Answers of a fake model that calls tools: what `llm.complete` resolves for a turn on the native
// transport (src/llm/openrouter.ts: `text`, `toolCalls` as `toolCallsOf` gives them, `finishReason`).
// `call` builds one tool call by the skill's dotted name (the API name is derived, the arguments are
// JSON as the model writes them), `badCall` one whose arguments could not be read, `toolAnswer` the
// answer holding them. A plain string is a speech-only answer and needs none of this.
import { apiNameOf, skillNameOfApi } from '../../src/tools/definitions.ts';

/** One tool call as `toolCallsOf` gives it: the API name, the arguments as written and as parsed, a parse error. */
export type ToolCall = { id: string | null; name: string; arguments: string; parsed: unknown; parseError: string | null };

/** What `llm.complete` resolves: her text, the tool calls she made, the usage and the finish reason. */
export type Completion = {
  text: string;
  usage: object;
  estimated: number;
  toolCalls?: Array<ToolCall>;
  finishReason?: string;
};

/** A tool call of `name` (dotted) with `args`; `id` is hers (omitted: the engine makes `s<step>c<n>`). */
export function call(name: string, args: object = {}, { id = null }: { id?: string | null } = {}): ToolCall {
  return { id, name: apiNameOf(name) ?? name, arguments: JSON.stringify(args), parsed: args, parseError: null };
}

/** A tool call whose arguments `raw` are not a JSON object (`error` the parser's message). */
export function badCall(
  name: string,
  raw = '{"text": ',
  { id = null, error = 'Unexpected end of JSON input' }: { id?: string | null; error?: string } = {}
): ToolCall {
  return { id, name: apiNameOf(name) ?? name, arguments: raw, parsed: null, parseError: error };
}

/**
 * One answer: `text` (her speech, `<think>` first) and `calls` (call() / badCall() results, in her order),
 * ended with `finishReason`.
 */
export function toolAnswer(
  text = '',
  calls: Array<ToolCall> = [],
  { finishReason = 'stop', usage = {} }: { finishReason?: string; usage?: object } = {}
): Completion {
  return { text, toolCalls: calls, usage, estimated: 10, finishReason };
}

/** What a fake `complete` resolves for `answer`: an object as it is, a string as speech-only. */
export function completionOf(answer: unknown): Completion {
  return typeof answer === 'string' ? { text: answer, usage: {}, estimated: 10 } : (answer as Completion);
}

/** A `<tool_call>` block as the text transport has the model write it: the dotted name and the arguments, as `call()`/`badCall()` built them. */
export function callBlock(item: ToolCall): string {
  const name = skillNameOfApi(item.name) ?? item.name;
  const args = item.parsed ?? item.arguments;
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

/** The same answer as `toolAnswer`, for the text transport: the calls are written as blocks after the text and no tool calls are returned. */
export function textAnswer(
  text = '',
  calls: Array<ToolCall> = [],
  { finishReason = 'stop', usage = {} }: { finishReason?: string; usage?: object } = {}
): Completion {
  return { text: `${text}${calls.map(callBlock).join('')}`, usage, estimated: 10, finishReason };
}
