// The request of a reply turn with what she made for the person she answers (spec 2026-11-12 made-and-given, slice 1):
// the counts stand in `<my_day>`, in the tail, and a call of hers changes nothing before `<chat>`, the part the prompt
// cache holds. Reply turns in `c1` of the real turn runner over the service world's memory, whose day rows hold the
// calls (tests/fixtures/service-turn.ts#replyRun), the answer a message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { ELENI, TURN_NOW, replyRun, serviceWorld } from './fixtures/service-turn.ts';
import { useIface } from './fixtures/turn-world.ts';

useIface('fake');

const MIN = 60_000;
const iso = (at: number): string => new Date(at).toISOString();
const PLACE = 'fake:channel:c1';
const SCOPE = { place_id: PLACE, scope_kind: 'group', scope_iface: 'fake' };

/** The day rows of a turn that Ελένη asked (her account's native id is `111`) and of `draws` pictures it made. */
function dayRows(draws: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [
    {
      id: 'ts',
      at: iso(TURN_NOW - 40 * MIN),
      what: 'turn.start',
      turn_id: 't-a',
      extra: JSON.stringify({ trigger: { kind: 'mention', messageId: 'm0', authorId: '111' } }),
      ...SCOPE,
    },
  ];
  for (let i = 0; i < draws; i += 1) {
    const at = TURN_NOW - 30 * MIN + i * 10_000;
    const start = { opId: `o${i}`, name: 'skill', phase: 'started', input: { skill: 'draw.create' } };
    const done = { opId: `o${i}`, name: 'skill', phase: 'succeeded' };
    rows.push(
      { id: `s${i}`, at: iso(at), what: 'action', turn_id: 't-a', extra: JSON.stringify(start), ...SCOPE },
      { id: `e${i}`, at: iso(at + 1000), what: 'action', turn_id: 't-a', extra: JSON.stringify(done), ...SCOPE }
    );
  }
  return rows;
}

/** The user text of the one request Ελένη's line gets when she has had `draws` pictures made today. */
async function requestAfter(draws: number): Promise<string> {
  const world = serviceWorld();
  try {
    insertRows(world.db, { day: dayRows(draws) });
    const run = await replyRun({
      world,
      context: { myDay: { lines: 12, people: 3 } },
      steps: [
        {
          trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN },
          answers: ['<think>STEP 4. So: answer.</think><msg>γεια</msg>'],
        },
      ],
    });
    const first = run.requests[0] ?? [];
    return first[0] ?? '';
  } finally {
    world.close();
  }
}

/** What a request holds before its first own block: the part the cache keeps. */
const heldOf = (request: string): string => request.slice(0, request.indexOf('\n<chat>\n'));
const myDayOf = (request: string): string => /<my_day>([\s\S]*?)<\/my_day>/.exec(request)?.[1] ?? '';

test('keeps the bytes before <chat> when she makes one more thing, and shows the count in <my_day>', async () => {
  // Bug: the counts go into `<people>` or another held block, so every picture she makes rewrites the cache.
  const before = await requestAfter(7);
  const after = await requestAfter(8);
  assert.ok(before.includes('\n<chat>\n'), 'the request has a chat block');
  assert.equal(heldOf(after), heldOf(before));
  const asker = `@${handleOf(ELENI)}`;
  assert.ok(myDayOf(before).includes(asker), myDayOf(before));
  assert.match(myDayOf(before), /\b7\b/);
  assert.doesNotMatch(myDayOf(before), /\b8\b/);
  assert.match(myDayOf(after), /\b8\b/);
  assert.ok(!heldOf(after).includes('<my_day>'));
});
