// `buildRequest` (src/behavior/prompt.ts) as the prompt tests call it: the inputs are loose stand-ins (a fake config,
// prompts without every key, lines with the fields a case reads), and the request comes back with the system message
// as text and the user message as the parts the cache segments cut it into.
import { buildRequest as buildRequestOf } from '../../src/behavior/prompt.ts';
import type {
  BuildRequestInput,
  BuildRequestResult,
  RequestMessage,
  RequestPart,
} from '../../src/behavior/prompt-types.ts';

/** The input of a request as the code takes it; a test writes the fields a case needs and casts the rest in once. */
export type RequestInput = BuildRequestInput;

/** One part of the user message; `cacheSegment` names the cached part it belongs to. */
export type Part = RequestPart & { cacheSegment?: string };

/** A request as these tests read it. */
export type Built = Omit<BuildRequestResult, 'messages'> & {
  messages: [{ role: string; content: string }, { role: string; content: Array<Part> }, ...Array<RequestMessage>];
};

/** Builds the request of `input`, which a test writes with the fields the case needs. */
export function buildRequest(input: object): Built {
  // The one cast: each test input stands for the request input it is shaped like.
  return buildRequestOf(input as BuildRequestInput) as Built;
}
