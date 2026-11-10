// The service turns on the template of the turn frame (plan 2026-11-06-turn-frame, slice 5, "The services as one
// template" and "The service trees"): a heartbeat and a selfimprovement wake run with `chat: null`, their
// request holds the service list (no `<chat>`, no `<surroundings>`), `<meanwhile>` holds her last
// `context.memory.serviceMessages` lines over the rooms of every group of every interface and no direct chat, and
// `<memory>` reads as herself. tests/inner-turn.test.ts is near the file length limit, so these live here.
// The shapes the specifier chose:
//   runTurn({ chat: null, mode: 'inner', triggerKind: 'inner', inner: { wake, currentChannel, shadow, mayAct } })
//     is a service turn nowhere; the wake carries a selfimprovement wake's facts under `wake.selfimprovement`
//     (SelfimprovementFacts of src/behavior/selfimprovement-view.ts), as the drain hands them today.
//   `<work>` and `<board>` are subtags of `<inner>`; `<work>` states its window with the first day as `formatDate`
//     writes it in the shipped labels' locale, and every line of a shape, a repeat or a failure names a turn id.
//   The persona's journal is read at `journal.read(PERSONA_ID, { day, kind: 'turn' })`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATION_REQUIRED } from '../src/behavior/inner-output.ts';
import type { SelfimprovementFacts } from '../src/behavior/selfimprovement-view.ts';

import { formatDate } from '../src/format.ts';
import { PERSONA_ID } from '../src/memory/db/storage-keys.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { MARK, TEXT, TURN_NOW, blockOf, rootTags, serviceTurn, serviceWake } from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

useIface('fake');

const DAY = 86_400_000;
const THINK = '<think>STEP 4. So: nothing.</think>';

/** The service list without `persona`, which is the system message and no root tag of the user text. */
const SERVICE_TAGS = blocksOf('heartbeat', null).filter((name) => name !== 'persona');

/** The tags a service request may not omit. */
const ALWAYS = ['self', 'meanwhile', 'spatial_awareness', 'task'];

/** Whether `tags` keep the order of `list` and hold nothing else. */
function inOrderOf(tags: ReadonlyArray<string>, list: ReadonlyArray<string>): boolean {
  let at = -1;
  for (const tag of tags) {
    const next = list.indexOf(tag, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

test('a heartbeat request holds the service list in its order, with no <chat> and no <surroundings>', async () => {
  // Bug: the heartbeat keeps the old `<wake>` emission, or the chat and surroundings of a stand-in chat.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const text = run.requests[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, SERVICE_TAGS), tags.join(' '));
  for (const tag of ALWAYS) assert.ok(tags.includes(tag), `holds <${tag}>`);
  assert.ok(text.includes(MARK.heartbeat), 'its own task');
});

test('a selfimprovement request holds the service list too', async () => {
  // Bug: only the heartbeat moves to the template, and selfimprovement keeps `<wake>` and the anchor's chat.
  const run = await serviceTurn({
    wake: serviceWake('selfimprovement', { selfimprovement: facts() }),
    answers: ['<skip/>'],
    chat: null,
  });
  const tags = rootTags(run.requests[0] ?? '');
  assert.ok(inOrderOf(tags, SERVICE_TAGS), tags.join(' '));
  for (const tag of ALWAYS) assert.ok(tags.includes(tag), `holds <${tag}>`);
});

test('<meanwhile> of a heartbeat holds her lines from the groups of two interfaces and none from a direct chat', async () => {
  // Bug: a service reads `context.meanwhile.messages` (8 by default, 1 here) instead of serviceMessages, reads one
  // interface, or lets a private chat into a turn that needs none.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
  assert.ok(meanwhile.includes(TEXT.ownGarden), 'the room of the first interface');
  assert.ok(meanwhile.includes(TEXT.ownHarbour), 'the room of the second interface');
  assert.ok(!meanwhile.includes(TEXT.ownPrivate), 'no direct chat');
});

test('<meanwhile> of a service is cut at context.memory.serviceMessages', async () => {
  // Bug: the new setting is not read and a service shows every line of hers it can find.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: ['<skip/>'],
    chat: null,
    settings: { serviceMessages: 1 },
  });
  const meanwhile = blockOf(run.requests[0] ?? '', 'meanwhile');
  assert.ok(meanwhile.includes(TEXT.ownHarbour), 'her newest group line');
  assert.ok(!meanwhile.includes(TEXT.ownGarden), 'the older one is past the cut');
});

test('<memory> of a heartbeat raised from a group line holds that person private fact, under an origin', async () => {
  // Bug: the service reads memory under a group scope and loses what she knows from a direct chat, or seeds the
  // reader from a chat window it does not have, so the person who wrote beside her line never enters.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const memory = blockOf(run.requests[0] ?? '', 'memory');
  assert.ok(memory.includes(TEXT.eleniSecret), memory);
  const entry = memory.split('\n\n').find((part) => part.includes(TEXT.eleniSecret)) ?? '';
  const origins = Object.values(shippedLabels.memory?.origin ?? {}).filter((value) => typeof value === 'string');
  assert.ok(
    origins.some((origin) => entry.includes(origin)),
    entry
  );
});

test('a heartbeat with no chat reads no history and journals its turn under herself', async () => {
  // Bug: the turn reads the history of a stand-in or a recent room, or its turn record lands in a place's journal.
  const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
  const { port } = run;
  const reads = port.calls.filter((one: { op: string }) => one.op === 'history' || one.op === 'fetchMessages');
  assert.deepEqual(reads, []);
  assert.ok(!(run.requests[0] ?? '').includes(TEXT.roomLine), 'no line of a room as a chat');
  const turns = await run.journal.read(PERSONA_ID, { day: '2026-11-02', kind: 'turn', n: 10 });
  assert.equal(turns.length, 1);
});

test('a tool that takes a place is refused in a heartbeat with no chat when she names none', async () => {
  // Bug: the call falls back to a chat the turn does not have and reads a room nobody named.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [toolAnswer(THINK, [call('conversation.read', {})]), '<skip/>'],
    chat: null,
  });
  const [action = ''] = run.actions;
  const [skill, status, code] = action.split(':');
  assert.equal(skill, 'conversation.read');
  assert.notEqual(status, 'executed', action);
  assert.ok(code !== undefined && code !== '' && code !== 'ok', action);
});

test('a <msg> in a heartbeat carries destination-required', async () => {
  // Bug: a message with no destination goes to a stand-in or to the room the wake rode on.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [`${THINK}<msg>γεια σας</msg>`, '<skip/>'],
    chat: null,
  });
  const post = run.actions.find((action) => action.startsWith('message.create:')) ?? '';
  assert.equal(post.split(':')[2], DESTINATION_REQUIRED.code, post);
  const { port } = run;
  assert.equal(port.calls.filter((one: { op: string }) => one.op === 'send').length, 0);
});

test('a second deciding call in one step of a heartbeat with no chat is still refused', async () => {
  // Bug: the one-change rule is keyed on a chat, so a heartbeat nowhere files two intentions in one step.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      toolAnswer(THINK, [
        call('intention.set', { due: '1h', text: 'πρώτο' }),
        call('intention.set', { due: '2h', text: 'δεύτερο' }),
      ]),
      '<skip/>',
    ],
    chat: null,
  });
  assert.deepEqual(run.actions, ['intention.set:executed:ok', 'intention.set:refused:heartbeat-only']);
  assert.equal(run.intentions.list({ all: true }).length, 1);
});

/** The facts of a selfimprovement wake: two shapes, one repeat and one failure, each with its turn ids. */
function facts(): SelfimprovementFacts {
  const from = TURN_NOW - 9 * DAY;
  return {
    memory: null,
    from,
    days: 9,
    shapes: [
      {
        key: 'memory.search(query)',
        steps: [{ tool: 'memory.search', args: ['query'] }],
        count: 3,
        failures: 1,
        retries: 0,
        costUsd: 0,
        example: { turnId: 'turn:alpha', at: from + DAY },
        turnIds: ['turn:alpha', 'turn:beta', 'turn:gamma'],
      },
      {
        key: 'lore.list()',
        steps: [{ tool: 'lore.list', args: [] }],
        count: 1,
        failures: 0,
        retries: 0,
        costUsd: 0,
        example: { turnId: 'turn:delta', at: from + 2 * DAY },
        turnIds: ['turn:delta'],
      },
    ],
    moreShapes: 0,
    repeated: [{ key: 'memory.search(query)', count: 3, turnIds: ['turn:alpha', 'turn:beta', 'turn:gamma'] }],
    failures: [{ tool: 'memory.search', code: 'timeout', count: 1, turnIds: ['turn:beta'] }],
    unusedTools: [],
    skills: [],
    proposals: [],
    news: { questions: [], reviews: [], outbox: [], landed: [] },
    outboxSeqs: [],
  };
}

test('<work> of a selfimprovement wake sits in <inner>, states its window and names a turn id on every line', async () => {
  // Bug: the work report loses the turn ids the agents need as evidence, or never says which days it covers.
  const given = facts();
  const run = await serviceTurn({
    wake: serviceWake('selfimprovement', { selfimprovement: given }),
    answers: ['<skip/>'],
    chat: null,
  });
  const inner = blockOf(run.requests[0] ?? '', 'inner');
  const work = /<work>\n([\s\S]*?)\n<\/work>/.exec(inner)?.[1] ?? '';
  assert.ok(work !== '', inner);
  assert.ok(work.includes(formatDate(given.from, 'UTC', shippedLabels.locale)), work);
  const ids = ['turn:alpha', 'turn:beta', 'turn:gamma', 'turn:delta'];
  const lines = work.split('\n').filter((line) => line.includes('memory.search') || line.includes('lore.list'));
  assert.ok(lines.length >= 3, work);
  for (const line of lines)
    assert.ok(
      ids.some((id) => line.includes(id)),
      line
    );
});
