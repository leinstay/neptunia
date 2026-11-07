// src/memory/db/mind-read.ts: the graph reader, what comes to her mind on a turn (plan 2026-11-06-turn-frame, slice 3 (b),
// "How memory fills" and "Why the graph is the centre"). Code walks listed paths over the graph from the seeds of a turn,
// reads under the turn's context, ranks by evidence and cuts to a budget. No model takes part. Contract:
//   mindOf(db: Db, ctx: Context, seeds: Seeds, settings: MindSettings, now: number): Mind
//   Seeds = { messages: Array<SeedMessage>; counterpart: { personId; accountId } | null; place: string | null;
//     previous: Array<EntryRef>; candidates: Array<{ nodeId; sourceIds: Array<string>; from: 'prefetch' | 'query' }> }
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
import { mindOf } from '../src/memory/db/mind-read.ts';
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
  rootId,
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
  assert.ok(personIn(mind, 'person:discord:p1') !== undefined, 'the person the trigger mentions');
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
  assert.ok(personIn(mind, friend) !== undefined);
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
