// `--skills <file>`: a JSON array of scenarios (scripts/fixtures/skill-scenarios.example.json shows the shape;
// parseScenarios in scripts/lib/replay-scenarios.ts checks it), each `{ id, placeId, before?, author, text, grants,
// runs? }`, or `steps` or `taskResult` for `author` and `text`. Each scenario is put to the persona on the engine's own
// turn runner (scripts/lib/replay-turn.ts) after its channel's real chat: the channel's lines up to and including the
// message `before` names (omitted: the newest ones), read over Discord's REST API, then `text` as a new message by
// the member `author`, one minute after that message (now, without `before`), calling the persona by a tag. The channel's
// history reads of the turn answer from those lines, so the turn reads the scenario's message as the newest one. The
// persona's grants are exactly `grants` in a copy of the config (personaGrantsConfig: skill names, groups and `*`
// expanded as `/tools grant` expands them for the persona), and `--core-tools` turns `features.coreTools` on in that copy.
// The turn runs as a live one does, its classifiers, its blocks and its tool loop included: the persona's read tools run on the
// data folder, read only, and every other call is kept and answered as done (scripts/lib/turn-tools.ts). Each scenario
// runs `runs` times (1..10, default 1), each run on a runner of its own.
//
// A multi-step scenario has `steps` (each `{ author?, text?, gapMinutes?, burst?, self? }`): each run replays every
// step from the start. A step's message, then its `burst` (more messages, each by its own author, 5 s apart), joins
// the channel `gapMinutes` (default 1) after the newest line so far. The step's own message tags the persona; a burst's message
// calls them only as its text does. The step is played as the live queue plays it (scripts/lib/replay-steps.ts
// burstTurns): the first message starts their turn, every call after it waits for its own turn in arrival order, the
// plain follow-ups share the channel's one follow-up slot, and each turn names the calls still waiting after it
// (`queued`, as the live drain passes them). What the persona sent and the reactions they put in the channel join it for the
// next turn and step (carriedLines). A line of the persona is seeded with a step `{ self: "<text>" }` or a burst item
// `{ self: true, text }` (seededSelfLine): it joins the channel as their line, and no turn is run for it.
// A task-result scenario has `taskResult` (`{ agent, goal, state, text?, files?, asker }`): one of the persona's errands ended
// `done` or `failed`, and the turn its end opens runs as src/errands/turns.ts opens it, an interjection of trigger kind
// `errand` in the scenario's channel carrying the errand, the asker its requester.
//
// `--out` (default ./replay-skills-<time>/, refused under data/ and when it exists and is not empty) gets `runs.jsonl`,
// one line per turn (scripts/lib/replay-records.ts: the scenario, run, step and turn, the decision, the calls by name and
// status, the persona's messages and the turn's report as the stored-turn mode writes one), and `report.md`. stdout gets each
// scenario's summary. `--spend` also stops the runs once what the provider reports spent reaches it. `--dry` sends no
// request: each scenario's first turn runs up to its first request of purpose `reply`, every request before it answered
// with nothing, and its sizes are printed. `--prompts <dir>` answers every scenario with `<dir>` laid over the data
// folder's prompts. THE FILES HOLD MESSAGE CONTENTS: the server's eyes only.

import fs from 'node:fs';
import path from 'node:path';
import { lineOf as lineOfEvent } from '../../src/behavior/line-of.ts';
import { estimateMessages } from '../../src/llm/tokens.ts';
import type { Reads } from '../../src/interface/reads.ts';
import { expandPersonaGrant } from '../../src/tools/operations/access.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import { cappedLlm } from './replay-llm.ts';
import { scenarioSummary, turnRecord } from './replay-records.ts';
import type { TurnRecord } from './replay-records.ts';
import { renderSkillsReport } from './replay-report.ts';
import {
  BURST_SPACING_MS,
  SCENARIO_AFTER_MS,
  personaGrantsConfig,
  scenarioGrants,
  scenarioTask,
  scenarioTrigger,
  withCoreTools,
} from './replay-scenarios.ts';
import { burstTurns, carriedLines, replyParams, seededSelfLine } from './replay-steps.ts';
import type { QueuedCall } from './replay-steps.ts';
import { replayTurn, reportOf } from './replay-turn.ts';
import type { ReplayTurnRun } from './replay-turn.ts';
import type { Rec, Scenario } from './replay-types.ts';

/** The newest moment among `lines` (ms), or `fallback` when none has one. */
function newestTs(lines: Untyped, fallback: Untyped) {
  const times = lines.map((line: Untyped) => line?.ts).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : fallback;
}

/**
 * The lines one step adds to the channel (`transcript`, the channel before it), in arrival
 * order: the first `gapMinutes` after the newest line so far (the first step's at `firstAt`),
 * the next ones BURST_SPACING_MS apart. A member's message is `lineOf(message, at, { tagged })`
 * (tagging the persona when it is the step's own, `own`), a seeded line of theirs `seedLine(message, at)`.
 * `callers` the members' lines (those that may get a turn), `seeded` the persona's. Pure.
 */
function stepLines({ step, index, transcript, firstAt, lineOf, seedLine }: Rec) {
  const start = index === 0 ? firstAt : newestTs(transcript, firstAt) + step.gapMinutes * 60_000;
  const incoming = step.messages.map((message: Untyped, i: number) => {
    const at = start + i * BURST_SPACING_MS;
    if (message.self !== true) return lineOf(message, at, { tagged: step.own !== false && i === 0 });
    if (typeof seedLine !== 'function') throw new CliError("replay-cli: a seeded line of the persona's needs seedLine");
    return seedLine(message, at);
  });
  const messages = step.messages as Array<Rec>;
  const seeded = incoming.filter((_: Untyped, i: number) => messages[i].self === true);
  return { incoming, callers: incoming.filter((line: Untyped) => !seeded.includes(line)), seeded };
}

/**
 * The first decision of a multi-step scenario, as playSteps reaches it: the channel (`lines`:
 * `history`, then every step up to and including the first that runs the persona's turn -- the steps
 * before it only seed lines of theirs, stepLines) and that step's first turn (`turn`, planBurst's).
 * What `--dry` builds and the memory is read at. Pure apart from what the callbacks do.
 */
export function firstDecision({
  scenario,
  history,
  firstAt,
  lineOf,
  seedLine,
  planBurst,
}: {
  scenario: { steps: Array<Rec> };
  history: Array<Rec>;
  firstAt: number;
  lineOf: (...args: Array<Untyped>) => Untyped;
  seedLine?: (...args: Array<Untyped>) => Untyped;
  planBurst: (...args: Array<Untyped>) => Untyped;
}): { lines: Array<Rec>; turn: { line: Rec; kind: string; queued: Array<QueuedCall> } } {
  let transcript = [...history];
  for (const [index, step] of scenario.steps.entries()) {
    const { incoming, callers, seeded } = stepLines({ step, index, transcript, firstAt, lineOf, seedLine });
    if (callers.length > 0) {
      const plan = planBurst(callers, { history: [...transcript, ...seeded] });
      return { lines: [...transcript, ...incoming], turn: plan.turns[0] };
    }
    transcript = [...transcript, ...incoming];
  }
  throw new CliError("replay-cli: the scenario has no step that runs the persona's turn");
}

/**
 * One run of a multi-step scenario, every step from the start: before each step its messages join the channel
 * (`lineOf(message, at, { tagged })`, the step's own message tagging the persona, a burst's message by its text alone), the first
 * `gapMinutes` after the newest line so far (the first step's at `firstAt`), the next ones BURST_SPACING_MS apart
 * (stepLines). A seeded line of the persona joins as `seedLine(message, at)` and runs no turn. `planBurst(incoming, { history })`
 * says which of the members' messages get a turn, in the order the live queue answers them, and which a newer follow-up
 * `replaced` or the queue's cap `dropped`. Each turn is one decision: `answerStep({ lines, trigger, kind, at, queued })`
 * runs the persona's turn over the channel so far at its newest moment and resolves the run, or null when the run was stopped.
 * Its record (`step`, and for a step of several members' messages `turn` and `queue`) goes to `onRecord`, and
 * `afterTurn({ lines, run, at })` gives the channel the next turn reads.
 */
export async function playSteps({
  scenario,
  history,
  firstAt,
  runIndex,
  lineOf,
  seedLine,
  planBurst,
  answerStep,
  afterTurn,
  onRecord,
}: {
  scenario: Pick<Scenario, 'id'> & { steps: Array<Rec> };
  history: Array<Rec>;
  firstAt: number;
  runIndex: number;
  lineOf: (...args: Array<Untyped>) => Untyped;
  seedLine?: (...args: Array<Untyped>) => Untyped;
  planBurst: (...args: Array<Untyped>) => Untyped;
  answerStep: (turn: {
    lines: Array<Rec>;
    trigger: Rec;
    kind: string;
    at: number;
    queued: Array<QueuedCall>;
  }) => Promise<ReplayTurnRun | null>;
  afterTurn: (turn: { lines: Array<Rec>; run: ReplayTurnRun; at: number }) => Array<Rec>;
  onRecord: (record: TurnRecord) => void;
}): Promise<{ stopped: boolean }> {
  let transcript = [...history];
  for (const [index, step] of scenario.steps.entries()) {
    const { incoming, callers, seeded } = stepLines({ step, index, transcript, firstAt, lineOf, seedLine });
    const plan =
      callers.length > 0
        ? planBurst(callers, { history: [...transcript, ...seeded] })
        : { turns: [], replaced: [], dropped: [] };
    const byId = new Map<Untyped, Untyped>(callers.map((line: Untyped) => [line.id, line]));
    const about = (id: string) => ({ id, author: byId.get(id)?.authorId ?? null, text: byId.get(id)?.content ?? '' });
    let lines = [...transcript, ...incoming];
    for (const [turnIndex, turn] of plan.turns.entries()) {
      const at = newestTs(lines, turn.line.ts);
      const run = await answerStep({ lines, trigger: turn.line, kind: turn.kind, at, queued: turn.queued });
      if (run === null) return { stopped: true };
      const turnId = `t-replay-skill-${runIndex + 1}-${index + 1}-${turnIndex + 1}`;
      const queue =
        callers.length > 1
          ? {
              turns: plan.turns.length,
              kind: turn.kind,
              trigger: about(turn.line.id),
              queued: turn.queued.length,
              replaced: plan.replaced.map(({ id, by }: Rec) => ({ ...about(id), by })),
              dropped: plan.dropped.map(({ id, reason }: Rec) => ({ ...about(id), reason })),
            }
          : null;
      const ids = {
        scenario: scenario.id,
        run: runIndex,
        step: index + 1,
        ...(queue ? { turn: turnIndex + 1, queue } : {}),
      };
      onRecord(turnRecord(ids, reportOf(run, turnId, runIndex + 1)));
      lines = afterTurn({ lines, run, at });
    }
    transcript = lines;
  }
  return { stopped: false };
}

/** What the `--skills` mode is handed (scripts/lib/replay-main.ts). */
type SkillsKit = {
  args: { dry: boolean; outDir: string | null; prompts: string | null; coreTools: boolean };
  root: string;
  liveData: string;
  dataDir: string;
  hot: { config: Untyped };
  port: unknown;
  reads: Reads;
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  connection: { guild: Untyped; self: { id: string; name: string } };
  scenarios: Array<Scenario>;
  signal?: AbortSignal;
  budget: number | null;
};

/** The lines of a scenario's channel up to and including `before` (the newest ones without it), as its turns read them. */
async function channelLines(reads: Reads, chat: { iface: string; chatId: string }, before: string | null) {
  const page = await reads.history(chat, { limit: 100, ...(before ? { before: String(BigInt(before) + 1n) } : {}) });
  if (page === null) throw new CliError('replay-cli: that channel cannot be read');
  const lines = page.events.map((event) => lineOfEvent(event)).sort((a, b) => Number(a.ts) - Number(b.ts));
  if (before && lines.at(-1)?.id !== before)
    throw new CliError('replay-cli: the anchor message was not found in that channel');
  return lines;
}

/** A display name of a member: their name on the server, else the id. */
async function memberName(guild: Untyped, id: string): Promise<string> {
  try {
    const member = await guild.members.fetch(id);
    return String(member?.displayName ?? id);
  } catch {
    // A member who left: the id names them.
    return id;
  }
}

/** What a scenario's turns are put on: its channel's lines, its moment, the builders of its lines and its turn. */
async function stageOf(kit: SkillsKit, scenario: Scenario, grantNames: Array<string>, llm: SkillsKit['llm']) {
  const self = kit.connection.self;
  const chat = { iface: 'discord', chatId: scenario.placeId };
  const authors = scenario.steps
    ? [...new Set(scenario.steps.flatMap((step) => step.messages.flatMap((m) => ('author' in m ? [m.author] : []))))]
    : [scenario.taskResult ? scenario.taskResult.asker : String(scenario.author)];
  if (authors.includes(self.id))
    throw new CliError(`replay-cli: the ${scenario.taskResult ? 'asker' : 'author'} is the persona`);
  const history = await channelLines(kit.reads, chat, scenario.before);
  if (scenario.taskResult && history.length === 0)
    throw new CliError("replay-cli: the channel has no message to put the errand's end after");
  const names = new Map<string, string>();
  for (const id of authors) names.set(id, await memberName(kit.connection.guild, id));
  const last = history.at(-1) ?? null;
  const [firstStep] = scenario.steps ?? [];
  const firstGapMs = firstStep ? firstStep.gapMinutes * 60_000 : SCENARIO_AFTER_MS;
  const at = scenario.before && last ? Number(last.ts) + firstGapMs : Date.now();
  const named = (value: unknown) => (typeof value === 'string' ? value : null);
  const channel = { id: scenario.placeId, name: named(last?.channelName), topic: named(last?.channelTopic) };
  const lineOf = (message: Untyped, ts: number, { tagged = true }: Rec = {}) =>
    scenarioTrigger({
      text: message.text,
      authorId: message.author,
      authorName: names.get(message.author) ?? message.author,
      channel,
      selfId: self.id,
      at: ts,
      tagged,
    });
  const seedLine = (message: Untyped, ts: number) =>
    seededSelfLine({ text: message.text, at: ts, selfId: self.id, selfName: self.name, channel });
  // The config with the persona's grants, read now and kept for the scenario, never written; --core-tools sets it.
  const config = personaGrantsConfig(
    kit.args.coreTools ? withCoreTools(kit.hot.config) : kit.hot.config,
    self.id,
    grantNames
  );
  const hot = new Proxy(kit.hot, { get: (target, prop) => (prop === 'config' ? config : Reflect.get(target, prop)) });
  const planBurst = (incoming: Rec, { history: before }: Rec) =>
    burstTurns(incoming as Array<Untyped>, { selfId: self.id, config, history: before });
  const task = scenario.taskResult ? scenarioTask(scenario as Parameters<typeof scenarioTask>[0], { at }) : null;
  // A request a run that sends nothing makes before the one it keeps is answered with nothing.
  const silent = { complete: () => Promise.resolve({ text: '', toolCalls: [] }) };
  const turn = (lines: Array<Rec>, when: number, params: Rec, turnId: string, stopAt: string | null) =>
    replayTurn({
      root: kit.root,
      dataDir: kit.dataDir,
      hot,
      port: kit.port,
      llm: stopAt === null ? llm : silent,
      embed: kit.embed,
      rng: Math.random,
      turnId,
      at: when,
      served: new Map([[scenario.placeId, lines]]),
      params: () => Promise.resolve({ chat, ...params }),
      stopAt,
    });
  // The parameters of the turn an errand's end opens (src/errands/turns.ts), its asker the requester.
  const errandParams = {
    mode: 'interject',
    trigger: null,
    triggerKind: 'errand',
    taskResult: task,
    requester: { id: scenario.taskResult?.asker },
  };
  return { history, at, lineOf, seedLine, planBurst, task, turn, replyParams, errandParams, channel, self };
}

type Stage = Awaited<ReturnType<typeof stageOf>>;

/** The sizes of a scenario's first request, its turn run up to that request (`--dry`). */
async function dryEntry(scenario: Scenario, stage: Stage): Promise<Rec> {
  const { history, at, task } = stage;
  const first = scenario.steps
    ? firstDecision({
        scenario: scenario as { steps: Array<Rec> },
        history,
        firstAt: at,
        lineOf: stage.lineOf,
        seedLine: stage.seedLine,
        planBurst: stage.planBurst,
      })
    : null;
  const lines = first?.lines ?? (task ? history : [...history, stage.lineOf(scenario, at)]);
  const trigger = (first?.turn.line ?? lines.at(-1)) as Rec;
  const params = task
    ? stage.errandParams
    : stage.replyParams(trigger, first?.turn.kind ?? 'mention', first?.turn.queued ?? []);
  const run = await stage.turn(lines, task ? at : Number(trigger.ts), params, 't-replay-skill-dry', 'reply');
  const request = run.requests.find((one) => one.purpose === 'reply');
  const files: ReadonlyArray<unknown> = task ? (task.result.files as Array<unknown>) : [];
  return {
    id: scenario.id,
    placeId: scenario.placeId,
    lines: history.length,
    requestTokens: request ? estimateMessages(request.messages) : null,
    tools: request?.tools.length ?? 0,
    runs: scenario.runs,
    ...(scenario.steps ? { steps: scenario.steps.length } : {}),
    ...(task ? { taskResult: { id: task.id, files: files.length } } : {}),
  };
}

/** Every run of a scenario, each turn's record handed to `keep`; false once the stop signal ended the runs. */
async function scenarioRuns(
  scenario: Scenario,
  stage: Stage,
  { keep, stopped }: { keep: (record: TurnRecord) => void; stopped: AbortSignal }
): Promise<boolean> {
  const { history, at, task, self, channel } = stage;
  for (let runIndex = 0; runIndex < scenario.runs; runIndex += 1) {
    if (stopped.aborted) return false;
    if (scenario.steps) {
      const played = await playSteps({
        scenario: scenario as Pick<Scenario, 'id'> & { steps: Array<Rec> },
        history,
        firstAt: at,
        runIndex,
        lineOf: stage.lineOf,
        seedLine: stage.seedLine,
        planBurst: stage.planBurst,
        answerStep: ({ lines, trigger, kind, at: when, queued }) =>
          stopped.aborted
            ? Promise.resolve(null)
            : stage.turn(lines, when, stage.replyParams(trigger, kind, queued), `t-replay-skill-${runIndex + 1}`, null),
        afterTurn: ({ lines, run, at: when }) =>
          carriedLines({ lines, writes: run.writes, at: when, channel, selfId: self.id, selfName: self.name }),
        onRecord: keep,
      });
      if (played.stopped) return false;
      continue;
    }
    const lines = task ? history : [...history, stage.lineOf(scenario, at)];
    const params = task ? stage.errandParams : stage.replyParams(lines.at(-1) as Rec, 'mention', []);
    const turnId = `t-replay-skill-${runIndex + 1}`;
    const run = await stage.turn(lines, at, params, turnId, null);
    keep(turnRecord({ scenario: scenario.id, run: runIndex }, reportOf(run, turnId, runIndex + 1)));
  }
  return true;
}

/** The output folder of a `--skills` run, made empty: refused under data/ and when it holds files. */
function outFolder(root: string, liveData: string, asked: string | null): string {
  const outDir = path.resolve(root, asked ?? `replay-skills-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
    throw new CliError('replay-cli: --out may not be under data/');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
    throw new CliError(`replay-cli: ${outDir} is not empty`);
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

/**
 * The `--skills` mode (see the head of this file): every scenario put to the persona on the turn runner, nothing posted
 * or written but the output files. Returns `{ code, result }`: code 1 when a scenario failed or the runs were stopped.
 */
export async function runSkills(kit: SkillsKit): Promise<{ code: number; result: Rec }> {
  const { args, scenarios, root } = kit;
  // Every grant is checked before anything is fetched or sent.
  const plans = scenarios.map((scenario) => ({ scenario, grantNames: scenarioGrants(scenario, expandPersonaGrant) }));
  const outDir = args.dry ? null : outFolder(root, kit.liveData, args.outDir);
  const jsonl = outDir === null ? null : path.join(outDir, 'runs.jsonl');
  if (jsonl) fs.writeFileSync(jsonl, '');
  const capped = cappedLlm(kit.llm, kit.budget, kit.signal);
  const entries: Array<{ id: string; summary: Rec | null; records: Array<TurnRecord>; error?: string }> = [];
  const dry: Array<Rec> = [];
  let cut = false;
  for (const { scenario, grantNames } of plans) {
    if (capped.stopped.aborted) break;
    const records: Array<TurnRecord> = [];
    const keep = (record: TurnRecord) => {
      records.push(record);
      if (jsonl) fs.appendFileSync(jsonl, `${JSON.stringify(record)}\n`);
    };
    try {
      const stage = await stageOf(kit, scenario, grantNames, capped.llm);
      if (args.dry) {
        dry.push(await dryEntry(scenario, stage));
        continue;
      }
      if (!(await scenarioRuns(scenario, stage, { keep, stopped: capped.stopped }))) cut = true;
      const summary = scenarioSummary(records, { steps: scenario.steps ? scenario.steps.length : null });
      entries.push({ id: scenario.id, records, summary });
    } catch (err) {
      const error = err instanceof CliError ? err.message : String((err as Error)?.name ?? 'Error');
      if (args.dry) dry.push({ id: scenario.id, error });
      else entries.push({ id: scenario.id, records, summary: null, error });
    }
  }
  if (entries.length + dry.length < plans.length) cut = true;
  const stoppedBy = !cut ? null : kit.signal?.aborted ? 'signal' : 'spend';
  if (args.dry || outDir === null)
    return { code: dry.some((d) => d.error) ? 1 : 0, result: { dry: true, scenarios: dry } };
  const report = path.join(outDir, 'report.md');
  fs.writeFileSync(report, renderSkillsReport(entries));
  const failed = entries.filter((e) => e.error).map((e) => ({ id: e.id, error: e.error }));
  return {
    code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
    result: {
      out: outDir,
      runs: jsonl,
      report,
      ...(args.prompts !== null ? { prompts: path.resolve(root, args.prompts) } : {}),
      scenarios: entries.filter((e) => !e.error).map((e) => ({ id: e.id, ...e.summary })),
      failed,
      stoppedBy,
      spentUsd: capped.spent(),
    },
  };
}
