// One stored turn run again by the engine's own turn code over a copy of a data folder: what the stored-turn mode of
// scripts/replay.ts (scripts/lib/replay-stored.ts) and scripts/harness.ts share. `runStoredTurn` reads the turn's
// `turn.start` row, builds the port over the copy's stored lines (scripts/lib/turn-stage.ts) and the runner as the core
// composes it (scripts/lib/turn-wiring.ts), passes it the parameters the pipeline, the drain or the diary service
// passed (a reply turn's trigger line, an inner turn's wake run, a diary turn's kind) and returns what the run kept.
// `hotOf` builds the copy's settings and prompts, and `archiveOfCopy` the model client that answers from the copy's
// archive (scripts/lib/turn-archive.ts).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHot } from '../../src/hot.ts';
import type { Hot } from '../../src/hot.ts';
import { deepMerge } from '../../src/config.ts';
import { archiveAnswers, archivedToolResults, counterIds } from './turn-archive.ts';
import { seededRng } from './diary-day.ts';
import { overlayPromptsHot } from './prompt-layers.ts';
import { diaryParamsOf, stageOf, storedTurn, triggerOf, turnParamsOf } from './turn-stage.ts';
import { buildTurnRunner, homeIdentity, identityIn, offlineFetch, randomUUID, scratchDir } from './turn-wiring.ts';
import { innerParamsOf, storedWakeRun } from './turn-inner.ts';
import { recordingLlm } from './turn-report.ts';
import type { KeptRequest } from './turn-report.ts';
import type { RecordedWrite } from './turn-port.ts';
import type { GatewayCall, KeptCall } from './turn-tools.ts';
import type { KeptJournal } from './turn-wiring.ts';

type Rec = Record<string, unknown>;

const idOf = (trigger: unknown): string | null => {
  const id = (trigger as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : null;
};

/** The archived answers of the stored turn `turnId` (a whole id or a prefix) in the copy's memory. */
export function archiveOfCopy(dataDir: string, turnId: string): ReturnType<typeof archiveAnswers> {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'), { readOnly: true });
  try {
    return archiveAnswers(db, storedTurn(db, turnId).turnId);
  } finally {
    db.close();
  }
}

/** The settings and prompts of the copy, with `--prompts` laid over its prompts as every replay mode lays them. */
export function hotOf(root: string, dataDir: string, promptsDir: string | null): { hot: Hot; close: () => void } {
  if (promptsDir === null) {
    const hot = createHot({ rootDir: root, privateDir: dataDir });
    return { hot, close: () => hot.close() };
  }
  // The copy's prompts under `promptsDir`, laid as every replay mode lays a prompt directory.
  const layered = overlayPromptsHot(createHot, root, path.resolve(promptsDir), {
    mergeJson: deepMerge,
    env: { NEPTUNIA_DATA_DIR: dataDir },
  });
  return {
    hot: layered.hot,
    close: () => {
      layered.hot.close();
      fs.rmSync(layered.dir, { recursive: true, force: true });
    },
  };
}

/** The parameters of a reply turn: its trigger line read off the port, as the pipeline passes them. */
async function replyParams(
  stage: ReturnType<typeof stageOf>,
  turn: ReturnType<typeof storedTurn>,
  db: DatabaseSync,
  wired: ReturnType<typeof buildTurnRunner>
): Promise<Record<string, unknown>> {
  const trigger = await triggerOf(stage, turn, db);
  const internal = turn.iface === 'cli' ? wired.memoryContext({ kind: 'internal' }) : null;
  return turnParamsOf(turn, stage, trigger, internal);
}

/** The parameters of an inner turn as the drain passed them, and the hold a live turn's posts wait in. */
function innerParams(
  stage: ReturnType<typeof stageOf>,
  turn: ReturnType<typeof storedTurn>,
  db: DatabaseSync,
  wired: ReturnType<typeof buildTurnRunner>,
  life: { hot: Hot; iface: string; dataDir: string; uuid: () => string; now: () => number }
) {
  return innerParamsOf(storedWakeRun(db, turn.turnId), {
    ...life,
    reads: wired.reads,
    port: stage.port,
    intentionOf: (id) => wired.intentions.store()?.get(id) ?? null,
  });
}

/** What one run of a stored turn kept. */
export type StoredTurnRun = {
  turn: ReturnType<typeof storedTurn>;
  result: Rec;
  /** The posts a live inner turn left waiting for its wake's completion; null for any other turn. */
  held: ReadonlyArray<unknown> | null;
  requests: Array<KeptRequest>;
  writes: Array<RecordedWrite>;
  calls: Array<KeptCall>;
  carried: Array<unknown>;
  journal: KeptJournal['lines'];
  gateway: Array<GatewayCall>;
  /** The line a reply turn answers; null for a turn that answers none. */
  triggerId: string | null;
  tmpDir: string;
};

/**
 * One run of the stored turn: its requests, its writes, its kept calls, every call its tool gateway answered, the
 * turn's result and the scratch folder it ran in (removed when it returns).
 */
export async function runStoredTurn(options: {
  /** The checkout whose engine runs the turn. */
  root: string;
  /** The name stderr lines start with. */
  tool: string;
  dataDir: string;
  turnId: string;
  hot: Hot;
  llm: { complete: (messages: unknown, options?: unknown) => Promise<unknown> };
  embed: (texts: Array<string>, options?: unknown) => Promise<Array<ArrayLike<number> | null>>;
  stopAt: string | null;
  calibration: number | null;
  kind: string | null;
  seed: string | null;
  /** Whether the answers come from the archive, and with them the network tools' results. */
  archive: boolean;
}): Promise<StoredTurnRun> {
  const db = new DatabaseSync(path.join(options.dataDir, 'memory.db'), { readOnly: true });
  const tmpDir = scratchDir('nep-replay-turn-');
  try {
    const stored = storedTurn(db, options.turnId);
    const now = () => stored.at;
    // One counter for every id of the run, the stage's and the runner's.
    const seeded =
      options.seed === null
        ? null
        : { newId: counterIds(), wall: now, rng: seededRng(options.seed, `turn:${stored.turnId}`) };
    // The adapter of the turn's interface knows the persona by their account there, and the core by their account on the home one.
    const home = homeIdentity(db, options.dataDir);
    // A turn in no place, a diary turn, runs on the home interface as the core's diary service runs it.
    const turn = stored.placeId === null ? { ...stored, iface: home.iface } : stored;
    const diary = stored.mode === 'diary' || options.kind !== null ? diaryParamsOf(stored, options.kind) : null;
    const self = { selfId: home.selfId, selfName: home.selfName };
    const said =
      home.from === 'clients.json'
        ? 'the first interface of clients.json'
        : "no clients.json, the persona's first account off the command line";
    process.stderr.write(`${options.tool}: identity: ${home.iface} (${said})\n`);
    const stage = stageOf({
      db,
      dataDir: options.dataDir,
      turn,
      selfId: identityIn(db, turn.iface).selfId,
      now,
      tmpDir,
      ...(seeded === null ? {} : { newId: seeded.newId, wall: seeded.wall }),
    });
    const { prompts } = options.hot;
    const labels: unknown = prompts.labels;
    const words = (labels as { tools?: { result?: Record<string, unknown> } }).tools?.result ?? {};
    const offline = options.archive
      ? { fetchImpl: offlineFetch, archived: archivedToolResults(db, stored.turnId, words) }
      : {};
    const recorded = recordingLlm(options.llm, { stopAt: options.stopAt, ...(seeded ? { wall: seeded.wall } : {}) });
    const wired = buildTurnRunner({
      root: options.root,
      dataDir: options.dataDir,
      hot: options.hot,
      turnId: turn.turnId,
      now,
      identity: { iface: turn.iface, ...self, rootNative: stage.rootNative },
      rootPlace: stage.rootPlace,
      port: stage.port,
      llm: recorded.llm,
      embed: options.embed,
      ...offline,
      ...(seeded === null ? {} : { rng: seeded.rng, newId: seeded.newId }),
      ...(options.calibration === null ? {} : { calibration: options.calibration }),
    });
    try {
      await wired.seed();
      const inner =
        diary === null && stored.mode === 'inner'
          ? await innerParams(stage, turn, db, wired, {
              hot: options.hot,
              iface: home.iface,
              dataDir: tmpDir,
              uuid: seeded?.newId ?? randomUUID,
              now,
            })
          : null;
      const params = diary ?? inner?.params ?? (await replyParams(stage, turn, db, wired));
      const result = (await wired.under(() => wired.runner.runTurn(params))) as Rec;
      return {
        turn,
        result,
        held: inner?.hold?.sends ?? null,
        requests: recorded.requests,
        writes: stage.writes,
        calls: wired.calls,
        carried: wired.carried,
        journal: wired.journal.lines,
        gateway: wired.gateway,
        // The line a reply turn answers, which a command line turn's `command.result` names.
        triggerId: diary === null && inner === null ? idOf((params as { trigger?: unknown }).trigger) : null,
        tmpDir,
      };
    } finally {
      wired.close();
      stage.close();
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
