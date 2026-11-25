// `--inner <kind>`: the inner turn the scheduler would run for one wake, against the live data
// (or `--snapshot`) read only: `--intention <id>` names the intention of an `intention_due` or
// `errand_deadline` wake (required for those), in the intention's destination, or nowhere when it names none. No
// server is chosen: every guild the bot is in is served, as the core serves them, and the state is the persona's
// data/persona/inner.json. Each sample's turn runner is the one the stored-turn mode composes as the core composes
// its own (scripts/lib/turn-wiring.ts): the memory database read only for `<meanwhile>`, `<memory>`, the persona's day and the
// places they name, a memory context per turn, their intentions and errands, their identity as the core holds it, over
// the Discord adapter on REST (GET only, every write kept and answered as delivered) and an unflushed copy of the
// memory store; `wakes.mode` forced to `shadow`, so their reads run (on production's routing) and every other call is
// only proposed; the journal reads the data and writes nothing; intentions read only (an expiry sweep writes nothing). Prints the request's blocks (`--show-request`: the
// whole request), the persona's answers, their proposed and executed actions, the cost.
//
// `--inner heartbeat`: the heartbeat's turn. The wake is built by the scheduler itself (a real
// src/behavior/inner.ts life over a throwaway copy of inner.json, with a turn runner that only
// records the wake and the chat it was handed), so its `<wake>` is the one the live
// heartbeat would carry now, and like the live one it runs nowhere (no chat). Takes no
// `--intention`. Every `--inner` kind takes `--samples n` (n independent runs of
// the same request, one after another, default 1), `--prompts <dir>` (a prompt layer laid over
// the live prompts.local/ as `--skills --prompts` does: a directory holding only heartbeat/task.md
// replaces only that file, so a variant of the task text is tried without a deploy) and
// `--out <file>` (the report as Markdown; not under data/). The JSON on stdout holds every
// sample: the `<wake>` block, the persona's `<think>`, their messages and calls with their arguments,
// the actions (proposed, executed, refused), the cost, and `facts` (scripts/lib/inner-summary.ts#sampleFacts: the
// first request's prompt tokens and block sizes, each request's tokens and think size, every call's name, status and
// refusal code, each errand call with its agent and whether a result answered it, and how the sample ended: its
// intention changes, each with its kind, place as the call gave it, whether that place is a direct chat, minutes to its
// due time, recurrence and purpose length in words; a skip of their own, with no call of theirs left unanswered; or
// unresolved with a short code: an errand call only proposed or not answered, a loop cut by the step cap, the time
// budget or the token cap, an error, or no decision at all). `summary` counts the three endings over the samples
// (innerSummary), takes the shares of skips and intentions over the resolved samples, and heads the Markdown report
// as a table; the same report in Markdown
// goes to stderr and to `--out` whatever its extension, and the JSON is stdout's. `--seed <text>` draws sample i from
// a random source of the seed and i, so two variants meet the same order; without it the samples draw from
// Math.random. No errand is ever started: in shadow the persona's errand call is only proposed and ends the turn, unless
// `--errand-answers <file>` gives results (scripts/lib/errand-answers.ts: a JSON list of `{ agent, status, text,
// error? }`, `agent` one of scout, server, code or any, `status` one of done, failed or cancelled), taken in order as
// their errand calls come, each sample from the first. That call then runs the errand tool over an errand service that
// files in process and ends the errand with the next result for its agent, so the persona reads it as a live heartbeat reads
// a result it waited for; a call that finds none left answers `errand-wait-ended`. `--spend` also stops the samples: none starts when the cost reported so far plus the
// last sample's would pass it.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { personaRecord, personaJournal } from '../../src/behavior/inner/persona-sources.ts';
import type { Hot } from '../../src/hot.ts';
import type { Reads } from '../../src/interface/reads.ts';
import { accountOf } from '../../src/memory/addresses.ts';
import type { Db } from '../../src/memory/db/types.ts';
import type { Adapter } from '../../src/protocol/adapter.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError, defaultDataDir, platformToken } from './cli.ts';
import { seededRng } from './diary-day.ts';
import { readErrandAnswers } from './errand-answers.ts';
import type { ErrandAnswer } from './errand-answers.ts';
import { runSamples } from './inner-samples.ts';
import { innerSummaryTable, sampleFacts, turnEndOf, innerSummary } from './inner-summary.ts';
import type { InnerSummary } from './inner-summary.ts';
import { readOnlyMemory } from './memory-read.ts';
import { cachedChannel, hiddenReads, chatRef } from './platform-objects.ts';
import { overlayPromptsHot, diaryPromptLayers } from './prompt-layers.ts';
import { loadDiaryMods } from './replay-diary.ts';
import { connectDiscord, refuseDiscordWrites } from './replay-discord.ts';
import { replayRouting, recordingLlm, addUsage } from './replay-llm.ts';
import { memoryFor, storeMemoryFor } from './replay-memory.ts';
import type { Rec, WakeInfo, ModeCtx } from './replay-types.ts';
import { recordingPort } from './turn-port.ts';
import type { RecordedWrite } from './turn-port.ts';
import { homeIdentity, buildTurnRunner, unflushedStore } from './turn-wiring.ts';
import type { WiringInput, Wired } from './turn-wiring.ts';

/** The `<tag>` block of a request's user text, whole (tags included); null when it has none. */
function blockOf(text: string, tag: Untyped): string | null {
  const match = new RegExp(`(?:^|\\n\\n)(<${tag}>\\n[\\s\\S]*?\\n</${tag}>)(?=\\n\\n|$)`).exec(text ?? '');
  return match ? match[1] : null;
}

// ---- an inner turn (--inner) ----------------------------------------------------

/**
 * `hot` as an `--inner` turn sees it: `wakes.mode` forced to `shadow` (the persona's reads run, nothing else
 * does). Every other value as the config read has it; the live config untouched. The journal stays
 * off because the runner is given none (`journal: null`).
 */
export function innerReplayHot(hot: Untyped): Rec {
  return new Proxy(hot, {
    get(target, prop) {
      if (prop === 'config') {
        const config = target.config ?? {};
        return { ...config, wakes: { ...(config.wakes ?? {}), mode: 'shadow' } };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The wake an `--inner` turn runs for, as the scheduler's drain builds it
 * (src/behavior/inner.ts#createInnerLife): the intention's wake (`intention`, for
 * `intention_due` or `errand_deadline`). `inner` is src/behavior/inner.ts's module. Pure.
 */
export function innerReplayWake({ inner, kind, intention = null, now, timezone }: Rec): {
  wake: Untyped;
  info: WakeInfo;
} {
  const wake = inner.wakeOfDue({
    intention,
    reason: kind === 'errand_deadline' ? 'wait-deadline' : 'due',
    at: Number.isFinite(intention?.dueAt) ? intention.dueAt : now,
  });
  return {
    wake,
    info: {
      kind: wake.kind,
      items: [
        { kind: wake.kind, reason: wake.reason, intentionIds: wake.intentionIds, errandId: wake.errandId ?? null },
      ],
      intentions: intention ? [intention] : [],
      now,
      timezone,
      channels: [],
      chainId: wake.chainId,
    },
  };
}

/** The guild's intention stores with every write refused (`read-only`): an expiry sweep writes nothing. */
function readOnlyIntentionStores(stores: Untyped) {
  return {
    get(placeId: string) {
      const store = stores.get(placeId);
      if (!store) return null;
      return new Proxy(store, {
        get(target, prop) {
          if (prop === 'add' || prop === 'update') return () => ({ ok: false, code: 'read-only' });
          if (prop === 'forgetUser' || prop === 'wipe')
            return () => {
              throw new Error('replay-cli: intentions are read-only here');
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

/** The tag names of a request's user text, in order, each once. */
function blockNames(text: string) {
  return [...new Set([...String(text).matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]))];
}

/**
 * The ids `--hide-channel` / `--hide-message` name, as sets (an experiment: salient items removed from a frozen moment).
 * @param args From parseArgs.
 */
export function hideSetsOf(args: { hideChannels?: Array<string>; hideMessages?: Array<string> } = {}): {
  channels: Set<string>;
  messages: Set<string>;
  any: boolean;
} {
  const channels = new Set((args.hideChannels ?? []).map(String));
  const messages = new Set((args.hideMessages ?? []).map(String));
  return { channels, messages, any: channels.size > 0 || messages.size > 0 };
}

/** True when a record line is in a hidden channel or is (or was made of) a hidden message. */
function recordLineHidden(line: Untyped, hide: Rec) {
  const channel = line?.scope?.channel;
  if (typeof channel === 'string' && hide.channels.has(channel)) return true;
  if (typeof line?.messageId === 'string' && hide.messages.has(line.messageId)) return true;
  return (
    Array.isArray(line?.sourceMessageIds) && line.sourceMessageIds.some((id: string) => hide.messages.has(String(id)))
  );
}

/**
 * The record with the hidden channels' and messages' lines left out of what it iterates (every other method
 * passes through). Nothing is written; the real record is only read.
 */
export function hiddenRecord(record: Untyped, hide: Rec): Rec {
  if (!hide?.any || !record) return record;
  return new Proxy(record, {
    get(target, prop) {
      if (prop === 'iterate') {
        return async function* iterate(...args: Array<Untyped>) {
          for await (const line of target.iterate(...args)) if (!recordLineHidden(line, hide)) yield line;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The record and the journal as the core hands them to the inner life (src/core.ts): the persona's, read by a query
 * alone over every served place, the record with the hidden lines left out.
 */
export function innerSourcesOf({
  record,
  journal,
  store,
  places,
  hide,
}: {
  record: Parameters<typeof personaRecord>[0];
  journal: Parameters<typeof personaJournal>[0];
  store: Parameters<typeof personaRecord>[1];
  places: () => Array<string>;
  hide: Rec;
}): {
  record: { iterate(query: Rec): AsyncIterable<unknown> };
  journal: ReturnType<typeof personaJournal>;
} {
  return {
    record: hiddenRecord(personaRecord(record, store, places), hide) as { iterate(query: Rec): AsyncIterable<unknown> },
    journal: personaJournal(journal, places, store),
  };
}

/** The inner life's record and journal over the data directory, every guild the bot is in served as the core serves it. */
function replayInnerSources({
  mods,
  dataDir,
  log,
  store,
  rootIds,
  hide,
}: {
  mods: Untyped;
  dataDir: string;
  log: Untyped;
  store: Untyped;
  rootIds: Array<string>;
  hide: Rec;
}) {
  const memoryDb = memoryFor(dataDir);
  return innerSourcesOf({
    record: mods.createRecord({ dataDir, log, memoryDb }),
    journal: mods.createJournal({ dataDir, config: () => ({}), log, memoryDb }),
    store,
    places: () => rootIds.map((id) => store.placeOfRoot(id, 'discord') as string),
    hide,
  });
}

/** The places list without the hidden channels (the channel directory is another list and stays whole). */
export function hiddenPlaces(places: unknown, hide: Rec): (...args: Array<Untyped>) => Array<Rec> {
  const listed = places as (...args: Array<Untyped>) => Array<Rec>;
  if (!hide?.any || typeof places !== 'function') return listed;
  return (...args) => listed(...args).filter((entry) => !hide.channels.has(String(entry?.id)));
}

/**
 * The heartbeat's wake, built by the scheduler itself: a real inner life (src/behavior/inner.ts#createInnerLife)
 * over a throwaway data directory holding a copy of the persona's inner.json (`dataDir` is only read), the
 * stores and sources it was given, the heartbeat wake queued for `now` and one drain; its turn runner only
 * records what it was handed (the `<wake>` facts, the chat, the current channel) and ends the turn
 * as a skip. So the facts are the ones the live heartbeat would carry now, with no chat, since a heartbeat
 * runs nowhere. Nothing is written under `dataDir`; the throwaway directory is removed. A CliError when the drain
 * ran no turn (stopped, paused).
 * @param input.inner src/behavior/inner.ts's module.
 * @param input.deps The createInnerLife options besides hot, dataDir and turns:
 *   intentions, record, journal (reads only), places, nameOf, reads, iface, store.
 * @param input.tmpRoot Where the throwaway directory is made (default the OS temp directory).
 */
export async function heartbeatReplayWake({
  inner,
  hot,
  dataDir,
  now,
  deps = {},
  tmpRoot = os.tmpdir(),
  log = { info() {}, warn() {} },
}: {
  inner: Rec;
  hot: Rec;
  dataDir: string;
  now: number;
  deps?: Rec;
  tmpRoot?: string;
  log?: Rec;
}): Promise<{
  info: WakeInfo;
  chat: { iface: string; chatId: string } | null;
  currentChannel: string | null;
}> {
  const scratch = fs.mkdtempSync(path.join(tmpRoot, 'replay-heartbeat-'));
  try {
    // The persona's state where src/behavior/inner/queue.ts keeps it.
    const stateFile = path.join(dataDir, 'persona', 'inner.json');
    if (fs.existsSync(stateFile)) {
      // A copy with the kill switch lifted (a stopped life would queue nothing; a preview is wanted anyway).
      const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.mkdirSync(path.join(scratch, 'persona'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'persona', 'inner.json'), JSON.stringify({ ...kept, stopped: false }));
    }
    let seen = null;
    const life = inner.createInnerLife({
      ...deps,
      hot,
      dataDir: scratch,
      turns: {
        runTurn: async (turn: Rec) => {
          seen = {
            info: turn.inner.wake,
            chat: turn.chat,
            currentChannel: turn.inner.currentChannel ?? null,
          };
          return { outcome: 'skip', reason: 'replay-capture' };
        },
      },
      journal: deps.journal ?? null,
      now: () => now,
      rng: () => 0.5,
      log,
    });
    const queued = life.onWake({
      kind: 'inner.wake',
      at: now,
      id: `inner.wake:heartbeat:${now}`,
      wake: inner.heartbeatWake(now),
    });
    if (queued?.status !== 'queued')
      throw new CliError(`replay-cli: the heartbeat wake was not queued (${queued?.status ?? 'unknown'})`);
    const drained = await life.drain();
    if (!seen) {
      const why = drained?.deferred ?? drained?.refused ?? (drained?.dropped ? 'dropped' : 'nothing ran');
      throw new CliError(`replay-cli: the scheduler would not run the heartbeat now: ${why}`);
    }
    return seen;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The random source of sample `n` of an `--inner` run with `--seed`: the same seed and sample give the same draws, so
 * two variants meet the same order. Null without a seed: the sample draws from `Math.random`, the runner's default.
 */
export function innerSampleRng(seed: string | null, n: number): (() => number) | null {
  return seed === null ? null : seededRng(seed, `inner-sample-${n}`);
}

/**
 * One reply of an `--inner` run, as the report shows it: the persona's `<think>` whole, their messages, their tool calls with
 * their arguments (a drawing is a `draw.create` call), their reactions, gif, whether they skipped. `tools` gives
 * the tool side of the answer (`{ answerOf, toolCalls, finishReason }`: src/behavior/turn.js#answerOf
 * splits the text into speech and calls); without it the text is read as speech only. Pure.
 * @param text The raw reply.
 * @param parseOutput src/llm/parse.ts#parseOutput.
 * @param failedCode The failure code when the model request of this step failed (no reply).
 */
export function innerAnswerOf(
  text: string | null,
  parseOutput: (...args: Array<Untyped>) => Untyped,
  failedCode: string | null = null,
  tools: {
    answerOf?: (...args: Array<Untyped>) => Untyped;
    toolCalls?: Array<Rec> | null;
    finishReason?: string | null;
  } | null = null
):
  | {
      failed: { code: string };
      think: string;
      messages: Array<never>;
      calls: Array<never>;
      reactions: Array<never>;
      gif: null;
      skip: boolean;
      text: string;
    }
  | {
      think: Untyped;
      messages: Untyped;
      calls: Untyped;
      reactions: Untyped;
      gif: Untyped;
      skip: Untyped;
      text: string;
      failed?: undefined;
    } {
  if (failedCode) {
    // The request itself failed: no answer exists, and an empty one would read as the persona choosing to skip.
    return {
      failed: { code: String(failedCode) },
      think: '',
      messages: [],
      calls: [],
      reactions: [],
      gif: null,
      skip: false,
      text: '',
    };
  }
  const split =
    typeof tools?.answerOf === 'function'
      ? tools.answerOf({
          text: String(text ?? ''),
          toolCalls: tools.toolCalls ?? [],
          finishReason: tools.finishReason ?? null,
        })
      : { speechText: String(text ?? ''), calls: [] };
  const parsed = parseOutput(split.speechText);
  return {
    think: parsed.think,
    // The persona's text outside every tag is no message (parseOutput `bare`): the report shows it apart.
    ...(parsed.untagged ? { bare: parsed.bare } : {}),
    messages: parsed.messages.map((message: Untyped) => message.text),
    calls: split.calls.map((call: Rec) => ({
      skill: call.name,
      args: call.args,
      ...(call.problem ? { problem: call.problem } : {}),
    })),
    reactions: parsed.reactions,
    gif: parsed.gif,
    skip: parsed.skip,
    text: String(text ?? ''),
  };
}

/**
 * The Markdown report of an `--inner` result (`runInner`'s): the `<wake>` block once, then per sample the persona's think,
 * their answer, the actions and the cost. Pure.
 */
export function innerReportMarkdown(result: Untyped): string {
  const fence = (text: string) => `~~~\n${String(text ?? '')}\n~~~`;
  const lines = [
    `# Inner turn: ${result.kind}${result.intention ? ` (${result.intention})` : ''}`,
    '',
    `Channel: ${result.placeId ?? '-'}`,
    '',
  ];
  if (result.cut) lines.push(`Cut short: ${result.cut.finished} of ${result.cut.asked} samples finished`, '');
  const hidden = result.hidden as { channels?: Array<unknown>; messages?: Array<unknown> } | undefined;
  if (hidden && ((hidden.channels?.length ?? 0) > 0 || (hidden.messages?.length ?? 0) > 0))
    lines.push(
      `Hidden channels: ${(result.hidden.channels ?? []).join(', ') || '-'}`,
      `Hidden messages: ${(result.hidden.messages ?? []).join(', ') || '-'}`,
      ''
    );
  if (result.summary) lines.push('## summary', '', ...innerSummaryTable(result.summary as InnerSummary), '');
  if (result.wake) lines.push('## wake', '', fence(result.wake), '');
  if (result.request?.messages)
    lines.push('## request', '', fence(JSON.stringify(result.request.messages, null, 2)), '');
  (result.samples ?? []).forEach((sample: Untyped, index: number) => {
    const failedSteps = sample.answers.filter((answer: Rec) => answer.failed).length;
    const lastFailed = sample.answers.at(-1)?.failed ?? null;
    lines.push(
      `## Sample ${index + 1}`,
      '',
      `Outcome: ${sample.outcome ?? '-'}${sample.reason ? ` (${sample.reason})` : ''}${lastFailed ? `; ended in error (${lastFailed.code})` : ''}`,
      ''
    );
    if (failedSteps > 0)
      lines.push(
        `Failed steps: ${failedSteps} of ${sample.answers.length} (the model request failed; these are not the persona's answers)`,
        ''
      );
    sample.answers.forEach((answer: Untyped, step: Untyped) => {
      if (answer.failed) {
        lines.push(`### Step ${step + 1}: error (${answer.failed.code})`, '');
        return;
      }
      lines.push(`### Answer ${step + 1}`, '', 'think:', '', fence(answer.think || '(none)'), '');
      if (answer.messages.length > 0)
        lines.push(
          'messages:',
          '',
          ...answer.messages.map((message: Untyped) => `- ${message.replace(/\n/g, '\n  ')}`),
          ''
        );
      if (answer.calls.length > 0) lines.push('calls:', '', fence(JSON.stringify(answer.calls, null, 2)), '');
      if (answer.reactions?.length > 0) lines.push('reactions:', '', fence(JSON.stringify(answer.reactions)), '');
      if (answer.gif) lines.push('gif:', '', fence(JSON.stringify(answer.gif)), '');
      if (answer.skip) lines.push('skip', '');
    });
    lines.push(
      'actions:',
      '',
      sample.actions.length > 0 ? fence(JSON.stringify(sample.actions, null, 2)) : '(none)',
      ''
    );
    lines.push(
      `posted: ${sample.posted}; requests: ${sample.usage.requests}; tokens: ${sample.usage.promptTokens} in, ${sample.usage.completionTokens} out; cost: ${Number(sample.usage.cost ?? 0).toFixed(4)} USD`,
      ''
    );
  });
  lines.push(
    `Total cost: ${Number(result.usage?.cost ?? 0).toFixed(4)} USD${result.stopped ? ` (stopped: ${result.stopped})` : ''}`,
    ''
  );
  return lines.join('\n');
}

/**
 * The readable channels of every served guild at once, with whether the persona can write there, as the core's places listing
 * gives them to the inner life.
 */
function guildPlaces(guilds: Array<Untyped>, capabilities: Untyped): Array<Rec> {
  return guilds.flatMap((guild) =>
    capabilities.channelDirectoryOf(guild).map((entry: Rec) => {
      let writable = null;
      try {
        const found = cachedChannel(guild, entry.id);
        writable = found ? capabilities.canSend(found) : null;
      } catch {
        // A channel the cache holds in a shape canSend cannot read: its permission is unknown.
        writable = null;
      }
      return { id: entry.id, name: entry.name, writable };
    })
  );
}

/**
 * Whether each place the persona's intention calls name is a direct chat, read from the interface (a chat with no root), the
 * command line's chat always one. A place the interface does not know is left out.
 */
async function directPlaces(iface: unknown, reads: Untyped, actions: Array<Rec>, answers: Array<Rec>) {
  const named = new Set<string>();
  for (const action of actions) {
    const channel: unknown = action.target?.channel;
    if (typeof channel === 'string') named.add(channel);
  }
  for (const answer of answers)
    for (const call of answer.calls ?? []) {
      const place: unknown = call.args?.place;
      if (typeof place === 'string') named.add(place);
    }
  const direct = new Map<string, boolean>();
  for (const place of named) {
    if (place.startsWith('cli:dm:')) {
      direct.set(place, true);
      continue;
    }
    // A handle the interface cannot read as a chat id answers with an error: its kind stays unknown.
    const found = await reads.chatInfo({ iface, chatId: place }).catch(() => null);
    if (found?.chat) direct.set(place, found.chat.rootId === null);
  }
  return direct;
}

/**
 * The turn runner of one `--inner` sample: the runner a replayed turn has (scripts/lib/turn-wiring.ts#buildTurnRunner),
 * composed as the core composes its own over the data folder read only: the memory database for the graph reader, the persona's
 * lines elsewhere, their day and the places they name, a memory context per turn, their intentions and errands. They are
 * who the core holds them to be (turn-wiring.ts#homeIdentity), on no root. `port`'s reads answer the turn; every write
 * of the turn is kept in `writes` and answered as delivered (scripts/lib/turn-port.ts#recordingPort).
 */
export function innerTurnRunner({
  root,
  dataDir,
  hot,
  port,
  llm,
  embed,
  rng,
  now,
  turnId,
  wrapReads,
  errandAnswers = null,
  images,
  describePicture,
}: {
  root: string;
  dataDir: string;
  hot: unknown;
  port: unknown;
  llm: unknown;
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  rng: () => number;
  now: () => number;
  turnId: string;
  wrapReads?: (reads: Reads) => Reads;
  errandAnswers?: ReadonlyArray<ErrandAnswer> | null;
  images?: WiringInput['images'];
  describePicture?: WiringInput['describePicture'];
}): { wired: Wired; writes: Array<RecordedWrite> } {
  const memory = readOnlyMemory(dataDir);
  const db = memory.memoryDb?.database() as Db | null | undefined;
  if (!db) throw new CliError(`replay-cli: no memory database in ${dataDir}`);
  let identity;
  try {
    identity = homeIdentity(db, dataDir);
  } finally {
    memory.close();
  }
  const recorded = recordingPort(port as Adapter, now);
  const wired = buildTurnRunner({
    root,
    dataDir,
    hot: hot as Hot,
    turnId,
    now,
    identity: { iface: identity.iface, selfId: identity.selfId, selfName: identity.selfName, rootNative: null },
    rootPlace: null,
    port: recorded.port,
    llm: llm as WiringInput['llm'],
    embed,
    rng,
    ...(wrapReads ? { wrapReads } : {}),
    errandAnswers,
    ...(images ? { images } : {}),
    ...(describePicture ? { describePicture } : {}),
  });
  return { wired, writes: recorded.writes };
}

/**
 * The runner of the replay's diary modes: the runner an `--inner` sample has (innerTurnRunner), with the memory reads,
 * the recall, the intentions read only and the place handles of the core, over the data folder read only. `turn(kind)`
 * runs one diary turn on it, `kind` forced as the owner's command forces it or null to draw it as the live diary does,
 * and answers the turn's result with the journal lines it kept, whose operations give each call's status. One runner
 * serves a whole day, so a slot sees the entries of the slots before it.
 */
export function diaryReplayRunner(wiring: Omit<Parameters<typeof innerTurnRunner>[0], 'errandAnswers'>): {
  turn: (kind: string | null) => Promise<{ result: Untyped; journal: Wired['journal']['lines'] }>;
  close: () => void;
} {
  const { wired } = innerTurnRunner(wiring);
  const { lines } = wired.journal;
  let seeded: Promise<void> | null = null;
  return {
    async turn(kind) {
      const from = lines.length;
      let result: Untyped;
      try {
        seeded ??= wired.seed();
        await seeded;
        result = await wired.under(() =>
          wired.runner.runTurn({
            chat: null,
            mode: 'diary',
            diary: kind ? { kind, forced: true } : { kind: null, forced: false },
          })
        );
      } catch (err: Untyped) {
        result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
      }
      return { result, journal: lines.slice(from) };
    },
    close: () => wired.close(),
  };
}

/**
 * The `--inner` mode (see the header): one inner turn for one wake (`--samples` times), in shadow, against the
 * live data (or `--snapshot`) read only. Returns `{ code, result }`.
 */
export async function runInner({
  args,
  root,
  load,
  hot: liveHot,
  createHot,
  log,
  signal,
  budget = null,
  answers,
  routes,
}: ModeCtx): Promise<{ code: number; result: Rec }> {
  const mods = {
    ...(await loadDiaryMods(load)),
    ...(await load('behavior/inner.ts')),
    ...(await load('intentions/store.ts')),
    ...(await load('intentions/service.ts')),
    ...(await load('errands/store.ts')),
    ...(await load('memory/append-store.ts')),
    ...(await load('memory/record.ts')),
    ...(await load('memory/journal.ts')),
    ...(await load('llm/embed.ts')),
    ...(await load('behavior/prompt.ts')),
  };
  await load('tools/operations/index.ts');
  const { createJournal } = await load('memory/journal.ts');
  const { deepMerge } = await load('config.ts');
  const {
    createStore,
    createCalibrator,
    createLlm,
    createIntentionStores,
    createIntentionService,
    createErrandStore,
    userText,
  } = mods;
  const liveData = defaultDataDir(root);
  const dataDir = args.snapshot !== null ? path.resolve(root, args.snapshot) : liveData;
  if (!fs.existsSync(dataDir)) throw new CliError(`replay-cli: no data directory at ${dataDir}`);
  const outFile = args.outDir !== null ? path.resolve(root, args.outDir) : null;
  if (outFile !== null && [liveData, dataDir].some((dir) => outFile === dir || outFile.startsWith(`${dir}${path.sep}`)))
    throw new CliError('replay-cli: --out may not be under data/');
  // The errand results, read and checked before anything connects or asks a model.
  const errandAnswers = readErrandAnswers(args.errandAnswers, root);
  const discordToken = platformToken('discord', { rootDir: root });

  let layered = null;
  let client: Untyped = null;
  try {
    if (args.prompts !== null) {
      layered = overlayPromptsHot(createHot, root, args.prompts, { mergeJson: deepMerge });
      log.info('replay-cli: inner prompt layers', { layers: diaryPromptLayers(root, args.prompts).length });
    }
    const hot = innerReplayHot(layered?.hot ?? liveHot);
    const config = hot.config;
    const settings = mods.innerSettings(config);
    const timezone = config.bot?.timezone ?? 'UTC';
    const { store, state } = unflushedStore(createStore({ dataDir, memoryDb: storeMemoryFor(dataDir) }));
    const calibrator = createCalibrator(state.data.calibration);
    const routing = await replayRouting(createLlm, hot, calibrator, state, { root, answers, routes });
    const calls: Array<Untyped> = [];
    const requests: Array<Untyped> = [];
    const recorded = recordingLlm(routing.llm, calls, { noCache: true, errorCodeOf: mods.errorCodeOf });
    const llm = new Proxy(recorded, {
      get(target, prop) {
        if (prop === 'complete') {
          return (messages: Untyped, options: Untyped = {}) => {
            requests.push({ purpose: options?.purpose ?? null, messages });
            return target.complete(messages, options);
          };
        }
        return Reflect.get(target, prop, target);
      },
    });

    // Discord over REST, every write refused; anything the turn would post goes to an in-memory port.
    const discord = createRequire(path.join(root, 'package.json'))('discord.js');
    // Every guild the bot is in, none chosen: an inner turn belongs to the persona, not to one server.
    const connection = await connectDiscord({ discord, token: discordToken, everyGuild: true, log });
    client = connection.client;
    const rootIds = connection.guilds.map((guild) => String(guild.id));
    refuseDiscordWrites(client);
    const hide = hideSetsOf(args);
    const capabilities = mods.createDiscordInterface({ client }).capabilities;
    const discordPort = mods.createDiscordInterface({ client, config: () => hot.config }).port;
    const reads = hiddenReads(mods.createReads(discordPort, log), hide);

    // The persona's intentions and errands for the scheduler's wake, read only; the turn reads its own (innerTurnRunner).
    const taskStore = createErrandStore({
      config: () => hot.config,
      journal: null,
      memoryDb: memoryFor(dataDir),
    });
    const intentions = createIntentionService({
      stores: readOnlyIntentionStores(createIntentionStores({ memoryDb: memoryFor(dataDir) })),
      hot,
      tasks: { store: () => taskStore },
    });
    const sources = replayInnerSources({ mods: { ...mods, createJournal }, dataDir, log, store, rootIds, hide });
    const now = Date.now();
    let intention = null;
    let chat = null;
    let info = null;
    let currentChannel: string | null = null;
    if (args.inner === 'heartbeat') {
      // The scheduler builds it over the stores as they are; it runs nowhere.
      if (!settings.heartbeat.enabled)
        log.warn('replay-cli: heartbeat.enabled is off; the live scheduler would not wake the persona', {});
      // A pause of the persona would hold the live drain; a preview is wanted anyway (the copy of the store is not written).
      if (state.data.paused)
        log.warn('replay-cli: the persona is paused; the live scheduler holds the heartbeat, a preview runs it', {});
      const schedulerStore = new Proxy(store, {
        get(target, prop) {
          if (prop === 'state') return { ...state, data: { ...state.data, paused: false } };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const caught = await heartbeatReplayWake({
        inner: mods,
        hot,
        dataDir,
        now,
        log,
        deps: {
          intentions,
          record: sources.record,
          journal: sources.journal,
          places: hiddenPlaces(() => guildPlaces(connection.guilds, capabilities), hide),
          nameOf: (id: string, accountId: string) => store.getUser(accountOf(store, accountId))?.names?.[0] ?? null,
          reads,
          iface: () => discordPort.iface,
          store: schedulerStore,
        },
      });
      ({ info, chat, currentChannel } = caught);
    } else {
      intention = intentions.store()?.get(args.intention) ?? null;
      if (!intention) throw new CliError(`replay-cli: no intention ${args.intention}`);
      if (!['pending', 'waiting'].includes(intention.status))
        log.warn('replay-cli: the intention is not open, no wake is due', { status: intention.status });
      const dmChat = intention.provenance?.scope === 'dm';
      const target = dmChat ? intention.provenance?.placeId : (intention.destination ?? intention.provenance?.placeId);
      // An intention with no place runs nowhere, as the drain runs it (src/behavior/inner/drain.ts#chatFor).
      if (target) {
        const found = await client.channels.fetch(String(target)).catch(() => null);
        if (!found) throw new CliError("replay-cli: the intention's place is gone; the live drain runs it nowhere");
        chat = chatRef(found);
      }
      info = innerReplayWake({ inner: mods, kind: args.inner, intention, now, timezone }).info;
    }

    // The embedder of the turn's recall, on the embedding role's key; an offline run embeds nothing.
    const embedder = answers ? null : mods.createEmbedder({ apiKey: '', keyOf: routing.keyOf, state });
    const embed = (texts: Array<string>, options?: unknown) =>
      embedder === null ? Promise.resolve(texts.map(() => null)) : embedder.embed(texts, options);
    log.info('replay-cli: inner ready', {
      guilds: rootIds.length,
      chatId: chat?.chatId ?? null,
      kind: args.inner,
      intention: intention?.id ?? null,
      samples: args.samples,
    });

    // Set by the first sample's run, which the compiler does not follow into the callback.
    let firstRequest = null as { text: string; messages: Array<Rec> | null } | null;
    let total = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    let [lastCost, code] = [0, 0];
    // The same request again: none starts when its cost would pass --spend; SIGTERM or SIGINT keeps the finished ones.
    const { samples, stopped, cut } = await runSamples({
      count: args.samples!,
      signal: signal ?? new AbortController().signal,
      stop: (n) => (n > 0 && budget !== null && total.cost + lastCost > budget ? 'spend' : null),
      runOne: async (n) => {
        requests.length = 0;
        calls.length = 0;
        // Each sample on a runner of its own, composed as the core composes it, so no sample carries into the next.
        const { wired, writes } = innerTurnRunner({
          root,
          dataDir,
          hot,
          port: discordPort,
          llm,
          embed,
          rng: innerSampleRng(args.seed, n) ?? Math.random,
          now: Date.now,
          turnId: `t-replay-inner-${n + 1}`,
          wrapReads: (found) => hiddenReads(found, hide),
          errandAnswers,
        });
        let result: Untyped;
        try {
          await wired.seed();
          result = await wired.under(() =>
            wired.runner.runTurn({
              chat,
              mode: 'inner',
              triggerKind: 'inner',
              inner: {
                wake: structuredClone(info),
                currentChannel,
                shadow: true,
                mayAct: () => false,
              },
            })
          );
        } catch (err: Untyped) {
          result = { outcome: 'error', reason: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
        } finally {
          wired.close();
        }
        const replies = requests.filter((request) => request.purpose === 'reply');
        const firstReply = replies[0] as { messages: Array<Rec> } | undefined;
        const firstMessages = firstReply?.messages;
        if (n === 0)
          firstRequest = {
            text: firstReply ? userText(firstMessages?.[1]?.content) : '',
            messages: firstMessages ?? null,
          };
        const usage = addUsage({ requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 }, calls);
        total = {
          requests: total.requests + usage.requests,
          promptTokens: total.promptTokens + usage.promptTokens,
          completionTokens: total.completionTokens + usage.completionTokens,
          cost: total.cost + usage.cost,
        };
        lastCost = usage.cost;
        if (result?.outcome === 'error') code = 1;
        const answers = calls
          .filter((call) => call.purpose === 'reply')
          .map((call) =>
            innerAnswerOf(call.text, mods.parseOutput, call.error ? (call.code ?? 'error') : null, {
              answerOf: mods.answerOf,
              toolCalls: call.toolCalls,
              finishReason: call.finishReason,
            })
          );
        const actions = result?.inner?.actions ?? [];
        const direct = await directPlaces(discordPort.iface, reads, actions, answers);
        return {
          outcome: result?.outcome ?? null,
          reason: result?.reason ?? null,
          failedSteps: answers.filter((answer) => answer.failed).length,
          ...(answers.at(-1)?.failed ? { endedInError: answers.at(-1)?.failed?.code } : {}),
          answers,
          actions,
          posted: writes.filter((write) => write.op === 'send').length,
          usage,
          facts: sampleFacts(
            {
              requests: calls.filter((call) => call.purpose === 'reply'),
              answers,
              actions,
              turn: turnEndOf(result),
            },
            { now, timezone, directOf: (place) => direct.get(place) ?? null }
          ),
        };
      },
    });
    code = cut ? 1 : code;
    const blocks: Rec = {};
    for (const tag of ['wake', 'intentions', 'errands', 'retrieved', 'task']) {
      const whole = blockOf(firstRequest?.text ?? '', tag);
      if (whole) blocks[tag] = whole;
    }
    const report = {
      kind: args.inner,
      intention: intention?.id ?? null,
      placeId: chat?.chatId ?? null,
      hidden: hide.any ? { channels: [...hide.channels], messages: [...hide.messages] } : null,
      wake: blocks.wake ?? null,
      request: {
        blocks: blockNames(firstRequest?.text ?? ''),
        ...blocks,
        ...(args.showRequest && firstRequest?.messages ? { messages: firstRequest.messages } : {}),
      },
      ...(args.seed !== null ? { seed: args.seed } : {}),
      summary: innerSummary(samples.map((sample) => sample.facts)),
      samples,
      usage: total,
      ...(stopped ? { stopped } : {}),
      ...(cut ? { cut } : {}),
    };
    const markdown = innerReportMarkdown(report);
    if (outFile !== null) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, markdown);
    }
    process.stderr.write(`${markdown}\n`);
    return { code, result: report };
  } finally {
    if (layered) {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    }
    if (client && typeof client.destroy === 'function') await Promise.resolve(client.destroy()).catch(() => {});
  }
}
