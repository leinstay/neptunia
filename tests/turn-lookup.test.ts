import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, type Lookup } from '../src/turn/lookup.ts';
import { issueContext, type Context } from '../src/memory/db/scope.ts';
import { rig } from './fixtures/reads-rig.ts';
import { config, NOW } from './fixtures/recall-run-kit.ts';
import { labels } from './fixtures/labels.ts';

for (const direction of ['ordinary-first', 'internal-first'] as const) {
  test(`prefetch separates the same trigger by issued context when ${direction}`, async () => {
    const ordinary = issueContext({ kind: 'group', iface: 'fake', newId: () => 'ctx:ordinary', now: () => NOW });
    const internal = issueContext({ kind: 'internal', newId: () => 'ctx:owner', now: () => NOW });
    const contexts: Array<unknown> = [];
    const lookup = createLookup({
      hot: { prompts: { labels } },
      store: {},
      llm: {
        complete: () => Promise.reject(new Error('prefetch does not classify')),
      },
      clock: () => NOW,
      recall: {
        prefetch: (args) => {
          contexts.push(args.memoryContext);
          return Promise.resolve({
            status: 'ok',
            excerpts: [args.memoryContext === internal ? 'private-evidence' : 'public-evidence'],
          });
        },
      },
      membersOf: null,
      selfIdOf: () => 'self',
      ifaceReads: rig().reads,
      classifierContext: () => {
        throw new Error('prefetch does not classify');
      },
      linkCalls: () => {
        throw new Error('the recording recall does not decorate');
      },
    });
    const start = (memoryContext: Context) => {
      const input: Parameters<Lookup['startPrefetch']>[0] = {
        config: config(),
        channel: { id: 'same-room', communityId: 'g1' },
        guildId: 'g1',
        guild: { id: 'g1' },
        trigger: { id: 'same-trigger', authorId: 'asker' },
        candidate: { content: 'θυμάσαι το κουνέλι στον κήπο', authorId: 'asker' },
        triggerKind: 'mention',
        mode: 'reply',
        history: [],
        selfId: 'self',
        selfName: 'Nova',
        memoryContext,
      };
      const pending = lookup.startPrefetch(input);
      assert.ok(pending);
      return pending.pending;
    };
    const first = direction === 'ordinary-first' ? ordinary : internal;
    const second = direction === 'ordinary-first' ? internal : ordinary;
    assert.deepEqual(await start(first), {
      status: 'ok',
      excerpts: [first === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(await start(second), {
      status: 'ok',
      excerpts: [second === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(await start(second), {
      status: 'ok',
      excerpts: [second === internal ? 'private-evidence' : 'public-evidence'],
    });
    assert.deepEqual(contexts, [first, second]);
  });
}
