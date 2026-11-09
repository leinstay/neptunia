// The panel of one gate of the task board: what is being approved, and one row each to approve and to reject. Opening it answers
// nothing, Esc answers nothing, and each answer names the revision on the screen, so the board can refuse a stale one. The
// board decides: this panel holds no permission of its own. Stored task text is made visible before it reaches the terminal.
import type { Panel, PanelResult, PanelRow } from './panel.ts';
import { displaySafe } from './transcript.ts';

export type GateHandoff = {
  readonly result: string;
  readonly evidence: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<{ readonly command: string; readonly passed: number; readonly failed: number }>;
  readonly open_issues: ReadonlyArray<string>;
};

export type GateView = {
  readonly taskId: string;
  readonly scope: string;
  readonly revision: number;
  readonly title: string;
  readonly handoff: GateHandoff | null;
};

export type GateAnswer = {
  taskId: string;
  scope: string;
  revision: number;
  decision: 'approve' | 'reject';
  note?: string;
};

const listed = (label: string, items: ReadonlyArray<string>): Array<string> =>
  items.length === 0 ? [] : [`${label}:`, ...items.map((one) => `  ${one}`)];

/** What the worker handed in, or nothing for a gate before any work. */
function handoffLines(handoff: GateHandoff | null): Array<string> {
  if (handoff === null) return [];
  return [
    `Result: ${handoff.result}`,
    ...listed('Evidence', handoff.evidence),
    ...listed('Artifacts', handoff.artifacts),
    ...listed(
      'Tests',
      handoff.tests.map((one) => `${one.command}: ${one.passed} passed, ${one.failed} failed`)
    ),
    ...listed('Open issues', handoff.open_issues),
  ];
}

export function approvalPanel(
  gate: GateView,
  { respond }: { respond: (answer: GateAnswer) => Promise<PanelResult> }
): Panel {
  const shown = { taskId: gate.taskId, scope: gate.scope, revision: gate.revision };
  // One answer at a time, and none once the board took one: a refused answer can be corrected on the same panel.
  let isSettled = false;
  async function answerOnce(answer: GateAnswer): Promise<PanelResult> {
    if (isSettled) return { status: 'invalid', text: 'This gate is answered.' };
    isSettled = true;
    const result = await respond(answer);
    isSettled = result.status === 'ok';
    return result;
  }
  const rows: Array<PanelRow> = [
    {
      id: 'approve',
      label: `Approve the ${displaySafe(gate.scope)}`,
      detail: 'The board moves the task and records your approval. It starts nothing else.',
      group: 'Decision',
      apply: () => answerOnce({ ...shown, decision: 'approve' }),
    },
    {
      id: 'reject',
      label: `Reject the ${displaySafe(gate.scope)}`,
      detail: 'Enter types the reason, which the board asks for.',
      group: 'Decision',
      edit: { kind: 'text', value: '' },
      apply: (note) => answerOnce({ ...shown, decision: 'reject', ...(note === '' ? {} : { note }) }),
    },
  ];
  const lines = [
    `${gate.scope} approval of ${gate.taskId}, revision ${gate.revision}`,
    gate.title,
    ...handoffLines(gate.handoff),
  ];
  return { title: 'Approval', lines: lines.map(displaySafe), rows };
}
