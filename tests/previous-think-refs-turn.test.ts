// Her previous think carries a `#n` into the next turn of the same place, over the real turn runner with a fake model.
// The number must be the one the new request's `<chat>` gives that line, or be absent when the chat does not show it.
// Synthetic Greek lines only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { NOW, coreTurn, rawMessage, requestText } from './fixtures/turn-harness.ts';

const MIN_MS = 60_000;

/** The fixture's context with `chatLines` lines of chat and a 30-minute window for the previous think. */
const withChatLines = (chatLines: number) => ({
  context: {
    channelMessages: chatLines,
    neighborMessages: 5,
    neighborMaxAgeMinutes: 60,
    neighborMaxChannels: 8,
    maxMessageChars: 800,
    gapMarkerMinutes: 20,
    otherProfiles: 6,
    caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
    vision: {
      maxImages: 2,
      tokensPerImage: 400,
      imageSize: 512,
      recentImages: 0,
      recentImageMinutes: 0,
      maxBytes: 1_500_000,
      fetchTimeoutMs: 10_000,
    },
    pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
    previousThink: { minutes: 30 },
  },
});

const thinkBlock = (text: string) => /<previous_think>\n([\s\S]*?)\n<\/previous_think>/.exec(text)?.[1] ?? null;

/** The `#n` the request's `<chat>` gives the line that reads `words`, null when the chat does not show it. */
function chatNumberOf(text: string, words: string): number | null {
  const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
  const line = chat.split('\n').find((one) => one.includes(words));
  const n = line ? /^#(\d+)/.exec(line)?.[1] : undefined;
  return n === undefined ? null : Number(n);
}

/**
 * Two turns in #general: the first answers `βρες κάτι` with a think that names that line by the `#n` its request gave
 * it, her reply goes out, and Zoë and Alice write two more lines, the last of which starts the second turn.
 */
async function thinkAcrossTurns(chatLines: number) {
  const clock = { t: NOW };
  const earlier = ['ένα', 'δύο'].map((content, i) =>
    rawMessage({ id: `e${i}`, ts: NOW - 9000 + i * 1000, authorId: 'u2', authorName: 'Zoë', content })
  );
  const firstAnswer = (request: Array<{ content?: unknown }>) => {
    const n = chatNumberOf(userText(request[1]?.content), 'βρες κάτι');
    return `<think>Alice asked at #${String(n)}</think><msg>ναι</msg>`;
  };
  const run = await coreTurn({
    answers: [firstAnswer, '<skip/>'],
    earlier,
    config: withChatLines(chatLines),
    runner: { now: () => clock.t },
    onAnswer: (index, history) => {
      if (index !== 0) return;
      history.push(rawMessage({ id: 'm2', ts: NOW + MIN_MS, authorId: 'u2', authorName: 'Zoë', content: 'το βιβλίο' }));
      history.push(rawMessage({ id: 'm3', ts: NOW + 2 * MIN_MS, content: 'και τώρα;' }));
    },
  });
  clock.t = NOW + 3 * MIN_MS;
  await withCapturedLogs(() => run.again());
  return { first: requestText(run.llm, 0), second: requestText(run.llm, 1) };
}

test('a #n in the carried think is the number the same request gives that line in <chat>', async () => {
  // Bug: the store kept her think with the numbers of the request it was written in, so after her reply and two more
  // lines the carried `#n` named another line of the new transcript.
  const { first, second } = await thinkAcrossTurns(4);
  const before = chatNumberOf(first, 'βρες κάτι');
  const now = chatNumberOf(second, 'βρες κάτι');
  assert.ok(before !== null && now !== null && before !== now, `the line moved: #${before} then #${now}`);
  const carried = thinkBlock(second) ?? '';
  assert.deepEqual(
    [...carried.matchAll(/#(\d+)/g)].map((match) => Number(match[1])),
    [now],
    carried
  );
});

test('a line the new <chat> no longer shows leaves no #n in the carried think', async () => {
  // Bug: the old number stayed in the think and named whichever line holds it in the new transcript.
  const { second } = await thinkAcrossTurns(2);
  assert.equal(chatNumberOf(second, 'βρες κάτι'), null, 'the line is out of the window');
  const carried = thinkBlock(second) ?? '';
  assert.ok(carried.includes('Alice asked at'), carried);
  assert.doesNotMatch(carried, /#\d/);
});
