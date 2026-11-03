// Every model request of the engine goes through here on its way to the provider: the core wraps its chat client and the
// memory writer's client (src/core.ts). `archivedLlm` writes the whole request to the archive before it goes out and its
// outcome after, awaited at both ends, so a request the provider saw is on disk. A write that fails is logged and the
// call goes on: her voice does not depend on the archive. A picture is kept as its marker and size, the media
// tables hold what was preserved of it. Turn, attempt and step come from `withRequestMeta`, which the turn opens.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
export type RequestMeta = { turnId?: string; attemptId?: string; step?: number };
type ArchiveDeps = {
  write: (update: Row) => Promise<unknown>;
  now?: () => number;
  newId?: () => string;
  log: { warn(msg: string, meta?: unknown): void };
};

const meta = new AsyncLocalStorage<RequestMeta>();

/** Runs `work` with a fresh record of its turn, attempt and step. */
export function withRequestMeta<TResult>(work: () => TResult): TResult {
  return meta.run({}, work);
}

export function currentRequestMeta(): RequestMeta | null {
  return meta.getStore() ?? null;
}

function withoutPictureBytes(part: unknown): unknown {
  const value = part as { type?: unknown; image_url?: { url?: unknown }; messageId?: unknown } | null;
  if (value?.type !== 'image_url') return part;
  const url = typeof value.image_url?.url === 'string' ? value.image_url.url : '';
  const comma = url.startsWith('data:') ? url.indexOf(',') : -1;
  return {
    type: 'image_marker',
    messageId: value.messageId ?? null,
    bytes: comma >= 0 ? Math.floor(((url.length - comma - 1) * 3) / 4) : null,
    url: comma >= 0 ? null : url,
  };
}

function storedMessages(messages: unknown): Array<unknown> {
  return (Array.isArray(messages) ? messages : []).map((message: Row) =>
    Array.isArray(message?.content) ? { ...message, content: message.content.map(withoutPictureBytes) } : message
  );
}

function systemOf(messages: unknown): string | null {
  const first = (Array.isArray(messages) ? messages : []).find((message: Row) => message?.role === 'system') as
    Row | undefined;
  if (typeof first?.content === 'string') return first.content;
  return first === undefined ? null : JSON.stringify(first.content);
}

function thinkOf(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const match = /<think>([\s\S]*?)<\/think>/.exec(text);
  return match?.[1] ?? null;
}

/** `llm` whose `complete` keeps each request and its outcome. Every other member passes through. */
export function archivedLlm<TLlm extends { complete: (...args: Array<never>) => Promise<unknown> }>(
  llm: TLlm,
  { write, now = () => Date.now(), newId = () => randomUUID(), log }: ArchiveDeps
): TLlm {
  const keep = async (update: Row): Promise<void> => {
    try {
      await write({ kind: 'request-archive', ...update });
    } catch (error) {
      log.warn('llm: the request archive could not be written', { op: update.op, error });
    }
  };
  const complete = async (messages: unknown, options: Row = {}, ...rest: Array<unknown>): Promise<unknown> => {
    const id = newId();
    const turn = currentRequestMeta();
    const step = turn?.step ?? 0;
    if (turn !== null) turn.step = step + 1;
    await keep({
      op: 'start',
      record: {
        id,
        at: now(),
        turn_id: turn?.turnId ?? null,
        attempt_id: turn?.attemptId ?? null,
        step,
        role: options.role ?? null,
        model: options.model ?? null,
        purpose: options.purpose ?? null,
        system_text: systemOf(messages),
        messages: JSON.stringify(storedMessages(messages)),
        tools: options.tools === undefined ? null : JSON.stringify(options.tools),
        tool_choice: typeof options.toolChoice === 'string' ? options.toolChoice : null,
        source: 'live',
      },
    });
    try {
      const answer = await (llm.complete as unknown as (...args: Array<unknown>) => Promise<Row>)(
        messages,
        options,
        ...rest
      );
      await keep({
        op: 'finish',
        id,
        at: now(),
        status: 'ok',
        response_text: typeof answer?.text === 'string' ? answer.text : null,
        think: thinkOf(answer?.text),
        tool_calls: answer?.toolCalls === undefined ? null : JSON.stringify(answer.toolCalls),
        usage: answer?.usage === undefined ? null : JSON.stringify(answer.usage),
      });
      return answer;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      await keep({
        op: 'finish',
        id,
        at: now(),
        status: 'failed',
        error_code: typeof code === 'string' ? code : 'error',
      });
      throw error;
    }
  };
  return Object.assign(Object.create(Object.getPrototypeOf(llm) as object) as TLlm, llm, { complete });
}
