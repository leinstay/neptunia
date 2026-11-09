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

function rig(lines: ReadonlyArray<SourceLine> = LINES) {
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
