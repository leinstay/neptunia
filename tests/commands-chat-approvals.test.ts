// `/approvals` from the chat's panel over src/interface/commands/chat-state.ts, down to a real board's commands: the gate the
// panel shows, one answer reaching the board, and a refusal coming back. `/context` and the panel's menus beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatPanel } from '../bin/chat-panels.ts';
import type { ApprovalGate, ApprovalResult } from '../src/board/approval-view.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings } from '../src/board/board.ts';
import { createTaskCommands } from '../src/board/commands.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { createChatState } from '../src/interface/commands/chat-state.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { tempDir } from './fixtures/tmp.ts';

const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

type Context = { after: (fn: () => void) => void };

function rig(t: Context) {
  const dir = tempDir('nep-chat-approvals-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({ owner: { kind: 'agent', tokenFile: 'clients/o.token', permissions: [], boardRoles: ['owner'] } })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const board: Board = openBoard({
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    settings: () => SETTINGS,
  });
  const commands = createTaskCommands({ board: () => board, briefWaitMs: () => 1000 });
  const added = board.call('owner', 'task.add', { title: 'zeta74 task', lane: 'dev', project: 'core' });
  const triaged = board.call('owner', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  const state = createChatState({
    sessions: {} as never,
    checkpoints: {} as never,
    approvals: {
      gates: async () => ((await commands.run('owner', 'task.approvals', {})).data ?? []) as Array<ApprovalGate>,
      answer: async (answer) => {
        const reply = await commands.run('owner', 'task.approval.answer', answer);
        return (reply.data ?? { status: 'refused', code: reply.status, message: reply.text }) as ApprovalResult;
      },
    },
    context: () => ({ usedTokens: null, limitTokens: 50000, route: 'zeta-route', model: 'zeta-model' }),
  });
  const run = async (command: { name: string; args: Record<string, unknown> }) =>
    (await state.command(command.name, command.args)) ?? { text: 'no such command', status: 'failed' };
  return { board, run, id: triaged.id };
}

test('/approvals shows the one gate, and its approve row moves the task on the board once', async (t) => {
  // Bug: the panel reads one list and answers through another path than the board's.
  const { board, run, id } = rig(t);
  const panel = await chatPanel('/approvals', run);
  assert.match(panel?.lines.join('\n') ?? '', /zeta74 task/);
  const approve = panel?.rows?.find((row) => row.id === 'approve');
  assert.equal((await approve?.apply?.(''))?.status, 'ok');
  const view = board.call('owner', 'task.show', { id });
  assert.equal(view.task.status, 'approved');
  assert.equal(view.approvals.length, 1);
  assert.equal(view.task.lease_owner, null, 'an approval starts no work');
  assert.match((await chatPanel('/approvals', run))?.lines.join('\n') ?? '', /Nothing waits/);
});

test('an answer against a revision the board has passed comes back refused, and the task stays', async (t) => {
  // Bug: a panel left open approves the plan as it stood before someone changed it.
  const { board, run, id } = rig(t);
  const panel = await chatPanel('/approvals', run);
  const before = board.call('owner', 'task.show', { id }).task;
  board.call('owner', 'task.update', { id, revision: before.revision, set: { estimate: 21 } });
  const answer = await panel?.rows?.find((row) => row.id === 'approve')?.apply?.('');
  assert.equal(answer?.status, 'invalid');
  assert.equal(answer?.code, 'stale');
  assert.equal(board.call('owner', 'task.show', { id }).task.status, 'triaged');
});

test('/approvals names a gate that does not wait, and says so', async (t) => {
  // Bug: a typed id opens another task's gate.
  const { run } = rig(t);
  assert.match((await chatPanel('/approvals T9', run))?.lines.join('\n') ?? '', /T9/);
});

test('/context shows the numbers the core holds and names the rest unknown', async (t) => {
  // Bug: the panel reads as 0 tokens used when nothing measured it.
  const { run } = rig(t);
  const shown = (await chatPanel('/context', run))?.lines.join('\n') ?? '';
  assert.match(shown, /unknown of 50000 tokens/);
  assert.match(shown, /zeta-route/);
  assert.match(shown, /zeta-model/);
});
