#!/usr/bin/env node
// Measurement: the graph reader (src/memory/db/mind-read.ts#mindOf) over the last archived reply turns of a snapshot,
// read-only. For each turn it rebuilds the seeds from the journal's `turn` row (`day`, `what = 'turn'`): the window's
// lines from `seen.messageIds`, the trigger as the last of them, the place, and the trigger's author as the counterpart.
// It reads under the context the turn had: the command line reads everything, a direct chat reads as that chat, any
// other place as the groups of its interface. It prints one line of JSON per turn (the turn id, the entries per kind, the
// left-out counts, the rows read and the milliseconds) and a last line with the totals. Names, words and ids of a row
// never reach the output, except the turn id. Writes nothing and calls no model.
//
//   node scripts/mind-report.ts --db <memory.db> [--turns 50]
//
// The settings are `context.memory` of config/config.json. Exit 0, or 2 for usage or a database that cannot be read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mindOf, mindSettingsOf } from '../src/memory/db/mind-read.ts';
import type { Mind, SeedMessage, Seeds } from '../src/memory/db/mind-read.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dmContext, dmContextPerson, groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TURNS = 50;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function flag(argv: ReadonlyArray<string>, name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

/** A stored JSON list of strings, or none. */
function listOf(value: unknown): Array<string> {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

/** The last `limit` reply turns of the journal, newest last. */
function replyTurns(db: Db, limit: number): Array<Row> {
  return db
    .prepare(
      `SELECT turn_id, place_id, at, json_extract(extra, '$.seen.messageIds') AS ids FROM day
       WHERE what = 'turn' AND json_extract(extra, '$.mode') = 'reply' AND place_id IS NOT NULL
       ORDER BY at DESC LIMIT ?`
    )
    .all(limit)
    .reverse();
}

/** The account row of a native id on an interface. */
function accountOf(db: Db, iface: string, native: string): string | null {
  const row = db
    .prepare('SELECT id FROM accounts WHERE iface = ? AND native_id = ? ORDER BY generation DESC')
    .get(iface, native);
  return text(row?.id);
}

/** The window's lines as seeds, oldest first; the last is the trigger. */
function seedMessages(db: Db, place: Row, ids: Array<string>): Array<SeedMessage> {
  const read = db.prepare(
    `SELECT id, iface, native_id, place_id, author_account, reply_to, mentions, occurred_at, text FROM sources
     WHERE place_id = ? AND native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1`
  );
  // The journal keeps the interface's message ids; a stored line is keyed by its family's native key.
  const family = db.prepare(
    'SELECT native_key FROM message_families WHERE iface = ? AND message_id = ? ORDER BY generation DESC LIMIT 1'
  );
  const nativeOf = (id: string) => text(family.get(String(place.iface), id)?.native_key) ?? id;
  const lines = ids.map((id) => read.get(place.id, nativeOf(id))).filter((row): row is Row => row !== undefined);
  const byNative = new Map(lines.map((row) => [String(row.native_id), String(row.id)]));
  return lines.map((row, i) => {
    const iface = String(row.iface);
    const reply = text(row.reply_to);
    return {
      id: String(row.id),
      at: text(row.occurred_at) ?? '',
      authorAccount: text(row.author_account),
      placeId: text(row.place_id),
      replyTo: reply === null ? null : (byNative.get(reply) ?? reply),
      mentions: listOf(row.mentions).flatMap((native) => accountOf(db, iface, native) ?? []),
      text: text(row.text) ?? '',
      trigger: i === lines.length - 1,
    };
  });
}

/** The context the turn read under. */
function contextOf(place: Row): Context {
  const iface = String(place.iface);
  if (iface === 'cli') return internalContext();
  if (place.chat === 'dm' || place.kind === 'dm')
    return dmContext(dmContextPerson(text(place.partner_person), iface, String(place.id)), iface, String(place.id));
  return groupContext(iface);
}

function counterpartOf(db: Db, trigger: SeedMessage | undefined): Seeds['counterpart'] {
  if (trigger?.authorAccount == null) return null;
  const row = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(trigger.authorAccount);
  const person = text(row?.person_id);
  return person === null ? null : { personId: person, accountId: trigger.authorAccount };
}

const sizes = (mind: Mind): Record<string, number> => ({
  people: mind.people.length,
  places: mind.places.length,
  interfaces: mind.interfaces.length,
  lore: mind.lore.length,
  recent: mind.recent.length,
  found: mind.found.length,
});

function main(argv: ReadonlyArray<string>): number {
  const file = flag(argv, '--db') ?? '';
  const turns = Number(flag(argv, '--turns') ?? DEFAULT_TURNS);
  if (file === '' || !fs.existsSync(file) || !Number.isInteger(turns) || turns <= 0) {
    process.stderr.write('usage: mind-report --db <memory.db> [--turns 50]\n');
    return 2;
  }
  const config: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  const settings = mindSettingsOf(config);
  let handle: ReturnType<typeof openMemoryDb>;
  try {
    handle = openMemoryDb(file, { readOnly: true });
  } catch {
    process.stderr.write('mind-report: the database cannot be read\n');
    return 2;
  }
  const totals = { turns: 0, entries: 0, leftOut: 0, ms: 0 };
  try {
    const db = dbOf(handle);
    for (const turn of replyTurns(db, turns)) {
      const place = db
        .prepare('SELECT id, iface, kind, chat, partner_person FROM places WHERE id = ?')
        .get(turn.place_id);
      if (!place) continue;
      const messages = seedMessages(db, place, listOf(turn.ids));
      const seeds: Seeds = {
        messages,
        counterpart: counterpartOf(db, messages.at(-1)),
        place: String(place.id),
        previous: [],
        candidates: [],
      };
      const started = performance.now();
      const mind = mindOf(db, contextOf(place), seeds, settings, Date.parse(String(turn.at)));
      const ms = Math.round(performance.now() - started);
      const entries = sizes(mind);
      const left = Object.values(mind.leftOut).reduce((sum, n) => sum + n, 0);
      totals.turns += 1;
      totals.entries += Object.values(entries).reduce((sum, n) => sum + n, 0);
      totals.leftOut += left;
      totals.ms += ms;
      const read = mind.reads.reduce((sum, one) => sum + one.rows, 0);
      process.stdout.write(
        `${JSON.stringify({ turn: turn.turn_id, lines: messages.length, entries, leftOut: mind.leftOut, rowsRead: read, ms })}\n`
      );
    }
  } finally {
    handle.close();
  }
  process.stdout.write(`${JSON.stringify({ totals })}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv);
