// Stored lines of one place for the tests of an edited line, in the two shapes the readers meet: an edit that keeps the
// moment of the line it changed (what a platform reports) and the rows production holds from the command line, where the
// edit's row carries the moment of the edit, 93 minutes after the line was said. Rows go in through `insertRows`, so
// every reader sees what the writers leave. Synthetic text.
import { insertRows } from '../../../src/memory/db/rows.ts';
import type { Db } from '../../../src/memory/db/types.ts';

/** The moment the first line of a scene is said. */
export const T0 = Date.parse('2026-11-12T01:00:00.000Z');
/** How long after her line the edit event arrived in production. */
export const EDIT_DELAY_MS = 93 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The moment `minute` minutes after `T0`. */
export const minute = (n: number): number => T0 + n * 60_000;

/** One stored revision of a message. */
export type Revision = {
  /** The message id the row's `native_id` holds. */
  native: string;
  text: string;
  /** The moment the row says the message was written. */
  at: number;
  revision?: number;
  /** `said` for her own new line, `seen` for the rest and for every edit, as the observation writes them. */
  kind: 'said' | 'seen';
  /** Whose line the row says it is. */
  by: 'her' | 'someone';
};

/** `revision` as a row of `place` on `iface`, recorded at its own moment. */
export function storeRevision(db: Db, { iface, place }: { iface: string; place: string }, revision: Revision): void {
  const { native, text, at, kind, by, revision: given } = revision;
  const hers = by === 'her';
  const moment = iso(at);
  const number = given ?? 1;
  insertRows(db, {
    sources: [
      {
        id: `source:${native}:${number}`,
        kind,
        iface,
        native_id: native,
        native_kind: 'message',
        revision: number,
        place_id: place,
        author_account: hers ? null : `${iface}:member`,
        author_kind: hers ? 'self' : 'account',
        occurred_at: moment,
        recorded_at: moment,
        text,
        scope_kind: 'group',
        scope_iface: iface,
        scope_dm: null,
      },
    ],
  });
}

/**
 * A chat of four lines, `owner-1`, `hers-1`, `owner-2` and `hers-2`, one minute apart from `T0`, then the edit of
 * `hers-1` stored the way production holds it: revision 2, kind `seen`, her as the author, at the moment of the edit.
 */
export function storeProductionEdit(db: Db, where: { iface: string; place: string }): void {
  storeRevision(db, where, { native: 'owner-1', text: 'first words', at: minute(0), kind: 'seen', by: 'someone' });
  storeRevision(db, where, { native: 'hers-1', text: 'the kettle is on 🙂', at: minute(1), kind: 'said', by: 'her' });
  storeRevision(db, where, { native: 'owner-2', text: 'second words', at: minute(2), kind: 'seen', by: 'someone' });
  storeRevision(db, where, { native: 'hers-2', text: 'her next words', at: minute(3), kind: 'said', by: 'her' });
  storeRevision(db, where, {
    native: 'hers-1',
    text: 'the kettle is on',
    at: minute(1) + EDIT_DELAY_MS,
    revision: 2,
    kind: 'seen',
    by: 'her',
  });
}
