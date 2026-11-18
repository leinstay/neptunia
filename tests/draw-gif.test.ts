// A picture she draws in a chat turn (src/turn/draw-gif.ts) is looked at by her eyes once it is posted, and what they
// saw comes back in the result of her draw.create call, which she reads in her next step (owner, 2026-11-16 and 17).
// The eyes are the injected `describePicture` of the turn runner; the image client, the interface and the model are
// fakes (tests/fixtures/turn-draws.ts). Stand-in labels for the description lines; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageGenError } from '../src/llm/images.ts';
import { CODE } from '../src/tools/codes.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { appended, contentText } from './fixtures/turn-harness.ts';
import type { HotStandIn } from './fixtures/turn-harness.ts';
import { fakeStore } from './fixtures/turn-harness.ts';
import { DRAW_CONFIG, drawTurn, fakeImages } from './fixtures/turn-draws.ts';
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
const DRAW_ANSWERS = [
  toolAnswer('<think>x</think>', [call('draw.create', { people: [], text: 'my laptop' })]),
  '<skip/>',
];

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

// ---------- the people a drawing shows ----------

const PEOPLE = [
  { id: 'u1', names: ['Alice'] },
  { id: 'u2', names: ['Zoë'] },
];

/** A record that keeps every line it is asked to append. */
function keptRecord() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    append: (_placeId: string, appended: ReadonlyArray<Record<string, unknown>>) => {
      lines.push(...appended);
      return Promise.resolve();
    },
  };
}

/** A drawing turn whose call is `args`, with Alice and Zoë known and her said lines kept. */
async function drawWith(args: Record<string, unknown>, extra: Partial<Parameters<typeof drawTurn>[0]> = {}) {
  const record = keptRecord();
  const images = fakeImages();
  const run = await drawTurn({
    answers: [toolAnswer('<think>x</think>', [call('draw.create', { text: 'a picnic', ...args })]), '<skip/>'],
    images,
    store: fakeStore({ profiles: PEOPLE }),
    config: { ...DRAW_CONFIG, features: { record: true } },
    runner: { record },
    ...extra,
  });
  const said = record.lines.filter((line) => line.kind === 'said');
  return { run, images, said };
}

test('a draw.create call without people is refused before anything is drawn', async () => {
  // Bug: the list is optional, she leaves it out, and the picture is stored with nobody in it.
  const { images, run } = await drawWith({ self: true });
  assert.equal(images.calls.length, 0);
  assert.equal(pictures(run).length, 0);
});

test('a handle nobody goes by refuses the call before the drawing model is asked', async () => {
  // Bug: an unknown name is dropped and the picture is drawn and stored without the person she meant.
  const { images, run } = await drawWith({ self: false, people: ['Alice', 'Nobody'] });
  assert.equal(images.calls.length, 0);
  assert.equal(pictures(run).length, 0);
  const codes = run.logs.filter((entry) => entry.msg === 'skills: called').map((entry): unknown => entry.code);
  assert.deepEqual(codes, [CODE.UNKNOWN_MEMBER]);
});

test('an empty list with self true marks the drawing as hers showing herself alone', async () => {
  // Bug: her self-portrait reaches memory with no mark, and she later reads it as a stranger's picture.
  const { said } = await drawWith({ self: true, people: [] });
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]?.marks, { self: true, accounts: [] });
});

test('two handles with self false mark the drawing as showing those two and not her', async () => {
  // Bug: the people she named are lost, or she is put into a picture she is not in.
  const { said } = await drawWith({ self: false, people: ['Alice', 'Zoë'] });
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]?.marks, { self: false, accounts: ['u1', 'u2'] });
});

test('the caption she gets back of her drawing carries the made mark and the people it shows', async () => {
  // Bug: the eyes name a character her design resembles and nothing tells her the picture is of herself and Alice.
  const looking = eyes(SEEN);
  const { run } = await drawWith(
    { self: true, people: ['Alice'] },
    {
      runner: { describePicture: looking.describePicture, record: keptRecord() },
      withHot: (hot) => {
        withSeenLabels(hot);
        const held = hot.prompts.labels as typeof labels;
        hot.prompts.labels = {
          ...held,
          transcript: {
            ...held.transcript,
            mediaMade: '[MADE]',
            mediaDepicts: '[SHOWS {names}]',
            mediaDepictsSelf: 'HERSELF',
          },
        };
      },
    }
  );
  const result = drawResult(run);
  assert.ok(result.includes('[MADE]'), result);
  // The owner's ruling (2026-11-18): a person is written by the handle she can pass to a tool, never by a name.
  // The stand-in store links no person, so Alice's handle is cut from her account, as every block of a request does.
  assert.ok(result.includes(`[SHOWS HERSELF, @${handleOf('u1')}]`), result);
});
