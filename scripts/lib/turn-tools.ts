// The gate of the tools a turn replayed by scripts/replay.ts calls. A tool whose effect class is `read`
// (src/tools/definitions.ts#effectsOf) runs for real through the operation runner it is given. Every other tool, an
// unknown one included, is kept in `calls` and answered with a plain success, so the turn goes on as if it had worked
// and nothing in the world changes. A tool named in `runs` runs too: the errand tools of a replay whose errand service
// answers from a file and starts nothing (scripts/lib/errand-answers.ts). A tool `archived` answers is kept and gets
// that answer: the web tools and the look at a picture, which reach the network, answered with what the live turn
// read (scripts/lib/turn-archive.ts `archivedToolResults`). `log` holds every call the gate answered, run or kept, with its
// result. `gatedOps` wraps the three runners a turn takes (`runOp`, `runOwnOp`,
// `runInitiativeOp`). `gatedPersonLinks` stands in for the person link tool, which writes, and so never runs.

import { effectsOf } from '../../src/tools/definitions.ts';
import type { LinkAsk, LinkStart, PersonLinks } from '../../src/interface/person-link.ts';

/** A call of the turn that did not run. */
export type KeptCall = { op: string; args: unknown; at: number };

type RunOperation = (op: unknown, args: unknown, context: unknown) => unknown;

/** A call the gate answered, in the order it came: whether it ran or was kept, and the result it gave. */
export type GatewayCall = { op: string; args: unknown; ran: boolean; result: unknown };

/** The answer of a kept call. */
const PLAIN_SUCCESS = Object.freeze({ status: 'ok' as const, data: { text: '' } });

/** The three runners with every tool but a read and those of `runs` kept in `calls`. */
export function gatedOps({
  runOp,
  runOwnOp,
  runInitiativeOp,
  now,
  runs = [],
  archived = () => null,
}: {
  runOp: RunOperation;
  runOwnOp: RunOperation;
  runInitiativeOp: RunOperation;
  now: () => number;
  runs?: ReadonlyArray<string>;
  /** The answer the live turn read for the next call of `op`, null for a tool it does not answer. */
  archived?: (op: string) => unknown;
}): {
  runOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  runOwnOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  runInitiativeOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  calls: Array<KeptCall>;
  log: Array<GatewayCall>;
} {
  const calls: Array<KeptCall> = [];
  const log: Array<GatewayCall> = [];
  const kept = (op: string, args: unknown, result: unknown): Promise<unknown> => {
    calls.push({ op, args, at: now() });
    log.push({ op, args, ran: false, result });
    return Promise.resolve(result);
  };
  const gated =
    (run: RunOperation) =>
    (op: unknown, args: unknown, context: unknown): Promise<unknown> => {
      const name = String(op);
      const answer = archived(name);
      if (answer !== null) return kept(name, args, answer);
      if (effectsOf(name) === 'read' || runs.includes(name)) {
        const entry: GatewayCall = { op: name, args, ran: true, result: null };
        log.push(entry);
        return Promise.resolve(run(op, args, context)).then((result) => {
          entry.result = result;
          return result;
        });
      }
      return kept(name, args, { ...PLAIN_SUCCESS });
    };
  return { runOp: gated(runOp), runOwnOp: gated(runOwnOp), runInitiativeOp: gated(runInitiativeOp), calls, log };
}

/** The person link tool of a replay: every link the persona asks for kept in `calls`. */
export function gatedPersonLinks(calls: Array<KeptCall>, now: () => number): Pick<PersonLinks, 'start'> {
  return {
    start(ask: LinkAsk): Promise<LinkStart> {
      calls.push({ op: 'person.link', args: ask, at: now() });
      return Promise.resolve({ status: 'ok', data: { text: '' } });
    },
  };
}
