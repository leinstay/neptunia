// The intention turn on the template of the turn frame (plan 2026-11-06-turn-frame, slice 5 (a) and "The service
// trees"): a place on an intention says where she begins. With a place the turn is the ordinary turn there, with the due
// intention first and whole in `<intentions>` inside `<inner>`. Without one she wakes nowhere in the service frame and
// reaches any place through `message.create`, the command line's `cli:dm:owner` included. `intention.set` takes the
// place as optional and refuses a root and a place she cannot write to. The shapes the specifier chose:
//   the place of `intention.set` is its model-facing argument `place` (src/tools/definitions.ts, slice 7);
//   `message.create` names the destination by its place id in the same argument;
//   a refusal is an action whose status is not `executed` with a code that is not `ok`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { CLI_PLACE, MARK, TURN_NOW, blockOf, rootTags, serviceTurn, serviceWake } from './fixtures/service-turn.ts';
import type { ServiceRun } from './fixtures/service-turn.ts';

useIface('fake');

const THINK = '<think>STEP 4. So: do it.</think>';
const HOUR = 3_600_000;
/** A purpose past the 200 characters a line of `<intentions>` keeps, with a marker at its end. */
const DUE_PURPOSE = `${'να γράψω στον κήπο για τα λουλούδια της άνοιξης '.repeat(6)}ΤΕΛΟΣ-ΣΚΟΠΟΥ`;

type Made = { ok: boolean; intention?: { id: string } };

/** Seeds three open intentions, the due one made second, and gives its id through `due`. */
function seeded(due: { id: string }, place: string | null) {
  return (service: ServiceRun['intentions']): void => {
    service.set({ purpose: 'ΑΛΛΗ-ΠΡΩΤΗ', dueAt: TURN_NOW + 5 * HOUR, by: 'persona' });
    const made = service.set({
      purpose: DUE_PURPOSE,
      dueAt: TURN_NOW - 60_000,
      destination: place,
      by: 'persona',
    }) as Made;
    due.id = made.intention?.id ?? '';
    service.set({ purpose: 'ΑΛΛΗ-ΤΡΙΤΗ', dueAt: TURN_NOW + 6 * HOUR, by: 'persona' });
  };
}

const dueWake = (id: string): Record<string, unknown> =>
  serviceWake('intention_due', {
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: [id], errandId: null }],
    intentions: [{ id, purpose: DUE_PURPOSE, dueAt: TURN_NOW - 60_000 }],
    chainId: id,
  });

test('an intention with a place builds the reply frame there, and <intentions> opens with the due one whole', async () => {
  // Bug: the intention turn keeps `<wake>`, loses the room it meant to begin in, or cuts the due purpose to a line.
  const due = { id: '' };
  const run = await serviceTurn({
    wake: () => dueWake(due.id),
    answers: ['<skip/>'],
    chat: { iface: 'fake', chatId: 'c1' },
    seed: seeded(due, 'c1'),
  });
  const text = run.requests[0] ?? '';
  const tags = rootTags(text);
  assert.ok(tags.includes('chat') && tags.includes('surroundings'), tags.join(' '));
  const inner = blockOf(text, 'inner');
  const intentions = /<intentions>\n([\s\S]*?)\n<\/intentions>/.exec(inner)?.[1] ?? '';
  assert.ok(intentions.includes(DUE_PURPOSE), intentions);
  assert.ok(intentions.indexOf(DUE_PURPOSE) < intentions.indexOf('ΑΛΛΗ-ΠΡΩΤΗ'), 'the due one before an older one');
  assert.ok(text.includes(MARK.inner), 'the intention task');
});

test('an intention without a place builds the service frame, nowhere', async () => {
  // Bug: an intention with no place runs in a recent room, or throws as a reply with no place.
  const due = { id: '' };
  const run = await serviceTurn({
    wake: () => dueWake(due.id),
    answers: ['<skip/>'],
    chat: null,
    seed: seeded(due, null),
  });
  const tags = rootTags(run.requests[0] ?? '');
  assert.equal(tags.includes('chat'), false, tags.join(' '));
  assert.equal(tags.includes('surroundings'), false, tags.join(' '));
  assert.ok(tags.includes('meanwhile'), tags.join(' '));
});

test('a message.create naming the command line from an intention nowhere posts in the owner chat', async () => {
  // Bug: the tree check refuses a destination on another interface, or a direct chat is refused outright.
  const due = { id: '' };
  const run = await serviceTurn({
    wake: () => dueWake(due.id),
    answers: [toolAnswer(THINK, [call('message.create', { place: CLI_PLACE, text: 'καλημέρα από εδώ' })]), '<skip/>'],
    chat: null,
    seed: seeded(due, null),
  });
  const { cli } = run;
  const sent = cli.calls.filter((one: { op: string }) => one.op === 'send');
  assert.equal(sent.length, 1, run.actions.join(' '));
  const [, content] = sent[0]?.args ?? [];
  assert.equal((content as { text?: string } | undefined)?.text, 'καλημέρα από εδώ');
});

test('intention.set without a place is accepted and stores no place', async () => {
  // Bug: a heartbeat nowhere is told a destination is required, so she names a root to get the intention through.
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'να ρωτήσω για το βιβλίο' })])],
    chat: null,
  });
  assert.deepEqual(run.actions, ['intention.set:executed:ok']);
  const [made] = run.intentions.list({ all: true });
  assert.equal(made?.destination ?? null, null);
});

/** The one action of a heartbeat that called intention.set naming `channel`, and how many intentions it left. */
async function setNaming(channel: string): Promise<{ status: string; code: string; open: number }> {
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'να γράψω εκεί', place: channel })]),
      '<skip/>',
    ],
    chat: null,
  });
  const [, status = '', code = ''] = (run.actions[0] ?? '').split(':');
  const open = run.intentions.list({ all: true });
  return { status, code, open: open.length };
}

test('intention.set naming a root is refused with a code', async () => {
  // Bug: a root is kept as a place to begin in, and the turn later runs as a reply in a place with no chat.
  const set = await setNaming('g1');
  assert.notEqual(`${set.status}:${set.code}`, 'executed:ok');
  assert.ok(set.code !== '' && set.code !== 'ok', set.code);
  assert.equal(set.open, 0);
});

test('intention.set naming a place she cannot write to is refused with a code', async () => {
  // Bug: the intention keeps a read-only room, and at its due time she wakes where she cannot answer.
  const set = await setNaming('c3');
  assert.notEqual(`${set.status}:${set.code}`, 'executed:ok');
  assert.ok(set.code !== '' && set.code !== 'ok', set.code);
  assert.equal(set.open, 0);
});
