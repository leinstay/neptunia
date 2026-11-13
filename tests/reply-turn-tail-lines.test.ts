// Three lines of the tail of her request (spec 2026-11-13 request-tail-three-lines): a restart too short to be felt is
// left out of `You were away:` (`context.away.minMinutes`), and a place in a line of `<my_day>` or of `<intentions>`
// reads as the handle the rest of the request uses for it, the way a window of `<meanwhile>` heads with it. Reply
// turns and an intention turn of the real turn runner over the service world (tests/fixtures/service-turn.ts), the
// garden `c2` renamed with an emoji in front. The facts are read off the request through the labels of
// config/labels.json, never their wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { TURN_NOW, blockOf, replyRun, serviceTurn, serviceWake, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyStep, ServiceTurnSpec } from './fixtures/service-turn.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';
import { useIface } from './fixtures/turn-world.ts';

useIface('fake');

const MIN = 60_000;
const HOUR = 60 * MIN;
const SAY = '<think>STEP 4. So: answer.</think><msg>γεια</msg>';
const GARDEN = 'fake:channel:c2';
const EMOJI = '🌿';
const iso = (at: number): string => new Date(at).toISOString();
const SCOPE = { place_id: 'fake:channel:c1', scope_kind: 'group', scope_iface: 'fake' };

const turn = (id: string, ago: number): ReplyStep => ({
  trigger: { id, text: 'καλημέρα', at: TURN_NOW - ago * MIN },
  answers: [SAY],
});

/** The service world with the garden named `🌿κήπος`, a name whose emoji the rest of the request leaves out. */
function worldWithEmojiGarden(): World {
  const world = serviceWorld();
  world.db.prepare('UPDATE places SET name = ? WHERE id = ?').run(`${EMOJI}κήπος`, GARDEN);
  return world;
}

/** One post she made in the garden at `at`, as the two lines of the journal's rows that an action leaves. */
function postInGarden(at: number): Array<Record<string, unknown>> {
  const started = { opId: 'o1', name: 'post', phase: 'started', target: { channel: 'c2' } };
  const done = { opId: 'o1', name: 'post', phase: 'succeeded' };
  return [
    { id: 's1', at: iso(at), what: 'action', turn_id: 't-a', extra: JSON.stringify(started), ...SCOPE },
    { id: 'e1', at: iso(at + 1000), what: 'action', turn_id: 't-a', extra: JSON.stringify(done), ...SCOPE },
  ];
}

/** The `#c…` handle of the garden's entry of `<places>`: the entry whose heading holds its name. */
function gardenHandle(request: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(blockOf(request, 'memory'))?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes('κήπος')) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

const bodyOf = (request: string, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1] ?? '';

/** A label of `labels.journal` by its key, read at the moment of use so a missing one fails its own test. */
function offLead(): string {
  const lead: unknown = shippedLabels.journal?.offLead;
  if (typeof lead !== 'string' || lead === '') throw new Error('labels.journal.offLead is missing');
  return lead;
}

/** The request of one reply turn after a stop at `stopAgo` minutes before the turn that lasted `lastedMs`. */
async function requestAfterStop(stopAgo: number, lastedMs: number, minMinutes: number): Promise<string> {
  const world = serviceWorld();
  try {
    const stopAt = TURN_NOW - stopAgo * MIN;
    const run = await replyRun({
      world,
      context: { away: { minMinutes } },
      steps: [
        {
          ...turn('r2', 1),
          journalBefore: async (journal) => {
            await journal.system({ event: 'stop', by: 'service', occurredAt: iso(stopAt) });
            await journal.system({ event: 'start', by: 'service', occurredAt: iso(stopAt + lastedMs) });
          },
        },
      ],
    });
    const [first = []] = run.requests;
    return first[0] ?? '';
  } finally {
    world.close();
  }
}

test('a restart of 20 seconds leaves no lead line of her time away in the request', async () => {
  // Bug: every deploy restart of the day lists as `Off, ... (less than a minute)`, so she reads a normal day as one
  // of absences.
  const request = await requestAfterStop(40, 20_000, 5);
  assert.ok(request.includes('<spatial_awareness>'), 'the request has the awareness block');
  assert.ok(!request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
});

test('a stop of an hour keeps the lead line of her time away in the request', async () => {
  // Bug: the cut reads the setting in the wrong unit, or drops every period, so a real absence never reaches her.
  const request = await requestAfterStop(180, HOUR, 5);
  assert.ok(request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
});

test('with the setting at 0 a restart of 20 seconds keeps the lead line', async () => {
  // Bug: the cut is a number in the reader and not the setting read at the moment of use, so 0 cannot turn it off.
  const request = await requestAfterStop(40, 20_000, 0);
  assert.ok(request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
});

/** The request of one reply turn in `c1` after a post in the emoji garden, and the garden's handle in that request. */
async function afterPostInGarden(
  steps: ReadonlyArray<ReplyStep>,
  seed?: ServiceTurnSpec['seed']
): Promise<Array<string>> {
  const world = worldWithEmojiGarden();
  try {
    insertRows(world.db, { day: postInGarden(TURN_NOW - 30 * MIN) });
    const run = await replyRun({
      world,
      context: { myDay: { lines: 12, people: 3 } },
      steps,
      ...(seed === undefined ? {} : { seed }),
    });
    return run.requests.map((requests) => requests[0] ?? '');
  } finally {
    world.close();
  }
}

test('a line of <my_day> names the garden by the handle its entry of <places> opens with, not by its name', async () => {
  // Bug: the line names the place by its stored name, emoji and all, so one place has a handle in <places> and a
  // name in <my_day> and she cannot tie the two.
  const [request = ''] = await afterPostInGarden([turn('r2', 1)]);
  const handle = gardenHandle(request);
  assert.match(handle, /^#c[0-9a-z]+$/, 'the garden has an entry of <places> with a handle');
  const lines = bodyOf(request, 'my_day').split('\n');
  const line = lines.find((one) => one.startsWith('[')) ?? '';
  assert.ok(line.includes(handle), line);
  assert.ok(!line.includes(EMOJI) && !line.includes('κήπος'), line);
});

test('two requests with nothing stored between them hold the same bytes in <my_day> and <intentions>', async () => {
  // Bug: the handle of a place in the day's lines or in an intention is taken from a book that the second request
  // builds in another order, so the same line reads under two handles between turns.
  const seed: ServiceTurnSpec['seed'] = (service) => {
    service.set({ purpose: 'ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ', dueAt: TURN_NOW + 5 * HOUR, destination: 'c1', by: 'persona' });
  };
  const [first = '', second = ''] = await afterPostInGarden([turn('r2', 3), turn('r3', 1)], seed);
  const day = bodyOf(first, 'my_day');
  const intentions = bodyOf(first, 'intentions');
  assert.ok(intentions.includes('ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ'), 'the intention stands in <intentions>');
  assert.ok(day.includes(gardenHandle(first)), day);
  assert.equal(bodyOf(second, 'my_day'), day);
  assert.equal(bodyOf(second, 'intentions'), intentions);
});

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

test('the destination of an intention in a stored place the interface snapshot lacks reads as that place handle', async () => {
  // Bug: the destination is named through the interface's chat snapshot alone, so the garden, which memory holds and the
  // snapshot lacks, reads as the word for an unnamed place.
  const request = await intentionTurn('c2');
  const handle = gardenHandle(request);
  assert.match(handle, /^#c[0-9a-z]+$/, 'the garden has an entry of <places> with a handle');
  const line = intentionLine(request);
  assert.ok(line.includes(handle), line);
  const { spatial } = shippedLabels;
  const unnamed: unknown = spatial?.unnamed;
  assert.ok(typeof unnamed === 'string' && unnamed !== '' && !line.includes(unnamed), line);
});
