// src/memory/db/graph-find.ts: places and people found by the memory graph for a name or a description in her words
// (plan 2026-11-08-meta-person, fault 4 and slice 9). A place is ranked by its name and aliases, its stored purpose,
// tone and topics, the people who talk there and what was said there lately; a person by their names, their stored
// character, style and relationship, and the claims about them. Words every candidate shares weigh little. Nothing the
// context may not read is a candidate. Contract:
//   placesFound(db: Db, ctx: Context, request: string, settings?: Partial<FindSettings>): Array<FoundPlace>
//   peopleFound(db: Db, ctx: Context, request: string, settings?: Partial<FindSettings>): Array<FoundPerson>
//   FoundPlace = { id; name; about: string | null; score: number }, FoundPerson = { id; name; about; score }
//   FindSettings = { candidates: number; lines: number }
// Synthetic names, in Greek.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleFound, placesFound } from '../src/memory/db/graph-find.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import type { Db } from '../src/memory/db/types.ts';
import {
  AT,
  addClaim,
  addDm,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

const GROUP = groupContext('discord');
const ROOT = rootId('discord', 'g1');

function world(): World {
  const opened = openWorld();
  worlds.push(opened);
  noteInterface(opened, 'discord', [{ id: 'g1', name: 'Αγορά' }]);
  return opened;
}

/** A stored description of a place or a person, readable by the groups of the interface or inside one direct chat. */
function describe(
  db: Db,
  {
    id,
    kind,
    subject,
    field,
    text,
    dm = null,
  }: {
    id: string;
    kind: 'place' | 'person';
    subject: string;
    field: string;
    text: string;
    dm?: { place: string; person: string } | null;
  }
): void {
  const scope =
    dm === null
      ? { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }
      : { scope_kind: 'dm', scope_iface: 'discord', scope_dm: dm.person, audience_id: `aud:dm:${dm.place}` };
  insertRows(db, {
    descriptions: [{ id, subject_kind: kind, subject_id: subject, field, current_version: `${id}:v1`, ...scope }],
    description_versions: [
      { id: `${id}:v1`, description_id: id, text, author: 'her', written_at: AT, chars: text.length, origin: 'review' },
    ],
  });
}

/** Three rooms: one for music by its fields only, one where a music bot is ordered, one for cooking. */
function rooms(w: World): { sounds: string; player: string; kitchen: string } {
  const sounds = addRoom(w.db, { iface: 'discord', native: 'c1', root: ROOT, name: 'Ήχοι' });
  const player = addRoom(w.db, { iface: 'discord', native: 'c2', root: ROOT, name: 'Πικάπ' });
  const kitchen = addRoom(w.db, { iface: 'discord', native: 'c3', root: ROOT, name: 'Κουζίνα' });
  describe(w.db, {
    id: 'd:c1:p',
    kind: 'place',
    subject: sounds,
    field: 'purpose',
    text: 'Κανάλι όπου μοιράζονται μουσική και τραγούδια.',
  });
  describe(w.db, {
    id: 'd:c1:t',
    kind: 'place',
    subject: sounds,
    field: 'topics',
    text: 'Μουσικά βίντεο, δίσκοι, συναυλίες.',
  });
  describe(w.db, {
    id: 'd:c2:p',
    kind: 'place',
    subject: player,
    field: 'purpose',
    text: 'Κανάλι για εντολές στο ρομπότ που παίζει μουσική στη φωνή.',
  });
  describe(w.db, {
    id: 'd:c3:p',
    kind: 'place',
    subject: kitchen,
    field: 'purpose',
    text: 'Κανάλι για συνταγές και φαγητό.',
  });
  return { sounds, player, kitchen };
}

test('a place is found by its purpose and topics when the words differ from its name', () => {
  // Bug: a place is looked up by its name alone, so a request for the music place finds nothing or a wrong room.
  const w = world();
  const { sounds, kitchen } = rooms(w);
  const found = placesFound(w.db, GROUP, 'μουσικά τραγούδια');
  assert.equal(found[0]?.id, sounds);
  assert.equal(
    found.some((place) => place.id === kitchen),
    false,
    'a room that shares only the common word stays out'
  );
});

test('two candidates come back best first when two places fit the request', () => {
  // Bug: the finder returns its first match only, so she reads one room and never learns another one fit.
  const w = world();
  const { sounds, player, kitchen } = rooms(w);
  const found = placesFound(w.db, GROUP, 'μουσική');
  assert.deepEqual(
    found.map((place) => place.id).filter((id) => id !== kitchen),
    [sounds, player]
  );
  assert.ok((found[0]?.score ?? 0) > (found[1]?.score ?? 0), 'the room with more fields that fit ranks first');
});

test('a word every place shares does not rank a place on its own', () => {
  // Bug: a common word such as the noun for a place weighs as much as the word that tells the places apart.
  const w = world();
  const { sounds } = rooms(w);
  const found = placesFound(w.db, GROUP, 'κανάλι μουσική τραγούδια');
  assert.equal(found[0]?.id, sounds);
  assert.deepEqual(placesFound(w.db, GROUP, 'κανάλι'), [], 'the shared word alone tells no place apart');
});

test('a place is found by what was said there lately and by who talks there', () => {
  // Bug: a room with no stored description is invisible to the finder, though its lines say what it is about.
  const w = world();
  rooms(w);
  const pier = addRoom(w.db, { iface: 'discord', native: 'c4', root: ROOT, name: 'Μόλος' });
  addPerson(w.db, {
    id: 'person:z1',
    accounts: [{ id: 'discord:z1', iface: 'discord', native: 'z1', names: ['Ζωή'] }],
  });
  addLine(w.db, { id: 'l1', iface: 'discord', place: pier, author: 'discord:z1', text: 'Πήγα για ψάρεμα το πρωί' });
  addLine(w.db, {
    id: 'l2',
    iface: 'discord',
    place: pier,
    author: 'discord:z1',
    text: 'Το ψάρεμα με καλάμι είναι ηρεμία',
  });
  assert.equal(placesFound(w.db, GROUP, 'ψάρεμα')[0]?.id, pier);
  assert.equal(placesFound(w.db, GROUP, 'Ζωή')[0]?.id, pier, 'the room where she talks');
});

test('a place the context may not read is never a candidate', () => {
  // Bug: the finder ranks every place, so a group turn learns of a direct chat about the same thing.
  const w = world();
  const { sounds } = rooms(w);
  addPerson(w.db, {
    id: 'person:m1',
    accounts: [{ id: 'discord:m1', iface: 'discord', native: 'm1', names: ['Μαρία'] }],
  });
  const dm = addDm(w.db, { iface: 'discord', native: 'm1', person: 'person:m1', account: 'discord:m1' });
  describe(w.db, {
    id: 'd:dm:p',
    kind: 'place',
    subject: dm,
    field: 'purpose',
    text: 'Ιδιωτική κουβέντα για μουσική και τραγούδια.',
    dm: { place: dm, person: 'person:m1' },
  });
  const found = placesFound(w.db, GROUP, 'μουσική τραγούδια').map((place) => place.id);
  assert.equal(found.includes(dm), false);
  assert.equal(found[0], sounds);
  assert.ok(
    placesFound(w.db, dmContext('person:m1', 'discord', dm), 'μουσική τραγούδια').some((place) => place.id === dm),
    'the chat finds itself inside its own context'
  );
});

test('the candidates stop at the configured count and an empty request finds nothing', () => {
  // Bug: the list grows with the number of places, or an empty request lists every place.
  const w = world();
  rooms(w);
  assert.equal(placesFound(w.db, GROUP, 'μουσική', { candidates: 1 }).length, 1);
  assert.deepEqual(placesFound(w.db, GROUP, '   '), []);
  assert.deepEqual(placesFound(w.db, GROUP, 'αστεροσκοπείο'), [], 'a word nothing holds');
});

test('a found place says what it is for from its stored purpose', () => {
  // Bug: the candidates carry only names, so she cannot tell two rooms apart when she asks which one was meant.
  const w = world();
  const { player } = rooms(w);
  const found = placesFound(w.db, GROUP, 'ρομπότ μουσική');
  assert.equal(found[0]?.id, player);
  assert.equal(found[0]?.name, 'Πικάπ');
  assert.equal(found[0]?.about, 'Κανάλι για εντολές στο ρομπότ που παίζει μουσική στη φωνή.');
});

test('a person is found by their stored character when the words differ from their name', () => {
  // Bug: a person is looked up by name only, so "the one who loves astronomy" finds nobody.
  const w = world();
  addPerson(w.db, {
    id: 'person:a1',
    accounts: [{ id: 'discord:a1', iface: 'discord', native: 'a1', names: ['Ανδρέας'] }],
  });
  addPerson(w.db, {
    id: 'person:b1',
    accounts: [{ id: 'discord:b1', iface: 'discord', native: 'b1', names: ['Βασίλης'] }],
  });
  describe(w.db, {
    id: 'd:a1:c',
    kind: 'person',
    subject: 'person:a1',
    field: 'character',
    text: 'Λατρεύει την αστρονομία και τα τηλεσκόπια.',
  });
  describe(w.db, {
    id: 'd:b1:c',
    kind: 'person',
    subject: 'person:b1',
    field: 'character',
    text: 'Μαγειρεύει κάθε βράδυ.',
  });
  const found = peopleFound(w.db, GROUP, 'αστρονομία');
  assert.deepEqual(
    found.map((person) => person.id),
    ['person:a1']
  );
  assert.equal(found[0]?.name, 'Ανδρέας');
});

test('a person is found by an alias only where the alias may be read', () => {
  // Bug: an alias learned in a direct chat finds the person from a group turn.
  const w = world();
  addPerson(w.db, {
    id: 'person:s1',
    accounts: [{ id: 'discord:s1', iface: 'discord', native: 's1', names: ['Σταύρος'] }],
  });
  const dm = addDm(w.db, { iface: 'discord', native: 's1', person: 'person:s1', account: 'discord:s1' });
  addClaim(w.db, {
    id: 'claim:alias:s1',
    person: 'person:s1',
    kind: 'alias',
    text: 'Σταυράκης',
    audience: { dm, iface: 'discord', person: 'person:s1' },
  });
  assert.deepEqual(peopleFound(w.db, GROUP, 'Σταυράκης'), []);
  assert.deepEqual(
    peopleFound(w.db, dmContext('person:s1', 'discord', dm), 'Σταυράκης').map((person) => person.id),
    ['person:s1']
  );
});
