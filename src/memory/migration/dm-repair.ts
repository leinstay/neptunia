// The repair the offline conversion makes for what a shipped engine filed under a group while it belonged to a DM: a wake's
// said line and post operation, written under the spelled channel place of the DM's conversation, and a DM place's own notes,
// written with a group scope. A DM's lines name their conversation in their locator, and those ids are all the repair
// reads: never a line's words. A conversation no DM names stays where it is.

import { graphNodeId } from '../db/graph.ts';
import { channelPlaceId, dmPartnerOfPlace } from '../db/ids.ts';
import { dmAudienceId } from '../db/scope.ts';
import { placeCollection, storageId } from '../db/storage-keys.ts';
import type { StorageKey, StorageKind } from '../db/storage-keys.ts';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;
type Db = InstanceType<typeof DatabaseSync>;

/** One DM as a moved row names it. */
type DmHome = { place: string; iface: string; person: string | null; account: string | null; native: string | null };

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The DM places of a database with the partner their rows name. */
function dmHomes(source: Db): Map<string, DmHome> {
  const rows = source
    .prepare(
      `SELECT p.id, p.iface, p.partner_person, p.partner_account, a.native_id AS native FROM places p
       LEFT JOIN accounts a ON a.id = p.partner_account WHERE p.kind = 'dm' OR p.conversation = 'dm' ORDER BY p.id`
    )
    .all() as Array<Row>;
  return new Map(
    rows.map((row) => [
      String(row.id),
      {
        place: String(row.id),
        iface: String(row.iface),
        person: text(row.partner_person) ?? dmPartnerOfPlace(row.id)?.person ?? null,
        account: text(row.partner_account),
        native: text(row.native) ?? /^[^:]+:dm:(.+)$/.exec(String(row.id))?.[1] ?? null,
      },
    ])
  );
}

/**
 * The native conversation of each DM: what the partner's own lines there name, read from the locator columns of their
 * `extra` only. A line by anyone else proves nothing about whose conversation it is.
 */
function conversationsOf(source: Db, homes: ReadonlyMap<string, DmHome>): Map<string, DmHome> {
  const named = source.prepare(
    `SELECT DISTINCT json_extract(extra, '$."$messageLocator".conversationId') AS located,
       json_extract(extra, '$.scope.channel') AS scoped, json_extract(extra, '$.dmChannel') AS kept
     FROM sources WHERE place_id = ? AND author_account = ? AND json_valid(extra)`
  );
  const found = new Map<string, DmHome | null>();
  for (const home of homes.values()) {
    if (home.account === null) continue;
    for (const row of named.all(home.place, home.account) as Array<Row>) {
      for (const id of [row.located, row.scoped, row.kept]) {
        const conversation = text(id);
        if (conversation === null) continue;
        const held = found.get(conversation);
        // Two DMs naming one conversation say nothing about whose it is.
        found.set(conversation, held === undefined || held === home ? home : null);
      }
    }
  }
  const out = new Map<string, DmHome>();
  for (const [conversation, home] of found) if (home !== null) out.set(conversation, home);
  return out;
}

const scopeColumnsOf = (home: DmHome): Row => ({
  scope_kind: 'dm',
  scope_iface: home.iface,
  scope_dm: home.person,
  audience_id: dmAudienceId(home.place),
});

export type DmRepair = {
  /** What a row of `table` becomes, or null when it stays. */
  moved(table: string, row: Row, nextPosition: (unit: string, table: string) => number): Row | null;
  /** The storage units moved rows went to that the input did not hold, by id. */
  units: Map<string, StorageKey>;
  /** The audiences moved rows name, by id, with what their row needs. */
  audiences: Map<string, DmHome>;
  /** The rows moved, per table. */
  counts: Record<string, number>;
};

/** The extra of a moved row with the `add` keys laid over it, as the DM's mapper would have written them. */
function extraWith(extra: unknown, add: Row): string {
  let value: Row = {};
  try {
    const parsed: unknown = typeof extra === 'string' ? JSON.parse(extra) : {};
    if (parsed !== null && typeof parsed === 'object') value = parsed as Row;
  } catch {
    value = {};
  }
  return JSON.stringify({ ...value, ...add });
}

/** Reads the input's ids and answers how each row moves. Pure over the rows handed to `moved`. */
export function planDmRepair(source: Db): DmRepair {
  const homes = dmHomes(source);
  const byPlace = new Map<string, { home: DmHome; conversation: string }>();
  for (const [conversation, home] of conversationsOf(source, homes))
    byPlace.set(channelPlaceId(home.iface, conversation), { home, conversation });
  const units = new Map<string, StorageKey>();
  const audiences = new Map<string, DmHome>();
  const counts: Record<string, number> = {};
  const movedNodes = new Map<string, DmHome>();
  const movedEdges = new Map<string, DmHome>();
  const destOfNode = new Map<string, string>();
  const movedRowids = new Map<number, DmHome>();

  const count = (table: string): void => {
    counts[table] = (counts[table] ?? 0) + 1;
  };
  /** The unit of `kind` of a DM for the day of `at`; registered when the input has no such unit. */
  const dayUnit = (kind: StorageKind, home: DmHome, at: unknown): string => {
    const key = placeCollection(kind, home.place, { partition: String(at).slice(0, 10) });
    const id = storageId(key);
    units.set(id, key);
    return id;
  };

  // The tables copy in name order, so what the graph and the vectors follow is known before any line moves.
  const lines = source.prepare('SELECT rowid AS rowid_, id, occurred_at FROM sources WHERE place_id = ?');
  const edges = source.prepare('SELECT id FROM graph_edges WHERE src = ? OR dst = ?');
  for (const [place, { home }] of byPlace) {
    for (const row of lines.all(place) as Array<Row>) {
      const node = graphNodeId('source', row.id);
      movedNodes.set(node, home);
      movedRowids.set(Number(row.rowid_), home);
      destOfNode.set(node, dayUnit('record', home, row.occurred_at));
      for (const edge of edges.all(node, node) as Array<Row>) movedEdges.set(String(edge.id), home);
    }
  }

  function movedLine(table: string, row: Row, nextPosition: (unit: string, table: string) => number): Row | null {
    const found = byPlace.get(String(row.place_id));
    if (!found) return null;
    const { home, conversation } = found;
    audiences.set(dmAudienceId(home.place), home);
    count(table);
    const isDay = table === 'day';
    const owner = isDay ? dayUnit('journal', home, row.at) : dayUnit('record', home, row.occurred_at);
    return {
      ...scopeColumnsOf(home),
      place_id: home.place,
      owner_key: owner,
      position: nextPosition(owner, table),
      // What a DM's unit keeps of the conversation: a day row its channel, a record line its private mark.
      extra: extraWith(
        row.extra,
        isDay
          ? { dmChannel: conversation }
          : { scope: { ...(home.native ? { user: home.native } : {}), private: true, channel: conversation } }
      ),
    };
  }

  return {
    units,
    audiences,
    counts,
    moved(table, row, nextPosition) {
      if (table === 'sources' || table === 'day') return movedLine(table, row, nextPosition);
      if ((table === 'claims' || table === 'descriptions') && row.subject_kind === 'place') {
        const home = homes.get(String(row.subject_id));
        if (!home || row.scope_kind !== 'group') return null;
        audiences.set(dmAudienceId(home.place), home);
        count(table);
        return scopeColumnsOf(home);
      }
      if (table === 'vectors' && row.scope_kind === 'group') {
        const home = typeof row.source_rowid === 'number' ? movedRowids.get(row.source_rowid) : undefined;
        if (!home) return null;
        count(table);
        return scopeColumnsOf(home);
      }
      if (table === 'graph_edges') {
        const home = movedEdges.get(String(row.id));
        if (!home) return null;
        count(table);
        const owner = destOfNode.get(String(row.src));
        return { audience_id: dmAudienceId(home.place), ...(owner ? { owner_key: owner } : {}) };
      }
      if (table === 'node_access') {
        const home = movedNodes.get(String(row.evidence_id)) ?? movedEdges.get(String(row.evidence_id));
        if (!home) return null;
        count(table);
        return { audience_id: dmAudienceId(home.place) };
      }
      return null;
    },
  };
}
