// cli/session-picker.ts: the panels over the session service, and the same panel mounted over a fake core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryPanel, checkpointPanel, sessionsPanel } from '../cli/session-picker.ts';
import type { SessionClient } from '../cli/session-picker.ts';
import { KEY, chatEnv, press, shows, withChat } from './fixtures/chat-rig.ts';

function clientOf(over: Partial<SessionClient> = {}) {
  const calls: Array<string> = [];
  const client: SessionClient = {
    list: () => {
      calls.push('list');
      return Promise.resolve([
        { id: 's1', name: 'First question', parentId: null, lines: 4, lastAt: 40 },
        { id: 's2', name: 'First question', parentId: 's1', lines: 2, lastAt: 20 },
      ]);
    },
    inspect: (id) => {
      calls.push(`inspect:${id}`);
      return Promise.resolve({
        id,
        memory: 'continuous',
        lines: [
          { id: 'l1', at: 10, who: 'owner', text: 'exact   line\nsecond row' },
          { id: 'l2', at: 20, who: 'her', text: 'an answer' },
        ],
      });
    },
    resume: (id) => {
      calls.push(`resume:${id}`);
      return Promise.resolve({ status: 'ok', text: 'resumed' });
    },
    branch: (id, boundary) => {
      calls.push(`branch:${id}:${boundary}`);
      return Promise.resolve({ status: 'ok', text: 'branched' });
    },
    ...over,
  };
  return { client, calls };
}

test('opening the picker only reads, and a session is resumed by its row', async () => {
  // Bug: opening the panel opens a session or writes a row.
  const { client, calls } = clientOf();
  const panel = await sessionsPanel(client);
  assert.deepEqual(calls, ['list']);
  const rows = panel.rows ?? [];
  assert.equal(rows.length, 2);
  await rows.find((row) => row.id === 's2')?.apply?.('');
  assert.deepEqual(calls, ['list', 'resume:s2']);
});

test('two sessions with one name differ in their rows by lineage', async () => {
  // Bug: a branch and its parent look the same and the owner resumes the wrong one.
  const { client } = clientOf();
  const rows = (await sessionsPanel(client)).rows ?? [];
  assert.notEqual(rows[0]?.detail, rows[1]?.detail);
});

test('no sessions leaves an empty panel that says so', async () => {
  // Bug: an empty list draws a blank panel with no way to know why.
  const { client } = clientOf({ list: () => Promise.resolve([]) });
  const panel = await sessionsPanel(client);
  assert.deepEqual(panel.rows ?? [], []);
  assert.ok(panel.lines.length > 0);
});

test('a boundary row shows the exact line, the panel states that memory stays, and only its row branches', async () => {
  // Bug: the branch point is a preview that differs from the stored line, or the panel promises a forgetting.
  const { client, calls } = clientOf();
  const panel = await boundaryPanel(client, 's1');
  assert.deepEqual(calls, ['inspect:s1']);
  const row = panel.rows?.find((one) => one.id === 'l1');
  assert.equal(row?.value, 'exact   line\nsecond row');
  assert.ok(panel.lines.length > 0, 'the memory statement');
  await row?.apply?.('');
  assert.deepEqual(calls, ['inspect:s1', 'branch:s1:l1']);
});

test('a failed branch answers with its failure', async () => {
  // Bug: a refused boundary reads as success in the panel.
  const { client } = clientOf({ branch: () => Promise.resolve({ status: 'failed', text: 'unknown boundary' }) });
  const panel = await boundaryPanel(client, 's1');
  const answer = await panel.rows?.[0]?.apply?.('');
  assert.equal(answer?.status, 'failed');
});

test('an unsupported checkpoint backend shows its reason and has no restore row', () => {
  // Bug: a restore row on a backend that cannot restore reports success.
  const panel = checkpointPanel({ restore: false, reason: 'no worktree authority' }, []);
  assert.deepEqual(panel.rows ?? [], []);
  assert.ok(panel.lines.join('\n').includes('no worktree authority'));
});

test('a restore row carries the previewed paths before its action', async () => {
  // Bug: restore runs with no sight of what it will change.
  const restored: Array<string> = [];
  const panel = checkpointPanel({ restore: true }, [
    {
      id: 'c1',
      revision: 3,
      changes: [{ path: 'src/a.ts', change: 'modified' }],
      restore: (id) => {
        restored.push(id);
        return Promise.resolve({ status: 'ok', text: 'restored' });
      },
    },
  ]);
  const row = panel.rows?.[0];
  assert.match(`${row?.label} ${row?.detail} ${row?.value}`, /src\/a\.ts/);
  await row?.apply?.('');
  assert.deepEqual(restored, ['c1']);
});

test('the mounted picker keeps the draft, and Enter on its row resumes without a chat line', async () => {
  // Bug: `/sessions` goes to her as a message, or closing the picker loses the draft.
  const { client, calls } = clientOf();
  const { env, sent } = chatEnv({
    commands: [{ name: 'sessions', help: 'chats' }],
    panelOf: async (line) => (line === '/sessions' ? sessionsPanel(client) : null),
  });
  await withChat(env, async (rig) => {
    await press(rig, '/sessions', shows(rig, '> /sessions'));
    await press(rig, KEY.enter, shows(rig, 'First question'));
    await press(rig, KEY.enter, () => calls.includes('resume:s1'));
    await press(rig, KEY.escape, () => !rig.screen().join('\n').includes('First question'));
  });
  assert.deepEqual(calls, ['list', 'resume:s1']);
  assert.deepEqual(sent, []);
});
