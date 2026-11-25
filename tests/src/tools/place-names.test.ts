// How a place named in a read call resolves: `matchPlace` (src/tools/place-names.ts), the list of choices it renders
// (`placeChoicesText`), and `resolveCall` for the two read skills, `memory.search` and `conversation.read`
// (src/tools/executors.ts). A turn in a DM or on the command line has no `<channel_directory>`, so the persona writes a
// name they guessed: it is compared after folding case and dropping emoji, punctuation and `#`, a loaded stemmer lets an
// inflected word find the channel, and an answer that cannot be one place lists the places the persona may read, as
// data, so they can call again. Synthetic names only. Which places the persona may read is decided in
// tests/src/turn/calls.test.ts; here the list is given.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import { resolveCall } from '../../../src/tools/executors.ts';
import {
  PLACE_CHOICES_MAX,
  matchPlace,
  placeChoicesText,
  type PlaceCandidate,
} from '../../../src/tools/place-names.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import '../../../src/tools/operations/index.ts';
import { labels } from '../../fixtures/labels.ts';
import { addRoom, AT, rootId } from '../../fixtures/memory-db/mind-world.ts';
import { type ServiceRun, serviceTurn, serviceWake, serviceWorld, TURN_NOW } from '../../fixtures/service-turn.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { appended, contentText, coreTurn } from '../../fixtures/turn-harness.ts';
import { type Fake, useIface } from '../../fixtures/turn-world.ts';

/** A tiny stemmer for the tests: drops a plural `s` or `ing`. */
const stem = (word: string): string => word.replace(/(?:ing|s)$/, '');

const GARDEN: PlaceCandidate = { id: '1001', name: '🌿┃Garden Notes', handle: 'cg1' };
const CELLAR: PlaceCandidate = { id: '1002', name: '🥕 root_cellar!', handle: null };
const PLACES: ReadonlyArray<PlaceCandidate> = [GARDEN, CELLAR, { id: '1003', name: '📺 film-club', handle: 'cg3' }];

function idOf(match: ReturnType<typeof matchPlace>): string | null {
  return match.kind === 'one' ? match.id : null;
}

test('takes a place named by its handle, with or without the hash', () => {
  assert.equal(idOf(matchPlace('#cg1', PLACES)), '1001');
  assert.equal(idOf(matchPlace('cg1', PLACES)), '1001');
});

test('takes a place named by its native id or its mention', () => {
  assert.equal(idOf(matchPlace('1002', PLACES)), '1002');
  assert.equal(idOf(matchPlace('<#1002>', PLACES)), '1002');
});

test('takes a place named by its name once case, emoji, punctuation and the hash are dropped', () => {
  assert.equal(idOf(matchPlace('#garden notes', PLACES)), '1001');
  assert.equal(idOf(matchPlace('GARDEN NOTES', PLACES)), '1001');
  assert.equal(idOf(matchPlace('🌱 Garden Notes', PLACES)), '1001');
  assert.equal(idOf(matchPlace('rootcellar', PLACES)), '1002');
});

test('takes an inflected name when a stemmer is loaded and lists the choices when none is', () => {
  const places: Array<PlaceCandidate> = [{ id: '2001', name: '🍲 recipes', handle: null }, GARDEN];
  assert.equal(idOf(matchPlace('recipe', places, { stem })), '2001');
  assert.equal(idOf(matchPlace('cooking recipe', places, { stem })), null, 'an extra word is no match');
  assert.equal(matchPlace('recipe', places).kind, 'none');
});

test('stems every word of a name, so a many-word name is found by its inflected form', () => {
  assert.equal(idOf(matchPlace('garden note', PLACES, { stem })), '1001');
});

test('takes the exact name with no list when a stem would also match another place', () => {
  const places: Array<PlaceCandidate> = [
    { id: '3001', name: 'rose', handle: null },
    { id: '3002', name: 'roses', handle: null },
  ];
  assert.equal(idOf(matchPlace('roses', places, { stem })), '3002');
  assert.equal(idOf(matchPlace('rose', places, { stem })), '3001');
});

test('answers the matches when several places share a folded name', () => {
  const places: Array<PlaceCandidate> = [
    { id: '4001', name: '🌿 herbs', handle: 'h1' },
    { id: '4002', name: '🌱 Herbs', handle: null },
    { id: '4003', name: 'stone', handle: null },
  ];
  const match = matchPlace('herbs', places);
  assert.equal(match.kind, 'several');
  assert.deepEqual(match.kind === 'several' ? match.choices.map((choice) => choice.id).sort() : [], ['4001', '4002']);
});

test('answers every place the persona may read when the name matches none', () => {
  const match = matchPlace('memes', PLACES);
  assert.equal(match.kind, 'none');
  assert.deepEqual(match.kind === 'none' ? match.choices.map((choice) => choice.id).sort() : [], [
    '1001',
    '1002',
    '1003',
  ]);
});

test('answers no choices and a total of zero when the persona may read no place at all', () => {
  const match = matchPlace('memes', []);
  assert.equal(match.kind, 'none');
  assert.equal(match.kind === 'none' ? match.choices.length : -1, 0);
  assert.equal(match.kind === 'none' ? match.total : -1, 0);
});

test('lists at most the bound of choices and reports how many places there are', () => {
  const many: Array<PlaceCandidate> = Array.from({ length: PLACE_CHOICES_MAX + 9 }, (_, i) => ({
    id: String(5000 + i),
    name: `room ${i}`,
    handle: null,
  }));
  const match = matchPlace('nothing like it', many);
  assert.equal(match.kind, 'none');
  assert.equal(match.kind === 'none' ? match.choices.length : -1, PLACE_CHOICES_MAX);
  assert.equal(match.kind === 'none' ? match.total : -1, PLACE_CHOICES_MAX + 9);
  const capped = matchPlace('nothing like it', many, { max: 3 });
  assert.equal(capped.kind === 'none' ? capped.choices.length : -1, 3);
});

test('a reference with nothing left after folding matches no place', () => {
  assert.equal(matchPlace('🌿 #!', PLACES).kind, 'none');
  assert.equal(matchPlace('', PLACES).kind, 'none');
});

// ---- the rendered list --------------------------------------------------------------------------------------------

/** Labels with a marker per key, so the test checks that the list is rendered from them, never their wording. */
const marked = {
  tools: {
    tools: {
      place: {
        several: 'SEVERAL-MARK {given} {count}',
        none: 'NONE-MARK {given}',
        line: 'LINE-MARK {ref} {name}',
        more: 'MORE-MARK {count}',
      },
    },
  },
};

test('renders the choices under the lead of the label for the case, one line each with the token to write', () => {
  const text = placeChoicesText(matchPlace('memes', PLACES), marked, 'memes');
  assert.ok(text.includes('NONE-MARK memes'), text);
  assert.equal(text.includes('SEVERAL-MARK'), false);
  assert.ok(text.includes('LINE-MARK #cg1 🌿┃Garden Notes'), 'a place with a handle is written by its handle');
  // A place is named by its handle and name, and no raw place id reaches the persona.
  const cellar = text.split('\n').find((line) => line.includes('root_cellar!')) ?? '';
  assert.equal(cellar.split('root_cellar!').length - 1, 1, 'a place without a handle is listed by its name, once');
  assert.equal(text.includes('1002'), false, 'a place without a handle is never written by its id');
  assert.equal(text.includes('MORE-MARK'), false, 'no tail while every place is listed');
});

test('renders the several-lead with the number of matches and the tail when matches were left out', () => {
  const places: Array<PlaceCandidate> = Array.from({ length: 5 }, (_, i) => ({
    id: String(6000 + i),
    name: 'herbs',
    handle: null,
  }));
  const text = placeChoicesText(matchPlace('herbs', places, { max: 2 }), marked, 'herbs');
  assert.ok(text.includes('SEVERAL-MARK herbs 5'), text);
  assert.ok(text.includes('MORE-MARK 3'), text);
  assert.equal(text.split('LINE-MARK').length - 1, 2);
});

test('the token written for a choice resolves back to its own place', () => {
  const view = { skills: skillRegistry(), places: PLACES, chats: [] };
  for (const place of PLACES) {
    const ref = place.handle ? `#${place.handle}` : place.id;
    const resolved = resolveCall({ skill: 'conversation.read', args: { place: ref } }, view);
    assert.equal(resolved.ok, true, ref);
    assert.equal('args' in resolved ? resolved.args.place : null, place.id);
  }
});

// ---- resolveCall for the read skills ------------------------------------------------------------------------------

const READ_SKILLS = [
  ['memory.search', { question: 'what was posted' }],
  ['conversation.read', {}],
] as const;

for (const [skill, extra] of READ_SKILLS) {
  const resolve = (channel: string, view: object) =>
    resolveCall({ skill, args: { ...extra, place: channel } }, { skills: skillRegistry(), ...view });
  const choiceIds = (refusal: object): Array<string> =>
    'choices' in refusal ? (refusal.choices as ReadonlyArray<{ id: string }>).map((choice) => choice.id).sort() : [];

  test(`${skill}: resolves a channel written by its folded name from the places the persona may read`, () => {
    const resolved = resolve('#garden notes', { places: PLACES, chats: [] });
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.place : null, '1001');
  });

  test(`${skill}: resolves an inflected name with the stemmer of the view`, () => {
    const view = { places: [{ id: '2001', name: '🍲 recipes', handle: null }], chats: [], stem };
    const resolved = resolve('recipe', view);
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.place : null, '2001');
  });

  test(`${skill}: refuses an unknown name with the places the persona may read as choices`, () => {
    const refusal = resolve('#memes', { places: PLACES, chats: [] });
    assert.equal(refusal.ok, false);
    assert.equal('reason' in refusal ? refusal.reason : null, 'args.place:unknown-channel');
    assert.deepEqual(choiceIds(refusal), ['1001', '1002', '1003']);
  });

  test(`${skill}: refuses a name that fits several places with the matches as choices`, () => {
    const places: Array<PlaceCandidate> = [
      { id: '4001', name: '🌿 herbs', handle: 'h1' },
      { id: '4002', name: '🌱 Herbs', handle: null },
      { id: '4003', name: 'stone', handle: null },
    ];
    const refusal = resolve('herbs', { places, chats: [] });
    assert.equal(refusal.ok, false);
    assert.equal('code' in refusal ? refusal.code : null, 'target-ambiguous');
    assert.deepEqual(choiceIds(refusal), ['4001', '4002']);
  });

  // The adversary: the root holds a channel the persona may not read here, and the name is exactly its name.
  test(`${skill}: never matches or lists a channel that is not among the places the persona may read`, () => {
    const refusal = resolve('staff room', { places: PLACES, chats: [{ id: '9999', name: 'staff room' }] });
    assert.equal(refusal.ok, false);
    assert.deepEqual(choiceIds(refusal), ['1001', '1002', '1003']);
  });

  test(`${skill}: an unknown name with no place to read is refused with an empty list`, () => {
    const refusal = resolve('#memes', { places: [], chats: [] });
    assert.equal(refusal.ok, false);
    assert.deepEqual('choices' in refusal ? refusal.choices : null, []);
  });
}

// The write path names channels by `chats`, whatever the persona may read.
test('message.create still resolves a destination from the chats of the view, not the places to read', () => {
  const view = { skills: skillRegistry(), places: [], chats: [{ id: '9999', name: 'staff room' }] };
  const resolved = resolveCall({ skill: 'message.create', args: { text: 'hello', place: 'staff room' } }, view);
  assert.equal(resolved.ok, true);
  assert.equal('args' in resolved ? resolved.args.place : null, '9999');
});

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

/** An intention turn nowhere whose one step reads the place the persona wrote as `written`. */
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

describe('a place found in a turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a place named by what it is for comes back as ranked candidates and nothing is read', async () => {
    // Bug: a name that is no place's name is refused with every place listed in id order, or a guessed room is read, so
    // the persona reads the wrong room instead of the one the words describe.
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
});

/** The second interface, holding the room `k1` where the persona may read and not write. */
function teleAdapter(): Fake {
  const tele = createFakeAdapter({ iface: 'tele', selfId: 'self-id', now: () => TURN_NOW });
  tele.seedChat({
    iface: 'tele',
    id: 'k1',
    kind: 'channel',
    name: 'λιμάνι',
    rootId: 't1',
    topic: null,
    permissions: { read: true, send: false, attach: false, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  });
  return tele;
}

/** One case: the interface, the name the persona writes, and where a post there would land. */
type Case = { iface: string; written: string; sentThere: (run: ServiceRun, tele: Fake) => number };

const CASES: ReadonlyArray<Case> = [
  {
    iface: 'fake',
    written: 'Ανακοινωσεις',
    sentThere: (run) => run.port.messagesIn('c3').length,
  },
  {
    iface: 'tele',
    written: 'ΛΙΜΑΝΙ',
    sentThere: (_run, tele) => tele.calls.filter((one) => one.op === 'send').length,
  },
];

/** An intention turn nowhere whose one step calls `skill` with `args`, over the world with the room `c3` stored too. */
async function callNowhere(skill: string, args: Record<string, unknown>): Promise<{ run: ServiceRun; tele: Fake }> {
  const world = serviceWorld();
  addRoom(world.db, { iface: 'fake', native: 'c3', root: rootId('fake', 'g1'), name: 'ανακοινώσεις' });
  const tele = teleAdapter();
  const due = { id: '' };
  try {
    const run = await serviceTurn({
      world,
      adapters: [tele],
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000 }],
          chainId: due.id,
        }),
      seed: (service) => {
        const made = service.set({ purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000, by: 'persona' }) as {
          intention?: { id: string };
        };
        due.id = made.intention?.id ?? '';
      },
      answers: [toolAnswer(THINK, [call(skill, args)]), '<skip/>'],
      chat: null,
    });
    return { run, tele };
  } finally {
    world.close();
  }
}

/** `skill:status:code` of the turn's first call, split. The status is the action's (`executed` once the operation ran,
 * whatever it answered), so the code carries the refusal. */
function firstAction(run: ServiceRun): { skill: string; status: string; code: string } {
  const [skill = '', status = '', code = ''] = (run.actions[0] ?? '').split(':');
  return { skill, status, code };
}

describe('place names across interfaces', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  for (const one of CASES) {
    test(`a read named by place of the same room of ${one.iface} goes through`, async () => {
      // Bug: a room the persona may not write in loses its read handle too, or the name is matched only among the turn's own
      // interface's channels and a room of another interface is unknown.
      const { run } = await callNowhere('conversation.read', { place: one.written });
      assert.deepEqual(firstAction(run), { skill: 'conversation.read', status: 'executed', code: 'ok' });
    });
  }
});

const toolsLabels = labels.tools;
const withPlaceLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsLabels.tools,
      place: {
        several: 'SEVERAL-MARK {given} {count}',
        none: 'NONE-MARK {given}',
        line: 'LINE-MARK {ref} {name}',
        more: 'MORE-MARK {count}',
      },
    },
  },
};

async function readChannel(channel: string) {
  const run = await coreTurn({
    answers: [toolAnswer('', [call('conversation.read', { place: channel })]), '<skip/>'],
    allowed: ['conversation.read'],
    neighbours: [
      { id: 'c3', name: '🌿 herbs' },
      { id: 'c4', name: '🌱 Herbs' },
    ],
    prompts: { labels: withPlaceLabels },
  });
  return appended(run.llm, 1)
    .filter((message) => message.role === 'tool')
    .map((message) => contentText(message.content))
    .join('\n');
}

test('conversation.read of a name that fits two channels answers with both as choices', async () => {
  const told = await readChannel('herbs');
  assert.ok(told.includes('SEVERAL-MARK herbs 2'), told);
  assert.ok(told.includes('🌿 herbs') && told.includes('🌱 Herbs'), told);
});

test('conversation.read of a name that fits no channel answers with the channels the persona may read', async () => {
  const told = await readChannel('memes');
  assert.ok(told.includes('NONE-MARK memes'), told);
  assert.ok(told.includes('jardin') && told.includes('general'), told);
});
