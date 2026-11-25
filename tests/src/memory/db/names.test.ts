// src/memory/db/names.ts: the name index of the graph reader. One row per name, per node, per audience and per row it
// came from, so a public and a private name of one node are two rows and a retired claim or a revoked link takes
// exactly its own rows with it. Contract:
//   table names(label, normalized, stem, kind, node_id, audience_id, source_table, source_id), trigram table names_tri
//   touchNames(db: Db, sourceTable: string, sourceId: string): void   the rows of one stored row, again; the writers call it
//   matchName(db: Db, ctx: Context, word: string): Array<NameHitRow>
//   NameHit = { nodeId; kind; label; match: 'exact' | 'stem' | 'trigram'; audienceId }
// A hit's `nodeId` is a graph node id (`graphNodeId`). A name of an account points at the account's person while the link
// is verified, since a name raises a person. A hit is read under `ctx` as every scoped row is (scope.ts#audienceWhere).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchName, placesNamed, touchNames } from '../../../../src/memory/db/names.ts';
import type { NameHit } from '../../../../src/memory/db/names.ts';
import { applyPersonLinkWrite } from '../../../../src/memory/db/person-links.ts';
import { dmContext, groupAudienceId, groupContext } from '../../../../src/memory/db/scope.ts';
import { fillStems } from '../../../../src/memory/db/stems.ts';
import {
  addClaim,
  addDm,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  personNode,
  placeNode,
  rekeyNode,
  rootId,
  seedStemmer,
} from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';
import { waitFor, withFakes } from '../../../fixtures/two-fakes.ts';

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

function world(): World {
  const opened = openWorld();
  worlds.push(opened);
  noteInterface(opened, 'discord', [{ id: 'g1', name: 'Ágora' }]);
  return opened;
}

/** The nodes `words` name, read under `ctx`: per word, one hit per node by its strongest match. */
const namesOf = (
  db: Parameters<typeof matchName>[0],
  ctx: Parameters<typeof matchName>[1],
  words: Array<string>
): Array<NameHit> => words.flatMap((word) => matchName(db, ctx, word));
const GROUP = groupContext('discord');
const hitsFor = (hits: Array<NameHit>, nodeId: string): Array<NameHit> => hits.filter((hit) => hit.nodeId === nodeId);

test('a place name in an inflected form is found by stem and not by exact', () => {
  // Bug: the index matches only the exact form, so "the sea's" never finds the room named "the sea".
  const w = openWorld();
  worlds.push(w);
  seedStemmer(w.db, ['ς', 'ν'], [['θαλασσα', 3]]);
  noteInterface(w, 'discord', [{ id: 'g1', name: 'Ágora' }]);
  const room = addRoom(w.db, { iface: 'discord', native: 'c1', root: rootId('discord', 'g1'), name: 'Θάλασσα' });
  const found = hitsFor(namesOf(w.db, GROUP, ['Θάλασσας']), placeNode(room));
  assert.deepEqual(
    found.map((hit) => hit.match),
    ['stem']
  );
});

test('a name written with other case and accents is an exact match', () => {
  // Bug: the exact form is compared raw, so a name typed without its accent falls to a weaker match or none.
  const w = world();
  const found = hitsFor(namesOf(w.db, GROUP, ['AGORA']), placeNode(rootId('discord', 'g1')));
  assert.deepEqual(
    found.map((hit) => hit.match),
    ['exact']
  );
});

test('a spelling variant of a name is found by trigram and marked so', () => {
  // Bug: a name typed with one letter fewer finds nobody, or is reported as the person by an exact match.
  const w = world();
  addPerson(w.db, {
    id: 'person:discord:k1',
    accounts: [{ id: 'discord:k1', iface: 'discord', native: 'k1', names: ['Kalliópi'] }],
  });
  const found = hitsFor(namesOf(w.db, GROUP, ['Kaliópi']), personNode('person:discord:k1'));
  assert.ok(found.length > 0, 'the variant finds the person');
  assert.deepEqual([...new Set(found.map((hit) => hit.match))], ['trigram']);
});

test('a private alias of a person who also has a public name is not found in a group context while the public name is', () => {
  // Bug: the name index forgets the audience of the claim it came from, and a name learned in a private chat opens the
  // person to the group.
  const w = world();
  const person = 'person:discord:s1';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:s1', iface: 'discord', native: 's1', names: ['Stávros'] }] });
  const dm = addDm(w.db, { iface: 'discord', native: 's1', person, account: 'discord:s1' });
  addClaim(w.db, {
    id: 'claim:alias:s1',
    person,
    kind: 'alias',
    text: 'Stavráki',
    audience: { dm, iface: 'discord', person },
  });
  assert.deepEqual(hitsFor(namesOf(w.db, GROUP, ['Stavráki']), personNode(person)), []);
  assert.ok(hitsFor(namesOf(w.db, GROUP, ['Stávros']), personNode(person)).length > 0, 'the public name');
  assert.ok(
    hitsFor(namesOf(w.db, dmContext(person, 'discord', dm), ['Stavráki']), personNode(person)).length > 0,
    'the alias inside its own chat'
  );
});

test('a retired alias claim leaves no name row and finds nobody', () => {
  // Bug: the index keeps the name of a retired claim, so a name the session took back still raises the person.
  const w = world();
  const person = 'person:discord:l1';
  addPerson(w.db, {
    id: person,
    accounts: [{ id: 'discord:l1', iface: 'discord', native: 'l1', names: ['Leftéris'] }],
  });
  const alias = {
    id: 'claim:alias:l1',
    person,
    kind: 'alias' as const,
    text: 'Lefterákis',
    audience: { group: 'discord' },
  };
  addClaim(w.db, alias);
  assert.ok(hitsFor(namesOf(w.db, GROUP, ['Lefterákis']), personNode(person)).length > 0, 'found while live');
  addClaim(w.db, { ...alias, retiredAt: '2026-11-01T12:00:00.000Z' });
  const rows = w.db
    .prepare("SELECT COUNT(*) AS n FROM names WHERE source_table = 'claims' AND source_id = ?")
    .get('claim:alias:l1');
  assert.equal(Number(rows?.n), 0);
  assert.deepEqual(hitsFor(namesOf(w.db, GROUP, ['Lefterákis']), personNode(person)), []);
});

test('a revoked link takes the account name away from the person', () => {
  // Bug: the name of an account the owner unlinked still raises the person it was linked to.
  const w = world();
  const person = 'person:discord:i1';
  addPerson(w.db, {
    id: person,
    accounts: [
      { id: 'discord:i1', iface: 'discord', native: 'i1', names: ['Ilías'] },
      { id: 'telegram:i2', iface: 'telegram', native: 'i2', names: ['Liákos'] },
    ],
  });
  const context = groupContext('telegram');
  assert.ok(hitsFor(namesOf(w.db, context, ['Liákos']), personNode(person)).length > 0, 'found while linked');
  applyPersonLinkWrite(w.handle, {
    op: 'unbind',
    accountId: 'telegram:i2',
    now: Date.parse('2026-11-01T12:00:00.000Z'),
  });
  assert.deepEqual(hitsFor(namesOf(w.db, context, ['Liákos']), personNode(person)), []);
  assert.ok(
    hitsFor(namesOf(w.db, GROUP, ['Ilías']), personNode(person)).length > 0,
    'the linked account keeps its name'
  );
});

test('a real name stored as the people mapper writes it, an object with its name, is found by that name', () => {
  // Bug: `people.real_name` holds `{ name, from, to, itemId, recordedAt }` (src/memory/db/account-profile.ts), the
  // index reads only a string or a list, and no person of a live database is found by the name a user gave.
  const w = world();
  const person = 'person:discord:e1';
  addPerson(w.db, {
    id: person,
    realName: JSON.stringify({
      name: 'Eléni Daskaláki',
      from: 'claim',
      to: null,
      itemId: 'i-1',
      recordedAt: '2026-11-01',
    }),
    accounts: [{ id: 'discord:e1', iface: 'discord', native: 'e1', names: ['lena'] }],
  });
  touchNames(w.db, 'people', person);
  const hits = hitsFor(namesOf(w.db, GROUP, ['Daskaláki']), personNode(person));
  assert.deepEqual(
    hits.map((hit) => hit.kind),
    ['real_name']
  );
});

test("a place named in a tool's argument is found whatever its graph node's id spells", () => {
  // Bug: the place was cut out of the text of the name's graph node id, so a node whose id does not spell
  // `place:<row id>` named no place. The node's row id is stored in `graph_nodes.row_id`.
  const w = world();
  const room = addRoom(w.db, { iface: 'discord', native: 'c1', root: rootId('discord', 'g1'), name: 'Θάλασσα' });
  rekeyNode(w.db, placeNode(room), 'node-91c2');
  assert.deepEqual(placesNamed(w.db, GROUP, 'Θάλασσα'), [{ id: room, name: 'Θάλασσα' }]);
});

// Names across scripts. `NameMatch` has the member `'script'`: the third way
// of `matchName`, after the stems and before the trigrams, by the key of src/memory/db/script-key.ts computed over the stems.
// The key is filled for the rows that exist by `fillStems` (stems.ts), as the stems are.
const SCRIPT_ENDINGS = ['а'];
const SCRIPT_STEMS: Array<[string, number]> = [
  ['сад', 3],
  ['vokzal', 3],
];

/** A world whose stemmer knows "сада" is "сад", with one room named `name`. */
function roomWorld(name: string): { w: World; room: string } {
  const w = openWorld();
  worlds.push(w);
  seedStemmer(w.db, SCRIPT_ENDINGS, SCRIPT_STEMS);
  noteInterface(w, 'discord', [{ id: 'g1', name: 'Ágora' }]);
  return { w, room: addRoom(w.db, { iface: 'discord', native: 'c1', root: rootId('discord', 'g1'), name }) };
}

test('a place stored with a Latin prefix and a hyphen is found by the same words with the prefix in Cyrillic and an inflected second word, marked as a script match', () => {
  // Bug: the name written in the other script matches nothing, and the second word alone finds another place.
  const { w, room } = roomWorld('3d-сад');
  const found = hitsFor(namesOf(w.db, GROUP, ['3д сада']), placeNode(room));
  assert.deepEqual(
    found.map((hit) => hit.match),
    ['script']
  );
});

test('a place stored in Cyrillic is found by its Latin spelling', () => {
  // Bug: the key is applied one way only, so a Latin spelling of a Cyrillic name finds nothing.
  const { w, room } = roomWorld('Вокзал кино');
  const found = hitsFor(namesOf(w.db, GROUP, ['vokzal kino']), placeNode(room));
  assert.deepEqual(
    found.map((hit) => hit.match),
    ['script']
  );
});

test('a word that shares letters by the table with an unrelated name of another length matches nothing', () => {
  // Bug: the key is compared as a prefix or by trigrams, so "vokzalnyy" finds the place named "вокзал".
  const { w, room } = roomWorld('вокзал');
  assert.deepEqual(hitsFor(namesOf(w.db, GROUP, ['vokzalnyy']), placeNode(room)), []);
});

test('a place written before the key existed is found by script once the fill ran', () => {
  // Bug: the key is written for new rows only, so every name stored before it stays unreachable by script.
  const { w, room } = roomWorld('3d-сад');
  // A row as a database from before the change holds it: no key written.
  w.db.prepare('DELETE FROM names WHERE source_id = ?').run(room);
  w.db
    .prepare(
      `INSERT INTO names (label, normalized, stem, kind, node_id, audience_id, source_table, source_id)
       VALUES (?, ?, ?, 'place', ?, ?, 'places', ?)`
    )
    .run('3d-сад', '3d сад', '3d сад', placeNode(room), groupAudienceId('discord'), room);
  assert.deepEqual(hitsFor(namesOf(w.db, GROUP, ['3д сада']), placeNode(room)), [], 'before the fill');
  fillStems(w.db);
  assert.deepEqual(
    hitsFor(namesOf(w.db, GROUP, ['3д сада']), placeNode(room)).map((hit) => hit.match),
    ['script']
  );
});

test('a private alias in Cyrillic is found by its Latin spelling inside its own chat and not from a group', () => {
  // Bug: the script lookup skips the audience filter, so a name learned in a private chat opens the person to the group.
  const w = world();
  const person = 'person:discord:s2';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:s2', iface: 'discord', native: 's2', names: ['Stávros'] }] });
  const dm = addDm(w.db, { iface: 'discord', native: 's2', person, account: 'discord:s2' });
  addClaim(w.db, {
    id: 'claim:alias:s2',
    person,
    kind: 'alias',
    text: 'Вокзал кино',
    audience: { dm, iface: 'discord', person },
  });
  assert.deepEqual(
    hitsFor(namesOf(w.db, dmContext(person, 'discord', dm), ['vokzal kino']), personNode(person)).map(
      (hit) => hit.match
    ),
    ['script'],
    'inside its own chat'
  );
  assert.deepEqual(hitsFor(namesOf(w.db, GROUP, ['vokzal kino']), personNode(person)), [], 'from a group');
});

// Tests for the fake interface (scripts/lib/fake-interface.ts): `start(host)` serves the in-memory adapter over the
// link, like the Discord session does for Discord. The link runs over the loopback into a real event door, so each
// assertion reads what the core's end sees. `start(host, options)` takes the persona's id and the `legacy` object
// the core reads (a test passes none here), `emit(event)` is the interface injecting an inbound event and resolves
// with the ack status, and `adapter` is the fake adapter whose stored messages are what the persona posted.

// Plan 2026-11-06-turn-frame, slice 3 (c): an interface says its own names and nouns in `hello.names`, and the core keeps
// them as the interface's name and as names of kind `interface_noun` in the name index.
const NAMES = { interface: 'Fakebook', nouns: { server: 'όμιλος', channel: 'αίθουσα' }, dm: 'ιδιωτικό' };

test('a hello with names stores the interface name and its nouns as names of the interface', async () => {
  // Bug: the core takes the hello and drops its names, so "server" or the interface's own name raises nothing.
  await withFakes({ names: ['fake'] }, async ({ connect, rows }) => {
    await connect('fake', [{ id: 'g1', name: 'Ágora' }], NAMES);
    await waitFor(() => rows("SELECT id FROM places WHERE id = 'fake:server:g1'").length === 1, 'the hello');
    assert.equal(rows("SELECT name FROM interfaces WHERE id = 'fake'")[0]?.name, 'Fakebook');
    const nouns = rows("SELECT label FROM names WHERE kind = 'interface_noun'").map((row) => String(row.label));
    assert.deepEqual(
      ['όμιλος', 'αίθουσα'].filter((noun) => !nouns.includes(noun)),
      []
    );
    const own = rows("SELECT label FROM names WHERE node_id = 'interface:fake'").map((row) => String(row.label));
    assert.ok(own.includes('Fakebook'), 'the interface name is a name of its node');
  });
});

test('a hello without names stores the interface id as its name', async () => {
  // Bug: an interface that says nothing of itself stays unnamed, and the audit reports it forever.
  await withFakes({ names: ['fake'] }, async ({ connect, rows }) => {
    await connect('fake', [{ id: 'g1', name: 'Ágora' }]);
    // Waited for on the root the same hello names, which the core writes in the same step.
    await waitFor(() => rows("SELECT id FROM places WHERE id = 'fake:server:g1'").length === 1, 'the hello');
    assert.equal(rows("SELECT name FROM interfaces WHERE id = 'fake'")[0]?.name, 'fake');
  });
});
