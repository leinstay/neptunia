// The chat's bare `/memory users`, `places`, `graph` and `inspect`: one panel over the same reads a script gets, each row
// prefilling the command that opens it, so the chat and a shell select the same typed ids. Plan 2026-11-04-cli-and-memory
// tasks 8 to 10: no second browser, and opening a panel asks no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';
import type { PanelResult } from '../interfaces/cli/panel.ts';

function reader(answers: Record<string, unknown>): {
  asked: Array<string>;
  run: (command: { name: string; args: Record<string, unknown> }) => Promise<PanelResult>;
} {
  const asked: Array<string> = [];
  return {
    asked,
    run: (command) => {
      asked.push(command.name);
      const answer = answers[command.name];
      return Promise.resolve(
        answer === undefined
          ? { status: 'failed', text: 'the memory database is closed' }
          : { status: 'ok', text: JSON.stringify(answer) }
      );
    },
  };
}

const page = (items: Array<unknown>, total: number, next: string | null = null): unknown => ({
  items,
  snapshot: '',
  next,
  total,
  truncated: next !== null,
  reason: next === null ? null : 'page',
});

test('/memory users lists every kind of entry, each prefilling its own detail by typed id', async () => {
  // Bug: the panel keeps a display name as its key, so two people who share a name open one record.
  const { run, asked } = reader({
    'memory.users.list': page(
      [
        { kind: 'person', id: 'person:1', names: ['Ελένη'], accountIds: ['account:1'], mergedInto: null },
        { kind: 'account', id: 'account:9', names: ['Ελένη'] },
        { kind: 'participant', id: 'participant:1', display: 'Ανώνυμος' },
      ],
      3
    ),
  });
  const panel = await chatPanel('/memory users', run);
  assert.deepEqual(asked, ['memory.users.list']);
  assert.deepEqual(
    panel?.rows?.map((row) => row.prefill),
    [
      '/memory users show person:1',
      '/memory inspect rows accounts --filters [{"column":"id","value":{"kind":"text","value":"account:9"}}]',
      '/memory inspect rows participants --filters [{"column":"id","value":{"kind":"text","value":"participant:1"}}]',
    ]
  );
});

test('a panel says what the page left out', async () => {
  // Bug: the first page of a long list reads as the whole list.
  const { run } = reader({ 'memory.places.list': page([{ id: 'place:1', name: 'κήπος', childCount: 2 }], 40, 'c1') });
  const panel = await chatPanel('/memory places', run);
  assert.ok(panel?.lines.some((line) => line.includes('1 of 40')));
  assert.equal(panel?.rows?.[0]?.prefill, '/memory places tree place:1');
});

test('/memory graph lists its kinds and names the deferred ones', async () => {
  const { run } = reader({
    'memory.graph.kinds': {
      kinds: [
        { kind: 'person', table: 'people', state: 'implemented', reason: null, nodes: 4 },
        { kind: 'skill', table: null, state: 'deferred', reason: 'not built', nodes: 0 },
      ],
      predicates: [],
    },
  });
  const panel = await chatPanel('/memory graph', run);
  assert.equal(panel?.rows?.[0]?.prefill, '/memory graph nodes --kinds person');
  assert.ok(panel?.rows?.[1]?.detail.includes('deferred'));
});

test('/memory inspect lists every table under one snapshot, whatever its class', async () => {
  // Bug: the rows of the panel read a later moment than the catalog it listed.
  const { run } = reader({
    'memory.inspect.tables': {
      snapshot: 's1',
      catalog: { tables: [{ name: 'future_family', kind: 'table', storageClass: 'unclassified' }] },
    },
  });
  const panel = await chatPanel('/memory inspect', run);
  assert.equal(panel?.rows?.[0]?.prefill, '/memory inspect rows future_family --snapshot s1');
  assert.ok(panel?.rows?.[0]?.detail.includes('unclassified'));
});

test('a refused read shows its reason and no empty list', async () => {
  // Bug: a closed database reads as a memory with nobody in it.
  const { run } = reader({});
  const panel = await chatPanel('/memory users', run);
  assert.deepEqual(panel?.lines, ['the memory database is closed']);
  assert.equal(panel?.rows, undefined);
});
