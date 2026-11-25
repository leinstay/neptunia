// The model of scripts/replay.ts `--answers archive`, and the counter ids of its `--seed`. `archiveAnswers` answers
// the k-th request of purpose p of a replayed turn with the k-th answer of purpose p the live turn received, read from
// the copy's `model_requests` (answered rows only, in the order they started), its tool calls included, so the replay
// walks the live turn's path through its tool rounds. A request past the archive gets `<skip/>` and is kept in `past`.
// `counterIds` gives `harness-1`, `harness-2` and so on, the ids a seeded run uses where the engine draws random ones.

import type { Db } from '../../src/memory/db/types.ts';

type Rec = Record<string, unknown>;

/** The answer a request past the archive gets: the output contract's tag for staying silent. */
export const PAST_ARCHIVE = '<skip/>';

/** One request answered past the archive: its purpose and its 1-based index among the requests of that purpose. */
export type PastRequest = { purpose: string; index: number };

type Answer = { text: string; toolCalls: Array<unknown> | null };

/** The answered requests of `turnId` in `db`, by purpose, each list in the order the requests started. */
function archivedAnswers(db: Db, turnId: string): Map<string, Array<Answer>> {
  const rows = db
    .prepare(
      `SELECT purpose, response_text, tool_calls FROM model_requests WHERE turn_id = ? AND status = 'ok'
       ORDER BY started_at, step, id`
    )
    .all(turnId);
  const out = new Map<string, Array<Answer>>();
  for (const row of rows) {
    const purpose = typeof row.purpose === 'string' ? row.purpose : '';
    const calls: unknown = typeof row.tool_calls === 'string' ? JSON.parse(row.tool_calls) : null;
    const list = out.get(purpose) ?? [];
    list.push({
      text: typeof row.response_text === 'string' ? row.response_text : '',
      toolCalls: Array.isArray(calls) ? calls : null,
    });
    out.set(purpose, list);
  }
  return out;
}

/** The client that answers the replayed turn `turnId` from the archive of `db` (see the head of this file). */
export function archiveAnswers(
  db: Db,
  turnId: string
): { llm: { complete(messages: unknown, options?: unknown): Promise<Rec> }; past: Array<PastRequest> } {
  const answers = archivedAnswers(db, turnId);
  const asked = new Map<string, number>();
  const past: Array<PastRequest> = [];
  const complete = (_messages: unknown, options?: unknown): Promise<Rec> => {
    const given = (typeof options === 'object' && options !== null ? options : {}) as Rec;
    const purpose = typeof given.purpose === 'string' ? given.purpose : '';
    const index = (asked.get(purpose) ?? 0) + 1;
    asked.set(purpose, index);
    const found = answers.get(purpose)?.[index - 1];
    if (found === undefined) past.push({ purpose, index });
    const hasTools = Array.isArray(given.tools) && given.tools.length > 0;
    const toolCalls = found?.toolCalls ?? (hasTools ? [] : null);
    return Promise.resolve({
      text: found?.text ?? PAST_ARCHIVE,
      ...(toolCalls === null ? {} : { toolCalls }),
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0, source: 'archive' },
      estimated: 0,
      finishReason: 'stop',
      provider: 'archive',
      promptTokens: 0,
    });
  };
  return { llm: { complete }, past };
}

/** Ids `harness-1`, `harness-2` and so on, counted from one for each call. */
export function counterIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `harness-${count}`;
  };
}

/** The tools that reach the network: a replay answers them with what the live turn read instead of running them. */
const NETWORK_TOOLS = ['web.search', 'web.read', 'media.look'];

/** The status lines of `labels.tools.result` a result text opens with, by status. */
type ResultWords = Readonly<Record<string, unknown>>;

/**
 * The result of a call whose text the live turn read: the status whose line opens the text (the part of the line before
 * its `{reason}`), the rest of the text as its data. A text no line opens is a failure with the whole text as data.
 */
function resultOfText(text: string, words: ResultWords): Rec {
  const [head = '', ...rest] = text.split('\n');
  for (const [status, line] of Object.entries(words)) {
    if (typeof line !== 'string') continue;
    const lead = line.split('{reason}')[0];
    if (lead === '' || !head.startsWith(lead)) continue;
    const data = { text: rest.join('\n') };
    if (lead === line) return { status, data };
    const end = line.slice(lead.length + '{reason}'.length);
    const reason = head.slice(lead.length, end === '' ? undefined : head.length - end.length);
    return { status, reason, data };
  }
  return { status: 'failed', data: { text } };
}

/**
 * The answers of the network tools of `turnId` in `db`: each call of `web.search`, `web.read` and `media.look` gets, in
 * order per tool, the result text the live turn's next request carried for that tool's k-th call, read back into a
 * result with `words`, the copy's `labels.tools.result`. A call past the archive, or of another tool, gets null.
 */
export function archivedToolResults(db: Db, turnId: string, words: ResultWords): (op: string) => Rec | null {
  const rows = db
    .prepare(
      `SELECT messages, tool_calls FROM model_requests WHERE turn_id = ? AND status = 'ok' ORDER BY started_at, step, id`
    )
    .all(turnId);
  const said = new Map<string, string>();
  const asked: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    const messages: unknown = typeof row.messages === 'string' ? JSON.parse(row.messages) : [];
    for (const message of Array.isArray(messages) ? (messages as Array<Rec>) : [])
      if (message.role === 'tool' && typeof message.tool_call_id === 'string' && typeof message.content === 'string')
        said.set(message.tool_call_id, message.content);
    const calls: unknown = typeof row.tool_calls === 'string' ? JSON.parse(row.tool_calls) : [];
    for (const call of Array.isArray(calls) ? (calls as Array<Rec>) : [])
      if (typeof call.id === 'string' && typeof call.name === 'string') asked.push({ id: call.id, name: call.name });
  }
  const queues = new Map<string, Array<Rec>>();
  for (const call of asked) {
    // The model names a tool with `_` where the engine's operation has `.`.
    const op = NETWORK_TOOLS.find((name) => name.replaceAll('.', '_') === call.name);
    const text = said.get(call.id);
    if (op === undefined || text === undefined) continue;
    queues.set(op, [...(queues.get(op) ?? []), resultOfText(text, words)]);
  }
  return (op) => queues.get(op)?.shift() ?? null;
}
