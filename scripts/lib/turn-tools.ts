// The gate of the tools a turn replayed by scripts/turn-replay.ts calls. A tool whose effect class is `read`
// (src/tools/definitions.ts#effectsOf) runs for real through the operation runner it is given. Every other tool, an
// unknown one included, is kept in `calls` and answered with a plain success, so the turn goes on as if it had worked
// and nothing in the world changes. `gatedOps` wraps the three runners a turn takes (`runOp`, `runOwnOp`,
// `runInitiativeOp`). `gatedPersonLinks` stands in for the person link tool, which writes, and so never runs.

import { effectsOf } from '../../src/tools/definitions.ts';
import type { LinkAsk, LinkStart, PersonLinks } from '../../src/interface/person-link.ts';

/** A call of the turn that did not run. */
export type KeptCall = { op: string; args: unknown; at: number };

type RunOperation = (op: unknown, args: unknown, context: unknown) => unknown;

/** The answer of a kept call. */
const PLAIN_SUCCESS = Object.freeze({ status: 'ok' as const, data: { text: '' } });

/** The three runners with every tool but a read kept in `calls`. */
export function gatedOps({
  runOp,
  runOwnOp,
  runInitiativeOp,
  now,
}: {
  runOp: RunOperation;
  runOwnOp: RunOperation;
  runInitiativeOp: RunOperation;
  now: () => number;
}): {
  runOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  runOwnOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  runInitiativeOp: (op: unknown, args: unknown, context: unknown) => Promise<unknown>;
  calls: Array<KeptCall>;
} {
  const calls: Array<KeptCall> = [];
  const gated =
    (run: RunOperation) =>
    (op: unknown, args: unknown, context: unknown): Promise<unknown> => {
      const name = String(op);
      if (effectsOf(name) === 'read') return Promise.resolve(run(op, args, context));
      calls.push({ op: name, args, at: now() });
      return Promise.resolve({ ...PLAIN_SUCCESS });
    };
  return { runOp: gated(runOp), runOwnOp: gated(runOwnOp), runInitiativeOp: gated(runInitiativeOp), calls };
}

/** The person link tool of a replay: every link she asks for kept in `calls`, none withheld. */
export function gatedPersonLinks(calls: Array<KeptCall>, now: () => number): Pick<PersonLinks, 'start' | 'isWithheld'> {
  return {
    start(ask: LinkAsk): Promise<LinkStart> {
      calls.push({ op: 'person.link', args: ask, at: now() });
      return Promise.resolve({ status: 'ok', data: { text: '' } });
    },
    isWithheld: () => false,
  };
}
