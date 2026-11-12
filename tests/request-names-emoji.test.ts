// Names shown without emoji (spec 2026-11-12 names-across-scripts, slice 2): a request that shows the name of a place or
// of a person leaves the emoji of the name out, and shows them when `context.names.emoji` is `true`. Reply turns of the
// real turn runner over a small world whose names carry emoji (tests/fixtures/service-turn.ts#replyRun), a scripted
// model, made-up names. The stored name is the world's row and stays as written.
//
// The setting travels as `config.context.names.emoji`: `replyRun({ context: { names: { emoji: true } } })` lays it over
// the rig's `context`, and the request builder reads it from the config it is given at each request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addClaim,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { TURN_NOW, blockOf, replyRun } from './fixtures/service-turn.ts';

useIface('fake');

const MIN = 60_000;
const THINK = '<think>STEP 4. So: answer.</think>';
const SAY = `${THINK}<msg>εντάξει</msg>`;
const iso = (at: number): string => new Date(at).toISOString();
const EMOJI = /\p{Extended_Pictographic}/u;

/** A room with a leading emoji, a garden with one between its words, a person whose names and alias carry emoji. */
function emojiWorld(): World {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: '🌿 γενικά' });
  const garden = addRoom(world.db, {
    iface: 'fake',
    native: 'c2',
    root: rootId('fake', 'g1'),
    name: 'ωραίος 🌱 κήπος',
  });
  addPerson(world.db, {
    id: 'person:fake:111',
    accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['🍀 Ελένη', 'Ελένη 🍀 Λένα'] }],
  });
  addClaim(world.db, {
    id: 'claim:alias:111',
    person: 'person:fake:111',
    kind: 'alias',
    text: '🌟 Ελενάκι',
    audience: { group: 'fake' },
  });
  addLine(world.db, {
    id: 'r1',
    iface: 'fake',
    place: room,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΔΩΜΑΤΙΟΥ',
    at: iso(TURN_NOW - 5 * MIN),
  });
  addLine(world.db, {
    id: 'g0',
    iface: 'fake',
    place: garden,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΚΗΠΟΥ',
    at: iso(TURN_NOW - 51 * MIN),
  });
  return world;
}

/** The `#c…` handle of the entry of `<places>` that holds `word`. */
function placeHandle(request: string, word: string): string {
  const places = blockOf(blockOf(request, 'memory'), 'places');
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(word)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** Two turns in the room: she reads the garden by its handle in the first, the second shows the read in `<recall>`. */
async function run(emoji: boolean | undefined): Promise<{ first: string; read: string }> {
  const world = emojiWorld();
  try {
    const out = await replyRun({
      world,
      ...(emoji === undefined ? {} : { context: { names: { emoji } } }),
      steps: [
        {
          trigger: { id: 'r2', text: 'τι έγινε στον κήπο;', at: TURN_NOW - 3 * MIN },
          answers: [
            (request: string) =>
              toolAnswer(THINK, [call('conversation.read', { place: placeHandle(request, 'κήπος'), last: 10 })]),
            SAY,
          ],
        },
      ],
    });
    const requests = out.requests[0] ?? [];
    return { first: requests[0] ?? '', read: requests[1] ?? '' };
  } finally {
    world.close();
  }
}

const hidden = run(undefined);
const shown = run(true);

/** The line of `text` that holds `marker`. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';
const peopleOf = (request: string): string => blockOf(blockOf(request, 'memory'), 'people');

test('a place with a leading emoji reads without it in an entry of <places>', async () => {
  // Bug: the entry shows the stored name, so the emoji of a channel reads as part of its name.
  const { first } = await hidden;
  const entry = lineWith(blockOf(blockOf(first, 'memory'), 'places'), 'γενικά');
  assert.match(entry, /^#c[0-9a-z]+: "γενικά", "Αγορά"/, entry);
  assert.doesNotMatch(entry, EMOJI);
});

test('a place with a leading emoji reads without it in <place>', async () => {
  // Bug: `<place>` of the surroundings reads the name through another path than `<places>` and keeps the emoji.
  const { first } = await hidden;
  const place = blockOf(blockOf(first, 'surroundings'), 'place');
  assert.match(place, /^#c[0-9a-z]+: "γενικά", "Αγορά"/, place);
  assert.doesNotMatch(place, EMOJI);
});

test('a name with an emoji between two words keeps both words and one space in the source line of a read', async () => {
  // Bug: the source line of a read names the place by its stored name, and the emoji stands in it.
  const { read } = await hidden;
  const source = lineWith(read.split('</task>').slice(1).join('</task>'), 'conversation.read');
  assert.ok(source.includes('"ωραίος κήπος"'), source);
  assert.doesNotMatch(source, EMOJI);
});

test("a person's heading reads without emoji", async () => {
  // Bug: the heading of an entry of <people> is the stored name.
  const { first } = await hidden;
  const heading = lineWith(peopleOf(first), 'Ελένη');
  assert.match(heading, /^@u[0-9a-z]+: Ελένη \(/, heading);
});

test('the names of an account line read without emoji, each trimmed', async () => {
  // Bug: the account line joins the stored names, so `🍀 Ελένη` and `Ελένη 🍀 Λένα` keep their emoji.
  const { first } = await hidden;
  const account = lineWith(peopleOf(first), 'account 111');
  assert.ok(account.includes('Ελένη, Ελένη Λένα'), account);
  assert.doesNotMatch(account, EMOJI);
});

test('an alias reads without emoji', async () => {
  // Bug: the aliases line is the stored claim text.
  const { first } = await hidden;
  const aliases = lineWith(peopleOf(first), 'Ελενάκι');
  assert.ok(aliases.includes('also called: Ελενάκι'), aliases);
  assert.doesNotMatch(aliases, EMOJI);
});

test('with context.names.emoji true the emoji of a place, a heading, an account line and an alias stand', async () => {
  // Bug: the setting is read nowhere, or only by one renderer, so the owner cannot show the names as stored.
  const { first, read } = await shown;
  assert.ok(lineWith(blockOf(blockOf(first, 'memory'), 'places'), 'γενικά').includes('🌿 γενικά'));
  assert.ok(blockOf(blockOf(first, 'surroundings'), 'place').includes('🌿 γενικά'));
  assert.ok(lineWith(read.split('</task>').slice(1).join('</task>'), 'conversation.read').includes('ωραίος 🌱 κήπος'));
  const people = peopleOf(first);
  assert.ok(lineWith(people, 'Ελένη').startsWith('@u'), people);
  assert.ok(lineWith(people, 'Ελένη').includes('🍀 Ελένη'), people);
  assert.ok(lineWith(people, 'account 111').includes('Ελένη 🍀 Λένα'), people);
  assert.ok(lineWith(people, 'Ελενάκι').includes('🌟 Ελενάκι'), people);
});
