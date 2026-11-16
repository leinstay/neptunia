// The presentations over existing contracts: the capability menus over the command table and the context line.
// Changed: the panel of a board gate is gone with the approvals (maintainer, 2026-11-16). Each reads what it is given and starts nothing by being opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPanel } from '../bin/chat-panels.ts';
import { contextLine } from '../interfaces/cli/context-line.ts';

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
