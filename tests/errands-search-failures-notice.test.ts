// The count of failed web searches (`result.searchFailures`) travels from the runner's result to her: the protocol
// keeps a positive whole count (src/agent-runner/protocol.ts#normalizeResult), the errand store keeps it
// (src/errands/store.ts), and `errandResultText` (src/errands/blocks.ts) adds `labels.errands.result.searchFailed`
// with `{count}` to the result she reads. No count, or zero, adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult } from '../src/agent-runner/protocol.ts';
import { errandResultText } from '../src/errands/blocks.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import path from 'node:path';
import type { Untyped } from '../src/tools/types.ts';

const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const labels = {
  errands: {
    states: { done: 'done', failed: 'failed' },
    result: {
      header: 'errand {id} ({agent}) ended {state}: {goal}',
      text: 'text:',
      empty: 'no text',
      error: 'error: {error}',
      searchFailed: 'The web search failed {count} times.',
    },
  },
};

const record = (result: Record<string, unknown>) =>
  ({
    id: 'e1',
    agent: 'scout',
    goal: 'find the notes',
    state: 'done',
    error: null,
    result,
  }) as unknown as Parameters<typeof errandResultText>[0];

test('normalizeResult keeps a positive count of failed searches', () => {
  // Catches: the runner's count dropped on the way, since the normalizer lists the fields it keeps.
  assert.equal(normalizeResult({ text: 'a', searchFailures: 3 }).searchFailures, 3);
});

for (const bad of [0, -1, 1.5, '3', null, Number.NaN]) {
  test(`normalizeResult drops a searchFailures of ${String(bad)}`, () => {
    // Catches: a zero or a malformed count passed on, which would print a failure notice for a clean run.
    assert.equal(Object.hasOwn(normalizeResult({ text: 'a', searchFailures: bad }), 'searchFailures'), false);
  });
}

test('the errand store keeps the count of failed searches on the finished errand', () => {
  // Catches: the count lost between the runner and the stored errand, so the notice never reaches her.
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-sf-'), 'data') });
  try {
    const config = { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } };
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = createErrandStores({ memoryDb: memory.memoryDb, config: () => config, log: quiet }).get();
    assert.ok(store, 'a store');
    const { errand } = store.add({
      agent: 'scout',
      goal: 'find the notes',
      requester: { accountId: '7', kind: 'member' },
      // The lead: an errand's origin names its place (`placeId`), as the store's type says.
      origin: { placeId: 'c1', messageId: 'm1' },
      scope: 'group',
    });
    const id = String(loose(errand).id);
    store.start(id);
    const done = store.finish(id, { status: 'done', result: { text: 'ok', searchFailures: 2 } });
    assert.equal(loose(loose(done).result).searchFailures, 2);
  } finally {
    void memory.close();
  }
});

test('the result she reads says the web search failed N times, with the count', () => {
  // Catches: a failed web search staying silent in an errand that otherwise looks done.
  const lines = errandResultText(record({ text: 'found', sources: [], files: [], searchFailures: 3 }), labels).split(
    '\n'
  );
  assert.ok(
    lines.includes('The web search failed 3 times.'),
    `the notice is a line of the result: ${JSON.stringify(lines)}`
  );
});

test('the result she reads has no search notice when the count is zero or missing', () => {
  // Catches: the notice printed for every errand.
  for (const searchFailures of [0, undefined]) {
    const text = errandResultText(record({ text: 'found', sources: [], files: [], searchFailures }), labels);
    assert.equal(text.includes('web search'), false);
  }
});

test('a failed errand that counted failed searches still says so beside its error', () => {
  // Catches: the notice kept for done errands only, hiding the likely cause of a run that ended empty.
  const failed = {
    ...record({ text: '', sources: [], files: [], searchFailures: 1 }),
    state: 'failed',
    error: 'empty-answer',
  };
  const text = errandResultText(failed as unknown as Parameters<typeof errandResultText>[0], labels);
  assert.ok(text.includes('error: empty-answer'));
  assert.ok(text.includes('The web search failed 1 times.'));
});
