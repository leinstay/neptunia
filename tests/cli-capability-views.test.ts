// The presentations over existing contracts: the approval panel, the capability menus over the command table, and the
// context line. Each reads what it is given and starts nothing by being opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPanel } from '../bin/chat-panels.ts';
import { approvalPanel } from '../cli/approval-view.ts';
import { contextLine } from '../cli/context-line.ts';
import { KEY, chatEnv, pause, withChat } from './fixtures/chat-rig.ts';

const REQUEST = {
  id: 'q1',
  runId: 'run-1',
  revision: 3,
  expiresAt: 2000,
  scope: { kind: 'tool', name: 'shell', grant: 'once' },
  action: {
    digest: 'sha256:aaa',
    summary: 'Run a command',
    command: ['git', 'status', '--short'],
    diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old line\n+new line',
  },
};

function panelRig(over: Partial<typeof REQUEST.action> = {}) {
  const answers: Array<unknown> = [];
  const panel = approvalPanel(
    { ...REQUEST, action: { ...REQUEST.action, ...over } },
    {
      respond: (answer) => {
        answers.push(answer);
        return Promise.resolve({ status: 'ok', text: 'forwarded' });
      },
    }
  );
  return { panel, answers };
}

test('the panel shows the actual command, the whole diff and the scope, and opening it answers nothing', () => {
  // Bug: a summary hides what would run, and the owner approves a diff they never saw.
  const { panel, answers } = panelRig();
  const shown = panel.lines.join('\n');
  assert.match(shown, /git status --short/);
  assert.match(shown, /-old line/);
  assert.match(shown, /\+new line/);
  assert.match(shown, /once/);
  assert.deepEqual(answers, []);
});

test('with no diff from the backend the panel says so, and invents none', () => {
  // Bug: an empty block reads as a change of nothing.
  const without = panelRig({ diff: null }).panel.lines.join('\n');
  const withDiff = panelRig().panel.lines.join('\n');
  assert.equal(without.includes('@@'), false);
  assert.notEqual(without, withDiff);
});

test('allow and deny are two rows, and each answers with the identity it was shown', async () => {
  // Bug: the answer names the current run rather than the one on the screen.
  const { panel, answers } = panelRig();
  const rows = panel.rows ?? [];
  assert.deepEqual(rows.map((row) => row.id).sort(), ['allow', 'deny']);
  await rows.find((row) => row.id === 'deny')?.apply?.('');
  assert.deepEqual(answers, [{ requestId: 'q1', decision: 'deny', digest: 'sha256:aaa', runId: 'run-1', revision: 3 }]);
});

test('control characters in a command are made visible in the panel', () => {
  // Bug: a terminal escape in a command hides the real command from the person approving it.
  const { panel } = panelRig({ command: ['echo', 'safe\u001b[2K\u001b[1Ghidden'] });
  // eslint-disable-next-line no-control-regex
  assert.equal(/\u001b/.test(panel.lines.join('\n')), false);
});

test('the mounted panel answers once on a double Enter, and Escape leaves it unanswered', async () => {
  // Bug: a double Enter in the panel approves twice, or Escape counts as a denial.
  const answers: Array<unknown> = [];
  const panel = approvalPanel(REQUEST, {
    respond: (answer) => {
      answers.push(answer);
      return Promise.resolve({ status: 'ok', text: 'forwarded' });
    },
  });
  const { env, sent } = chatEnv({ panelOf: () => Promise.resolve(panel) });
  await withChat(env, async (rig) => {
    rig.type('/approve');
    await pause();
    rig.type(KEY.enter);
    await pause(100);
    rig.type(KEY.escape);
    await pause(100);
    assert.deepEqual(answers, []);
  });
  const again = chatEnv({ panelOf: () => Promise.resolve(panel) });
  await withChat(again.env, async (rig) => {
    rig.type('/approve');
    await pause();
    rig.type(KEY.enter);
    await pause(100);
    rig.type(KEY.enter);
    rig.type(KEY.enter);
    await pause(100);
  });
  assert.equal(answers.length, 1);
  assert.deepEqual(sent, []);
});

function runner() {
  const calls: Array<string> = [];
  return {
    calls,
    run: (command: { name: string; args: Record<string, unknown> }) => {
      calls.push(command.name);
      return Promise.resolve({ status: 'ok', text: 'zeta71 available' });
    },
  };
}

test('a capability menu reads through the list operation, and its rows are the table subcommands', async () => {
  // Bug: the menu keeps its own list of actions, or opening it grants or installs something.
  for (const [kind, command] of [
    ['tools', 'tools'],
    ['skills', 'skills'],
    ['interfaces', 'interfaces'],
  ] as const) {
    const { run, calls } = runner();
    const panel = await capabilityPanel(kind, run);
    assert.deepEqual(calls, [`${command}.list`]);
    assert.ok(panel.lines.join('\n').includes('zeta71'));
    const rows = panel.rows ?? [];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(row.prefill?.startsWith(`/${command} `), row.id);
    assert.equal(
      rows.some((row) => row.apply !== undefined),
      false,
      'every change goes through its typed command'
    );
  }
});

test('the agents menu uses its own command, and a family with no command shows unavailable', async () => {
  // Bug: a plugin menu pretends to install what no operation supports.
  const agents = await capabilityPanel('agents', runner().run);
  for (const row of agents.rows ?? []) assert.ok(row.prefill?.startsWith('/agent '), row.id);
  const { run, calls } = runner();
  const plugins = await capabilityPanel('plugins', run);
  assert.deepEqual(plugins.rows ?? [], []);
  assert.ok(plugins.lines.length > 0);
  assert.deepEqual(calls, []);
});

test('a failing list read shows its failure and offers no action', async () => {
  // Bug: a dead core draws an empty menu that looks like nothing installed.
  const panel = await capabilityPanel('tools', () => Promise.resolve({ status: 'failed', text: 'zeta72 unreachable' }));
  assert.ok(panel.lines.join('\n').includes('zeta72'));
  assert.deepEqual(panel.rows ?? [], []);
});

test('the context line shows supplied numbers as they are', () => {
  // Bug: the percentage is computed against a guessed limit, or a route's model is hidden.
  const line = contextLine({ usedTokens: 5000, limitTokens: 20000, route: 'zeta-route', model: 'zeta-model' });
  assert.match(line, /25%/);
  assert.match(line, /zeta-route/);
  assert.match(line, /zeta-model/);
});

test('a missing field is unknown, never zero', () => {
  // Bug: an absent limit reads as 0% used, and the owner trusts a number nobody measured.
  const line = contextLine({ usedTokens: 5000, limitTokens: null, route: null, model: null });
  assert.equal(line.includes('%'), false);
  assert.ok(line.includes('5000') || line.includes('5,000') || line.includes('5k'));
  const empty = contextLine({ usedTokens: null, limitTokens: null, route: null, model: null });
  assert.equal(/\b0\b/.test(empty), false);
  assert.match(empty, /unknown/i);
});
