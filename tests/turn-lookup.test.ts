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
      store: { listUserProfiles: () => [] },
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
        // The channel by its id; its tree is `placeId` (plan 2026-11-05 T.4).
        channel: { id: 'same-room' },
        placeId: 'g1',
        place: { id: 'g1' },
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

test('prefetch memoization retains qualified history identity as well as the issued context', async () => {
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:qualified-history', now: () => NOW });
  const loaded: Array<unknown> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: { complete: () => Promise.reject(new Error('prefetch does not classify')) },
    clock: () => NOW,
    recall: {
      prefetch: (args) => {
        loaded.push(args.historyRef);
        return Promise.resolve({ status: 'ok', excerpts: [`load-${loaded.length}`] });
      },
    },
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: rig().reads,
    classifierContext: () => {
      throw new Error('prefetch does not classify');
    },
    linkCalls: () => {
      throw new Error('the recording loader does not decorate');
    },
  });
  const start = (historyRef: { iface: string; conversationId: string }) => {
    const pending = lookup.startPrefetch({
      config: config(),
      channel: { id: 'same-room' },
      placeId: 'g1',
      place: { id: 'g1' },
      trigger: { id: 'same-trigger', authorId: 'asker' },
      candidate: { content: 'θυμάσαι το κουνέλι στον κήπο', authorId: 'asker' },
      triggerKind: 'mention',
      mode: 'reply',
      history: [],
      selfId: 'self',
      selfName: 'Synthetic persona',
      memoryContext: context,
      historyRef,
    });
    if (!pending) throw new Error('valid prefetch did not start');
    return pending.pending;
  };
  const first = { iface: 'first', conversationId: 'same-room' };
  const otherInterface = { iface: 'second', conversationId: 'same-room' };
  const otherConversation = { iface: 'second', conversationId: 'different-room' };
  assert.deepEqual(await start(first), { status: 'ok', excerpts: ['load-1'] });
  assert.deepEqual(await start(first), { status: 'ok', excerpts: ['load-1'] });
  assert.deepEqual(await start(otherInterface), { status: 'ok', excerpts: ['load-2'] });
  assert.deepEqual(await start(otherConversation), { status: 'ok', excerpts: ['load-3'] });
  assert.deepEqual(await start(otherConversation), { status: 'ok', excerpts: ['load-3'] });
  assert.deepEqual(loaded, [first, otherInterface, otherConversation]);
});

test('the owner chat fetches no partner from the community', async () => {
  // Bug: a chat turn asked the platform for the member `owner`, which got an http-400 and a warning on every line.
  const asked: Array<unknown> = [];
  const lookup = createLookup({
    hot: { prompts: { labels } },
    store: { listUserProfiles: () => [] },
    llm: { complete: () => Promise.reject(new Error('no model here')) },
    clock: () => NOW,
    recall: null,
    membersOf: null,
    selfIdOf: () => 'self',
    ifaceReads: {
      ...rig().reads,
      memberInfo: (member: unknown) => {
        asked.push(member);
        return Promise.resolve(null);
      },
    },
    classifierContext: () => {
      throw new Error('no classifier here');
    },
    linkCalls: () => {
      throw new Error('no links here');
    },
  });
  const partner = await lookup.privatePartner({ iface: 'cli', placeId: 'g1', accountId: 'owner', config: {} });
  assert.equal(partner, null);
  assert.deepEqual(asked, []);
  await lookup.privatePartner({ iface: 'discord', placeId: 'g1', accountId: 'u1', config: {} });
  assert.equal(asked.length, 1);
});
