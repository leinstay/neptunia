// Synthetic SQLite sources, accounts and vectors shared by memory recall tests.
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import { fillStems } from '../../src/memory/db/stems.ts';
import { channelPlaceId, messageSourceId, personId } from '../../src/memory/db/ids.ts';
import { groupScope } from '../../src/memory/db/scope.ts';
import { quantize } from '../../src/memory/vectors.ts';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MAIN = channelPlaceId('discord', 'main');
const ALICE = 'u-alice';
const BOB = 'u-bob';

/** Filler chat that teaches the stemmer its Greek endings: twelve stems, each seen with five endings. */
const FILLER_STEMS = ['βιβλι', 'παιδ', 'δρομ', 'λογ', 'ανθρωπ', 'καιρ', 'φιλ', 'χρον', 'τοπ', 'κοσμ', 'νερ', 'ουραν'];
const FILLER_ENDINGS = ['ος', 'ου', 'ο', 'οι', 'ων'];

function makeFixture() {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const api = {
    handle,
    db,
    /** Inserts one chat line; returns its source id. `at` is epoch ms. */
    say({
      native,
      at,
      text,
      iface = 'discord',
      place = MAIN,
      author = ALICE,
      kind = 'seen',
      scope = groupScope('discord'),
      revision = 1,
      replyTo = null,
      extra = null,
    }: {
      native: string | number;
      at: number;
      text: string;
      iface?: string;
      place?: string;
      author?: string;
      kind?: string;
      scope?: ReturnType<typeof groupScope>;
      revision?: number;
      replyTo?: string | null;
      extra?: string | null;
    }) {
      const id = messageSourceId(iface, native, revision, kind);
      db.prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, reply_to, occurred_at, recorded_at, text, direct,
        scope_kind, scope_iface, scope_dm, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(
        id,
        kind,
        iface,
        String(native),
        revision,
        place,
        `${iface}:${author}`,
        replyTo,
        new Date(at).toISOString(),
        new Date(at).toISOString(),
        text,
        scope.scope_kind,
        scope.scope_iface,
        scope.scope_dm,
        extra
      );
      return id;
    },
    /** The place row of a group channel, as every stored line's place has one: a window names its chat by `native`. A row already there stays. */
    channel(place: string, native: string) {
      db.prepare(
        "INSERT OR IGNORE INTO places (id, iface, kind, native_id, chat, scope_kind) VALUES (?, 'discord', 'channel', ?, 'group', 'group')"
      ).run(place, native);
    },
    deleted(native: string, at: number) {
      db.prepare(
        `INSERT INTO sources (id, kind, iface, native_id, place_id, occurred_at, scope_kind, scope_iface)
        VALUES (?, 'deleted', 'discord', ?, ?, ?, 'group', 'discord')`
      ).run(
        `src:discord:${native}:none:deleted:x`,
        String(native),
        // A deletion stands in the place of the line it deletes.
        db.prepare('SELECT place_id FROM sources WHERE native_id = ? LIMIT 1').get(String(native))?.place_id ?? MAIN,
        new Date(at).toISOString()
      );
    },
    account(accountId: string, names: Array<string>) {
      db.prepare(
        "INSERT INTO accounts (id, iface, native_id, person_id, link, names) VALUES (?, 'discord', ?, ?, 'verified', ?)"
      ).run(`discord:${accountId}`, accountId, personId('discord', accountId), JSON.stringify(names));
    },
    /** A vector row for a source (by native id): the vector is stored as int8 the way the engine stores it. */
    vector(
      native: string,
      vector: Array<number>,
      { scope = groupScope('discord'), at = NOW }: { scope?: ReturnType<typeof groupScope>; at?: number } = {}
    ) {
      const source = db
        .prepare('SELECT rowid AS rowid FROM sources WHERE native_id = ? ORDER BY rowid LIMIT 1')
        .get(String(native))!;
      const { bytes, scale, norm } = quantize(vector);
      db.prepare(
        `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm)
        VALUES (?, ?, ?, 'test/embedder', ?, ?, ?, ?, '{}', ?, ?, ?, ?)`
      ).run(
        source.rowid,
        String(native),
        `record:${native}:1`,
        vector.length,
        scale,
        norm,
        bytes,
        new Date(at).toISOString(),
        scope.scope_kind,
        scope.scope_iface,
        scope.scope_dm
      );
    },
    /** Teaches the stemmer from the filler chat, then stamps every row. */
    stem() {
      FILLER_STEMS.forEach((stem, i) =>
        FILLER_ENDINGS.forEach((ending, j) =>
          api.say({
            native: `filler-${i}-${j}`,
            at: NOW - 400 * DAY,
            text: `${stem}${ending}`,
            place: channelPlaceId('discord', 'filler'),
            author: BOB,
          })
        )
      );
      return fillStems(db);
    },
    done() {
      handle.close();
    },
  };
  return api;
}

/** A fixture whose `channels` get their place rows, each place id mapped to its native id. */
export function fixture({ channels = {} }: { channels?: Record<string, string> } = {}): ReturnType<typeof makeFixture> {
  const env = makeFixture();
  for (const [place, native] of Object.entries(channels)) env.channel(place, native);
  return env;
}
