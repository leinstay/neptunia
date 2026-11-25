// Tests for src/handles-text.ts: a mention in a chat line shown as the handle of the person it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDm, addLine, addPerson } from '../fixtures/memory-db/mind-world.ts';
import type { World } from '../fixtures/memory-db/mind-world.ts';
import { OWNER_PERSON } from '../fixtures/owner-accounts.ts';
import { TURN_NOW, blockOf, replyRun, serviceWorld } from '../fixtures/service-turn.ts';
import type { ReplyRun, ReplyStep } from '../fixtures/service-turn.ts';
import { useIface } from '../fixtures/turn-world.ts';

// The cases of this file run on the interface `fake`, whatever a fixture above names when it loads. A describe
// that needs another interface names it in its hooks.
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
/** The name the owner's command line account carries, and the one their account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';
const OWNER_FAKE_NAME = 'Πέτρος';

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, their line in
 * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
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

/** The entry of `<people>` that holds `name`, '' when none does. */
const entryWith = (text: string, name: string): string => entriesOf(text).find((entry) => entry.includes(name)) ?? '';

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

test('a <@id> mention in a chat line is shown as the handle of the person it names', async () => {
  // Bug: a line whose text holds the mention as the platform wrote it shows the persona the bare account number.
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
