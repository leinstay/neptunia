// The presentations over existing contracts: the panel of a board gate, the capability menus over the command table, and the
// context line. Each reads what it is given and starts nothing by being opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPanel } from '../bin/chat-panels.ts';
import { approvalPanel } from '../interfaces/cli/approval-view.ts';
import { contextLine } from '../interfaces/cli/context-line.ts';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';

const GATE = {
  taskId: 'T1',
  scope: 'merge',
  revision: 3,
  title: 'Read the new tag',
  handoff: {
    result: 'The parser reads the new tag.',
    evidence: ['the parser tests pass 12 of 12'],
    artifacts: ['src/parser.ts'],
    tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
    open_issues: ['one open question'],
  },
} as const;

function panelRig(gate: Parameters<typeof approvalPanel>[0] = GATE) {
  const answers: Array<unknown> = [];
  const panel = approvalPanel(gate, {
    respond: (answer) => {
      answers.push(answer);
      return Promise.resolve({ status: 'ok', text: 'forwarded' });
    },
  });
  return { panel, answers };
}

test('the panel shows the scope, the title and what the worker handed in, and opening it answers nothing', () => {
  // Bug: the owner approves a merge without seeing the result, the tests or the open issues.
  const { panel, answers } = panelRig();
  const shown = panel.lines.join('\n');
  assert.match(shown, /merge/);
  assert.match(shown, /Read the new tag/);
  assert.match(shown, /The parser reads the new tag\./);
  assert.match(shown, /src\/parser\.ts/);
  assert.match(shown, /one open question/);
  assert.deepEqual(answers, []);
});

test('a plan gate has no handoff, and the panel invents none', () => {
  // Bug: an empty result block reads as a task that finished with nothing to report.
  const shown = panelRig({ ...GATE, scope: 'plan', handoff: null }).panel.lines.join('\n');
  assert.match(shown, /plan/);
  assert.equal(shown.includes('src/parser.ts'), false);
});

test('approve and reject are two rows, each answering with the revision it was shown', async () => {
  // Bug: the answer names the task as it is now rather than the one on the screen.
  const { panel, answers } = panelRig();
  const rows = panel.rows ?? [];
  assert.deepEqual(rows.map((row) => row.id).sort(), ['approve', 'reject']);
  await rows.find((row) => row.id === 'approve')?.apply?.('');
  assert.deepEqual(answers, [{ taskId: 'T1', scope: 'merge', revision: 3, decision: 'approve' }]);
});

test('a reject carries the typed note the board asks for', async () => {
  // Bug: the reject row drops the reason, and the board refuses it each time.
  const { panel, answers } = panelRig();
  const row = panel.rows?.find((one) => one.id === 'reject');
  assert.equal(row?.edit?.kind, 'text');
  await row?.apply?.('not this one');
  assert.deepEqual(answers, [{ taskId: 'T1', scope: 'merge', revision: 3, decision: 'reject', note: 'not this one' }]);
});

test('control characters in stored task text are made visible in the panel', () => {
  // Bug: a terminal escape in a title hides what is being approved.
  const { panel } = panelRig({ ...GATE, title: 'safe\u001b[2K\u001b[1Ghidden' });
  // eslint-disable-next-line no-control-regex
  assert.equal(/\u001b/.test(panel.lines.join('\n')), false);
});

test('the mounted panel answers once on a double Enter, and Escape leaves it unanswered', async () => {
  // Bug: a double Enter in the panel approves twice, or Escape counts as a rejection.
  const answers: Array<unknown> = [];
  const panel = approvalPanel(GATE, {
    respond: (answer) => {
      answers.push(answer);
      return Promise.resolve({ status: 'ok', text: 'forwarded' });
    },
  });
  const { env, sent } = chatEnv({ panelOf: () => Promise.resolve(panel) });
  await withChat(env, async (rig) => {
    await press(rig, '/approve', shows(rig, '> /approve'));
    await press(rig, KEY.enter, shows(rig, 'Read the new tag'));
    await press(rig, KEY.escape, () => !rig.screen().join('\n').includes('Read the new tag'));
    assert.deepEqual(answers, []);
  });
  const again = chatEnv({ panelOf: () => Promise.resolve(panel) });
  await withChat(again.env, async (rig) => {
    await press(rig, '/approve', shows(rig, '> /approve'));
    await press(rig, KEY.enter, shows(rig, 'Read the new tag'));
    rig.type(KEY.enter);
    rig.type(KEY.enter);
    await until(() => answers.length >= 1);
    // The second Enter changes nothing when the panel answers once, so only a fixed wait lets a second answer show.
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

test('the interfaces menu prefills no command before the interface', async () => {
  // The owner's decision of 2026-11-11 put the interface first and removed the old order. Catches: a menu row that
  // prefills `/interfaces setup `, a line the table refuses.
  const commands = [
    'setup',
    'settings',
    'set',
    'clear',
    'add',
    'remove',
    'enable',
    'disable',
    'invite',
    'pair',
    'roots',
  ];
  const panel = await capabilityPanel('interfaces', () =>
    Promise.resolve({ status: 'ok', text: 'zeta71  enabled  connected' })
  );
  for (const row of panel.rows ?? []) {
    const second = (row.prefill ?? '').split(' ')[1] ?? '';
    assert.equal(commands.includes(second), false, `${row.id}: ${row.prefill ?? ''}`);
  }
});

test('the agents menu uses its own command', async () => {
  // Bug: a menu row prefills a command of another family.
  // Changed: the menu opens under the command's own word, `/agent`, and `/agents` is no second name for it.
  const agents = await capabilityPanel('agent', runner().run);
  for (const row of agents.rows ?? []) assert.ok(row.prefill?.startsWith('/agent '), row.id);
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
