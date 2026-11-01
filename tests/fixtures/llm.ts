// What the LLM client tests read of what they fake and catch: an error the client throws, the input of a fake fetch, a
// JSON body read key by key, a message part the cache marks, a usage log line, a tool call and a call that a deferred
// transport holds, and the options of their helper clients. The names are short because the tests use them on lines
// that carry more than a type.

import { createLlm as createLlmOf } from '../../src/llm/openrouter.ts';
import { loose } from './as-options.ts';

/** The client taking its options as the tests write them: fakes that carry the members it reads. */
export const createLlm = loose(createLlmOf);

export type Rec = Record<string, unknown>;
export type Cfg = () => object;
export type Err = Error & {
  statusCode?: number;
  body?: string;
  key?: string;
  used?: number;
  cap?: number;
  code?: string;
  errorType?: string;
  nativeFinishReason?: string;
};
export type FetchInit = { headers: Record<string, string>; body: string; signal: AbortSignal };
export type Loose = { [key: string]: Loose };
export type MarkedPart = { type: string; text?: string; cache_control?: unknown };
export type LogLine = Rec;
export type ToolCall = { id: string; name: string; arguments: unknown; parsed: unknown; parseError?: unknown };
type DeferredCall = { body: string; signal: AbortSignal; answer: (r: unknown) => void; fail: (e: unknown) => void };
type CacheConfig = { ttl?: unknown; roles?: unknown; models?: unknown };
type Get = { url: string; init: { method?: string; headers: Record<string, string>; signal: AbortSignal } };
type FakeState = { data: Rec; dirty?: number; markDirty(): void };
export type CachingCfg = { promptCache?: boolean; cache?: CacheConfig; [key: string]: unknown };
export type HedgeOpts = {
  hedge?: unknown;
  llm?: Rec;
  transport?: { calls: Array<DeferredCall>; fetchImpl: (url: string, init: FetchInit) => unknown };
  state?: FakeState;
};
type Calibrator = { ratio: number; apply: (n: number) => number; observe: (raw: number, actual: number) => unknown };
/** The options of the helper clients of the tests, by helper. */
export type Opts = {
  cfg: CachingCfg;
  caching: { usage?: Rec | ((call: number) => Rec); calibrator?: Calibrator };
  ask: { role?: string; signal?: AbortSignal; long?: boolean; extra?: Rec };
  tool: { content?: string | null; finish?: string };
  get: Get;
  deferred: DeferredCall;
  state: FakeState;
};

/** The parts of a message whose content the cache cut into parts. */
export const partsOf = (message: { content: unknown }): Array<MarkedPart> => message.content as Array<MarkedPart>;
