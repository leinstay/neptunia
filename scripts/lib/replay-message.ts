// The message mode of scripts/replay.ts and `--show-request`. A message (`<placeId> <triggerMessageId>`) is answered
// again by the engine's own turn runner (scripts/lib/replay-turn.ts): a reply turn in that channel at the trigger's
// moment, the chat read over Discord's REST API up to that moment, the memory of the data folder (or `--snapshot`)
// read only, the persona's read tools run and every other call and every write kept. The trigger kind and the mode come from the
// journal's newest `turn.start` record whose trigger is this message (data/guilds/<g>/journal, read only), else the
// turn is a mention, or a reply when the trigger replies to the persona. `--samples n` runs the turn n times, each on its own
// runner. Each sample is the report the stored-turn mode writes (scripts/lib/turn-report.ts): each step's request
// size, the persona's think, every call with its status and result size, their messages and reactions, and why the turn ended.
// `--show-request` adds the first request of the first sample, its system text and its user text.
//
// `--show-request <turnId> [--steps]` sends no model request. It prints the request dumps of that turn when the
// journal kept them (data/guilds/<g>/journal/requests/<day>/<turnId>-<attempt>.json, every attempt, `source: 'dump'`;
// with `--steps` also each attempt's later requests, `<turnId>-<attempt>-s<step>.json`, each after its base dump).
// Else it rebuilds the turn's first request (`source: 'rebuilt'`): the turn's `turn.start` record gives the channel,
// the trigger message, the mode and the trigger kind, the turn runs as above with every request before its first
// request of purpose `reply` answered with nothing, and stops there.

import fs from 'node:fs';
import path from 'node:path';
import { lineOf } from '../../src/behavior/line-of.ts';
import type { Reads } from '../../src/interface/reads.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import { firstRequestOf, lineIn, replayTurn, reportOf } from './replay-turn.ts';
import type { ReplayTurnRun } from './replay-turn.ts';
import type { Rec } from './replay-types.ts';

/**
 * The journal's newest `turn.start` record whose trigger is `triggerId` (a
 * turn that answered this message), or null.
 * @param records The journal's records, oldest first (journalRecords).
 */
export function turnStartForTrigger(records: Array<Rec>, triggerId: string): Rec | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.kind === 'turn.start' && record.trigger?.messageId === triggerId) return record;
  }
  return null;
}

/** The JSON records of every journal day file under `dir`, oldest day first; unreadable lines skipped. */
export function journalRecords(dir: string): Array<Untyped> {
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, -1)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn or hand-broken line
      }
    }
  }
  return out;
}

/** One stored `later` message as shown: role, then tool_calls and tool_call_id when it has them, then content. */
function laterView(message: Untyped) {
  if (!message || typeof message !== 'object') return message;
  return {
    role: message.role,
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
    content: message.content ?? null,
  };
}

/**
 * The request dumps of `turnId` under a journal directory, every attempt, oldest day first, then
 * by attempt: the base dumps (`<turnId>-<attempt>.json`, the reply's request) only, unless `steps`
 * (`--steps`): then each attempt's later requests (`<turnId>-<attempt>-s<step>.json`, the tool
 * loop's steps and the follow-up after a call) follow its base dump in step order.
 */
export function storedDumps(
  journalDir: string,
  turnId: string,
  { steps = false }: { steps?: boolean } = {}
): Array<{ file: string; dump: Rec }> {
  const root = path.join(journalDir, 'requests');
  let days = [];
  try {
    days = fs
      .readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const day of days) {
    const found = [];
    for (const name of fs.readdirSync(path.join(root, day))) {
      if (!name.startsWith(`${turnId}-`)) continue;
      const match = /^(\d+)(?:-s(\d+))?\.json$/.exec(name.slice(turnId.length + 1));
      if (!match || (match[2] !== undefined && !steps)) continue;
      found.push({ name, attempt: Number(match[1]), step: match[2] === undefined ? 0 : Number(match[2]) });
    }
    found.sort((a, b) => a.attempt - b.attempt || a.step - b.step);
    for (const { name } of found) {
      try {
        const dump = JSON.parse(fs.readFileSync(path.join(root, day, name), 'utf8'));
        // A request that had tools names them by hash; the stored copy is read back as `toolDefinitions`
        // (absent when the copy is gone), so a replay re-sends the schemas the turn really saw.
        if (typeof dump.tools === 'string' && /^[0-9a-f]{64}$/.test(dump.tools)) {
          try {
            dump.toolDefinitions = JSON.parse(fs.readFileSync(path.join(root, 'tools', `${dump.tools}.json`), 'utf8'));
          } catch {
            // the copy is missing: the hash stays
          }
        }
        // The messages after the first two, shown as role, tool_calls and tool_call_id with their content.
        if (Array.isArray(dump.later)) dump.later = dump.later.map(laterView);
        out.push({ file: path.join(root, day, name), dump });
      } catch {
        // a dump cut short: skipped
      }
    }
  }
  return out;
}

/** The trigger kinds a recorded turn names that the replay runs; a private chat is never replayed. */
const KINDS = new Set(['mention', 'reply', 'followUp', 'overheard']);

/** What the message mode and the rebuilt request are handed (scripts/lib/replay-main.ts). */
export type MessageKit = {
  args: { samples: number | null; showRequest: boolean; showRequestTurn: string | null };
  root: string;
  dataDir: string;
  hot: unknown;
  port: unknown;
  reads: Reads;
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  journalOf: () => Array<Rec>;
  signal?: AbortSignal;
};

/** The moment of a message turn: its chat, its trigger line, the mode and the kind, and where the kind came from. */
export type Moment = {
  chat: { iface: string; chatId: string };
  trigger: Rec;
  at: number;
  mode: string;
  triggerKind: string;
  kindFrom: 'journal' | 'guess';
};

/** The moment of a message turn (see Moment), read off the platform up to the trigger and off the journal. */
export async function momentOf(
  kit: MessageKit,
  placeId: string,
  triggerId: string,
  recorded: Rec | null
): Promise<Moment> {
  const chat = { iface: 'discord', chatId: placeId };
  // The trigger is the newest message before the next id.
  const page = await kit.reads.history(chat, { limit: 1, before: String(BigInt(triggerId) + 1n) });
  const found = page?.events.find((event) => event.message.id === triggerId);
  const trigger = found === undefined ? null : lineOf(found);
  if (trigger === null) throw new CliError('replay-cli: the trigger message was not found');
  if (trigger.self === true)
    throw new CliError("replay-cli: the trigger is the persona's own message; give the message they answered");
  const turn = recorded ?? turnStartForTrigger(kit.journalOf(), triggerId);
  const recordedKind = String((turn?.trigger as { kind?: unknown } | undefined)?.kind);
  const kind = KINDS.has(recordedKind) ? recordedKind : null;
  const guessed =
    typeof trigger.replyPingAccountId === 'string' && trigger.replyPingAccountId !== '' ? 'reply' : 'mention';
  return {
    chat,
    trigger,
    at: Number(trigger.ts),
    // A message is answered: a recorded interjection was one with no trigger, which this mode does not run.
    mode: 'reply',
    triggerKind: kind ?? guessed,
    kindFrom: turn ? 'journal' : 'guess',
  };
}

/** One turn of the moment on the replay runner, its parameters read off the turn's own reads. */
export function turnOf(kit: MessageKit, moment: Moment, turnId: string, stopAt: string | null): Promise<ReplayTurnRun> {
  return replayTurn({
    root: kit.root,
    dataDir: kit.dataDir,
    hot: kit.hot,
    port: kit.port,
    llm: kit.llm,
    embed: kit.embed,
    rng: Math.random,
    turnId,
    at: moment.at,
    served: new Map(),
    stopAt,
    params: async (reads) => ({
      chat: moment.chat,
      mode: moment.mode,
      trigger: (await lineIn(reads, moment.chat, String(moment.trigger.id))) ?? moment.trigger,
      triggerKind: moment.triggerKind,
    }),
  });
}

/** The trigger as the output names it. */
const triggerOut = (moment: Moment) => ({
  id: moment.trigger.id,
  author: moment.trigger.authorName ?? null,
  at: new Date(moment.at).toISOString(),
  kind: moment.triggerKind,
  kindFrom: moment.kindFrom,
  mode: moment.mode,
});

/** The message mode (see the head of this file). Returns `{ code, result }`: code 1 when the samples were stopped. */
export async function runMessage(
  kit: MessageKit & { placeId: string; triggerId: string }
): Promise<{ code: number; result: Rec }> {
  const moment = await momentOf(kit, kit.placeId, kit.triggerId, null);
  const samples: Array<Rec> = [];
  let request: { system: string; user: string } | null = null;
  const asked = kit.args.samples ?? 1;
  for (let n = 1; n <= asked; n += 1) {
    if (kit.signal?.aborted) break;
    const run = await turnOf(kit, moment, `t-replay-message-${n}`, null);
    request ??= firstRequestOf(run);
    samples.push(reportOf(run, `t-replay-message-${n}`, n));
  }
  const stopped = samples.length < asked;
  return {
    code: stopped ? 1 : 0,
    result: {
      trigger: triggerOut(moment),
      channel: { id: kit.placeId, name: moment.trigger.channelName ?? null },
      samples,
      stopped,
      ...(kit.args.showRequest && request !== null ? { request } : {}),
    },
  };
}

/** The rebuilt first request of a journal turn (see the head of this file). */
export async function rebuiltRequest(kit: MessageKit & { turnStart: Rec }): Promise<{ code: number; result: Rec }> {
  const { turnStart } = kit;
  const scope = turnStart.scope as { channel?: unknown };
  const trigger = turnStart.trigger as { messageId?: unknown };
  const moment = await momentOf(kit, String(scope.channel), String(trigger.messageId), turnStart);
  const run = await turnOf(kit, moment, String(turnStart.turnId), 'reply');
  const request = firstRequestOf(run);
  if (request === null)
    throw new CliError(`replay-cli: the turn ended ${String(run.result.outcome)} before its first request`);
  return {
    code: 0,
    result: {
      source: 'rebuilt',
      note:
        "no request dump of this turn is kept: this is its first request rebuilt by the engine's turn runner from its turn.start record, the chat read now up to its trigger and the memory of " +
        `${kit.dataDir}, every request before it answered with nothing`,
      turnId: kit.args.showRequestTurn,
      trigger: triggerOut(moment),
      channel: { id: moment.chat.chatId, name: moment.trigger.channelName ?? null },
      request,
    },
  };
}
