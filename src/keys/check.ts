// The two probes that prove a key before it is saved: `checkRole` sends one minimal request for a model role on a given
// key (a few tokens or characters, so a check costs cents) and reports what answered, and `checkKey` reads the key's own
// record (`GET /auth/key`). Neither throws and neither lets the key into what it returns: a provider that echoes the
// value back has it replaced with `***`, and the provider's words are cut. A role no cheap request can prove, such as
// `drawing`, whose request bills a whole picture, answers `capability: 'unsupported'` and sends nothing: `ok: false` with
// that capability says nothing about the key, while `ok: false` without it means the provider or the network said no.
// Called by src/keys/commands.ts.

import { apiUrl, openRouterHeaders } from '../llm/openrouter.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { TEXT_ROLES } from '../llm/route-text.ts';

export type CheckResult = {
  ok: boolean;
  role: string;
  model: string;
  keyName: string;
  /** `usage.is_byok` of the answer, null when the answer has none. */
  isByok: boolean | null;
  /** The HTTP status, null when no answer came. */
  status: number | null;
  /** `usage.cost` in dollars, 0 when absent. */
  cost: number;
  /** The provider's words with the key replaced by `***`, cut to 500 characters; null when ok or when nothing was asked. */
  error: string | null;
  /** The check itself is out of reach for this role: nothing was sent, and the key is neither proved nor refused. */
  capability?: 'unsupported';
};

export type KeyInfo = {
  ok: boolean;
  status: number | null;
  limit: number | null;
  usage: number | null;
  error: string | null;
};

/** The wait for one probe, as hermes_cli/doctor_connectivity.py has it. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of the provider's words an answer keeps. */
const ERROR_CHARS = 500;

/** The text of the speech probe: billed per character, so a real voice message's length is never spent on a check. */
const SPEECH_PROBE_TEXT = 'ok';

/** What one role's probe asks: the endpoint and the body beside the model. */
type Probe = { endpoint: string; body: Record<string, unknown> };

/** The probe of `role`, or null for a role with none. */
function probeOf(role: string, voice: string | undefined): Probe | null {
  if (role === 'embedding') return { endpoint: 'embeddings', body: { input: 'ok' } };
  if (role === 'speech')
    return voice === undefined || voice === ''
      ? null
      : { endpoint: 'audio/speech', body: { input: SPEECH_PROBE_TEXT, voice, response_format: 'mp3' } };
  if (!TEXT_ROLES.some((one) => one === role)) return null;
  return {
    endpoint: 'chat/completions',
    body: { messages: [{ role: 'user', content: 'Reply with ok.' }], max_tokens: 8 },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `text` with every copy of `value` replaced and cut to the length an answer keeps. */
function safe(text: string, value: string): string {
  return text.split(value).join('***').slice(0, ERROR_CHARS);
}

/** The body of an answer as JSON, null when it is not. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The provider's words in a body: the message of its `error` object, else the text itself. */
function wordsOf(body: unknown, text: string): string {
  if (isRecord(body) && isRecord(body.error)) {
    const message = body.error.message;
    if (typeof message === 'string' && message !== '') return message;
    return JSON.stringify(body.error);
  }
  return text;
}

type Answer = { status: number; text: string };

/** One request that never throws: the answer, or why none came (the key replaced in the reason). */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; value: string; body?: unknown; timeoutMs: number }
): Promise<Answer | string> {
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: openRouterHeaders(init.value),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    return `no answer: ${safe(err instanceof Error ? err.message : String(err), init.value)}`;
  }
}

export async function checkRole(input: {
  fetch: typeof fetch;
  baseUrl: string;
  role: string;
  model: string;
  keyName: string;
  value: string;
  timeoutMs?: number;
  /** OpenRouter's provider routing, sent as the body's `provider` */
  provider?: Record<string, unknown>;
  /** the reasoning effort, sent as the body's `reasoning` */
  reasoning?: { effort: EffortLevel };
  /** `speech.voice`, which the speech probe synthesizes with */
  voice?: string;
}): Promise<CheckResult> {
  const { role, model, keyName, value } = input;
  const failed = (status: number | null, error: string): CheckResult => ({
    ok: false,
    role,
    model,
    keyName,
    isByok: null,
    status,
    cost: 0,
    error: safe(error, value),
  });
  const probe = probeOf(role, input.voice);
  if (probe === null)
    return {
      ok: false,
      role,
      model,
      keyName,
      isByok: null,
      status: null,
      cost: 0,
      error: null,
      capability: 'unsupported',
    };
  const answer = await send(input.fetch, apiUrl(input.baseUrl, probe.endpoint), {
    method: 'POST',
    value,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    body: {
      model,
      ...probe.body,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.reasoning === undefined || probe.endpoint !== 'chat/completions' ? {} : { reasoning: input.reasoning }),
    },
  });
  if (typeof answer === 'string') return failed(null, answer);
  const body = jsonOf(answer.text);
  if (answer.status < 200 || answer.status >= 300) return failed(answer.status, wordsOf(body, answer.text));
  if (isRecord(body) && body.error !== undefined && body.error !== null)
    return failed(answer.status, wordsOf(body, ''));
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    ok: true,
    role,
    model,
    keyName,
    isByok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
    status: answer.status,
    cost: typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : 0,
    error: null,
  };
}

export async function checkKey(input: {
  fetch: typeof fetch;
  baseUrl: string;
  value: string;
  timeoutMs?: number;
}): Promise<KeyInfo> {
  const answer = await send(input.fetch, apiUrl(input.baseUrl, 'auth/key'), {
    method: 'GET',
    value: input.value,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (typeof answer === 'string') return { ok: false, status: null, limit: null, usage: null, error: answer };
  const body = jsonOf(answer.text);
  if (answer.status < 200 || answer.status >= 300)
    return {
      ok: false,
      status: answer.status,
      limit: null,
      usage: null,
      error: safe(wordsOf(body, answer.text), input.value),
    };
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const number = (field: unknown): number | null =>
    typeof field === 'number' && Number.isFinite(field) ? field : null;
  return { ok: true, status: answer.status, limit: number(data.limit), usage: number(data.usage), error: null };
}
