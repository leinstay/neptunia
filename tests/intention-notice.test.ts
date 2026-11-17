// The notice before a heartbeat's intention is saved (src/turn/intention-notice.ts, docs/inner-life.md "Heartbeat"),
// over the real turn runner of tests/fixtures/service-turn.ts: a purpose near a post of hers saves nothing and reads the
// evidence, a call that confirms the notice saves the held intention, a changed purpose near nothing saves, a failed
// embedder saves with a warn line, and a chat turn and shadow mode keep their own ways. The fake embedder answers fixed
// vectors by the words of a text; no network, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleModel } from '../src/llm/roles.ts';
import { quantize } from '../src/memory/vectors.ts';
import { chainsOnDefaults } from './fixtures/chains.ts';
import { addLine } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { TURN_NOW, replyRun, serviceTurn, serviceWake, serviceWorld } from './fixtures/service-turn.ts';
import type { EmbedNotice } from './fixtures/service-turn.ts';

useIface('fake');

const DAY = 86_400_000;
const THINK = '<think>STEP 4. So: this.</think>';
/** The model the rig's settings give the embedding role, which the stored vectors carry. */
const MODEL = roleModel({ models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) } }, 'embedding', 'recall-query');
const CONCERT = 'ΣΥΝΑΥΛΙΑ';
const OLD_POST = 'ΠΑΛΙΑ-ΑΝΑΡΤΗΣΗ-ΓΙΑ-ΣΥΝΑΥΛΙΑ';
const GARDENING = 'ΚΗΠΟΥΡΙΚΗ';

/** A vector by the subject a text names: the concert, gardening or anything else. */
const vectorOf = (text: string): Array<number> =>
  text.includes(CONCERT) ? [1, 0, 0, 0] : text.includes(GARDENING) ? [0, 1, 0, 0] : [0, 0, 1, 0];

/** The fake embedder: one vector per text by its subject, the requests it got counted in `asked`. */
function embedder(asked: Array<Array<string>> = []): EmbedNotice {
  return (texts) => {
    asked.push(texts);
    return Promise.resolve(texts.map(vectorOf));
  };
}

/** The service world with a post of hers about the concert in the garden twenty days ago, its vector stored. */
function concertWorld(): World {
  const world = serviceWorld();
  const at = new Date(TURN_NOW - 20 * DAY).toISOString();
  addLine(world.db, {
    id: 'old1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'self',
    text: OLD_POST,
    at,
    turn: 'turn:old',
  });
  const { bytes, scale, norm } = quantize(vectorOf(OLD_POST));
  world.db
    .prepare(
      `INSERT INTO vectors (item_id, chunk_key, model, dims, scale, norm, bytes, occurred_at, kind, place_id)
       VALUES ('old1', 'record:old1:1', ?, 4, ?, ?, ?, ?, 'record', 'fake:server:g1')`
    )
    .run(MODEL ?? '', scale, norm, new Uint8Array(bytes.buffer), at);
  return world;
}

/** The id a notice in `request` gives for its confirming call. */
const noticeId = (request: string): string => /notice-\d+/.exec(request)?.[0] ?? 'none';

/** A heartbeat over the concert world answered by `answers`. */
async function heartbeat(answers: ReadonlyArray<unknown>, extra: { embedNotice?: EmbedNotice; shadow?: boolean } = {}) {
  const world = concertWorld();
  try {
    return await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers,
      chat: null,
      world,
      embedNotice: extra.embedNotice ?? embedder(),
      ...(extra.shadow === undefined ? {} : { shadow: extra.shadow }),
    });
  } finally {
    world.close();
  }
}

const purposes = (run: Awaited<ReturnType<typeof heartbeat>>): Array<string> =>
  run.intentions.list({ all: true }).map((one) => one.purpose);

test('a heartbeat intention near an earlier post of hers is not saved and she reads the post', async () => {
  // Bug: the intention is saved at once and she never sees that she posted the same thing twenty days ago.
  const run = await heartbeat([
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
    '<skip/>',
  ]);
  assert.deepEqual(run.actions, ['intention.set:refused:intention-notice']);
  assert.deepEqual(purposes(run), []);
  assert.ok(run.requests[1]?.includes(OLD_POST), 'the second request shows the post');
});

test('the call that confirms a notice saves the held intention and reads no second notice', async () => {
  // Bug: the confirming call is checked again and noticed again, or it saves an intention with no purpose.
  const run = await heartbeat([
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
    (request: string) => toolAnswer(THINK, [call('intention.set', { confirm: noticeId(request) })]),
    '<skip/>',
  ]);
  assert.deepEqual(run.actions, ['intention.set:refused:intention-notice', 'intention.set:executed:ok']);
  assert.deepEqual(purposes(run), [`${CONCERT} ξανά`]);
});

test('a changed purpose near nothing is saved at once after a notice', async () => {
  // Bug: the second call is noticed again with the same evidence, so a change can never save.
  const run = await heartbeat([
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${GARDENING} με τη Ζωή` })]),
    '<skip/>',
  ]);
  assert.deepEqual(run.actions, ['intention.set:refused:intention-notice', 'intention.set:executed:ok']);
  assert.deepEqual(purposes(run), [`${GARDENING} με τη Ζωή`]);
});

test('a purpose near nothing she did is saved with no notice, in one embedding request', async () => {
  // Bug: every heartbeat intention gets a notice, or the check embeds the purpose and her intentions in two requests.
  const asked: Array<Array<string>> = [];
  const run = await heartbeat([toolAnswer(THINK, [call('intention.set', { due: '1h', text: GARDENING })])], {
    embedNotice: embedder(asked),
  });
  assert.deepEqual(run.actions, ['intention.set:executed:ok']);
  assert.deepEqual(purposes(run), [GARDENING]);
  assert.equal(asked.length, 1);
});

test('with the embedder failing the intention is saved and a warn line names the stage', async () => {
  // Bug: a broken check blocks her intention, or it saves silently and nobody learns the check is down.
  const run = await heartbeat([toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })])], {
    embedNotice: () => Promise.reject(Object.assign(new Error('down'), { code: 'http' })),
  });
  assert.deepEqual(run.actions, ['intention.set:executed:ok']);
  const warned = run.logs.filter((line) => line.level === 'warn' && line.stage === 'embed');
  assert.equal(warned.length, 1, JSON.stringify(run.logs.filter((line) => line.level === 'warn')));
});

test('in shadow mode the first call reads the notice and the confirming call is proposed', async () => {
  // Bug: shadow proposes the first call before the check, so the simulator never sees the notice a live turn reads.
  const run = await heartbeat(
    [
      toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
      (request: string) => toolAnswer(THINK, [call('intention.set', { confirm: noticeId(request) })]),
      '<skip/>',
    ],
    { shadow: true }
  );
  assert.deepEqual(run.actions, ['intention.set:refused:intention-notice', 'intention.set:proposed:shadow']);
});

test('an intention set in a chat turn near the same post is saved with no notice', async () => {
  // Bug: the notice reaches every turn, so a promise made to someone in a chat is held back.
  const world = concertWorld();
  try {
    const run = await replyRun({
      world,
      embedNotice: embedder(),
      steps: [
        {
          trigger: { id: 'm1', text: 'θα έρθεις;', at: TURN_NOW - 60_000 },
          answers: [toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]), '<skip/>'],
        },
      ],
    });
    assert.deepEqual(
      run.intentions.list({ all: true }).map((one) => one.purpose),
      [`${CONCERT} ξανά`]
    );
  } finally {
    world.close();
  }
});
