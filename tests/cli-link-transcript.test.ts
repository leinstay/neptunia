// bin/cli-link.ts: the lines of a resumed conversation answer the core's history reads, in place of this session's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/wire.ts';
import { openLinkOver } from '../bin/cli-link.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';

test('showLines replaces the transcript, keeps native ids and marks her lines as hers', () => {
  // Bug: a branch shows on the screen while the model still gets the lines past the boundary.
  const { client } = createLoopback();
  const transcript: Array<MessageEvent> = [];
  const link = openLinkOver(client, { token: 't', print: null, transcript });
  void link.say('a line of this session');
  link.showLines([
    { id: 's1', at: 10, who: 'owner', text: 'stored', nativeId: 'n1' },
    { id: 's2', at: 20, who: 'her', text: 'reply' },
  ]);
  assert.deepEqual(
    transcript.map((event) => [event.message.id, event.message.content, event.message.author?.self]),
    [
      ['n1', 'stored', false],
      ['s2', 'reply', true],
    ]
  );
  link.close();
});
