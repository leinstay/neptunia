// Tests for src/intentions/blocks.ts: the body of the `<intentions>` block, the persona's active intentions with their
// wait, due time and outcome, then the candidates with the line they came from, cut to the token budget.
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import '../../../src/tools/operations/index.ts';
import { intentionsBlockText } from '../../../src/intentions/blocks.ts';
import { createIntention, transition, waitOn } from '../../../src/intentions/model.ts';
import { formatClock, formatDate } from '../../../src/format.ts';

import { present } from '../../fixtures/loose-types.ts';
import { TURN_NOW, serviceTurn, serviceWake, serviceWorld } from '../../fixtures/service-turn.ts';
import { useIface } from '../../fixtures/turn-world.ts';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;

const LABELS = {
  intentions: {
    header: 'H',
    line: '{id}|{state}|{purpose}',
    states: { pending: 'P', waiting: 'W' },
    due: 'due {when}',
    every: 'each {period}',
    waiting: 'wait {errand} until {deadline}',
    outcome: 'got {errand} {state}',
    notes: { 'wait-deadline': 'ran out {errand}' },
    destination: 'to #{channel}',
  },
};

function own(id: string, extra = {}) {
  return present(
    createIntention({ purpose: `σκοπός ${id}`, provenance: { kind: 'self' }, now: T0, id, ...extra }).intention
  );
}

const at = (ts: number) => `${formatDate(ts, 'UTC')} ${formatClock(ts, 'UTC')}`;

test('intentionsBlockText: active lines with due, wait, outcome and note', () => {
  const pending = own('i1', { dueAt: T0 + HOUR, destination: 'c9' });
  const waiting = present(waitOn(own('i2'), { errandId: 't7', deadline: T0 + 2 * HOUR, now: T0 }).intention);
  const back = transition(
    present(waitOn(own('i3'), { errandId: 't8', deadline: T0 + HOUR, now: T0 }).intention),
    'pending',
    {
      now: T0 + HOUR,
      patch: { note: 'wait-deadline' },
    }
  ).intention;
  const daily = own('i5', { dueAt: T0 + 2 * HOUR, every: { period: 'day', at: '12:00' } });
  const text = intentionsBlockText([pending, daily, back, waiting], LABELS, {
    channelNameOf: (id) => (id === 'c9' ? 'γενικά' : null),
  });
  assert.equal(
    text,
    [
      'H',
      `i1|P|σκοπός i1 · due ${at(T0 + HOUR)} · to #γενικά`,
      `i5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)} · each day`,
      'i3|P|σκοπός i3 · ran out t8',
      `i2|W|σκοπός i2 · wait t7 until ${at(T0 + 2 * HOUR)}`,
    ].join('\n')
  );
  // Without the every label a recurring line shows its due time alone.
  assert.equal(
    intentionsBlockText([daily], { intentions: { ...LABELS.intentions, every: undefined } }),
    `H\ni5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)}`
  );
});

test("intentionsBlockText: an attention shows its place, the day's wakes against the persona's bound, the settle and the people by handle", () => {
  // One handle per person: a person reads as their handle, never a name or an id,
  // and a place no reader names reads `spatial.unnamed`, never its id.
  const attention = own('i6', { attend: { place: 'c9', people: ['u1', 'u2'], settle: 30, perDay: 4 } });
  const counted = { ...attention, attend: { ...attention.attend, today: { day: '2026-10-18', wakes: 2 } } };
  const labels = {
    intentions: { ...LABELS.intentions, attend: 'in #{place} {wakes}/{perDay} q{settle}', attendPeople: 'of {people}' },
    authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
    spatial: { unnamed: 'unnamed' },
  };
  const text = intentionsBlockText([counted, own('i7', { attend: { place: 'c8' } })], labels, {
    channelNameOf: (id) => (id === 'c9' ? 'κήπος' : null),
    nameOf: (id) => (id === 'u1' ? 'Ana' : null),
    handleOf: (id) => (id === 'u1' ? '@u7ana' : null),
  });
  assert.equal(
    text,
    ['H', 'i6|P|σκοπός i6 · in #κήπος 2/4 q30 · of @u7ana, someone', 'i7|P|σκοπός i7 · in #unnamed 0/12 q90'].join('\n')
  );
  assert.equal(
    intentionsBlockText([counted], LABELS),
    'H\ni6|P|σκοπός i6',
    'without the attend labels the line stands alone'
  );
});

test('intentionsBlockText: an intention with no due time and no wait says so with its expiry; every line past the notice window shows its expiry; neither without its label', () => {
  const DAY = 24 * HOUR;
  const labels = {
    intentions: { ...LABELS.intentions, noDue: 'no date, expires {expires}', expiresSoon: 'expires {when}' },
  };
  const dateless = own('i1');
  const dated = own('i2', { dueAt: T0 + HOUR });
  // Dateless: the no-date part in the due slot, with its expiry (14 days by default: far from the notice window).
  assert.equal(
    intentionsBlockText([dateless, dated], labels, { now: T0 }),
    ['H', `i1|P|σκοπός i1 · no date, expires ${at(T0 + 14 * DAY)}`, `i2|P|σκοπός i2 · due ${at(T0 + HOUR)}`].join('\n')
  );
  // Inside the notice window (2 days by default) a dated line, a waiting one and a recurring one show their expiry at the end.
  const soon = own('i3', { dueAt: T0 + HOUR, expiresAt: T0 + DAY, destination: 'c9' });
  const waiting = present(
    waitOn(own('i4', { expiresAt: T0 + 36 * HOUR }), { errandId: 't7', deadline: T0 + 2 * HOUR, now: T0 }).intention
  );
  const daily = own('i5', { dueAt: T0 + 2 * HOUR, every: { period: 'day', at: '12:00' }, expiresAt: T0 + 2 * DAY });
  assert.equal(
    intentionsBlockText([soon, daily, waiting], labels, { now: T0, channelNameOf: () => 'γενικά' }),
    [
      'H',
      `i3|P|σκοπός i3 · due ${at(T0 + HOUR)} · to #γενικά · expires ${at(T0 + DAY)}`,
      `i5|P|σκοπός i5 · due ${at(T0 + 2 * HOUR)} · each day · expires ${at(T0 + 2 * DAY)}`,
      `i4|W|σκοπός i4 · wait t7 until ${at(T0 + 2 * HOUR)} · expires ${at(T0 + 36 * HOUR)}`,
    ].join('\n')
  );
  // The window is the setting: with one day only the 36-hour one is outside it; a dateless line inside it carries its expiry once.
  const near = own('i6', { expiresAt: T0 + 12 * HOUR });
  assert.equal(
    intentionsBlockText([waiting, near], labels, { now: T0, expiryNoticeDays: 1 }),
    [
      'H',
      `i4|W|σκοπός i4 · wait t7 until ${at(T0 + 2 * HOUR)}`,
      `i6|P|σκοπός i6 · no date, expires ${at(T0 + 12 * HOUR)}`,
    ].join('\n')
  );
  // An attention has no due time by design and is not dateless.
  const attention = own('i7', { attend: { place: 'c9' } });
  assert.equal(intentionsBlockText([attention], labels, { now: T0 }), ['H', 'i7|P|σκοπός i7'].join('\n'));
  // Without the labels the lines stand as before.
  assert.equal(
    intentionsBlockText([dateless, soon], LABELS, { now: T0 }),
    ['H', 'i1|P|σκοπός i1', `i3|P|σκοπός i3 · due ${at(T0 + HOUR)} · to #c9`].join('\n')
  );
});

test('intentionsBlockText: cut to the budget by whole lines; nothing without labels', () => {
  const records = [own('i1'), own('i2'), own('i3')];
  const lineCost = () => 10;
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 21, cost: lineCost }), 'H\ni1|P|σκοπός i1');
  assert.equal(
    intentionsBlockText(records, LABELS, { maxTokens: 33, cost: lineCost }),
    'H\ni1|P|σκοπός i1\ni2|P|σκοπός i2',
    'no room for a third line'
  );
  assert.equal(intentionsBlockText(records, LABELS, { maxTokens: 5, cost: lineCost }), '');
  assert.equal(intentionsBlockText(records, {}), '');
  assert.equal(intentionsBlockText([], LABELS), '');
});

const MIN = 60_000;

const bodyOf = (request: string, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1] ?? '';

/** The line of `<intentions>` that holds the purpose of the intention the turns below seed, '' when none does. */
function intentionLine(request: string): string {
  const lines = bodyOf(request, 'intentions').split('\n');
  return lines.find((one) => one.includes('ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ')) ?? '';
}

/** The intention turn of the room `c1` with one open intention that begins in that room. */
async function intentionTurn(destination = 'c1'): Promise<string> {
  const world = serviceWorld();
  try {
    const due = { id: '' };
    const run = await serviceTurn({
      world,
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ', dueAt: TURN_NOW - MIN }],
          chainId: due.id,
        }),
      answers: ['<skip/>'],
      chat: { iface: 'fake', chatId: 'c1' },
      seed: (service) => {
        const made = service.set({
          purpose: 'ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ',
          dueAt: TURN_NOW - MIN,
          destination,
          by: 'persona',
        }) as { intention?: { id: string } };
        due.id = made.intention?.id ?? '';
      },
    });
    return run.requests[0] ?? '';
  } finally {
    world.close();
  }
}

describe('the destination of an intention on the fake interface', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the destination of an intention reads as the handle of the room with one # before it', async () => {
    // Bug: the label writes a # before a name that already holds its own mark, or the destination keeps the room's name,
    // so the line reads `##c…` or names the room as nothing else in the request does.
    const request = await intentionTurn();
    const handle = /#c[0-9a-z]+/.exec(bodyOf(request, 'place'))?.[0] ?? '';
    assert.match(handle, /^#c[0-9a-z]+$/, 'the room has a handle in <place>');
    const line = intentionLine(request);
    assert.ok(line.includes(handle), line);
    assert.ok(!line.includes(`#${handle}`), line);
    assert.ok(!line.includes('γενικά'), line);
  });
});
