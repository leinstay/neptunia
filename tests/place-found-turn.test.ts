// A turn in which she names a place in her own words that is no place's name (plan 2026-11-08-meta-person, fault 4):
// the call reads nothing, and its result lists the places the memory graph ranks for her words, best first, each with
// the handle to call again with and what the place is for, so she reads the one that was meant or asks which one. An
// intention turn nowhere over the service world's memory, two rooms added whose names share no word with the request.
// Synthetic names, in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import type { Db } from '../src/memory/db/types.ts';
import { AT, addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { TURN_NOW, serviceTurn, serviceWake, serviceWorld } from './fixtures/service-turn.ts';
import type { ServiceRun } from './fixtures/service-turn.ts';

useIface('fake');

const THINK = '<think>STEP 4. So: do it.</think>';

function purpose(db: Db, id: string, subject: string, text: string): void {
  insertRows(db, {
    descriptions: [
      {
        id,
        subject_kind: 'place',
        subject_id: subject,
        field: 'purpose',
        current_version: `${id}:v1`,
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
    description_versions: [
      { id: `${id}:v1`, description_id: id, text, author: 'her', written_at: AT, chars: text.length, origin: 'review' },
    ],
  });
}

/** An intention turn nowhere whose one step reads the place she wrote as `written`. */
async function readNowhere(written: string): Promise<ServiceRun> {
  const world = serviceWorld();
  const sounds = addRoom(world.db, { iface: 'fake', native: 'c4', root: rootId('fake', 'g1'), name: 'Ήχοι' });
  const player = addRoom(world.db, { iface: 'fake', native: 'c5', root: rootId('fake', 'g1'), name: 'Πικάπ' });
  purpose(world.db, 'd:c4', sounds, 'Εδώ μοιράζονται μουσική, τραγούδια και δίσκους.');
  purpose(world.db, 'd:c5', player, 'Εντολές στο ρομπότ που παίζει μουσική.');
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
      answers: [toolAnswer(THINK, [call('conversation.read', { place: written })]), '<skip/>'],
      chat: null,
    });
  } finally {
    world.close();
  }
}

test('a place named by what it is for comes back as ranked candidates and nothing is read', async () => {
  // Bug: a name that is no place's name is refused with every place listed in id order, or a guessed room is read, so
  // she reads the wrong room instead of the one the words describe.
  const run = await readNowhere('μουσική τραγούδια');
  const told = run.requests[1] ?? '';
  const [skill = '', , code = ''] = (run.actions[0] ?? '').split(':');
  assert.deepEqual([skill, code], ['conversation.read', 'invalid-args'], run.actions.join(' '));
  const sounds = told.indexOf('Ήχοι');
  const player = told.indexOf('Πικάπ');
  assert.ok(sounds >= 0 && player >= 0, told);
  assert.ok(sounds < player, 'the room both words fit comes first');
  assert.ok(told.includes('Εδώ μοιράζονται μουσική'), 'each candidate says what it is for');
  // The list follows the request's own blocks, which name every room of the world's memory.
  assert.equal(told.slice(sounds).includes('κήπος'), false, 'a room the words do not fit stays out of the list');
});
