// src/interface/commands/chat-state.ts and the panels over it: `session.*` from the chat's panel to the real service, and the
// memory reader those lines come from on a real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';
import { createChatSessions } from '../src/chat/sessions.ts';
import type { ChatStore, SessionRow, SourceLine } from '../src/chat/sessions.ts';
import type { MediaKind, MediaRow } from '../src/memory/db/media-store.ts';
import type { CheckpointDesk } from '../src/development/checkpoint-desk.ts';
import { createChatState } from '../src/interface/commands/chat-state.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalGate, ApprovalResult } from '../src/board/approval-view.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings } from '../src/board/board.ts';
import { createTaskCommands } from '../src/board/commands.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { chatLines } from '../src/memory/db/chat-lines.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { storeProductionEdit } from './fixtures/memory-db/edited-line.ts';
import { tempDir } from './fixtures/tmp.ts';

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

function rig(lines: ReadonlyArray<SourceLine> = LINES, place: () => string | null = () => 'cli:dm:owner') {
  const rows: Array<SessionRow> = [];
  const store: ChatStore = {
    lines: (placeId) => lines.filter((line) => line.placeId === placeId),
    sessions: () => rows,
    saveSession(row) {
      const at = rows.findIndex((one) => one.id === row.id);
      if (at === -1) rows.push(row);
      else rows[at] = row;
    },
  };
  let serial = 0;
  const state = createChatState({
    sessions: createChatSessions({ store, now: () => 100, newId: () => `id${(serial += 1)}` }),
    checkpoints: noCheckpoints,
    approvals: {
      gates: () => Promise.resolve([]),
      answer: () => Promise.resolve({ status: 'refused', code: 'unused', message: '' }),
    },
    context: () => ({ usedTokens: null, limitTokens: 50000, route: 'zeta-route', model: 'zeta-model' }),
    place,
  });
  const run = async (command: { name: string; args: Record<string, unknown> }) =>
    (await state.command(command.name, command.args)) ?? { text: 'no such command', status: 'failed' };
  const shown: Array<ReadonlyArray<{ id: string }>> = [];
  const view = { showLines: (lines: ReadonlyArray<{ id: string }>) => void shown.push(lines) };
  return { run, view, shown, rows, state };
}

test('names outside its families are left to the desk', () => {
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
  // Bug: the branch is written but the chat stays on the whole chat, or the next branch cuts the old one.
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

test('/sessions resume with an id resumes it, an unknown id fails with nothing shown, and /resume is no panel', async () => {
  // Changed: `/resume <id>` shared its word with the end of a pause, so a session resumes under `/sessions`.
  // Bug: `/resume` stops ending a pause, or a typo reads as resumed.
  const { run, view, shown } = rig();
  await run({ name: 'session.open', args: {} });
  assert.equal(await chatPanel('/resume', run, [], view), null);
  assert.equal(await chatPanel('/resume nope', run, [], view), null);
  const refused = await chatPanel('/sessions resume nope', run, [], view);
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

test('a stored page gives each line the time it was sent', async () => {
  // Bug: the chat draws a line from memory with the time it was loaded, because the page carries no time.
  const { run } = rig();
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.page', args: { before: null, count: 10 } });
  const { lines } = JSON.parse(answer.text) as { lines: Array<{ id: string; at: number }> };
  assert.deepEqual(
    lines.map((line) => [line.id, line.at]),
    [
      ['s1', 10],
      ['s2', 20],
      ['s3', 30],
    ]
  );
});

/** A media row of a stored line, as src/memory/db/media-store.ts reads it: a kept file has a path under `media/cli/`. */
const item = (kind: MediaKind, position: number, path: string | null, fileName: string): MediaRow => ({
  mediaId: `m-${position}`,
  position,
  kind,
  nativeRef: `ref-${position}`,
  path,
  description: null,
  describedAt: null,
  availability: 'present',
  sha1: null,
  extra: { fileName },
});

/** A chat of 1335 lines seen through its newest three, each numbered over the whole history as memory numbers them. */
const NUMBERED: ReadonlyArray<SourceLine> = [
  { id: 'n1', placeId: 'cli:dm:owner', at: 10, who: 'owner', text: 'Older', number: 1333 },
  {
    id: 'n2',
    placeId: 'cli:dm:owner',
    at: 20,
    who: 'her',
    text: 'Here they are',
    number: 1334,
    media: [
      item('video', 0, 'media/cli/v1.mp4', 'clip.mp4'),
      item('voice', 1, 'media/cli/v2.ogg', 'note.ogg'),
      item('file', 2, null, 'lost.pdf'),
      item('link', 3, null, 'a page'),
    ],
  },
  { id: 'n3', placeId: 'cli:dm:owner', at: 30, who: 'owner', text: 'Thanks', number: 1335 },
];

type LineAnswer = {
  number: number;
  files: Array<{ name: string; kind: string; path: string | null; description: string | null }>;
};

test('a stored page gives each line its number over the whole chat, whatever page it is on', async () => {
  // Bug: the page leaves the number out, so the chat counts from the oldest line on the screen again.
  const { run } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.page', args: { before: 'n3', count: 1 } });
  const { lines } = JSON.parse(answer.text) as { lines: Array<{ id: string; number: number }> };
  assert.deepEqual(
    lines.map((line) => [line.id, line.number]),
    [['n2', 1334]]
  );
});

test('session.line answers the files of the line with that number, of any kind, in their order', async () => {
  // Bug: `/attach open #N` reaches only images, the files of a neighbouring line, or lists a link as a file.
  const { run } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.line', args: { number: 1334 } });
  assert.equal(answer.status, 'ok');
  const line = JSON.parse(answer.text) as LineAnswer;
  assert.equal(line.number, 1334);
  // Each file also carries the description memory stores for it, which the window shows beside a picture.
  assert.deepEqual(line.files, [
    { name: 'clip.mp4', kind: 'video', path: 'media/cli/v1.mp4', description: null },
    { name: 'note.ogg', kind: 'voice', path: 'media/cli/v2.ogg', description: null },
    { name: 'lost.pdf', kind: 'file', path: null, description: null },
  ]);
});

test('session.line answers the message id of the line, which a reply to it names as its parent', async () => {
  // Bug: the chat can draw `[#N]` but cannot name line N's message, so a reply to it goes out with no parent.
  const { run } = rig(LINES.map((line, index) => ({ ...line, number: index + 1 })));
  await run({ name: 'session.open', args: {} });
  const line = JSON.parse((await run({ name: 'session.line', args: { number: 1 } })).text) as { messageId: string };
  assert.equal(line.messageId, 'n1');
});

test('session.line answers a line with no file with an empty list', async () => {
  // Bug: a line of text alone answers a refusal that reads as an unknown line.
  const { run } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  const line = JSON.parse((await run({ name: 'session.line', args: { number: 1333 } })).text) as LineAnswer;
  assert.deepEqual(line.files, []);
});

test('session.line refuses a number no stored line holds', async () => {
  // Bug: an unknown number opens the newest file, or the line at that place of the screen.
  const { run } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.line', args: { number: 9999 } });
  assert.equal(answer.status, 'invalid');
  assert.equal(answer.code, 'unknown-line');
  assert.equal((await run({ name: 'session.line', args: { number: 'x' } })).code, 'unknown-line');
});

test('session.line finds a line by its number while a branch hides it from the screen', async () => {
  // Bug: the number resolves only inside the current view, so a number seen before a branch answers nothing.
  const { run, rows } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  await run({ name: 'session.branch', args: { from: rows[0]?.id, boundary: 'n1' } });
  const line = JSON.parse((await run({ name: 'session.line', args: { number: 1334 } })).text) as LineAnswer;
  assert.equal(line.files.length, 3);
});

test('a stored page gives each line the kinds of its files, and no link', async () => {
  // Bug: the chat draws a line that carried a video and a voice note as text alone.
  const { run } = rig(NUMBERED);
  await run({ name: 'session.open', args: {} });
  const answer = await run({ name: 'session.page', args: { before: null, count: 3 } });
  const { lines } = JSON.parse(answer.text) as { lines: Array<{ id: string; files?: Array<string> }> };
  assert.deepEqual(
    lines.map((line) => [line.id, line.files ?? []]),
    [
      ['n1', []],
      ['n2', ['video', 'voice', 'file']],
      ['n3', []],
    ]
  );
});

// `/approvals` from the chat's panel over src/interface/commands/chat-state.ts, down to a real board's commands: the gate the
// panel shows, one answer reaching the board, and a refusal coming back. `/context` and the panel's menus beside it.

const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

type Context = { after: (fn: () => void) => void };

function approvalsRig(t: Context) {
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
    place: () => 'cli:dm:owner',
  });
  const run = async (command: { name: string; args: Record<string, unknown> }) =>
    (await state.command(command.name, command.args)) ?? { text: 'no such command', status: 'failed' };
  return { board, run, id: triaged.id };
}

test('/approvals shows the one gate, and its approve row moves the task on the board once', async (t) => {
  // Bug: the panel reads one list and answers through another path than the board's.
  const { board, run, id } = approvalsRig(t);
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
  const { board, run, id } = approvalsRig(t);
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
  const { run } = approvalsRig(t);
  assert.match((await chatPanel('/approvals T9', run))?.lines.join('\n') ?? '', /T9/);
});

test('/status full ends with the numbers the core holds of a request and names the rest unknown, and /context is gone', async (t) => {
  // Changed: `/context` was a panel of its own beside the status. Bug: the line reads as 0 tokens used when nothing
  // measured it.
  const { run } = approvalsRig(t);
  assert.equal(await chatPanel('/context', run), null);
  const shown = (await chatPanel('/status full', run))?.lines.join('\n') ?? '';
  assert.match(shown, /unknown of 50000 tokens/);
  assert.match(shown, /zeta-route/);
  assert.match(shown, /zeta-model/);
});

test("the chat's sessions read the command line's place from its stored row, whatever its id spells", async () => {
  // Bug: the sessions named the place `cli:dm:owner`, so a stored place under another id showed no line.
  const stored = LINES.map((line, index) => ({ ...line, placeId: 'place:cli-7f3a', number: index + 1 }));
  const { run } = rig(stored, () => 'place:cli-7f3a');
  await run({ name: 'session.open', args: {} });
  const page = JSON.parse((await run({ name: 'session.page', args: {} })).text) as { lines: Array<{ id: string }> };
  assert.deepEqual(
    page.lines.map((line) => line.id),
    ['s1', 's2', 's3']
  );
  const line = JSON.parse((await run({ name: 'session.line', args: { number: 1 } })).text) as { messageId?: string };
  assert.equal(line.messageId, 'n1');
});

test('a chat opened before its place is stored starts at the root once the place is stored', async () => {
  // Bug: the open named a place spelled from the chat id; with the row read instead, an open before the first line
  // would leave the chat with no session, so its pages stayed empty after the first line was stored.
  let place: string | null = null;
  const stored = LINES.map((line) => ({ ...line, placeId: 'place:cli-late' }));
  const { run } = rig(stored, () => place);
  assert.equal((await run({ name: 'session.open', args: {} })).status, 'ok');
  place = 'place:cli-late';
  const page = JSON.parse((await run({ name: 'session.page', args: {} })).text) as { lines: Array<{ id: string }> };
  assert.deepEqual(
    page.lines.map((line) => line.id),
    ['s1', 's2', 's3']
  );
});

// Bug (production, 2026-11-12): the owner's screen loaded her edited line at the end of the chat, as his, under the
// number of its edit, and every line after its old place changed number. The page carries no mark field, so the mark
// is checked on the reader (tests/chat-lines.test.ts).
test('a stored page holds her line edited with the moment of the edit once, at its old place, as hers', async () => {
  const handle = openMemoryDb(':memory:');
  try {
    storeProductionEdit(handle.db as Parameters<typeof storeProductionEdit>[0], {
      iface: 'cli',
      place: 'cli:dm:owner',
    });
    const stored = chatLines(handle.db as Parameters<typeof chatLines>[0], 'cli:dm:owner');
    const { run } = rig(stored);
    await run({ name: 'session.open', args: {} });
    const answer = await run({ name: 'session.page', args: { before: null, count: 10 } });
    const { lines } = JSON.parse(answer.text) as {
      lines: Array<{ messageId: string; who: string; text: string; number: number }>;
    };
    assert.deepEqual(
      lines.map((line) => [line.messageId, line.number, line.who, line.text]),
      [
        ['owner-1', 1, 'owner', 'first words'],
        ['hers-1', 2, 'her', 'the kettle is on'],
        ['owner-2', 3, 'owner', 'second words'],
        ['hers-2', 4, 'her', 'her next words'],
      ]
    );
  } finally {
    handle.close();
  }
});
