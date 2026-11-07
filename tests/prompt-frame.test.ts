// What the kind of a turn decides in a request (src/turn/request/frame.ts), and what the archive keeps of its blocks
// (src/llm/archive.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { archivedLlm } from '../src/llm/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { readRequests } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';
import { frameInput, wakeInput } from './fixtures/frame-input.ts';
import { baseInput, NOW } from './fixtures/prompt-rig.ts';

test('buildRequest: a heartbeat frame emits no <chat>, whatever the other fields say', () => {
  // The fields disagree on purpose. Bug: the branch still reads `mode` and `wakeKind`, and her own time carries the chat.
  const request = buildRequest(baseInput({ mode: 'reply', frame: frameOf(wakeInput('heartbeat')) }));
  const [, user] = request.messages;
  assert.doesNotMatch(contentText(user.content), /^<chat>$/m);
});

test('buildRequest: a reply frame emits <chat>, whatever the other fields say', () => {
  // The fields disagree on purpose. Bug: the old `mode` and `wakeKind` branch empties the history of a reply.
  const request = buildRequest(baseInput({ mode: 'inner', wakeKind: 'heartbeat', frame: frameOf(frameInput()) }));
  const [, user] = request.messages;
  assert.match(contentText(user.content), /^<chat>$/m);
});

/** Every block of a request's user message as `<segment> <tag>`, read off the text that goes out. */
function emittedBlocks(request: Built): Array<string> {
  const [, user] = request.messages;
  return user.content.flatMap((part) =>
    [...String(part.text).matchAll(/^<([a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm)].map(
      (match) => `${part.cacheSegment ?? 'tail'} ${match[1]}`
    )
  );
}

test('the archive row of a request names every emitted block with its segment, and the provider never sees the list', async () => {
  // Bug: the row lists what a builder meant to emit, or a block of the profiles segment is filed under the tail.
  const request = buildRequest(baseInput({ frame: frameOf(frameInput()) }));
  const handle = openMemoryDb(':memory:');
  try {
    const sent: Array<unknown> = [];
    const llm = archivedLlm(
      {
        complete: (_messages: unknown, options: unknown) => {
          sent.push(options);
          return Promise.resolve({ text: 'ok' });
        },
      },
      {
        write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
        now: () => NOW,
        newId: () => 'r1',
        log: { warn() {} },
      }
    );
    await llm.complete(request.messages, { model: 'm', blocks: request.blocks });
    const [row] = readRequests(dbOf(handle));
    const blocks = JSON.parse(String(row?.blocks)) as Array<{ name: string; chars: number; segment: string }>;
    const named = blocks.filter((one) => one.chars > 0).map((one) => `${one.segment} ${one.name}`);
    assert.deepEqual(named.sort(), emittedBlocks(request).sort());
    assert.equal(Object.hasOwn(sent[0] as object, 'blocks'), false);
  } finally {
    handle.close();
  }
});
