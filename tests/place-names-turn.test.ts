// A real turn in which the persona reads a channel by a name that is not one place: the choices come back in the same
// tool result, as data she can call again with, and nothing is read. Labels carry markers so the test checks that the
// list is rendered from `labels.tools.tools.place` (docs/prompt-contract.md), never its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { appended, contentText, coreTurn } from './fixtures/turn-harness.ts';

const withPlaceLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...labels.tools.tools,
      place: {
        several: 'SEVERAL-MARK {given} {count}',
        none: 'NONE-MARK {given}',
        line: 'LINE-MARK {ref} {name}',
        more: 'MORE-MARK {count}',
      },
    },
  },
};

async function readChannel(channel: string) {
  const run = await coreTurn({
    answers: [toolAnswer('', [call('conversation.read', { place: channel })]), '<skip/>'],
    allowed: ['conversation.read'],
    neighbours: [
      { id: 'c3', name: '🌿 herbs' },
      { id: 'c4', name: '🌱 Herbs' },
    ],
    prompts: { labels: withPlaceLabels },
  });
  return appended(run.llm, 1)
    .filter((message) => message.role === 'tool')
    .map((message) => contentText(message.content))
    .join('\n');
}

test('conversation.read of a name that fits two channels answers with both as choices', async () => {
  const told = await readChannel('herbs');
  assert.ok(told.includes('SEVERAL-MARK herbs 2'), told);
  assert.ok(told.includes('🌿 herbs') && told.includes('🌱 Herbs'), told);
});

test('conversation.read of a name that fits no channel answers with the channels she may read', async () => {
  const told = await readChannel('memes');
  assert.ok(told.includes('NONE-MARK memes'), told);
  assert.ok(told.includes('jardin') && told.includes('general'), told);
});
