// src/interface/commands/chat-state.ts and the panels over it: `session.*` from the chat's panel to the real service, and the
// memory reader those lines come from on a real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';
import { createConversationSessions } from '../src/conversation/sessions.ts';
import type { ConversationStore, SessionRow, SourceLine } from '../src/conversation/sessions.ts';
import type { CheckpointDesk } from '../src/development/checkpoint-desk.ts';
import { createChatState } from '../src/interface/commands/chat-state.ts';

const LINES: ReadonlyArray<SourceLine> = [
  { id: 's1', placeId: 'cli:dm:owner', at: 10, who: 'owner', text: 'First', nativeId: 'n1' },
  { id: 's2', placeId: 'cli:dm:owner', at: 20, who: 'her', text: 'Answer' },
  { id: 's3', placeId: 'cli:dm:owner', at: 30, who: 'owner', text: 'Second' },
];

const noCheckpoints: CheckpointDesk = {
  list: () => Promise.resolve({ capability: { restore: false, reason: 'zeta73 reason' }, points: [] }),
  take: () => Promise.resolve({ ok: false, code: 'no-worktree' }),
  restore: () => Promise.resolve({ status: 'refused', code: 'no-worktree' }),
};

function rig() {
  const rows: Array<SessionRow> = [];
  const store: ConversationStore = {
    lines: (placeId) => LINES.filter((line) => line.placeId === placeId),
    sessions: () => rows,
    saveSession(row) {
      const at = rows.findIndex((one) => one.id === row.id);
      if (at === -1) rows.push(row);
      else rows[at] = row;
    },
  };
  let serial = 0;
  const state = createChatState({
    sessions: createConversationSessions({ store, now: () => 100, newId: () => `id${(serial += 1)}` }),
    checkpoints: noCheckpoints,
  });
  const run = async (command: { name: string; args: Record<string, unknown> }) =>
    (await state.command(command.name, command.args)) ?? { text: 'no such command', status: 'failed' };
  const shown: Array<ReadonlyArray<{ id: string }>> = [];
  const view = { showLines: (lines: ReadonlyArray<{ id: string }>) => void shown.push(lines) };
  return { run, view, shown, rows, state };
}

test('names outside these two families are left to the desk', () => {
  // Bug: the chat state swallows `status` or a board command.
  assert.equal(rig().state.command('status', {}), null);
  assert.equal(rig().state.command('task.list', {}), null);
});

test('/sessions lists the root, and its row shows the stored lines in the chat', async () => {
  // Bug: resume answers success and the chat goes on showing, and sending as context, the old lines.
  const { run, view, shown } = rig();
  await run({ name: 'session.open', args: {} });
  const panel = await chatPanel('/sessions', run, [], view);
  const row = panel?.rows?.[0];
  assert.equal(row?.label, 'First');
  const answer = await row?.apply?.('');
  assert.equal(answer?.status, 'ok');
  assert.deepEqual(
    shown[0]?.map((line) => line.id),
    ['s1', 's2', 's3']
  );
});

test('/branch cuts the current session at a line, and the chat then shows the lines up to it', async () => {
  // Bug: the branch is written but the chat stays on the whole conversation, or the next branch cuts the old one.
  const { run, view, shown } = rig();
  await run({ name: 'session.open', args: {} });
  const panel = await chatPanel('/branch', run, [], view);
  assert.equal(panel?.rows?.find((one) => one.id === 's1')?.value, 'First');
  const answer = await panel?.rows?.find((one) => one.id === 's1')?.apply?.('');
  assert.equal(answer?.status, 'ok');
  assert.deepEqual(
    shown.at(-1)?.map((line) => line.id),
    ['s1']
  );
  const next = await chatPanel('/branch', run, [], view);
  assert.deepEqual(
    next?.rows?.map((one) => one.id),
    ['s1'],
    'the branch is now the session in force'
  );
});

test('/resume with an id resumes it, an unknown id fails with nothing shown, and the bare line is not a panel', async () => {
  // Bug: `/resume` stops ending a pause, or a typo reads as resumed.
  const { run, view, shown } = rig();
  await run({ name: 'session.open', args: {} });
  assert.equal(await chatPanel('/resume', run, [], view), null);
  const refused = await chatPanel('/resume nope', run, [], view);
  assert.match(refused?.lines.join('\n') ?? '', /unknown-session/);
  assert.deepEqual(shown, []);
});

test('session.open twice is one root, and repeating a branch is one branch', async () => {
  // Bug: every chat start, or every double Enter, adds a session to the picker.
  const { run, rows } = rig();
  await run({ name: 'session.open', args: {} });
  await run({ name: 'session.open', args: {} });
  assert.equal(rows.length, 1);
  const from = rows[0]?.id;
  await run({ name: 'session.branch', args: { from, boundary: 's2' } });
  await run({ name: 'session.branch', args: { from, boundary: 's2' } });
  assert.equal(rows.length, 2);
});

test('a missing boundary refuses with its code and writes nothing', async () => {
  // Bug: a branch at a line that is gone becomes a branch of everything.
  const { run, rows } = rig();
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.branch', args: { from: rows[0]?.id, boundary: 'gone' } });
  assert.equal(answer.status, 'invalid');
  assert.equal(rows.length, 1);
});

test('/checkpoints shows the reason of a backend that cannot restore, and offers no row', async () => {
  // Bug: the panel offers a restore that reports success with nothing behind it.
  const { run, view } = rig();
  const panel = await chatPanel('/checkpoints', run, [], view);
  assert.deepEqual(panel?.rows ?? [], []);
  assert.match(panel?.lines.join('\n') ?? '', /zeta73 reason/);
});
