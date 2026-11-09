// What the key tests share: a fake `fetch` that records each call and answers by URL, a scripted dialog that records its
// questions, a fake pause control, and values that look like keys. No call leaves the process.

import type { Dialog, PauseControl } from '../../src/keys/commands.ts';

export const BASE_URL = 'https://openrouter.test/api/v1';

/** A key value that must never appear in a listing, a log line, an answer or an error. */
export const SECRET = 'sk-or-v1-SECRETVALUE-0001-WXYZ';
export const SECRET_2 = 'sk-or-v1-SECRETVALUE-0002-ABCD';
export const SECRET_3 = 'sk-or-v1-SECRETVALUE-0003-EFGH';

export type Call = { url: string; method: string; auth: string; body: Record<string, unknown> | null };
export type Reply = { status: number; body: unknown };

/** The answer of a healthy OpenRouter to each URL the keys code asks. */
export function healthy(call: Call): Reply {
  if (call.url.endsWith('/auth/key')) return { status: 200, body: { data: { limit: 100, usage: 1 } } };
  if (call.url.endsWith('/embeddings'))
    return { status: 200, body: { data: [{ embedding: [0.1] }], usage: { cost: 0.005 } } };
  return { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01, is_byok: false } } };
}

/** A fetch that records every call and answers with `answer` (healthy unless told otherwise). */
export function fakeFetch(answer: (call: Call) => Reply = healthy): { fetch: typeof fetch; calls: Array<Call> } {
  const calls: Array<Call> = [];
  const fake = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const parsed: unknown = init.body === undefined ? null : JSON.parse(init.body);
    const body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      auth: (init.headers?.Authorization ?? '').replace('Bearer ', ''),
      body,
    };
    calls.push(call);
    const reply = answer(call);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
      json: () => Promise.resolve(reply.body),
    });
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

/** A dialog that gives the scripted answers in order and records each question with its options. */
export function scriptedDialog(answers: Array<string>): {
  dialog: Dialog;
  asked: Array<{ question: string; secret: boolean }>;
} {
  const asked: Array<{ question: string; secret: boolean }> = [];
  const rest = [...answers];
  const dialog: Dialog = {
    ask(question, options) {
      asked.push({ question, secret: options?.secret === true });
      const next = rest.shift();
      return Promise.resolve(next ?? options?.fallback ?? '');
    },
  };
  return { dialog, asked };
}

/** A pause control that keeps the reason and counts the calls. */
export function fakePause(initial: string | null = null): PauseControl & { pauses: Array<string>; resumes: number } {
  let reason = initial;
  const state = {
    pauses: [] as Array<string>,
    resumes: 0,
    pause(why: string) {
      state.pauses.push(why);
      reason = why;
      return Promise.resolve();
    },
    resume() {
      state.resumes += 1;
      reason = null;
      return Promise.resolve();
    },
    reason: () => reason,
  };
  return state;
}

/**
 * The key ring the core reads off its chains, over a test's own chains: the first API route of the role's chain whose
 * key the store holds, with that key's value.
 */
export function chainRing(
  store: { valueOf(name: string): string | null },
  chainOf: (role: string) => ReadonlyArray<{ via: string; key?: string }>
): { route(role: string): { name: string; value: string } | null } {
  return {
    route(role) {
      for (const route of chainOf(role)) {
        const value = route.via === 'api' && route.key !== undefined ? store.valueOf(route.key) : null;
        if (value !== null && route.key !== undefined) return { name: route.key, value };
      }
      return null;
    },
  };
}

/**
 * The chains of a deployment whose every role runs on every key of `store` in file order, with the model `modelOf` gives
 * the role: what the core key list gave each role before the chains, for a test of something else than the routing.
 */
export function everyKeyChains(
  store: { names(): Array<string> },
  modelOf: (role: string) => string
): (role: string) => Array<{ via: 'api'; key: string; model: string; effort: null }> {
  return (role) => store.names().map((key) => ({ via: 'api', key, model: modelOf(role), effort: null }));
}
