// Tests for src/turn/intention-notice.ts: the notice before a heartbeat's intention is saved (docs/inner-life.md
// "Heartbeat"), over the real turn runner of tests/fixtures/service-turn.ts. A purpose near a post of the persona's
// saves nothing and reads the evidence, a call that confirms the notice saves the held intention, a changed purpose
// near nothing saves, a failed embedder saves with a warn line, and a chat turn and shadow mode keep their own ways.
// The fake embedder answers fixed vectors by the words of a text; no network, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleModel } from '../../../src/llm/roles.ts';
import { noticeText } from '../../../src/turn/intention-notice.ts';
import type { PastAct, PastRun } from '../../../src/memory/db/past-acts.ts';
import { quantize } from '../../../src/memory/vectors.ts';
import { writeIntentions } from '../../../src/memory/db/intentions-write.ts';
import { finishRun, startRun } from '../../../src/memory/db/wakes.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { addLine } from '../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { useIface } from '../../fixtures/turn-world.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { fill } from '../../../src/format.ts';
import { handleOf } from '../../../src/behavior/handles.ts';
import { TURN_NOW, ZOE, replyRun, serviceTurn, serviceWake, serviceWorld } from '../../fixtures/service-turn.ts';
import type { EmbedNotice } from '../../fixtures/service-turn.ts';

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

/** The fake embedder: one vector per text by its subject. */
function embedder(): EmbedNotice {
  return (texts) => Promise.resolve(texts.map(vectorOf));
}

/** The service world with a post of the persona's about the concert in the garden twenty days ago, its vector stored. */
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
      `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, occurred_at, kind, place_id)
       VALUES ((SELECT rowid FROM sources WHERE id = 'old1'), 'old1', 'record:old1:1', ?, 4, ?, ?, ?, ?, 'record',
         'fake:server:g1')`
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

/** The purposes an intention service holds, every one. */
const listed = (service: { list: (where: { all: boolean }) => Array<{ purpose: string }> }): Array<string> =>
  service.list({ all: true }).map((one) => one.purpose);

const purposes = (run: Awaited<ReturnType<typeof heartbeat>>): Array<string> => listed(run.intentions);

test("a heartbeat intention near an earlier post of the persona's is not saved and the post is shown", async () => {
  // Bug: the intention is saved at once and the persona never sees that they posted the same thing twenty days ago.
  const run = await heartbeat([
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
    '<skip/>',
  ]);
  assert.deepEqual(run.actions, ['intention.set:refused:intention-notice']);
  assert.deepEqual(purposes(run), []);
  const [, second] = run.requests;
  assert.ok(second?.includes(OLD_POST), 'the second request shows the post');
});

test('the notice names the place of a post by the handle <places> lists, with none of its description', async () => {
  // Bug: the notice writes the place's full reference, its kind, name, server and interface, which <places> holds.
  const run = await heartbeat([
    toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]),
    '<skip/>',
  ]);
  const second = run.requests[1] ?? '';
  const line = second.split('\n').find((one) => one.includes(OLD_POST)) ?? '';
  const handle = /#[\p{L}\p{N}_]+/u.exec(line)?.[0] ?? 'none';
  const places = /<places>\n([\s\S]*?)\n<\/places>/.exec(second)?.[1] ?? '';
  assert.ok(
    places.split('\n').some((entry) => entry.startsWith(`- ${handle}`) || entry.includes(`${handle}:`)),
    `${handle} in <places>`
  );
  for (const part of ['κήπος', 'Αγορά', 'fake']) assert.ok(!line.includes(part), line);
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

test('a purpose near nothing the persona did is saved with no notice', async () => {
  // Bug: every heartbeat intention gets a notice, whatever lies near it.
  const run = await heartbeat([toolAnswer(THINK, [call('intention.set', { due: '1h', text: GARDENING })]), '<skip/>']);
  assert.deepEqual(run.actions, ['intention.set:executed:ok']);
  assert.deepEqual(purposes(run), [GARDENING]);
});

test('with the embedder failing the intention is saved and a warn line names the stage', async () => {
  // Bug: a broken check blocks the persona's intention, or it saves silently and nobody learns the check is down.
  const run = await heartbeat(
    [toolAnswer(THINK, [call('intention.set', { due: '1h', text: `${CONCERT} ξανά` })]), '<skip/>'],
    {
      embedNotice: () => Promise.reject(Object.assign(new Error('down'), { code: 'http' })),
    }
  );
  assert.deepEqual(run.actions, ['intention.set:executed:ok']);
  const warned = run.logs.filter((line) => line.level === 'warn' && line.stage === 'embed');
  assert.equal(warned.length, 1, JSON.stringify(run.logs.filter((line) => line.level === 'warn')));
});

test('a heartbeat intention for a direct chat the persona wrote first in lists that, with the embedder failing', async () => {
  // Bug: the persona writes first into a direct chat again with no word of the last time and its silence, or the fact
  // waits on an embedding it does not need.
  const world = concertWorld();
  const record = { id: 'h1', purpose: 'ΣΚΟΠΟΣ-h1', status: 'done', createdAt: TURN_NOW - 3 * DAY, origin: 'heartbeat' };
  writeIntentions(world.db, { op: 'archive', records: [record] }, new Date(TURN_NOW).toISOString());
  const inputs = { wakes: [], intentions: [{ id: 'h1', updatedAt: null }], facts: [], placeId: null };
  startRun(world.handle, { id: 'turn:h1', kind: 'intention_due', startedAt: TURN_NOW - 2 * DAY, inputs });
  finishRun(world.handle, { id: 'turn:h1', status: 'succeeded', outcome: 'spoke', finishedAt: TURN_NOW - 2 * DAY });
  addLine(world.db, {
    id: 'h1-line',
    iface: 'fake',
    place: 'fake:dm:5678',
    author: 'self',
    text: 'ΓΡΑΜΜΗ-h1',
    at: new Date(TURN_NOW - 2 * DAY).toISOString(),
    turn: 'turn:h1',
  });
  const labels = shippedLabels as unknown as { heartbeat: { notice: Record<string, string> } };
  let place = 'none';
  try {
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [
        // The direct chat by the handle its entry of `<places>` opens with.
        (request: string) => {
          place = new RegExp(`(#\\w+): dm with @${handleOf(ZOE)}`).exec(request)?.[1] ?? 'none';
          return toolAnswer(THINK, [call('intention.set', { due: '1h', text: GARDENING, place })]);
        },
        '<skip/>',
      ],
      chat: null,
      world,
      embedNotice: () => Promise.reject(Object.assign(new Error('down'), { code: 'http' })),
    });
    assert.deepEqual(run.actions, ['intention.set:refused:intention-notice']);
    const { notice } = labels.heartbeat;
    const first = fill(notice.firstLines ?? 'none', { place, days: 30, count: 1, date: '2026-10-31' });
    const second = run.requests[1] ?? '';
    assert.ok(second.includes(first), second);
  } finally {
    world.close();
  }
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
    assert.deepEqual(listed(run.intentions), [`${CONCERT} ξανά`]);
  } finally {
    world.close();
  }
});

/** The notice of one intention of `status` that no run carried, under labels that mark which wording was chosen. */
function noRunNotice(status: string): string {
  const act: PastAct = { kind: 'intention', id: 'i1', score: 0.9, at: TURN_NOW, status, purpose: 'Π', runs: [] };
  const labels = { heartbeat: { notice: { intention: '{state}', notRun: 'NOT-YET', noRunRecorded: 'NO-RECORD' } } };
  return noticeText([act], { id: 'notice-1', labels, timezone: 'UTC', placeName: (id) => id, personName: () => null });
}

test('a closed intention no run names says the record holds no turn, and an open one that it is not carried out yet', () => {
  // Bug: a done intention older than the record of runs reads as never carried out, which contradicts its state.
  assert.ok(noRunNotice('done').includes('NO-RECORD'));
  assert.ok(!noRunNotice('done').includes('NOT-YET'));
  assert.ok(noRunNotice('pending').includes('NOT-YET'));
});

/** The notice of one done intention carried by `runs`, under labels that mark each clause and its count. */
function runsNotice(runs: Array<PastRun>): string {
  const act: PastAct = { kind: 'intention', id: 'i1', score: 0.9, at: TURN_NOW, status: 'done', purpose: 'Π', runs };
  const notice = {
    intention: '{state}',
    run: 'SENT {sent} {date}',
    runs: 'SENT {sent} {date} x{count}',
    runSilent: 'SILENT {date}',
    runsSilent: 'SILENT {date} x{count}',
    noAnswer: 'NA',
    dayQuiet: 'DQ',
    answers: 'A',
    answersUnnamed: 'A',
    dayLines: 'DL',
  };
  return noticeText([act], {
    id: 'notice-1',
    labels: { heartbeat: { notice } },
    timezone: 'UTC',
    placeName: (id) => id,
    personName: () => null,
  });
}

test('two silent runs of one day are one clause that names two turns', () => {
  // Bug: the line repeats "the turn that carried it out on that day sent nothing" once per run.
  const silent: PastRun = { at: TURN_NOW, status: 'succeeded', sent: 0, placeIds: [], after: null };
  const notice = runsNotice([silent, { ...silent, at: TURN_NOW + 60_000 }]);
  assert.equal(notice.split('SILENT').length - 1, 1, notice);
  assert.ok(notice.includes('x2'), notice);
});

test('a silent run and a run that sent a line stay two clauses in their order', () => {
  // Bug: runs that differ are folded into one clause and one of them is lost.
  const silent: PastRun = { at: TURN_NOW, status: 'succeeded', sent: 0, placeIds: [], after: null };
  const after = { answers: 0, answeredBy: [], lines: 0, direct: false, people: 0 };
  const notice = runsNotice([silent, { ...silent, at: TURN_NOW + 60_000, sent: 1, placeIds: ['c1'], after }]);
  assert.ok(notice.indexOf('SILENT') >= 0 && notice.indexOf('SILENT') < notice.indexOf('SENT 1'), notice);
  assert.ok(!notice.includes(' x'), notice);
});
