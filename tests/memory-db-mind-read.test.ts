// src/memory/db/mind-read.ts: the graph reader, what comes to her mind on a turn (plan 2026-11-06-turn-frame, slice 3 (b),
// "How memory fills" and "Why the graph is the centre"). Code walks listed paths over the graph from the seeds of a turn,
// reads under the turn's context, ranks by evidence and cuts to a budget. No model takes part. Contract:
//   mindOf(db: Db, ctx: Context, seeds: Seeds, settings: MindSettings, now: number): Mind
//   Seeds = { messages: Array<SeedMessage>; counterpart: { personId; accountId } | null; place: string | null;
//     previous: Array<NodeRef>; candidates: Array<NodeRef & { sourceIds: Array<string>; from: 'prefetch' | 'query' }> }
//   NodeRef = { kind: string; rowId: string }      a graph node by its kind and the id of its row, never by its node id
//   SeedMessage = { id; at; authorAccount: string | null; placeId: string | null; replyTo: string | null;
//     mentions: Array<string>; text; trigger: boolean }     ids are stored row ids, `at` an ISO time, mentions account ids
//   MindSettings = context.memory of config/config.json: windowMessages, maxHops, maxNodesRead, budgetTokens, shares,
//     counterpartTokens, candidatesMax, commonWordEntries, fanOut
//   Mind = { people: Array<PersonEntry>; places: Array<PlaceEntry>; interfaces: Array<InterfaceEntry>; lore; recent; found;
//     leftOut: Record<string, number>; reads }
//   every entry: { nodeId (a graph node id); evidence: 'native' | 'reply' | 'counterpart' | 'author' | 'place' | 'edge' |
//     'word' | 'prose'; detail: 'whole' | 'compact' | 'name'; candidate: boolean; anchorMessageId: string | null;
//     sources: Array<{ table; id; version }> }
//   PersonEntry adds accounts: Array<string> (account row ids) and claims: Array<{ id; kind; text }>.
// `leftOut` counts per subtag (`people`, `places`, ...) the eligible entries the budget left out.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { allowances, mindOf, mindSettingsOf } from '../src/memory/db/mind-read.ts';
import type { Mind, MindSettings, PersonEntry, SeedMessage, Seeds } from '../src/memory/db/mind-read.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import {
  AT,
  NOW,
  addClaim,
  addDm,
  addLine,
  addMembership,
  addPerson,
  addRoom,
  deny,
  interfaceNode,
  noteInterface,
  openWorld,
  personNode,
  placeNode,
  rekeyNode,
  rootId,
  seedStemmer,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

/** The owner's values of 2026-11-06 for `context.memory`. */
const SETTINGS: MindSettings = {
  windowMessages: 100,
  maxHops: 2,
  maxNodesRead: 2000,
  budgetTokens: 10000,
  shares: { people: 0.5, places: 0.15, lore: 0.15, recent: 0.1, found: 0.1 },
  counterpartTokens: 1500,
  candidatesMax: 3,
  commonWordEntries: 3,
  fanOut: { accounts: 10, memberships: 20, rooms: 10, members: 8, replies: 5, about: 30 },
};

const DISCORD_NAMES = { interface: 'Discord', nouns: { server: 'server', channel: 'channel' }, dm: 'DM' };
const AGORA = rootId('discord', 'g1');
const PORTICO = rootId('discord', 'g2');
const STOA = rootId('discord', 'g3');
const GROUP = groupContext('discord');

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

/** Discord with its names and the roots Ágora, Pórtico and Stoá, and a stranger who writes in a room of Ágora. */
function world(): World & { room: string } {
  const opened = openWorld();
  worlds.push(opened);
  noteInterface(
    opened,
    'discord',
    [
      { id: 'g1', name: 'Ágora' },
      { id: 'g2', name: 'Pórtico' },
      { id: 'g3', name: 'Stoá' },
    ],
    DISCORD_NAMES
  );
  const room = addRoom(opened.db, { iface: 'discord', native: 'c1', root: AGORA, name: 'λέσχη' });
  addPerson(opened.db, {
    id: 'person:discord:x1',
    accounts: [{ id: 'discord:x1', iface: 'discord', native: 'x1', names: ['Xénios'] }],
  });
  return { ...opened, room };
}

const message = (id: string, text: string, more: Partial<SeedMessage> = {}): SeedMessage => ({
  id,
  at: AT,
  authorAccount: null,
  placeId: null,
  replyTo: null,
  mentions: [],
  text,
  trigger: false,
  ...more,
});

const seedsOf = (messages: Array<SeedMessage>, more: Partial<Seeds> = {}): Seeds => ({
  messages,
  counterpart: null,
  place: null,
  previous: [],
  candidates: [],
  ...more,
});

/** A line of the stranger in the room, stored and handed over as a seed. */
function strangerSays(
  w: World & { room: string },
  id: string,
  text: string,
  more: Partial<SeedMessage> = {}
): SeedMessage {
  addLine(w.db, { id, iface: 'discord', place: w.room, author: 'discord:x1', text });
  return message(id, text, { authorAccount: 'discord:x1', placeId: w.room, ...more });
}

const personIn = (mind: Mind, person: string): PersonEntry | undefined =>
  mind.people.find((entry) => entry.nodeId === personNode(person));
const placeIds = (mind: Mind): Array<string> => mind.places.map((entry) => entry.nodeId);

test('a native mention raises its person whole', () => {
  // Bug: a mention is matched as a word, so the person she is asked about gets one compact line.
  const w = world();
  addPerson(w.db, {
    id: 'person:discord:p1',
    accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }],
  });
  const trigger = strangerSays(w, 'src:m1', 'τι λες εσύ;', { trigger: true, mentions: ['discord:p1'] });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  const entry = personIn(mind, 'person:discord:p1');
  assert.deepEqual([entry?.evidence, entry?.detail], ['native', 'whole']);
});

test('an alias in the window raises the person compact, anchored on the line that names it', () => {
  // Bug: a name said in passing raises a whole profile and eats the budget, or the entry outlives the line that raised it.
  const w = world();
  const person = 'person:discord:q1';
  addPerson(w.db, {
    id: person,
    accounts: [{ id: 'discord:q1', iface: 'discord', native: 'q1', names: ['Eleftheríou'] }],
  });
  addClaim(w.db, { id: 'claim:alias:q1', person, kind: 'alias', text: 'Lefterákis', audience: { group: 'discord' } });
  const passing = strangerSays(w, 'src:m1', 'χθες ήρθε ο Lefterákis');
  const trigger = strangerSays(w, 'src:m2', 'καλημέρα', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([passing, trigger], { place: w.room }), SETTINGS, NOW);
  const entry = personIn(mind, person);
  assert.deepEqual([entry?.evidence, entry?.detail, entry?.anchorMessageId], ['word', 'compact', 'src:m1']);
});

test('a word matching four entries raises none of them', () => {
  // Bug: a common name raises everyone who carries it and floods the people with strangers.
  const w = world();
  const people = ['m1', 'm2', 'm3', 'm4'].map((native) => {
    const id = `person:discord:${native}`;
    addPerson(w.db, { id, accounts: [{ id: `discord:${native}`, iface: 'discord', native, names: ['Mákis'] }] });
    return id;
  });
  const trigger = strangerSays(w, 'src:m1', 'πού είναι ο Mákis;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.deepEqual(
    people.filter((id) => personIn(mind, id) !== undefined),
    []
  );
});

test('a word matching two entries raises both, marked as candidates', () => {
  // Bug: an ambiguous name is resolved to whichever person sorts first and shown as that person.
  const w = world();
  const people = ['e1', 'e2'].map((native) => {
    const id = `person:discord:${native}`;
    addPerson(w.db, { id, accounts: [{ id: `discord:${native}`, iface: 'discord', native, names: ['Eliá'] }] });
    return id;
  });
  const trigger = strangerSays(w, 'src:m1', 'είδες την Eliá;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.deepEqual(
    people.map((id) => personIn(mind, id)?.candidate),
    [true, true]
  );
});

test('an interface name raises its top-level places and stops there', () => {
  // Bug: "Discord" raises nothing, or the walk goes on into every room of every server.
  const w = world();
  const room = addRoom(w.db, { iface: 'discord', native: 'c9', root: PORTICO, name: 'αυλή' });
  const friend = 'person:telegram:f1';
  addPerson(w.db, { id: friend, accounts: [{ id: 'telegram:f1', iface: 'telegram', native: 'f1', names: ['Nikos'] }] });
  const dm = addDm(w.db, { iface: 'telegram', native: 'f1', person: friend, account: 'telegram:f1' });
  addLine(w.db, {
    id: 'src:t1',
    iface: 'telegram',
    place: dm,
    author: 'telegram:f1',
    text: 'είσαι στο Discord;',
    audience: { dm, iface: 'telegram', person: friend },
  });
  const trigger = message('src:t1', 'είσαι στο Discord;', { authorAccount: 'telegram:f1', placeId: dm, trigger: true });
  const mind = mindOf(
    w.db,
    dmContext(friend, 'telegram', dm),
    seedsOf([trigger], { place: dm, counterpart: { personId: friend, accountId: 'telegram:f1' } }),
    SETTINGS,
    NOW
  );
  assert.ok(
    mind.interfaces.some((entry) => entry.nodeId === interfaceNode('discord')),
    'the interface'
  );
  assert.deepEqual(
    [AGORA, PORTICO, STOA].filter((id) => placeIds(mind).includes(placeNode(id))),
    [AGORA, PORTICO, STOA]
  );
  assert.deepEqual(
    [w.room, room].filter((id) => placeIds(mind).includes(placeNode(id))),
    []
  );
});

test('a person raises the roots of their memberships, two hops away, and not their rooms', () => {
  // Bug: the walk stops at the person, or follows a root down into rooms nobody named.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }] });
  addMembership(w.db, { account: 'discord:p1', place: PORTICO });
  const room = addRoom(w.db, { iface: 'discord', native: 'c9', root: PORTICO, name: 'αυλή' });
  const trigger = strangerSays(w, 'src:m1', 'πώς πάει;', { trigger: true, mentions: ['discord:p1'] });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.ok(placeIds(mind).includes(placeNode(PORTICO)), 'the root of his membership');
  assert.equal(placeIds(mind).includes(placeNode(room)), false, 'a room of that root');
});

test('a node no audience may read in the middle of a path is neither shown nor walked through', () => {
  // Bug: the reader checks access on what it shows and not on what it walks, so a hidden node leaks what lies past it.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }] });
  const hidden = addMembership(w.db, { account: 'discord:p1', place: PORTICO });
  addMembership(w.db, { account: 'discord:p1', place: STOA });
  deny(w.db, `membership:${hidden}`);
  const trigger = strangerSays(w, 'src:m1', 'πώς πάει;', { trigger: true, mentions: ['discord:p1'] });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.equal(placeIds(mind).includes(placeNode(PORTICO)), false, 'the place behind the hidden membership');
  assert.ok(placeIds(mind).includes(placeNode(STOA)), 'the place behind the visible one');
});

/** A person with a Discord and a Telegram account, a direct chat on each, a group fact and a fact of the Discord chat. */
function twoChats(w: World): { person: string; discordDm: string; telegramDm: string } {
  const person = 'person:discord:p1';
  addPerson(w.db, {
    id: person,
    accounts: [
      { id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] },
      { id: 'telegram:p2', iface: 'telegram', native: 'p2', names: ['Pétros'] },
    ],
  });
  const discordDm = addDm(w.db, { iface: 'discord', native: 'p1', person, account: 'discord:p1' });
  const telegramDm = addDm(w.db, { iface: 'telegram', native: 'p2', person, account: 'telegram:p2' });
  addClaim(w.db, { id: 'claim:open', person, kind: 'fact', text: 'παίζει κιθάρα', audience: { group: 'discord' } });
  addClaim(w.db, {
    id: 'claim:secret',
    person,
    kind: 'fact',
    text: 'αλλάζει δουλειά',
    audience: { dm: discordDm, iface: 'discord', person },
  });
  return { person, discordDm, telegramDm };
}

/** The claims of the person she answers, read under `ctx` from a line of his in `place`. */
function claimsOfCounterpart(w: World, ctx: Context, place: string, account: string, person: string): Array<string> {
  const trigger = message('src:c1', 'γεια', { authorAccount: account, placeId: place, trigger: true });
  const mind = mindOf(
    w.db,
    ctx,
    seedsOf([trigger], { place, counterpart: { personId: person, accountId: account } }),
    SETTINGS,
    NOW
  );
  return (personIn(mind, person)?.claims ?? []).map((claim) => claim.id);
}

test("a direct chat's claim is absent in a group context, where the group's claim is present", () => {
  // Bug: the person's facts are read as herself, and what he told her alone is shown in a room.
  const w = world();
  const { person } = twoChats(w);
  const claims = claimsOfCounterpart(w, GROUP, w.room, 'discord:p1', person);
  assert.deepEqual([claims.includes('claim:open'), claims.includes('claim:secret')], [true, false]);
});

test("a direct chat's claim is present in that chat and in the chat of a linked account", () => {
  // Bug: the reader checks the chat's own audience only, so the same person on another interface loses what he said.
  const w = world();
  const { person, discordDm, telegramDm } = twoChats(w);
  const inChat = claimsOfCounterpart(w, dmContext(person, 'discord', discordDm), discordDm, 'discord:p1', person);
  const linked: Context = {
    ...dmContext(person, 'telegram', telegramDm),
    linked: [{ iface: 'discord', person, place: discordDm }],
  };
  const inLinked = claimsOfCounterpart(w, linked, telegramDm, 'telegram:p2', person);
  assert.deepEqual([inChat.includes('claim:secret'), inLinked.includes('claim:secret')], [true, true]);
});

test('two accounts of one person render one entry that names both', () => {
  // Bug: the person she answers on Telegram and the same person named by his Discord name appear twice.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, {
    id: person,
    accounts: [
      { id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] },
      { id: 'telegram:p2', iface: 'telegram', native: 'p2', names: ['Pit'] },
    ],
  });
  const dm = addDm(w.db, { iface: 'telegram', native: 'p2', person, account: 'telegram:p2' });
  const trigger = message('src:t1', 'ο Pétros σου στέλνει χαιρετίσματα', {
    authorAccount: 'telegram:p2',
    placeId: dm,
    trigger: true,
  });
  const mind = mindOf(
    w.db,
    dmContext(person, 'telegram', dm),
    seedsOf([trigger], { place: dm, counterpart: { personId: person, accountId: 'telegram:p2' } }),
    SETTINGS,
    NOW
  );
  const entries = mind.people.filter((entry) => entry.nodeId === personNode(person));
  assert.equal(entries.length, 1);
  assert.deepEqual([...(entries[0]?.accounts ?? [])].sort(), ['discord:p1', 'telegram:p2']);
});

/** The accounts an entry lists for her, as `<iface> <platform id>`. */
const listedAccounts = (entry: PersonEntry | undefined): Array<string> =>
  (entry?.profileAccounts ?? []).map((account) => `${account.iface} ${account.platformId}`);

test('lines from two accounts of one person in one room raise one entry that lists both accounts', () => {
  // Bug: one person writing from two accounts reads as two people, or the entry does not say which accounts are his.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, {
    id: person,
    accounts: [
      { id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] },
      { id: 'discord:p2', iface: 'discord', native: 'p2', names: ['Pit'] },
    ],
  });
  addLine(w.db, { id: 'src:a1', iface: 'discord', place: w.room, author: 'discord:p1', text: 'καλημέρα' });
  addLine(w.db, { id: 'src:a2', iface: 'discord', place: w.room, author: 'discord:p2', text: 'πάλι εγώ' });
  const lines = [
    message('src:a1', 'καλημέρα', { authorAccount: 'discord:p1', placeId: w.room }),
    message('src:a2', 'πάλι εγώ', { authorAccount: 'discord:p2', placeId: w.room, trigger: true }),
  ];
  const mind = mindOf(w.db, GROUP, seedsOf(lines, { place: w.room }), SETTINGS, NOW);
  const entries = mind.people.filter((entry) => entry.personId === person);
  assert.equal(entries.length, 1);
  assert.deepEqual(listedAccounts(entries[0]), ['discord p1', 'discord p2']);
});

test("the owner's entry read from the command line lists his Discord account with its platform id", () => {
  // Bug: from the command line she knows the owner only as the command line's account, not his Discord id.
  const w = world();
  const owner = 'person:discord:o1';
  addPerson(w.db, {
    id: owner,
    accounts: [
      { id: 'discord:o1', iface: 'discord', native: 'o1', names: ['Ὅμηρος'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['owner'] },
    ],
  });
  const dm = addDm(w.db, { iface: 'cli', native: 'owner', person: owner, account: 'cli:owner' });
  addLine(w.db, {
    id: 'src:o1',
    iface: 'cli',
    place: dm,
    author: 'cli:owner',
    text: 'γεια',
    audience: { dm, iface: 'cli', person: owner },
  });
  const trigger = message('src:o1', 'γεια', { authorAccount: 'cli:owner', placeId: dm, trigger: true });
  const mind = mindOf(
    w.db,
    dmContext(owner, 'cli', dm),
    seedsOf([trigger], { place: dm, counterpart: { personId: owner, accountId: 'cli:owner' } }),
    SETTINGS,
    NOW
  );
  assert.ok(listedAccounts(personIn(mind, owner)).includes('discord o1'));
});

test('the budget cuts the lowest evidence first and leftOut counts it', () => {
  // Bug: the cut takes entries in the order they were found, so a name said in passing pushes out the person asked about,
  // or the request says nothing about what it left out.
  const w = world();
  addPerson(w.db, {
    id: 'person:discord:p1',
    accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }],
  });
  const passer = 'person:discord:q1';
  addPerson(w.db, {
    id: passer,
    accounts: [{ id: 'discord:q1', iface: 'discord', native: 'q1', names: ['Eleftheríou'] }],
  });
  addClaim(w.db, {
    id: 'claim:alias:q1',
    person: passer,
    kind: 'alias',
    text: 'Lefterákis',
    audience: { group: 'discord' },
  });
  const passing = strangerSays(w, 'src:m1', 'χθες ήρθε ο Lefterákis');
  const trigger = strangerSays(w, 'src:m2', 'τι λες εσύ;', { trigger: true, mentions: ['discord:p1'] });
  const tight: MindSettings = { ...SETTINGS, budgetTokens: 1, counterpartTokens: 0 };
  const mind = mindOf(w.db, GROUP, seedsOf([passing, trigger], { place: w.room }), tight, NOW);
  assert.equal(
    personIn(mind, 'person:discord:p1')?.nodeId,
    personNode('person:discord:p1'),
    'the person the trigger mentions'
  );
  assert.equal(personIn(mind, passer), undefined, 'the person a passing word raised');
  assert.equal(mind.leftOut.people, 1);
});

test('the person she answers is present with an empty budget', () => {
  // Bug: a budget spent elsewhere, or none at all, drops the one person the reply is for.
  const w = world();
  const friend = 'person:telegram:f1';
  addPerson(w.db, { id: friend, accounts: [{ id: 'telegram:f1', iface: 'telegram', native: 'f1', names: ['Nikos'] }] });
  const dm = addDm(w.db, { iface: 'telegram', native: 'f1', person: friend, account: 'telegram:f1' });
  const trigger = message('src:t1', 'γεια', { authorAccount: 'telegram:f1', placeId: dm, trigger: true });
  const empty: MindSettings = { ...SETTINGS, budgetTokens: 0, counterpartTokens: 0 };
  const mind = mindOf(
    w.db,
    dmContext(friend, 'telegram', dm),
    seedsOf([trigger], { place: dm, counterpart: { personId: friend, accountId: 'telegram:f1' } }),
    empty,
    NOW
  );
  assert.equal(personIn(mind, friend)?.nodeId, personNode(friend));
});

test('the Telegram case: a friend asks about a server of another interface and gets the server, its busiest rooms, its closest people and the place he shares with her', () => {
  // Bug: in a private chat on one interface she cannot think of a place or a person of another (the plan's first milestone).
  const w = world();
  const db = w.db;
  const lounge = w.room;
  const drawing = addRoom(db, { iface: 'discord', native: 'c2', root: AGORA, name: 'ζωγραφική' });
  const kitchen = addRoom(db, { iface: 'discord', native: 'c3', root: AGORA, name: 'κουζίνα' });
  const say = (room: string, count: number): void => {
    for (let i = 0; i < count; i += 1)
      addLine(db, { id: `src:her:${room}:${i}`, iface: 'discord', place: room, author: 'self', text: 'καλησπέρα' });
  };
  say(lounge, 5);
  say(drawing, 3);
  say(kitchen, 1);
  const friend = 'person:discord:f1';
  addPerson(db, {
    id: friend,
    realName: 'Nikólaos Aléxiou',
    accounts: [
      { id: 'discord:f1', iface: 'discord', native: 'f1', names: ['Nikólas'] },
      { id: 'telegram:f2', iface: 'telegram', native: 'f2', names: ['Nikos'] },
    ],
  });
  addMembership(db, { account: 'discord:f1', place: AGORA });
  addMembership(db, { account: 'discord:f1', place: PORTICO });
  const members = [
    ['h1', 'Eléni', 9],
    ['h2', 'Dimítris', 7],
    ['h3', 'Marína', 1],
  ] as const;
  for (const [native, name, affinity] of members) {
    addPerson(db, {
      id: `person:discord:${native}`,
      affinity,
      accounts: [{ id: `discord:${native}`, iface: 'discord', native, names: [name] }],
    });
    addMembership(db, { account: `discord:${native}`, place: AGORA });
  }
  const dm = addDm(db, { iface: 'telegram', native: 'f2', person: friend, account: 'telegram:f2' });
  const text = 'ποια είναι τα αγαπημένα σου κανάλια στην Ágora και ποιον συμπαθείς πιο πολύ εκεί;';
  addLine(db, {
    id: 'src:t1',
    iface: 'telegram',
    place: dm,
    author: 'telegram:f2',
    text,
    audience: { dm, iface: 'telegram', person: friend },
  });
  const trigger = message('src:t1', text, { authorAccount: 'telegram:f2', placeId: dm, trigger: true });
  const settings: MindSettings = { ...SETTINGS, fanOut: { ...SETTINGS.fanOut, rooms: 2, members: 2 } };
  const mind = mindOf(
    db,
    dmContext(friend, 'telegram', dm),
    seedsOf([trigger], { place: dm, counterpart: { personId: friend, accountId: 'telegram:f2' } }),
    settings,
    NOW
  );
  const [first] = mind.people;
  assert.equal(first?.nodeId, personNode(friend), 'the friend comes first');
  const places = placeIds(mind);
  assert.deepEqual(
    [AGORA, lounge, drawing, PORTICO].filter((id) => !places.includes(placeNode(id))),
    [],
    'the server, its two busiest rooms and the other server the friend shares'
  );
  const raised = members.map(([native]) => personIn(mind, `person:discord:${native}`) !== undefined);
  assert.deepEqual(raised, [true, true, false], 'the two members she is closest to');
  for (const entry of [...mind.people, ...mind.places])
    assert.ok(entry.sources.length > 0, `${entry.nodeId} has a source`);
});

// ---- nodes by kind and row --------------------------------------------------------------------------------------------
// A node's kind and row come from `graph_nodes` or from the caller, never from the text of its id: every case below gives
// a node an id that spells neither.

test("a word naming a person raises them whatever their graph node's id spells", () => {
  // Bug: the kind of a name's node was cut out of its id, so a person whose node id does not spell `person:` was no
  // person and the word raised nothing.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }] });
  rekeyNode(w.db, personNode(person), 'node-p1');
  const trigger = strangerSays(w, 'src:m1', 'είδες τον Pétros;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  const entry = mind.people.find((one) => one.nodeId === 'node-p1');
  assert.deepEqual([entry?.personId, entry?.evidence], [person, 'word']);
});

test("a person's membership raises its root whatever the root's graph node id spells", () => {
  // Bug: the place a membership edge reached was cut out of the edge's node id, so a root whose node id does not spell
  // `place:` was dropped from the walk.
  const w = world();
  const person = 'person:discord:p1';
  addPerson(w.db, { id: person, accounts: [{ id: 'discord:p1', iface: 'discord', native: 'p1', names: ['Pétros'] }] });
  addMembership(w.db, { account: 'discord:p1', place: PORTICO });
  rekeyNode(w.db, placeNode(PORTICO), 'node-portico');
  const trigger = strangerSays(w, 'src:m1', 'πώς πάει;', { trigger: true, mentions: ['discord:p1'] });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.equal(mind.places.find((one) => one.nodeId === 'node-portico')?.placeId, PORTICO);
});

test("an interface's name raises the interface and its top places whatever its graph node id spells", () => {
  // Bug: the interface was cut out of its node id, so a name of an interface whose node id does not spell `interface:`
  // raised nothing.
  const w = world();
  rekeyNode(w.db, interfaceNode('discord'), 'node-discord');
  const trigger = strangerSays(w, 'src:m1', 'είσαι στο Discord;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.equal(mind.interfaces.find((one) => one.nodeId === 'node-discord')?.iface, 'discord');
  assert.ok(placeIds(mind).includes(placeNode(STOA)), 'a top place of the interface');
});

test('a prefetched line given by its kind and row is an excerpt, and a place given so is raised', () => {
  // Bug: a candidate came as a node id the caller spelled and the reader cut apart again, so its kind and row were
  // guessed from text.
  const w = world();
  addLine(w.db, { id: 'src:old', iface: 'discord', place: w.room, author: 'discord:x1', text: 'παλιά κουβέντα' });
  const trigger = strangerSays(w, 'src:m1', 'θυμάσαι;', { trigger: true });
  const candidates: Seeds['candidates'] = [
    { kind: 'source', rowId: 'src:old', sourceIds: ['src:old'], from: 'prefetch' },
    { kind: 'place', rowId: PORTICO, sourceIds: [], from: 'query' },
  ];
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room, candidates }), SETTINGS, NOW);
  assert.deepEqual(
    mind.found.map((one) => [one.sourceId, one.from]),
    [['src:old', 'prefetch']]
  );
  assert.ok(placeIds(mind).includes(placeNode(PORTICO)), 'the place candidate');
});

/** The world with a learned stemmer that strips a final ς or ν, so a room's inflected names meet its own by stem. */
function stemmedWorld(): World & { room: string } {
  const w = world();
  seedStemmer(w.db, ['ς', 'ν'], [['θαλασσα', 3]]);
  return w;
}

test('a room under the current root that one inflected word names is an entry, no candidate', () => {
  // Bug (2026-11-10): a place named in the line by an inflected word matched by stem only and came as a candidate, a
  // name she could not trust, so in three of five samples she answered about a place without reading it.
  const w = stemmedWorld();
  const sea = addRoom(w.db, { iface: 'discord', native: 'c7', root: AGORA, name: 'Θάλασσα' });
  const trigger = strangerSays(w, 'src:m1', 'τι νέα της Θάλασσας;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  const entry = mind.places.find((one) => one.nodeId === placeNode(sea));
  assert.deepEqual([entry?.candidate, entry?.detail === 'name'], [false, false]);
});

test('an inflected word that two rooms under the current root share by stem leaves both candidates', () => {
  // Bug: the rule for one stem match takes the first of two rooms the word fits and shows it as the place she was asked
  // about, when the line does not say which one.
  const w = stemmedWorld();
  const rooms = [
    addRoom(w.db, { iface: 'discord', native: 'c7', root: AGORA, name: 'Θάλασσα' }),
    addRoom(w.db, { iface: 'discord', native: 'c8', root: AGORA, name: 'Θάλασσας' }),
  ];
  const trigger = strangerSays(w, 'src:m1', 'πάμε στη Θάλασσαν;', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.deepEqual(
    rooms.map((room) => mind.places.find((one) => one.nodeId === placeNode(room))?.candidate),
    [true, true]
  );
});

/** A live config with `context.memory` holding `memory` and `llm.maxRequestTokens` at 100000. */
const configOf = (memory: Record<string, unknown>): unknown => ({
  llm: { maxRequestTokens: 100000 },
  context: { memory },
});

test('the total of the memory blocks is budgetTokens when budgetShare is unset', () => {
  // Bug: the new key changes the total of a deployment that never set it.
  assert.equal(mindSettingsOf(configOf({ budgetTokens: 7000 })).budgetTokens, 7000);
});

test('the total is the share of llm.maxRequestTokens when that is less than budgetTokens', () => {
  // Bug: the share is ignored, so a small request cap still gets a memory budget that crowds out the chat.
  assert.equal(mindSettingsOf(configOf({ budgetTokens: 10000, budgetShare: 0.05 })).budgetTokens, 5000);
});

test('the total stays budgetTokens when the share of llm.maxRequestTokens gives more', () => {
  // Bug: the share replaces budgetTokens instead of capping it, so a large cap raises the total past the setting.
  assert.equal(mindSettingsOf(configOf({ budgetTokens: 10000, budgetShare: 0.5 })).budgetTokens, 10000);
});

test('a budgetShare that is zero, negative, above 1 or not a number counts as unset', () => {
  // Bug: zero empties <memory>, a negative or a string yields a negative or NaN total, and a share above 1 is read as a cap.
  for (const budgetShare of [0, -0.1, 1.5, '0.05', null, Number.NaN, {}]) {
    const total = mindSettingsOf(configOf({ budgetTokens: 10000, budgetShare })).budgetTokens;
    assert.equal(total, 10000, `budgetShare ${JSON.stringify(budgetShare)} gave ${total}`);
  }
});

const SHARES = { people: 0.4, places: 0.3, lore: 0.15, recent: 0.1, found: 0.05 };

test('what found leaves unused is lent to none of the stable shares, whatever found takes', () => {
  // Bug: the share the turn's own <found> leaves unused is lent to a full <places>, so a place's detail follows how much
  // the turn found and the stable part of the request changes on every turn. Budget 1000: people wants 100 of its 400,
  // places 900 of its 300, lore and recent exactly their share.
  const demandWith = (found: number) => ({ people: 100, places: 900, lore: 150, recent: 100, found });
  const empty = allowances({ budgetTokens: 1000, shares: SHARES }, demandWith(0));
  assert.equal(empty.places, 600, 'places takes its share and what people leaves unused');
  for (const found of [0, 20, 50, 400]) {
    const given = allowances({ budgetTokens: 1000, shares: SHARES }, demandWith(found));
    for (const tag of ['people', 'places', 'lore', 'recent'] as const)
      assert.equal(given[tag], empty[tag], `${tag} with found wanting ${found}`);
  }
});

// Names across scripts (spec 2026-11-12-names-across-scripts, slice 1): the key of src/memory/db/script-key.ts is one more
// way of matchName, and a hit of a phrase of two or three words drops the hit of a single word inside it.
/** The world with a stemmer that knows "сада" is "сад", a room named "сад" and a room named "3d-сад", both under Ágora. */
function gardenWorld(): { w: World & { room: string }; plain: string; digit: string } {
  const opened = openWorld();
  worlds.push(opened);
  seedStemmer(opened.db, ['а'], [['сад', 3]]);
  noteInterface(opened, 'discord', [{ id: 'g1', name: 'Ágora' }], DISCORD_NAMES);
  const room = addRoom(opened.db, { iface: 'discord', native: 'c1', root: AGORA, name: 'λέσχη' });
  addPerson(opened.db, {
    id: 'person:discord:x1',
    accounts: [{ id: 'discord:x1', iface: 'discord', native: 'x1', names: ['Xénios'] }],
  });
  const plain = addRoom(opened.db, { iface: 'discord', native: 'c2', root: AGORA, name: 'сад' });
  const digit = addRoom(opened.db, { iface: 'discord', native: 'c3', root: AGORA, name: '3d-сад' });
  return { w: { ...opened, room }, plain, digit };
}

const placeIn = (mind: Mind, place: string) => mind.places.find((entry) => entry.nodeId === placeNode(place));

test('a line naming two words of a place in another script raises that place sure and not the place named by the second word alone', () => {
  // Bug: the first word matches nothing, the second word alone stems to the other place, and the place asked about is lost.
  const { w, plain, digit } = gardenWorld();
  const trigger = strangerSays(w, 'src:g1', 'покажи 3д сада', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.deepEqual([placeIn(mind, digit)?.candidate, placeIn(mind, plain)], [false, undefined]);
});

test('a line naming the second word alone still raises the place named by it', () => {
  // Bug: the longer-phrase rule drops every single-word hit, even when no longer phrase of the line matched.
  const { w, plain } = gardenWorld();
  const trigger = strangerSays(w, 'src:g1', 'покажи сада', { trigger: true });
  const mind = mindOf(w.db, GROUP, seedsOf([trigger], { place: w.room }), SETTINGS, NOW);
  assert.equal(placeIn(mind, plain)?.candidate, false);
});
