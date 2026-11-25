// The inner turn of a turn replayed by scripts/replay.ts: the wakes a stored inner turn ran for and the
// parameters the drain passed `runTurn` for them. The wake run of the turn (`wake_runs`, its id the turn's) names the
// wakes, the intentions and the facts the drain showed, and the moment it started. The wakes come from `wakes` as the
// queue reads them. The parameters are built by the drain's own steps (src/behavior/inner/drain.ts
// `prepareInnerTurn`, `innerTurnParams`) over an inner context of the replay's reads and port, with three things
// served from the copy as they stood when the turn ran: the intentions the run names as the copy stores them, open or
// not, and the facts it showed as a fact of the copy's inner state or as the feedback wake that carried it, untold.
// `copyFacts` is the facts source the core hands every turn, over the copy's inner state as it stood at the turn.

import { innerContextOf } from '../../src/behavior/inner.ts';
import { innerTurnParams, prepareInnerTurn } from '../../src/behavior/inner/drain.ts';
import { contextOf, stateOf, timezoneOf } from '../../src/behavior/inner/queue.ts';
import { innerSettings } from '../../src/behavior/inner/settings.ts';
import { addFactTo, markFactsTold, pendingFactsOf } from '../../src/behavior/inner/facts.ts';
import { wakesOfRows } from '../../src/behavior/inner/wake-queue.ts';
import type { PreparedTurn } from '../../src/behavior/inner/drain.ts';
import type { Fact, FactInput, FactsApi, InnerContext, InnerTurnParams, Wake } from '../../src/behavior/inner/types.ts';
import type { Intention } from '../../src/intentions/types.ts';
import { wakeOf } from '../../src/memory/db/wake-queue.ts';
import type { StoredWake } from '../../src/memory/db/wake-queue.ts';
import type { Db } from '../../src/memory/db/types.ts';

type Rec = Record<string, unknown>;

/** What the wake run of a stored inner turn names. */
export type StoredWakeRun = {
  turnId: string;
  /** When the drain started the turn: the moment its wake was built at. */
  at: number;
  /** The attempt of the turn's claim, from its anchor wake. */
  attempt: number;
  /** The coalesced wakes, in the drain's order. */
  group: Array<Wake>;
  /** The intentions the drain found open for the group. */
  intentionIds: Array<string>;
  /** The facts the drain showed, each as it was kept; a fact the copy no longer knows is left out. */
  facts: Array<{ id: string; fact: FactInput }>;
};

const parsed = (text: unknown): Rec => {
  try {
    const value: unknown = JSON.parse(typeof text === 'string' ? text : '{}');
    return value !== null && typeof value === 'object' ? (value as Rec) : {};
  } catch {
    // A column the writer filled with unreadable JSON names nothing.
    return {};
  }
};

const texts = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The facts `ids` as they were kept: from the copy's inner state, else from the feedback wake that was queued with
 * them (its payload's `facts` beside its `factIds`, kept at its due moment in its place).
 */
function factsOf(db: Db, ids: ReadonlyArray<string>): Array<{ id: string; fact: FactInput }> {
  const known = new Map<string, FactInput>();
  const state = db.prepare("SELECT value FROM operational WHERE kind = 'inner' AND owner = 'persona:local'").get();
  for (const one of Array.isArray(parsed(state?.value).facts) ? (parsed(state?.value).facts as Array<Rec>) : []) {
    const { id, ...fact } = one;
    // Shown again as it stood before the turn told it.
    delete fact.told;
    if (typeof id === 'string' && ids.includes(id)) known.set(id, fact as FactInput);
  }
  for (const row of db.prepare("SELECT payload FROM wakes WHERE kind = 'feedback'").all()) {
    const payload = parsed(row.payload);
    const factIds = texts(payload.factIds);
    const facts = Array.isArray(payload.facts) ? (payload.facts as Array<Rec>) : [];
    factIds.forEach((id, i) => {
      if (!ids.includes(id) || known.has(id) || facts[i] === undefined) return;
      const fact = {
        ...facts[i],
        placeId: payload.placeId ?? null,
        dmChat: payload.dmChat === true,
        at: payload.dueAt,
      };
      known.set(id, fact as FactInput);
    });
  }
  return ids.flatMap((id) => {
    const fact = known.get(id);
    return fact === undefined ? [] : [{ id, fact }];
  });
}

/**
 * The facts source the core hands the turn runner (src/core.ts `turns.setFactsSource(inner.facts)`), over the copy's
 * inner state as it stood at `now()`: a fact kept after it is left out, and one told after it is untold again. It adds,
 * shows and marks as the inner life's facts do (src/behavior/inner.ts `factsApi`) and saves nothing.
 */
export function copyFacts(db: Db, deps: { iface: string; now: () => number }): FactsApi {
  const state = db.prepare("SELECT value FROM operational WHERE kind = 'inner' AND owner = 'persona:local'").get();
  const kept = parsed(state?.value).facts;
  const at = deps.now();
  const facts = (Array.isArray(kept) ? (kept as Array<Fact>) : [])
    .filter((fact) => !(typeof fact.at === 'number' && fact.at > at))
    .map((fact) => (typeof fact.told === 'number' && fact.told > at ? { ...fact, told: false as const } : fact));
  const held = { facts };
  // Only `iface` of the inner context names a fact's chat (src/behavior/inner/queue.ts `contextOf`).
  const life = { iface: () => deps.iface } as InnerContext;
  let seq = 0;
  return {
    enabled: () => true,
    add(fact) {
      const when = typeof fact.at === 'number' ? fact.at : deps.now();
      seq += 1;
      return addFactTo(held, { ...contextOf(life, fact.placeId), ...fact, at: when }, `f${when.toString(36)}-${seq}`);
    },
    pending: (scope) => pendingFactsOf(held, { ...contextOf(life, scope?.placeId), ...scope }),
    markTold: (ids) => markFactsTold(held, ids, deps.now(), contextOf(life)),
  };
}

/** The wake run of the stored inner turn `turnId` and the wakes it names. Throws for a turn with no wake run. */
export function storedWakeRun(db: Db, turnId: string): StoredWakeRun {
  const row = db.prepare('SELECT trigger, started_at, inputs FROM wake_runs WHERE id = ?').get(turnId);
  if (!row) throw new Error(`replay-cli: ${turnId} has no wake run`);
  const inputs = parsed(row.inputs);
  const rows = texts(inputs.wakes).flatMap((id) => {
    const found = wakeOf({ db }, id);
    return found === null ? [] : [found];
  });
  const anchor = rows.find((one: StoredWake) => one.id === row.trigger) ?? rows[0];
  if (anchor === undefined) throw new Error(`replay-cli: the wake run of ${turnId} names no stored wake`);
  const intentions = Array.isArray(inputs.intentions) ? (inputs.intentions as Array<Rec>) : [];
  return {
    turnId,
    at: Date.parse(String(row.started_at)),
    attempt: anchor.attempt,
    group: wakesOfRows(rows),
    intentionIds: intentions.map((one) => one.id).filter((id): id is string => typeof id === 'string'),
    facts: factsOf(db, texts(inputs.facts)),
  };
}

/** What the inner context of a replayed turn is built over. */
export type InnerDeps = {
  hot: { readonly config: unknown };
  /** A scratch folder: the context keeps no state file in it, and its wake queue is in memory. */
  dataDir: string;
  reads: InnerContext['reads'];
  port: InnerContext['port'];
  /** The home interface, as the core names it to the inner life. */
  iface: string;
  /** The intention `id` as the copy stores it. */
  intentionOf: (id: string) => Intention | null;
  uuid: () => string;
  now: () => number;
};

/**
 * The parameters the drain passed `runTurn` for the stored run, and the hold a live turn's posts wait in. Throws when
 * the drain would drop the wakes, which a turn that ran never was.
 */
export async function innerParamsOf(
  run: StoredWakeRun,
  deps: InnerDeps
): Promise<{ params: InnerTurnParams; hold: PreparedTurn['hold'] }> {
  const life = innerContextOf({
    hot: deps.hot,
    dataDir: deps.dataDir,
    turns: { runTurn: () => Promise.reject(new Error('replay-cli: the replay runs the turn itself')) },
    reads: deps.reads,
    iface: () => deps.iface,
    port: deps.port,
    uuid: deps.uuid,
    now: deps.now,
  });
  const state = stateOf(life);
  for (const { id, fact } of run.facts) addFactTo(state, { ...contextOf(life, fact.placeId), ...fact }, id);
  const prepared = await prepareInnerTurn(life, run.group, {
    settings: innerSettings(deps.hot.config),
    at: run.at,
    timezone: timezoneOf(life),
    openOf: (id) => (run.intentionIds.includes(id) ? deps.intentionOf(id) : null),
  });
  if ('drop' in prepared) throw new Error(`replay-cli: the drain drops the wakes of ${run.turnId} (${prepared.why})`);
  return {
    params: innerTurnParams(life, prepared, { turnId: run.turnId, attemptId: run.attempt }),
    hold: prepared.hold,
  };
}
