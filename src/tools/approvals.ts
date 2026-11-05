// The relay between an approval panel and the board's gates. It holds the gates a panel was shown and forwards one answer per
// shown revision to `authorize`, the board, which has the last word. An answer naming another revision never reaches the
// board, a gate never presented is refused, and a refused answer leaves the gate open for a corrected one. A reconnect presents
// the same gate again without a duplicate. An agent's mode is set in advance (src/subharness/control.ts), so this holds no
// tool approvals: those have no backend to answer them. src/interface/commands/chat-state.ts holds the owner's.

import type { ApprovalAnswer, ApprovalGate, ApprovalResult } from '../board/approval-view.ts';

export type RelayAnswer =
  | { status: 'forwarded'; result: ApprovalResult }
  | { status: 'refused'; code: 'unknown' | 'stale' | 'already-answered' };

export type ApprovalRelay = {
  present(gate: ApprovalGate): void;
  /** Takes back a gate the board no longer holds. */
  withdraw(gate: Pick<ApprovalGate, 'taskId' | 'scope'>): void;
  pending(): Array<ApprovalGate>;
  respond(answer: ApprovalAnswer): Promise<RelayAnswer>;
};

/** How many answered gates stay remembered, so a double Enter is known: far past one panel's life. Decided 2026-11-05. */
const ANSWERED_KEPT = 256;

const gateKey = (gate: Pick<ApprovalGate, 'taskId' | 'scope'>): string => `${gate.taskId}:${gate.scope}`;
const answeredKey = (gate: Pick<ApprovalGate, 'taskId' | 'scope' | 'revision'>): string =>
  `${gateKey(gate)}:${gate.revision}`;

export function createApprovalRelay({
  authorize,
}: {
  authorize: (answer: ApprovalAnswer) => ApprovalResult | Promise<ApprovalResult>;
}): ApprovalRelay {
  const gates = new Map<string, ApprovalGate>();
  const settled = new Set<string>();
  const inFlight = new Set<string>();

  return {
    present(gate) {
      if (!settled.has(answeredKey(gate))) gates.set(gateKey(gate), gate);
    },
    withdraw: (gate) => void gates.delete(gateKey(gate)),
    pending: () => [...gates.values()],
    async respond(answer) {
      const key = answeredKey(answer);
      if (settled.has(key) || inFlight.has(key)) return { status: 'refused', code: 'already-answered' };
      const gate = gates.get(gateKey(answer));
      if (gate === undefined) return { status: 'refused', code: 'unknown' };
      if (gate.revision !== answer.revision) return { status: 'refused', code: 'stale' };
      inFlight.add(key);
      try {
        const result = await authorize(answer);
        if (result.status === 'ok') {
          gates.delete(gateKey(answer));
          settled.add(key);
          for (const oldest of settled) {
            if (settled.size <= ANSWERED_KEPT) break;
            settled.delete(oldest);
          }
        }
        return { status: 'forwarded', result };
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
