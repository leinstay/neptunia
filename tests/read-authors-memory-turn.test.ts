// The people of the lines she reads join her memory (plan 2026-11-08-meta-person, fault 5, second half): after a
// conversation.read, the next step of the turn carries what the graph reader raises from the authors of the lines read,
// cut to the budget of `context.memory`, as a `<memory>` of the read's result. A person the request's own `<memory>`
// already shows is not told twice. An intention turn nowhere over the service world's memory, one room added whose
// author nothing else in the turn raises. Synthetic names, in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { AT, addLine, addPerson, addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import {
  HEARTBEAT_TEXT,
  TURN_NOW,
  heartbeatWorld,
  replyRun,
  serviceTurn,
  serviceWake,
  serviceWorld,
} from './fixtures/service-turn.ts';
import type { ServiceRun } from './fixtures/service-turn.ts';

useIface('fake');

const THINK = '<think>STEP 4. So: do it.</think>';
const NIKOS = 'person:fake:4242';
const RELATION = 'ΦΙΛΟΣ-ΤΟΥ-ΨΑΡΕΜΑΤΟΣ';
const LINE = 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ';

/** An intention turn nowhere whose one step reads `place` (a room's stored name), with `budgetTokens` laid over the memory's settings. */
async function readNowhere(place: string, budgetTokens?: number): Promise<ServiceRun> {
  const world = serviceWorld();
  const pier = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  insertRows(world.db, {
    descriptions: [
      {
        id: 'd:nikos:r',
        subject_kind: 'person',
        subject_id: NIKOS,
        field: 'relationship',
        current_version: 'd:nikos:r:v1',
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
    description_versions: [
      {
        id: 'd:nikos:r:v1',
        description_id: 'd:nikos:r',
        text: RELATION,
        author: 'her',
        written_at: AT,
        chars: RELATION.length,
        origin: 'review',
      },
    ],
  });
  addLine(world.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: LINE,
    at: new Date(TURN_NOW - 10 * 60_000).toISOString(),
  });
  const due = { id: '' };
  try {
    return await serviceTurn({
      world,
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΔΙΑΒΑΣΕ', dueAt: TURN_NOW - 60_000 }],
          chainId: due.id,
        }),
      seed: (service) => {
        const made = service.set({ purpose: 'ΔΙΑΒΑΣΕ', dueAt: TURN_NOW - 60_000, by: 'persona' }) as {
          intention?: { id: string };
        };
        due.id = made.intention?.id ?? '';
      },
      answers: [toolAnswer(THINK, [call('conversation.read', { place, last: 10 })]), '<skip/>'],
      chat: null,
      ...(budgetTokens === undefined ? {} : { settings: { budgetTokens } }),
    });
  } finally {
    world.close();
  }
}

/** The part of the second request after the line the read returned: the read's own result. */
function afterTheRead(run: ServiceRun): string {
  const told = run.requests[1] ?? '';
  const at = told.indexOf(LINE);
  assert.ok(at >= 0, told);
  return told.slice(at);
}

test("a read's author comes into the next step's memory with what she knows of them", async () => {
  // Bug: the lines she reads name their authors and nothing more, so she reads a room full of people she knows and
  // remembers none of them until a later turn.
  const run = await readNowhere('μόλος');
  assert.equal((run.requests[0] ?? '').includes(RELATION), false, 'the first request did not know of him');
  const result = afterTheRead(run);
  assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
  assert.ok(result.includes(RELATION), result);
});

test("a read's authors stay within the memory budget, as a name when nothing more fits", async () => {
  // Bug: the authors of a long read pour every stored line about them into the result, past the memory budget.
  const run = await readNowhere('μόλος', 1);
  const result = afterTheRead(run);
  assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
  assert.equal(result.includes(RELATION), false, 'the relation does not fit a budget of one token');
});

test("a person the request's memory already shows is not told again after a read", async () => {
  // Bug: every read repeats the people the request showed already, spending the budget twice on the same person.
  const run = await readNowhere('κήπος');
  const told = run.requests[1] ?? '';
  const at = told.indexOf('ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', (run.requests[0] ?? '').length);
  assert.ok(at >= 0, told);
  assert.equal(/<memory>/.test(told.slice(at)), false, told.slice(at));
});

/** A heartbeat over the heartbeat world whose steps read the yard, where the listed Νίκος wrote, `reads` times. */
async function heartbeatReads(reads: number): Promise<ServiceRun> {
  const world = heartbeatWorld();
  try {
    return await serviceTurn({
      world,
      wake: serviceWake('heartbeat'),
      answers: [
        ...Array.from({ length: reads }, () =>
          toolAnswer(THINK, [call('conversation.read', { place: 'αυλή', last: 10 })])
        ),
        '<skip/>',
      ],
      chat: null,
    });
  } finally {
    world.close();
  }
}

/** The part of request `n` after the last line of the yard the read before it returned. */
function afterYardRead(run: ServiceRun, n: number): string {
  const told = run.requests[n] ?? '';
  const at = told.lastIndexOf(`${HEARTBEAT_TEXT.yardLine}-y2`);
  assert.ok(at >= (run.requests[n - 1] ?? '').length, told);
  return told.slice(at);
}

test("a heartbeat's read brings what memory holds about a person its list showed by one line", async () => {
  // Bug: the heartbeat's list of people marks everyone it names as shown, so a read in the persona's own time never tells what
  // memory holds about the people who wrote the lines.
  const run = await heartbeatReads(1);
  assert.equal(
    (run.requests[0] ?? '').includes(HEARTBEAT_TEXT.nikosRelationRest),
    false,
    'the list holds one sentence'
  );
  const result = afterYardRead(run, 1);
  assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
  assert.ok(result.includes(HEARTBEAT_TEXT.nikosRelationRest), result);
});

test("a heartbeat's second read does not repeat the people its first read told", async () => {
  // Bug: every read of the heartbeat tells the same people again, spending the budget twice on them.
  const run = await heartbeatReads(2);
  assert.ok(afterYardRead(run, 1).includes(HEARTBEAT_TEXT.nikosRelationRest));
  assert.equal(afterYardRead(run, 2).includes('<memory>'), false, afterYardRead(run, 2));
});

test("a reply's read leaves out the person the request showed", async () => {
  // Bug: a read in a reply repeats the person the reply answers, whom the request already shows in full.
  const world = serviceWorld();
  try {
    const run = await replyRun({
      world,
      steps: [
        {
          trigger: { id: 'r1', text: 'ΔΙΑΒΑΣΕ-ΤΟΝ-ΚΗΠΟ', at: TURN_NOW - 60_000 },
          answers: [toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), '<skip/>'],
        },
      ],
    });
    const [first = '', second = ''] = run.requests[0] ?? [];
    assert.ok(first.includes('Ελένη'), 'the request shows her');
    const at = second.indexOf('ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', first.length);
    assert.ok(at >= 0, second);
    assert.equal(second.slice(at).includes('<memory>'), false, second.slice(at));
  } finally {
    world.close();
  }
});
