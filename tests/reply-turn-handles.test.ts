// One handle per person and per place across her request (spec 2026-11-10 one-handle-per-person-and-place, slice 2;
// contract .agents/docs/specs/2026-11-10-one-handle-contract.md). A person's handle comes from the meta-person, so the
// same handle stands for every account of the person on every interface; every line of every block names its author
// by that handle, a mention in a stored text reads as it, and her own `@handle` mentions the person's account on the
// interface she writes to. A place reads as its handle and name wherever it is named, and no raw place id or account id
// reaches the request. Reply turns of the real turn runner over the service world's memory
// (tests/fixtures/service-turn.ts#replyRun), in the room `c1` of the fake interface and on the owner's command line, a
// scripted model, synthetic names in Greek.
//
// The facts are read off the request without its wording: an entry of `<people>` opens with the person's `@u…` handle,
// a place entry of `<places>` with its `#c…` handle, and the author of a line is every `@u…` token that stands on the
// line before its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addClaim, addDm, addLine, addPerson, noteInterface } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { OWNER_PERSON } from './fixtures/owner-accounts.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import { CLI_CHAT, ELENI, TURN_NOW, blockOf, replyRun, serviceWorld } from './fixtures/service-turn.ts';
import type { ReplyRun, ReplyStep } from './fixtures/service-turn.ts';

useIface('fake');

const MIN = 60_000;
const THINK = '<think>STEP 4. So: answer.</think>';
const SAY = `${THINK}<msg>εντάξει</msg>`;
const iso = (at: number): string => new Date(at).toISOString();
/** A person's handle, whole. */
const HANDLE = /^@u[0-9a-z]+$/;

const NIKOS = 'person:fake:4242';
const GIANNIS = 'person:tele:88';
/** The texts of the world's lines, each unique so a test finds its line in one block. */
const LINE = {
  ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
  ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
  ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
  giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
  nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
} as const;
/** The name the owner's command line account carries, and the one his account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';
const OWNER_FAKE_NAME = 'Πέτρος';

/** Every place id and account id of the world: none of them may stand anywhere in a request. */
const RAW_IDS = [
  'fake:channel:c1',
  'fake:channel:c2',
  'fake:channel:c9',
  'tele:channel:k1',
  'fake:server:g1',
  'tele:server:t1',
  'cli:dm:owner',
  'fake:dm:111',
  'fake:dm:5678',
  'fake:111',
  'fake:5678',
  'fake:u1',
  'fake:4242',
  'fake:4243',
  'cli:owner',
  'tele:88',
];
/** The platform ids of the world's accounts: they stand in an account line of `<people>` and nowhere else. */
const PLATFORM_IDS = /\b(?:111|5678|u1|4242|4243|88)\b/;
/** The interface and platform id of each account of the world, the pair an account line of `<people>` carries. */
const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['fake', '111'],
  ['fake', '5678'],
  ['fake', 'u1'],
  ['fake', '4242'],
  ['fake', '4243'],
  ['tele', '88'],
];

/** Whether `word` stands whole in `line`. */
const holdsWord = (line: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, 'u').test(line);

/**
 * A request without the account lines of its `<people>`: the lines of a `<people>` that hold the interface and the
 * platform id of one account, the one place a platform id may stand (the lead's decision of 2026-11-10).
 */
const withoutAccountLines = (request: string): string =>
  request.replace(/<people>[\s\S]*?<\/people>/g, (people) =>
    people
      .split('\n')
      .filter((line) => !ACCOUNTS.some(([iface, id]) => holdsWord(line, iface) && holdsWord(line, id)))
      .join('\n')
  );

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, his line in
 * the garden `c2` right after hers, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after her line there. Ελένη's line before hers in the garden mentions nobody; the owner's mentions Ελένη.
 */
function handleWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
      { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
    ],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  addLine(world.db, {
    id: 'o1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'fake:u1',
    text: `${LINE.ownerGarden} <@111>`,
    at: iso(TURN_NOW - 49 * MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: iso(TURN_NOW - 39 * MIN),
  });
  addPerson(world.db, {
    id: NIKOS,
    accounts: [
      { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
      { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
    ],
  });
  return world;
}

/** The owner's line on the command line. */
const ownerSays = (id: string, text: string, at: number) => ({ id, text, at, authorId: 'owner', authorName: 'owner' });

/** Reply turns on the owner's command line over a fresh handle world. */
async function onCli(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, chat: CLI_CHAT, steps });
  } finally {
    world.close();
  }
}

/** Reply turns in the room `c1` of the fake interface over a fresh handle world. */
async function inRoom(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, steps });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step: number): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
const peopleBodies = (text: string): Array<string> =>
  [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

/** The entries of every `<people>` of a text, one text each. */
const entriesOf = (text: string): Array<string> =>
  peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

/** The `@u…` handle an entry opens with, null when its first line holds none. */
const entryHandle = (entry: string): string | null => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? null;

/** The handles of every entry of every `<people>` of a text. */
const entryHandles = (text: string): Array<string> =>
  entriesOf(text).flatMap((entry) => {
    const handle = entryHandle(entry);
    return handle === null ? [] : [handle];
  });

/** The entry of `<people>` that holds `name`, '' when none does. */
const entryWith = (text: string, name: string): string => entriesOf(text).find((entry) => entry.includes(name)) ?? '';

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The part of a line before `marker`: its number, time and author. */
const headOf = (text: string, marker: string): string => {
  const line = lineWith(text, marker);
  return line.slice(0, Math.max(0, line.indexOf(marker)));
};

/** The `@u…` handles that stand on the line of `marker` before it: the line's author. */
const authorOf = (text: string, marker: string): Array<string> => headOf(text, marker).match(/@u[0-9a-z]+/g) ?? [];

/** What follows the `<task>` of a request: her answer and the results of her calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

/**
 * The `#c…` handle of the place entry of `<places>` whose heading holds `name` in quotes. The owner's decision of
 * 2026-11-11: a place reads as the interface's noun and the quoted name, `#c…: channel "name", ...`.
 */
function placeHandle(request: string, name: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(request)?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(`"${name}"`)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** The `@u…` handle of the entry holding `name` in a request, as the scripted model reads it to write back. */
const handleIn = (request: string, name: string): string => entryHandle(entryWith(request, name)) ?? '@unone';

/** A turn on the command line in which she reads the garden by its name, finding the owner's line, then answers. */
const READ_GARDEN: ReplyStep = {
  trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - 3 * MIN),
  answers: [toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), SAY],
};
/** The owner's next line, whose turn shows the read in `<recall>`. */
const THANKS: ReplyStep = { trigger: ownerSays('m2', 'ευχαριστώ', TURN_NOW - MIN), answers: [SAY] };

test('a person with accounts on two interfaces has one handle on a turn of either interface', async () => {
  // Bug: the handle is cut from the platform id of an account, so the owner is one handle on the command line and
  // another in a room, and she takes the two for two people.
  const cli = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const room = await inRoom([{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }]);
  const onCommandLine = entryHandle(entryWith(requestOf(cli, 0, 0), OWNER_FAKE_NAME));
  const inTheRoom = entryHandle(entryWith(requestOf(room, 0, 0), OWNER_FAKE_NAME));
  assert.match(onCommandLine ?? '', HANDLE, 'the owner has an entry on the command line');
  assert.equal(inTheRoom, onCommandLine);
});

test("the owner's line on the command line and his line from another interface in <meanwhile> carry the same handle, and <people> holds him once with both accounts", async () => {
  // Bug: his command line line names him by one handle and his line in the garden by a display name, so she splits him
  // into "you" and a third person with his alias.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const request = requestOf(run, 0, 0);
  const entry = entryWith(request, OWNER_FAKE_NAME);
  const handle = entryHandle(entry);
  assert.match(handle ?? '', HANDLE);
  assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.ownerCli), [handle], 'his line on the command line');
  assert.deepEqual(authorOf(blockOf(request, 'meanwhile'), LINE.ownerGarden), [handle], 'his line in the garden');
  assert.equal(entryHandles(request).filter((one) => one === handle).length, 1, 'one entry of him');
  assert.ok(entry.includes(OWNER_CLI_NAME) && entry.includes(OWNER_FAKE_NAME), 'the entry holds both accounts');
});

test('an entry of <people> lists each account on a line of its own and marks the account of the place she is in', async () => {
  // Bug: the accounts stand on one line, so she cannot tell which of the person's accounts is the one she talks with.
  const cli = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const room = await inRoom([{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }]);
  const onCommandLine = entryWith(requestOf(cli, 0, 0), OWNER_FAKE_NAME);
  const inTheRoom = entryWith(requestOf(room, 0, 0), OWNER_FAKE_NAME);
  // The heading names him and says why he is here, which differs between the turns: the accounts follow it.
  const accountLine = (entry: string, name: string): string => lineWith(entry.split('\n').slice(1).join('\n'), name);
  const cliLine = (entry: string): string => accountLine(entry, OWNER_CLI_NAME);
  const fakeLine = (entry: string): string => accountLine(entry, OWNER_FAKE_NAME);
  assert.notEqual(cliLine(onCommandLine), fakeLine(onCommandLine), 'one line per account');
  assert.notEqual(cliLine(onCommandLine), cliLine(inTheRoom), 'the command line account is marked on one turn only');
  assert.notEqual(fakeLine(onCommandLine), fakeLine(inTheRoom), 'the room account is marked on one turn only');
});

test('an author in <chat> carries the handle his line in <meanwhile> carries, the handle of his entry', async () => {
  // Bug: a chat line names its author by the account's handle and a line elsewhere by a display name, so she ties the
  // two lines to an entry of <people> by comparing names.
  const run = await inRoom([
    {
      lines: [{ id: 'r2', text: LINE.ownerRoom, at: TURN_NOW - 2 * MIN, authorId: 'u1', authorName: OWNER_FAKE_NAME }],
      trigger: { id: 'r3', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const request = requestOf(run, 0, 0);
  const handle = entryHandle(entryWith(request, OWNER_FAKE_NAME));
  assert.match(handle ?? '', HANDLE);
  assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.ownerRoom), [handle]);
  assert.deepEqual(authorOf(blockOf(request, 'meanwhile'), LINE.ownerGarden), [handle]);
});

test("an author in <meanwhile> with no account on the turn's interface is the handle of an entry of <people>", async () => {
  // Bug: a line of another interface is named by a display name, or by the bare account id when the turn's interface
  // does not know the account, and no entry stands behind it.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const request = requestOf(run, 0, 0);
  const author = authorOf(blockOf(request, 'meanwhile'), LINE.giannisHarbour);
  assert.equal(author.length, 1, 'his line names one handle');
  assert.ok(entryHandles(request).includes(author[0] ?? ''), 'his handle opens an entry');
});

test('every author of a line of a stored place read is the handle of an entry of the request', async () => {
  // Bug: a place read names its authors by the stored display name, so the lines she read tie to nobody she knows.
  const run = await onCli([READ_GARDEN]);
  const request = requestOf(run, 0, 1);
  const result = afterTask(request);
  assert.ok(result.includes(LINE.ownerGarden), 'the read returned the owner line');
  const handles = entryHandles(request);
  for (const marker of [LINE.ownerGarden, LINE.eleniGarden]) {
    const author = authorOf(result, marker);
    assert.equal(author.length, 1, `the line ${marker} names one handle`);
    assert.ok(handles.includes(author[0] ?? ''), `the author of ${marker} opens an entry`);
  }
});

test('every author of a line in <recall> is the handle of an entry of <people>', async () => {
  // Bug: <recall> repeats the read as it was rendered, with display names, so the next turn ties its lines to nobody.
  const run = await onCli([READ_GARDEN, THANKS]);
  const request = requestOf(run, 1, 0);
  const recall = blockOf(request, 'recall');
  assert.ok(recall.includes(LINE.ownerGarden), 'the read stands in <recall>');
  const handles = entryHandles(request);
  for (const marker of [LINE.ownerGarden, LINE.eleniGarden]) {
    const author = authorOf(recall, marker);
    assert.equal(author.length, 1, `the line ${marker} names one handle`);
    assert.ok(handles.includes(author[0] ?? ''), `the author of ${marker} opens an entry`);
  }
});

test("lines of one person from two accounts in one place carry the person's handle and mark each account by its interface and platform id", async () => {
  // Bug: each account is a handle of its own, so one person writing from two accounts reads as two people.
  // The lead's decision of 2026-11-10: the mark is the account's interface and platform id, the pair its account line
  // in <people> carries, never a display name.
  const run = await inRoom([
    {
      lines: [
        { id: 'r2', text: LINE.nikosOne, at: TURN_NOW - 3 * MIN, authorId: '4242', authorName: 'Νίκος' },
        { id: 'r3', text: LINE.nikosTwo, at: TURN_NOW - 2 * MIN, authorId: '4243', authorName: 'Νικόλαος' },
      ],
      trigger: { id: 'r4', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const chat = blockOf(requestOf(run, 0, 0), 'chat');
  const one = authorOf(chat, LINE.nikosOne);
  assert.equal(one.length, 1);
  assert.deepEqual(authorOf(chat, LINE.nikosTwo), one, 'the same handle on both lines');
  const first = headOf(chat, LINE.nikosOne);
  const second = headOf(chat, LINE.nikosTwo);
  assert.ok(holdsWord(first, 'fake') && holdsWord(first, '4242') && !holdsWord(first, '4243'), first);
  assert.ok(holdsWord(second, 'fake') && holdsWord(second, '4243') && !holdsWord(second, '4242'), second);
  assert.ok(!first.includes('Νίκος') && !second.includes('Νικόλαος'), 'no display name marks an account');
});

test('a <@id> mention in a stored line is shown as the handle of the person it names', async () => {
  // Bug: a mention stored as the platform writes it reaches her as a bare account number.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const request = requestOf(run, 0, 0);
  const line = lineWith(blockOf(request, 'meanwhile'), LINE.ownerGarden);
  const eleni = entryHandle(entryWith(request, 'Ελένη'));
  assert.match(eleni ?? '', HANDLE, 'Ελένη has an entry');
  assert.ok(line.includes(eleni ?? ''), line);
  assert.doesNotMatch(line, /<@|&lt;@|\b111\b/);
});

test('a <@id> mention in a stored claim of <memory> is shown as a handle', async () => {
  // Bug: a stored text renders a mention as the account's display name, which changes ten times a day and ties to no
  // entry, or as the bare account number when nothing names it.
  const world = handleWorld();
  try {
    addClaim(world.db, {
      id: 'claim:fact:mention',
      person: ELENI,
      kind: 'fact',
      text: 'ΓΝΩΡΙΖΕΙ-ΤΗ <@5678>',
      audience: { group: 'fake' },
    });
    const run = await replyRun({
      world,
      steps: [{ trigger: { id: 'r2', text: 'καλημέρα', at: TURN_NOW - MIN }, answers: [SAY] }],
    });
    const line = lineWith(blockOf(requestOf(run, 0, 0), 'memory'), 'ΓΝΩΡΙΖΕΙ-ΤΗ');
    assert.match(line, /@u[0-9a-z]+/, line);
    assert.doesNotMatch(line, /<@|&lt;@|\b5678\b|Ζωή/);
  } finally {
    world.close();
  }
});

test('a <@id> mention in a chat line is shown as the handle of the person it names', async () => {
  // Bug: a line whose text holds the mention as the platform wrote it shows her the bare account number.
  const run = await inRoom([
    {
      lines: [
        { id: 'r2', text: `${LINE.nikosOne} <@111>`, at: TURN_NOW - 2 * MIN, authorId: '4242', authorName: 'Νίκος' },
      ],
      trigger: { id: 'r3', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const request = requestOf(run, 0, 0);
  const line = lineWith(blockOf(request, 'chat'), LINE.nikosOne);
  const eleni = entryHandle(entryWith(request, 'Ελένη'));
  assert.match(eleni ?? '', HANDLE, 'Ελένη has an entry');
  assert.ok(line.slice(line.indexOf(LINE.nikosOne)).includes(eleni ?? ''), line);
  assert.doesNotMatch(line, /<@|&lt;@|\b111\b/);
});

test("her @handle in a post to another interface mentions the person's account there", async () => {
  // Bug: the handle she saw on the command line stands for the owner's command line account, which the room's
  // interface does not know, so the post names nobody.
  const run = await onCli([
    {
      trigger: ownerSays('m1', 'πες τους ότι έρχεσαι', TURN_NOW - MIN),
      answers: [
        (request: string) =>
          toolAnswer(THINK, [
            call('message.create', { place: 'γενικά', text: `${handleIn(request, OWNER_FAKE_NAME)} ΕΡΧΟΜΑΙ` }),
          ]),
        SAY,
      ],
    },
  ]);
  const post = run.sends.find((one) => one.iface === 'fake' && one.text.includes('ΕΡΧΟΜΑΙ'));
  assert.ok(post, JSON.stringify(run.sends));
  assert.deepEqual(post.mentioned, ['u1']);
  assert.ok(post.text.includes('<@u1>'), post.text);
});

test('her @handle of a person with no account on the interface she writes to carries the name and no mention', async () => {
  // Bug: the handle resolves to the person's account on another interface, and the room gets a mention of an account
  // it does not have.
  const run = await onCli([
    {
      trigger: ownerSays('m1', 'πες τους για τον Γιάννη', TURN_NOW - MIN),
      answers: [
        (request: string) =>
          toolAnswer(THINK, [
            call('message.create', { place: 'γενικά', text: `${handleIn(request, 'Γιάννης')} ΗΡΘΕ` }),
          ]),
        SAY,
      ],
    },
  ]);
  const post = run.sends.find((one) => one.iface === 'fake' && one.text.includes('ΗΡΘΕ'));
  assert.ok(post, JSON.stringify(run.sends));
  assert.deepEqual(post.mentioned, []);
  assert.ok(post.text.includes('Γιάννης'), post.text);
  assert.doesNotMatch(post.text, /<@|@u[0-9a-z]+/);
});

test('a command line turn that holds lines of another interface holds no raw place id and no raw account id', async () => {
  // Bug: the command line's chat, a searched place and an author the interface does not know reach her as raw ids,
  // and she passes one back as an argument.
  const run = await onCli([READ_GARDEN, THANKS]);
  for (const request of [requestOf(run, 0, 1), requestOf(run, 1, 0)]) {
    for (const id of RAW_IDS) assert.ok(!request.includes(id), `${id} stands in the request`);
    assert.doesNotMatch(withoutAccountLines(request), PLATFORM_IDS);
    assert.doesNotMatch(request, /<@|&lt;@/);
  }
});

test('a group turn that holds lines of another interface holds no raw place id and no raw account id', async () => {
  // Bug: a line of another interface names its author by the bare account id the turn's interface does not know.
  const run = await inRoom([
    {
      lines: [
        { id: 'r2', text: `${LINE.nikosOne} <@111>`, at: TURN_NOW - 2 * MIN, authorId: '4242', authorName: 'Νίκος' },
      ],
      trigger: { id: 'r3', text: 'καλημέρα', at: TURN_NOW - MIN },
      answers: [SAY],
    },
  ]);
  const request = requestOf(run, 0, 0);
  assert.ok(blockOf(request, 'meanwhile').includes(LINE.ownerGarden), 'a line of the garden stands in <meanwhile>');
  for (const id of RAW_IDS) assert.ok(!request.includes(id), `${id} stands in the request`);
  assert.doesNotMatch(withoutAccountLines(request), PLATFORM_IDS);
  assert.doesNotMatch(request, /<@|&lt;@/);
});

test('the source line of a place read names the place by its handle and its name', async () => {
  // Bug: the source line names the place by its name alone, so the read ties to no entry of <places>.
  const run = await onCli([READ_GARDEN]);
  const request = requestOf(run, 0, 1);
  const garden = placeHandle(request, 'κήπος');
  assert.match(garden, /^#c[0-9a-z]+$/, 'the garden has an entry with a handle');
  const source = lineWith(afterTask(request), 'conversation.read');
  assert.ok(source.includes(garden) && source.includes('κήπος'), source);
});

test('a place she searched reads as its handle and name in <recall> and in her call mark', async () => {
  // Bug: the place argument of a lookup is kept as its resolved place id, and the next turn shows her the raw id.
  const run = await onCli([READ_GARDEN, THANKS]);
  const request = requestOf(run, 1, 0);
  const garden = placeHandle(request, 'κήπος');
  assert.match(garden, /^#c[0-9a-z]+$/, 'the garden has an entry with a handle');
  const recalled = lineWith(blockOf(request, 'recall'), 'conversation.read');
  assert.ok(recalled.includes(garden) && recalled.includes('κήπος'), recalled);
  const mark = lineWith(blockOf(request, 'chat'), 'conversation.read');
  assert.ok(mark.includes(garden), mark);
});

test("one person's handle is the same on a line of the chat and as the person she answers when the account's meta-person differs from its old link", async () => {
  // Bug: a chat author is keyed by the account's meta-person row (`person_accounts`) and the person she answers by the
  // account's old link (`accounts.person_id`), so after a bind one person reads as two handles in one request.
  const world = handleWorld();
  try {
    world.db
      .prepare('INSERT INTO people (id, first_seen_at, meta) VALUES (?, ?, 1)')
      .run('person:meta-nikos', '2026-11-01T10:00:00.000Z');
    world.db
      .prepare("UPDATE person_accounts SET person_id = ? WHERE iface = 'fake' AND platform_id = '4242'")
      .run('person:meta-nikos');
    const run = await replyRun({
      world,
      steps: [
        {
          trigger: { id: 'r2', text: LINE.nikosOne, at: TURN_NOW - MIN, authorId: '4242', authorName: 'Νίκος' },
          answers: [SAY],
        },
      ],
    });
    const request = requestOf(run, 0, 0);
    const answered = entryHandle(entriesOf(request)[0] ?? '');
    assert.match(answered ?? '', HANDLE, 'the person she answers opens <people>');
    assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.nikosOne), [answered]);
  } finally {
    world.close();
  }
});

test('the handles of the entries of a request are unique', async () => {
  // Guard: one handle for two people would make her mention and read the wrong one.
  const run = await onCli([READ_GARDEN, THANKS]);
  const handles = entryHandles(requestOf(run, 1, 0));
  assert.ok(handles.length >= 3, handles.join(' '));
  assert.equal(new Set(handles).size, handles.length, handles.join(' '));
});

test("<place> of a turn in a direct chat reads the interface's word for it and the partner's handle, never an unnamed place", async () => {
  // Bug (replay of 2026-11-11): the turn's own place read `#c…: "(unnamed)", interface "CLI"`, because the request handed
  // the body of `<place>` something other than the direct chat the stored place is.
  const world = handleWorld();
  noteInterface(world, 'cli', [], { interface: 'CLI', nouns: {}, dm: 'terminal chat' });
  let request: string;
  try {
    const run = await replyRun({
      world,
      chat: CLI_CHAT,
      steps: [{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }],
    });
    request = requestOf(run, 0, 0);
  } finally {
    world.close();
  }
  const place = blockOf(blockOf(request, 'surroundings'), 'place');
  assert.ok(place.includes('terminal chat'), place);
  assert.match(place, /@u[0-9a-z]+/, 'the partner is named by handle');
  assert.doesNotMatch(place, /unnamed/);
});

test('<place> of a turn in a direct chat whose place the store holds no chain for still reads as a direct chat', async () => {
  // Bug (replay of 2026-11-11): with no stored chain the turn's place fell back to a link of no kind and no name, so a
  // direct chat read as `"(unnamed)"` and the partner never showed.
  const world = serviceWorld();
  noteInterface(world, 'cli', [], { interface: 'CLI', nouns: {}, dm: 'terminal chat' });
  // The turn's own place, `cli:dm:owner`, has no row in this world, so the store gives it no chain.
  let request: string;
  try {
    const run = await replyRun({
      world,
      chat: CLI_CHAT,
      steps: [{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }],
    });
    request = requestOf(run, 0, 0);
  } finally {
    world.close();
  }
  const place = blockOf(blockOf(request, 'surroundings'), 'place');
  assert.ok(place.includes('terminal chat'), place);
  assert.doesNotMatch(place, /unnamed/);
});

test('an entry of <people> opens with its handle and a colon', async () => {
  // Bug: the entry opened `@handle Name`, so the handle read as part of the name. The owner's decision of 2026-11-11: a
  // handle and a colon open every entry.
  const run = await onCli([{ trigger: ownerSays('m1', LINE.ownerCli, TURN_NOW - MIN), answers: [SAY] }]);
  const entries = entriesOf(requestOf(run, 0, 0));
  assert.ok(entries.length > 0, 'the request has people');
  for (const entry of entries) assert.match(entry.split('\n')[0] ?? '', /^@u[0-9a-z]+: \S/, entry);
});
