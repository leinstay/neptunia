// A picture she draws in a chat turn (src/turn/draw-gif.ts) is looked at by her eyes once it is posted, and what they
// saw comes back in the result of her draw.create call, which she reads in her next step (owner, 2026-11-16 and 17).
// The eyes are the injected `describePicture` of the turn runner; the image client, the interface and the model are
// fakes (tests/fixtures/turn-draws.ts). Stand-in labels for the description lines; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGenError } from '../src/llm/images.ts';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { appended, contentText } from './fixtures/turn-harness.ts';
import type { HotStandIn } from './fixtures/turn-harness.ts';
import { drawTurn, fakeImages } from './fixtures/turn-draws.ts';
import { asRecord } from './fixtures/records.ts';

const SEEN = 'a laptop with its screen on the outside of the lid';

/** What the turn hands her eyes for one picture. */
type Looked = {
  placeId: string;
  messageId?: string;
  itemId?: string;
  url?: string;
  buffer?: Buffer;
  mediaType?: string;
};

/** Eyes that answer `answer` (an Error is thrown) and keep every picture they were asked about. */
function eyes(answer: string | null | Error) {
  const asked: Array<Looked> = [];
  const describePicture = (picture: Looked): Promise<string | null> => {
    asked.push(picture);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { asked, describePicture };
}

/** The stand-in lines for a description and for a look that failed. */
function withSeenLabels(hot: HotStandIn): void {
  const { tools } = labels;
  hot.prompts.labels = {
    ...labels,
    tools: { ...tools, result: { ...tools.result, seen: 'SEEN {description}', unseen: 'UNSEEN' } },
  };
}

/** The text of her draw.create result in the second request. */
function drawResult(run: Awaited<ReturnType<typeof drawTurn>>): string {
  return contentText(appended(run.llm, 1).find((message) => message.role === 'tool')?.content);
}

/** The sends that carried a picture. */
const pictures = (run: Awaited<ReturnType<typeof drawTurn>>) =>
  run.sends.filter((send) => asRecord(send.attachments)?.length === 1);

const { ok: okLabel } = labels.tools.result;
const DRAW_ANSWERS = [toolAnswer('<think>x</think>', [call('draw.create', { text: 'my laptop' })]), '<skip/>'];

test('a posted picture is looked at once and what her eyes saw is in the result she reads next', async () => {
  // Bug: draw.create answers ok with the reference alone, and she reads laughter at a broken picture as praise.
  const looking = eyes(SEEN);
  const run = await drawTurn({
    answers: DRAW_ANSWERS,
    runner: { describePicture: looking.describePicture },
    withHot: withSeenLabels,
  });
  const { calls } = run.llm;
  assert.equal(calls.length, 2);
  assert.equal(looking.asked.length, 1, 'one look per picture');
  const [firstLook] = looking.asked;
  assert.equal(firstLook?.placeId, 'c1');
  const result = drawResult(run);
  assert.ok(result.startsWith(okLabel), result);
  assert.ok(result.includes(`SEEN ${SEEN}`), result);
});

for (const [name, answer] of [
  ['answer nothing', null],
  ['throw', new Error('vision down')],
] as const) {
  test(`when her eyes ${name}, the picture is still posted, the call is ok and the result says it could not be looked at`, async () => {
    // Bug: a failed look fails the call of a picture already posted, or leaves her to assume it came out as asked.
    const looking = eyes(answer);
    const run = await drawTurn({
      answers: DRAW_ANSWERS,
      runner: { describePicture: looking.describePicture },
      withHot: withSeenLabels,
    });
    assert.equal(pictures(run).length, 1);
    const result = drawResult(run);
    assert.ok(result.startsWith(okLabel), result);
    assert.ok(result.includes('UNSEEN'), result);
    assert.equal(result.includes('SEEN '), false, result);
  });
}

test('with no eyes the result names neither a description nor a failed look', async () => {
  // Bug: vision off is told to her as a failed look on every picture she draws.
  const run = await drawTurn({ answers: DRAW_ANSWERS, withHot: withSeenLabels });
  assert.equal(pictures(run).length, 1);
  const result = drawResult(run);
  assert.equal(result.includes('SEEN'), false, result);
});

test('a refused generation asks her eyes nothing', async () => {
  // Bug: the look runs on a picture that does not exist and spends a vision request on nothing.
  const looking = eyes(SEEN);
  const run = await drawTurn({
    answers: DRAW_ANSWERS,
    images: fakeImages([new ImageGenError('moderation')]),
    runner: { describePicture: looking.describePicture },
    withHot: withSeenLabels,
  });
  assert.equal(pictures(run).length, 0);
  assert.equal(looking.asked.length, 0);
});
