// src/turn/request/head.ts when the DM partner has private memory and no public profile: the request shows that memory
// under the partner's name. Plan 2026-11-04-cli-and-memory task 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from './fixtures/built-request.ts';
import { MIN, NOW, baseInput, fakePrompts, makeMessage } from './fixtures/prompt-rig.ts';

test('a partner known only from the DM is shown under the name of the trigger, with the private text', () => {
  // Bug: the merged profile has no name or id, so the request carries the heading `## undefined`.
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice' });
  const request = buildRequest(
    baseInput({
      history: [trigger],
      trigger,
      triggerKind: 'private',
      prompts: fakePrompts({ private: 'PRIVATE_TASK' }),
      privateChat: { accountId: 'u1' },
      interlocutor: null,
      privateProfile: { relationship: 'PRIVATE_REL', affinity: { score: 5, reason: 'kind', history: [] } },
    })
  );
  const sent = JSON.stringify(request.messages);
  assert.ok(sent.includes('PRIVATE_REL'));
  assert.ok(sent.includes('## Alice'));
  assert.equal(sent.includes('## undefined'), false);
});

test('a partner with no private memory and no public profile gets no profile', () => {
  // Bug: the identity the trigger supplies becomes a profile of nobody, heading and all.
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice' });
  const request = buildRequest(
    baseInput({
      history: [trigger],
      trigger,
      triggerKind: 'private',
      prompts: fakePrompts({ private: 'PRIVATE_TASK' }),
      privateChat: { accountId: 'u1' },
      interlocutor: null,
      privateProfile: null,
    })
  );
  assert.equal(JSON.stringify(request.messages).includes('## Alice'), false);
});
