// The world of the tests of what she made and was given (src/memory/db/made-and-given.ts): four people with one
// account each on `discord`, two group chats and a direct chat with Boris, lines addressed to her that day, and the
// journal a turn writes through, on a clock the test moves. A turn is a `turn.start` line with its trigger's author
// (a native account id, null for an inner turn), a call is an operation of the journal that shares its `turnId`.
// The lines: Anna wrote to her six times today (three `direct`, two replies to a line of hers, one both), once
// yesterday, and Boris twice today. Made-up ids, no real names.
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { insertRows, addRelation } from '../../src/memory/db/rows.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../src/memory/db/service.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { createJournal } from '../../src/memory/journal.ts';
import { wrongly } from './loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from './memory-db/opaque-people.ts';
import { tempDir } from './tmp.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Noon of the day the tests read, by the server's zone `UTC`. */
export const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
export const TZ = 'UTC';

export const ANNA = 'person:0b7a4c1e';
export const BORIS = 'person:6d2f9e03';
export const CAROL = 'person:3c81a5d7';
export const DORA = 'person:91e4b2f6';
/** The native account ids a turn's trigger names her authors by. */
export const NATIVE = { [ANNA]: 'n-anna', [BORIS]: 'n-boris', [CAROL]: 'n-carol', [DORA]: 'n-dora' } as const;

export const CAFE = 'discord:channel:room-1';
export const SALON = 'discord:channel:room-2';
export const DM = 'discord:dm:n-boris';
/** The native chat id a turn writes its journal lines with. */
const CHAT: Record<string, string> = { [CAFE]: 'room-1', [SALON]: 'room-2', [DM]: 'dm-chat-boris' };

/** The skills the labels name a kind for, as the turn hands them to the reader. */
export const KINDS = ['draw.create', 'media.find', 'voice.say', 'errand.run'];

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const iso = (at: number): string => new Date(at).toISOString();

type LineSeed = { id: string; author: string | null; at: number; direct?: boolean; replyTo?: string };

/** The lines of the world: hers and the people's, in the café. */
const LINES: ReadonlyArray<LineSeed> = [
  { id: 'h1', author: null, at: NOW - 6 * HOUR },
  { id: 'h2', author: null, at: NOW - 6 * HOUR + MIN },
  { id: 'a-d1', author: 'discord:n-anna', at: NOW - 5 * HOUR, direct: true },
  { id: 'a-d2', author: 'discord:n-anna', at: NOW - 5 * HOUR + MIN, direct: true },
  { id: 'a-d3', author: 'discord:n-anna', at: NOW - 5 * HOUR + 2 * MIN, direct: true },
  { id: 'a-r1', author: 'discord:n-anna', at: NOW - 4 * HOUR, replyTo: 'h1' },
  { id: 'a-r2', author: 'discord:n-anna', at: NOW - 4 * HOUR + MIN, replyTo: 'h2' },
  { id: 'a-dr', author: 'discord:n-anna', at: NOW - 3 * HOUR, direct: true, replyTo: 'h1' },
  { id: 'a-old', author: 'discord:n-anna', at: NOW - 30 * HOUR, direct: true },
  { id: 'b-d1', author: 'discord:n-boris', at: NOW - 2 * HOUR, direct: true },
  { id: 'b-d2', author: 'discord:n-boris', at: NOW - 2 * HOUR + MIN, direct: true },
];

const opened: Array<MemoryDbService> = [];
/** Closes every world a test opened; a test file registers it with `after`. */
export async function closeMadeWorlds(): Promise<void> {
  for (const service of opened.splice(0)) await service.close();
}

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** How a call of hers ended: the phases it went through. */
export type CallEnd = 'succeeded' | 'failed' | 'unknown' | 'started' | 'proposed';

export type Call = {
  /** The turn that made it, null for a call the journal writes without one. */
  turn: string | null;
  skill: string;
  at: number;
  end?: CallEnd;
  /** The journal operation's name, `skill` unless the call is a post or a GIF. */
  name?: string;
};

/** What a test drives: the read handle, the turns' start lines and the calls. */
export type MadeWorld = {
  read: () => Db;
  turn: (place: string, spec: { id: string; at: number; by: string | null }) => Promise<void>;
  call: (place: string, one: Call) => Promise<void>;
  calls: (place: string, spec: { turn: string | null; skill: string; at: number; count: number }) => Promise<void>;
};

/** A memory database with the people, chats and lines above, and the journal a turn writes through. */
export function madeWorld(): MadeWorld {
  const dataDir = tempDir('nep-made-and-given-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  const people: Array<[string, string]> = [
    [ANNA, 'n-anna'],
    [BORIS, 'n-boris'],
    [CAROL, 'n-carol'],
    [DORA, 'n-dora'],
  ];
  for (const [person, native] of people)
    addAccount(db, { id: `discord:${native}`, iface: 'discord', authority: 'discord/global', native, person });
  addDmPlace(db, { id: DM, iface: 'discord', authority: 'discord/global', account: 'discord:n-boris', person: BORIS });
  // The DM is stored under its chat's key, so a call that names the chat finds the DM place.
  db.prepare('UPDATE places SET native_key = ? WHERE id = ?').run(`channel:${CHAT[DM]}`, DM);
  for (const place of [CAFE, SALON]) {
    addGroupPlace(db, place, 'discord', 'discord/global');
    db.prepare('UPDATE places SET native_id = ?, native_key = ? WHERE id = ?').run(
      CHAT[place],
      `channel:${CHAT[place]}`,
      place
    );
  }
  for (const line of LINES)
    insertRows(db, {
      sources: [
        {
          id: line.id,
          kind: line.author === null ? 'said' : 'seen',
          iface: 'discord',
          native_id: line.id,
          native_kind: 'message',
          place_id: CAFE,
          author_account: line.author,
          occurred_at: iso(line.at),
          recorded_at: iso(line.at),
          text: `the words of ${line.id}`,
          direct: line.direct === true ? 1 : 0,
          scope_kind: 'group',
          scope_iface: 'discord',
        },
      ],
    });
  for (const line of LINES) if (line.replyTo) addRelation(db, line.id, 'replies_to', { source: line.replyTo });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const clock = { at: NOW };
  const journal = createJournal({ dataDir, memoryDb, now: () => clock.at, log: quiet });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));

  /** The `turn.start` line of a turn in `place` that `by` (a native account id) asked, an inner turn when `by` is null. */
  async function turn(place: string, spec: { id: string; at: number; by: string | null }) {
    clock.at = spec.at;
    const trigger =
      spec.by === null
        ? { kind: 'inner', messageId: null, authorId: null, wake: 'heartbeat' }
        : { kind: 'mention', messageId: `m-${spec.id}`, authorId: spec.by };
    journal.start(place, {
      placeId: CHAT[place],
      turnId: spec.id,
      mode: spec.by === null ? 'inner' : 'reply',
      trigger,
      ...(spec.by === null ? {} : { participants: [spec.by] }),
    });
    await settled();
  }

  /** One call of hers in `place`: the lines of an operation up to the phase it ended in. */
  async function call(place: string, one: Call) {
    clock.at = one.at;
    const end = one.end ?? 'succeeded';
    const op = journal.op(place, {
      placeId: CHAT[place],
      turnId: one.turn,
      name: one.name ?? 'skill',
      by: 'persona',
      input: { skill: one.skill },
    });
    if (end === 'proposed') await op.proposed();
    else {
      await op.started();
      if (end === 'succeeded') await op.succeeded({ messageId: `m-${one.at}` });
      if (end === 'failed') await op.failed('E_TOOL', { status: 'refused' });
      if (end === 'unknown') await op.unknown({});
    }
    await settled();
  }

  /** `count` successful calls of `skill` in `place` for the turn `turnId`, a minute apart from `at` on. */
  async function calls(place: string, spec: { turn: string | null; skill: string; at: number; count: number }) {
    for (let i = 0; i < spec.count; i += 1) await call(place, { turn: spec.turn, skill: spec.skill, at: spec.at + i * MIN });
  }

  return { read, turn, call, calls };
}
